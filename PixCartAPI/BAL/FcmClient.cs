using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Model.DomainModel.Integrations;

namespace BAL;

/// <summary>
/// Firebase Cloud Messaging (HTTP v1): the Google access token made from the service account (a signed RS256 JWT, cached
/// for about 55 minutes) and one push to one device. The reference version's services/push.py.
/// </summary>
public static class FcmClient
{
    public const string Scope = "https://www.googleapis.com/auth/firebase.messaging";
    private static readonly object Gate = new();
    private static (string Token, long ExpiresAt, string Fingerprint)? _token;

    /// <summary>Forget the cached Google token (the connection test always asks Google again).</summary>
    public static void Reset()
    {
        lock (Gate) _token = null;
    }

    private static string PrivateKey(IntegrationSettings cfg) => cfg.FirebasePrivateKey.Replace("\\n", "\n");

    /// <summary>The Google access token. Throws <see cref="InvalidOperationException"/> when Google refuses, <see cref="FormatException"/> for an unreadable key.</summary>
    public static async Task<string> AccessTokenAsync(HttpClient http, IntegrationSettings cfg)
    {
        var fingerprint = $"{cfg.FirebaseClientEmail}:{cfg.FirebasePrivateKey.Length}";
        var nowSec = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        lock (Gate)
        {
            if (_token is { } t && t.ExpiresAt > nowSec + 60 && t.Fingerprint == fingerprint) return t.Token;
        }
        var assertion = SignJwt(new JsonObject
        {
            ["iss"] = cfg.FirebaseClientEmail, ["scope"] = Scope, ["aud"] = cfg.FirebaseOauthUrl, ["iat"] = nowSec, ["exp"] = nowSec + 3600,
        }, PrivateKey(cfg));
        using var resp = await http.PostAsync(cfg.FirebaseOauthUrl, new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer", ["assertion"] = assertion,
        }));
        var text = await resp.Content.ReadAsStringAsync();
        if ((int)resp.StatusCode >= 400)
            throw new InvalidOperationException($"Google sign-in failed ({(int)resp.StatusCode}): {(text.Length > 200 ? text[..200] : text)}");
        var data = JsonNode.Parse(text)!.AsObject();
        var token = data["access_token"]!.GetValue<string>();
        var expiresIn = data["expires_in"] is JsonValue ev && ev.TryGetValue<long>(out var e) ? e : 3600;
        lock (Gate) _token = (token, nowSec + expiresIn, fingerprint);
        return token;
    }

    /// <summary>RS256 JWT ({"alg":"RS256","typ":"JWT"}). Throws <see cref="FormatException"/> when the PEM key cannot be read.</summary>
    private static string SignJwt(JsonObject claims, string pem)
    {
        using var rsa = RSA.Create();
        try
        {
            rsa.ImportFromPem(pem);
        }
        catch (Exception ex) when (ex is ArgumentException or CryptographicException)
        {
            throw new FormatException(ex.Message);
        }
        var header = Utils.EncryptDecrypt.ToBase64Url(Encoding.UTF8.GetBytes("{\"alg\":\"RS256\",\"typ\":\"JWT\"}"));
        var payload = Utils.EncryptDecrypt.ToBase64Url(Encoding.UTF8.GetBytes(claims.ToJsonString()));
        var signature = rsa.SignData(Encoding.ASCII.GetBytes($"{header}.{payload}"), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        return $"{header}.{payload}.{Utils.EncryptDecrypt.ToBase64Url(signature)}";
    }

    /// <summary>Sends one push. Returns "sent", "gone" (the device unregistered: delete its token) or "error".</summary>
    public static async Task<string> SendOneAsync(HttpClient http, IntegrationSettings cfg, string publicWebUrl, string token, string title, string body,
        string link, IReadOnlyDictionary<string, string>? data)
    {
        var url = link.StartsWith("http") ? link : $"{publicWebUrl}{(link.Length > 0 ? link : "/")}";
        var urgent = data is not null && data.TryGetValue("urgent", out var u) && u.Length > 0;
        var dataObj = new JsonObject { ["link"] = link.Length > 0 ? link : "/" };
        if (data is not null) foreach (var (k, v) in data) dataObj[k] = v;
        var message = new JsonObject
        {
            ["token"] = token,
            ["notification"] = new JsonObject { ["title"] = Cut(title, 120), ["body"] = Cut(body, 400) },
            ["data"] = dataObj,
            ["webpush"] = new JsonObject
            {
                ["fcm_options"] = new JsonObject { ["link"] = url },
                ["notification"] = new JsonObject { ["icon"] = "/icon.svg", ["badge"] = "/icon.svg", ["requireInteraction"] = urgent },
            },
            ["android"] = new JsonObject
            {
                ["priority"] = "HIGH",
                ["notification"] = new JsonObject { ["channel_id"] = urgent ? "deliveries" : "updates", ["click_action"] = "OPEN_LINK" },
            },
        };
        var access = await AccessTokenAsync(http, cfg);
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{cfg.FirebaseFcmBase}/v1/projects/{cfg.FirebaseProjectId}/messages:send")
        {
            Content = JsonContent.Create(new JsonObject { ["message"] = message }),
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", access);
        using var resp = await http.SendAsync(req);
        var status = (int)resp.StatusCode;
        var text = await resp.Content.ReadAsStringAsync();
        if (status is 404 or 410 || (status == 400 && text.Contains("registration token", StringComparison.OrdinalIgnoreCase))) return "gone";
        return status >= 400 ? "error" : "sent";
    }

    private static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    internal static readonly JsonSerializerOptions Plain = new();
}
