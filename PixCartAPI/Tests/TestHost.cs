using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using BAL;
using Dapper;
using DAL.Helpers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MySqlConnector;
using Utils;

namespace Tests;

/// <summary>
/// The API on a test server with a real MySQL database (pixcart_test_auth on 127.0.0.1:3307), migrated once with the
/// DatabaseMigrator; every test starts from empty tables (the reference conftest's clean_db). Outbound calls to Firebase and
/// the integration checks go to <see cref="Fakes"/>.
/// </summary>
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    public const string Database = "pixcart_test_auth";
    public static readonly string ConnectionString = $"Server=127.0.0.1;Port=3307;Database={Database};User=root;Password=pixcart;";
    private static bool _migrated;
    private static readonly SemaphoreSlim Gate = new(1, 1);

    static ApiFactory()
    {
        Environment.SetEnvironmentVariable("App__Environment", "test");
        Environment.SetEnvironmentVariable("App__ConnectionString", ConnectionString);
        Environment.SetEnvironmentVariable("App__RunJobs", "false");
        Environment.SetEnvironmentVariable("App__SmsProvider", "console");
        Environment.SetEnvironmentVariable("App__RazorpayKeyId", "rzp_test_key");
        Environment.SetEnvironmentVariable("App__RazorpayKeySecret", "rzp_test_secret");
        Environment.SetEnvironmentVariable("App__RazorpayWebhookSecret", "whsec_test");
        var tmp = Path.Combine(Path.GetTempPath(), "pixcart-test-auth");
        Environment.SetEnvironmentVariable("App__MediaRoot", Path.Combine(tmp, "media"));
        Environment.SetEnvironmentVariable("App__PrivateRoot", Path.Combine(tmp, "private"));
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureTestServices(services =>
        {
            services.AddHttpClient(PushBAL.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new FakeHandler(r => Fakes.Push(r)));
            services.AddHttpClient(IntegrationBAL.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => new FakeHandler(r => Fakes.Integrations(r)));
        });
    }

    public async Task ResetAsync()
    {
        await Gate.WaitAsync();
        try
        {
            if (!_migrated)
            {
                var settings = new AppSettings { ConnectionString = ConnectionString, Environment = "test" };
                await using (var c = new MySqlConnection(ConnectionString.Replace($"Database={Database};", "")))
                {
                    await c.OpenAsync();
                    await c.ExecuteAsync($"DROP DATABASE IF EXISTS `{Database}`");
                }
                await new DatabaseMigrator(settings, NullLogger<DatabaseMigrator>.Instance).MigrateAsync();
                _migrated = true;
            }
        }
        finally
        {
            Gate.Release();
        }
        await using var conn = new MySqlConnection(ConnectionString);
        await conn.OpenAsync();
        var tables = (await conn.QueryAsync<string>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = @db AND table_type = 'BASE TABLE' AND table_name <> 'schema_versions'",
            new { db = Database })).ToList();
        var sql = "SET FOREIGN_KEY_CHECKS = 0; " + string.Concat(tables.Select(t => $"TRUNCATE TABLE `{t}`; ")) + "SET FOREIGN_KEY_CHECKS = 1;";
        await conn.ExecuteAsync(sql);
        Utils.SMSHelper.DevOutbox.Clear();
        FcmClient.Reset();
        Fakes.Reset();
    }

    /// <summary>A browser: its own cookie jar (the refresh cookie) and user agent.</summary>
    public Browser Browser(string userAgent = "TestBrowser/1.0") =>
        new(CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false }), userAgent);

    public static async Task<T> DbScalarAsync<T>(string sql, object? param = null)
    {
        await using var c = new MySqlConnection(ConnectionString);
        return (await c.ExecuteScalarAsync<T>(sql, param))!;
    }

    public static async Task<int> DbExecAsync(string sql, object? param = null)
    {
        await using var c = new MySqlConnection(ConnectionString);
        return await c.ExecuteAsync(sql, param);
    }

    public static async Task<List<T>> DbQueryAsync<T>(string sql, object? param = null)
    {
        await using var c = new MySqlConnection(ConnectionString + "GuidFormat=Char36;");
        return (await c.QueryAsync<T>(sql, param)).ToList();
    }
}

