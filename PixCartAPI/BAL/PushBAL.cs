using BAL.Interface;
using DAL;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <inheritdoc cref="IPushBAL"/>
public class PushBAL(PushDAL dal, IIntegrationBAL integrations, IRateLimitBAL limits, IHttpClientFactory http, AppSettings env, ILogger<PushBAL> log) : IPushBAL
{
    /// <summary>The named HttpClient for Google sign-in and FCM (tests replace its handler).</summary>
    public const string HttpClientName = "push";
    public const int MaxDevices = 10;

    public async Task<object> ConfigAsync()
    {
        var cfg = await integrations.GetAsync();
        if (!cfg.PushConfigured) return new Dictionary<string, object?> { ["enabled"] = false };
        return new Dictionary<string, object?>
        {
            ["enabled"] = true, ["apiKey"] = cfg.FirebaseApiKey, ["projectId"] = cfg.FirebaseProjectId, ["messagingSenderId"] = cfg.FirebaseSenderId,
            ["appId"] = cfg.FirebaseAppId, ["vapidKey"] = cfg.FirebaseVapidKey,
        };
    }

    public async Task RegisterAsync(UserModel user, string token, string platform, string app)
    {
        await limits.RateLimitAsync($"push-token:{user.Id}", 30, 3600);
        var now = DateTimeFunctions.UtcNow();
        var row = await dal.GetByTokenAsync(token);
        if (row is null)
            await dal.InsertAsync(new PushTokenModel { Id = Guid.NewGuid(), UserId = user.Id, Token = token, Platform = platform, App = app, CreatedAt = now, LastSeenAt = now });
        else
        {
            // the same device signed in to another account, or opened again
            row.UserId = user.Id;
            row.Platform = platform;
            row.App = app;
            row.LastSeenAt = now;
            await dal.UpdateAsync(row);
        }
        var count = await dal.CountForUserAsync(user.Id);
        if (count > MaxDevices) await dal.DeleteOldestAsync(user.Id, count - MaxDevices); // keep the newest devices only
    }

    public Task UnregisterAsync(UserModel user, string token) => dal.DeleteForUserAsync(user.Id, token);

    public async Task<int> SendToUsersAsync(IReadOnlyList<PushItem> items)
    {
        var sent = 0;
        try
        {
            var cfg = await integrations.GetAsync();
            if (!cfg.PushConfigured) return 0;
            var client = http.CreateClient(HttpClientName);
            client.Timeout = TimeSpan.FromSeconds(15);
            var gone = new List<string>();
            foreach (var item in items)
            {
                foreach (var t in await dal.TokensForUserAsync(item.UserId))
                {
                    var result = await FcmClient.SendOneAsync(client, cfg, env.PublicWebUrl, t, item.Title, item.Body, item.Link, item.Data);
                    if (result == "sent") sent++;
                    else if (result == "gone") gone.Add(t);
                    else log.LogWarning("push to a device of {User} failed", item.UserId);
                }
            }
            if (gone.Count > 0) await dal.DeleteTokensAsync(gone);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            // a push must never break the work that caused it
            log.LogError(e, "sending push notifications failed");
        }
        return sent;
    }
}
