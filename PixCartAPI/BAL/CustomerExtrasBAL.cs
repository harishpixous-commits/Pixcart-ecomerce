using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Utils;

namespace BAL;

/// <inheritdoc cref="ICustomerExtrasBAL"/>
public class CustomerExtrasBAL(NotificationDAL notifications, ProductEventDAL events) : ICustomerExtrasBAL
{
    public async Task<JsonObject> NotificationsAsync(Guid userId, int page)
    {
        var rows = await notifications.InAppPageAsync(userId, (page - 1) * 20, 20);
        var unread = await notifications.UnreadCountAsync(userId);
        return new JsonObject
        {
            ["unread"] = unread,
            ["items"] = new JsonArray(rows.Select(n => (JsonNode)new JsonObject
            {
                ["id"] = n.Id.ToString(), ["title"] = n.Subject, ["body"] = n.Body, ["link"] = n.Link,
                ["read"] = n.ReadAt is not null, ["at"] = DateTimeFunctions.Iso(n.CreatedAt),
            }).ToArray()),
        };
    }

    public Task ReadAllAsync(Guid userId) => notifications.MarkAllReadAsync(userId, DateTimeFunctions.UtcNow());

    /// <summary>Reference: _seen — count a visitor once per 30 minutes per product.</summary>
    private static readonly ConcurrentDictionary<(string, string, Guid), long> Seen = new();

    public async Task EventAsync(string ip, string type, Guid productId)
    {
        var key = (ip, type, productId);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Seen.TryGetValue(key, out var last) && now - last < 1800) return;
        Seen[key] = now;
        if (Seen.Count > 100_000) Seen.Clear();
        if (await events.IsPublicAsync(productId))
            await events.BumpAsync(productId, DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromMinutes(330)).Date),
                views: type == "view" ? 1 : 0, addToCart: type == "add_to_cart" ? 1 : 0);
    }
}