/// <summary>Outbound HTTP replaced in tests.</summary>
public static class Fakes
{
    public static Func<HttpRequestMessage, HttpResponseMessage>? PushHandler;
    public static Func<HttpRequestMessage, HttpResponseMessage>? IntegrationsHandler;

    public static void Reset()
    {
        PushHandler = null;
        IntegrationsHandler = null;
    }

    public static HttpResponseMessage Push(HttpRequestMessage r) => PushHandler?.Invoke(r) ?? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
    public static HttpResponseMessage Integrations(HttpRequestMessage r) => IntegrationsHandler?.Invoke(r) ?? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);

    public static HttpResponseMessage Json(int status, object body) =>
        new((HttpStatusCode)status) { Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
}

public sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.Content is not null) await request.Content.LoadIntoBufferAsync(cancellationToken);
        return respond(request);
    }
}

/// <summary>One test response: status, parsed JSON and headers.</summary>
public sealed class Res(HttpResponseMessage resp, string text)
{
    public int Status => (int)resp.StatusCode;
    public string Text => text;
    public JsonNode Json => JsonNode.Parse(text.Length > 0 ? text : "null")!;
    public string? ErrorCode => Json["error"]?["code"]?.GetValue<string>();
    public string? ErrorMessage => Json["error"]?["message"]?.GetValue<string>();
    public IEnumerable<string> SetCookies => resp.Headers.TryGetValues("Set-Cookie", out var v) ? v : [];
    public override string ToString() => $"{Status} {text}";
}

/// <summary>A browser with a manual cookie jar, sending a user agent; requests may carry a bearer token.</summary>
public sealed class Browser(HttpClient http, string userAgent) : IDisposable
{
    public Dictionary<string, string> Cookies { get; } = [];
    public string UserAgent { get; set; } = userAgent;

    public async Task<Res> SendAsync(HttpMethod method, string url, object? body = null, string? token = null, Dictionary<string, string>? headers = null)
    {
        using var req = new HttpRequestMessage(method, url);
        if (body is not null) req.Content = body is HttpContent hc ? hc : JsonContent.Create(body);
        if (UserAgent.Length > 0) req.Headers.TryAddWithoutValidation("User-Agent", UserAgent);
        if (token is not null) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        if (Cookies.Count > 0 && url.StartsWith("/api/auth")) req.Headers.TryAddWithoutValidation("Cookie", string.Join("; ", Cookies.Select(kv => $"{kv.Key}={kv.Value}")));
        foreach (var (k, v) in headers ?? []) req.Headers.TryAddWithoutValidation(k, v);
        using var resp = await http.SendAsync(req);
        var text = await resp.Content.ReadAsStringAsync();
        if (resp.Headers.TryGetValues("Set-Cookie", out var cookies))
            foreach (var c in cookies)
            {
                var first = c.Split(';')[0];
                var eq = first.IndexOf('=');
                var name = first[..eq];
                if (c.Contains("Max-Age=0")) Cookies.Remove(name);
                else Cookies[name] = first[(eq + 1)..];
            }
        return new Res(resp, text);
    }

    public Task<Res> Get(string url, string? token = null, Dictionary<string, string>? headers = null) => SendAsync(HttpMethod.Get, url, null, token, headers);
    public Task<Res> Post(string url, object? body = null, string? token = null, Dictionary<string, string>? headers = null) => SendAsync(HttpMethod.Post, url, body ?? new { }, token, headers);
    public Task<Res> Put(string url, object? body = null, string? token = null) => SendAsync(HttpMethod.Put, url, body ?? new { }, token);
    public Task<Res> Patch(string url, object? body = null, string? token = null) => SendAsync(HttpMethod.Patch, url, body ?? new { }, token);
    public Task<Res> Delete(string url, string? token = null) => SendAsync(HttpMethod.Delete, url, null, token);

    public void Dispose() => http.Dispose();
}

/// <summary>A signed-in person (the reference conftest's Api): the browser and the access token.</summary>
public sealed class Api(Browser b, string token, JsonNode user)
{
    public Browser B { get; } = b;
    public string Token { get; } = token;
    public JsonNode User { get; } = user;
    public string Id => User["id"]!.GetValue<string>();
    public Task<Res> Get(string url) => B.Get(url, Token);
    public Task<Res> Post(string url, object? body = null) => B.Post(url, body, Token);
    public Task<Res> Put(string url, object? body = null) => B.Put(url, body, Token);
    public Task<Res> Patch(string url, object? body = null) => B.Patch(url, body, Token);
    public Task<Res> Delete(string url) => B.Delete(url, Token);
}

[CollectionDefinition("api")]
public class ApiCollection : ICollectionFixture<ApiFactory>;

/// <summary>Base of every test class: a clean database before each test, and the conftest helpers.</summary>
[Collection("api")]
public abstract class ApiTest(ApiFactory factory) : IAsyncLifetime
{
    protected ApiFactory Factory { get; } = factory;
    public const string AdminPassword = "Admin@12345";
    public static readonly Dictionary<string, string> Csrf = new() { ["X-Requested-With"] = "pixcart" };

    public Task InitializeAsync() => Factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    protected static string Otp(string phone) => SMSHelper.DevOutbox[phone[^10..]];

    /// <summary>Signs in with a one-time code (creating the account when new) and forgets the refresh cookie (conftest.login_phone).</summary>
    protected async Task<Api> LoginPhone(string phone, string name = "Test User", Browser? b = null)
    {
        b ??= Factory.Browser();
        var r = await b.Post("/api/auth/otp/request", new { phone });
        Assert.True(r.Status == 200, r.ToString());
        r = await b.Post("/api/auth/otp/verify", new { phone, code = Otp(phone), name });
        Assert.True(r.Status == 200, r.ToString());
        b.Cookies.Clear();
        return new Api(b, r.Json["access_token"]!.GetValue<string>(), r.Json["user"]!);
    }

    /// <summary>The owner: admin@pixcart.in / Admin@12345 (conftest admin fixture).</summary>
    protected async Task<Api> Admin()
    {
        await ApiFactory.DbExecAsync(
            "INSERT INTO users (id, email, name, password_hash, is_admin, is_active, admin_role, ui_prefs) VALUES (@id, 'admin@pixcart.in', 'Admin', @hash, 1, 1, '', '{}')",
            new { id = Guid.NewGuid().ToString(), hash = EncryptDecrypt.HashPassword(AdminPassword) });
        var b = Factory.Browser();
        var r = await b.Post("/api/auth/login", new { email = "admin@pixcart.in", password = AdminPassword });
        Assert.True(r.Status == 200, r.ToString());
        b.Cookies.Clear();
        return new Api(b, r.Json["access_token"]!.GetValue<string>(), r.Json["user"]!);
    }

    /// <summary>A staff member with the role, signed in.</summary>
    protected async Task<Api> Staff(Api admin, string email, string role = "support", string password = "Staff@2026xyz")
    {
        var r = await admin.Post("/api/admin/staff", new { email, name = role.Length > 1 ? char.ToUpper(role[0]) + role[1..] : role, role, password });
        Assert.True(r.Status == 201, r.ToString());
        var b = Factory.Browser();
        r = await b.Post("/api/auth/login", new { email, password });
        Assert.True(r.Status == 200, r.ToString());
        b.Cookies.Clear();
        return new Api(b, r.Json["access_token"]!.GetValue<string>(), r.Json["user"]!);
    }

    /// <summary>conftest.add_address.</summary>
    protected static async Task<string> AddAddress(Api api, string state = "33", string pincode = "600028", string city = "Chennai")
    {
        var r = await api.Post("/api/addresses", new { full_name = "Priya S", phone = "9876500000", line1 = "4 Lake View St", city, state_code = state, pincode });
        Assert.True(r.Status == 201, r.ToString());
        return r.Json["id"]!.GetValue<string>();
    }

    protected static string ValidGstin(string state, string pan)
    {
        var first = $"{state}{pan}1Z";
        return first + Model.CustomeAttributes.IndianFormats.GstinCheckChar(first);
    }

    /// <summary>Moves every code's creation time back, so the resend wait is not in the way.</summary>
    protected static Task AgeOtps() => ApiFactory.DbExecAsync("UPDATE otp_challenges SET created_at = DATE_SUB(created_at, INTERVAL 10 MINUTE)");
}
