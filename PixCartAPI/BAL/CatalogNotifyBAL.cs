using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// In-app notifications for the storefront's events, with the same built-in texts as the reference version
/// (services/notify.py EVENTS) and the admin's saved templates taking precedence.
/// </summary>
public partial class CatalogNotifyBAL(CatalogSupportDAL support, CatalogDAL catalog, ISiteBAL site, AppSettings app) : ICatalogNotifyBAL
{
    /// <summary>event → (in-app title, in-app body).</summary>
    public static readonly IReadOnlyDictionary<string, (string Subject, string Body)> InApp = new Dictionary<string, (string, string)>
    {
        ["back_in_stock"] = ("Back in stock", "{{item}} is available again. Order before it sells out."),
        ["price_drop"] = ("Price dropped", "{{item}} in your wishlist is now {{price}} (was {{old_price}})."),
        ["question_answered"] = ("Your question was answered", "{{answerer}} answered your question about {{item}}."),
        ["seller_new_question"] = ("New customer question", "A shopper asked about {{item}}: {{question}}"),
        ["order_placed"] = ("Order {{order_number}} placed", "Thanks! Your order for {{amount}} is confirmed."),
        ["seller_new_order"] = ("New order {{order_number}}", "{{items}} — {{amount}}. Dispatch within {{dispatch_days}} days."),
        ["order_cancelled"] = ("Order {{order_number}} cancelled", "Your order was cancelled. {{refund_note}}"),
        ["seller_order_cancelled"] = ("Order {{order_number}} cancelled", "{{items}} — the customer cancelled {{reason}}."),
    };

    [GeneratedRegex(@"\{\{\s*(\w+)\s*\}\}")]
    private static partial Regex Var();

    public static string Render(string text, IReadOnlyDictionary<string, string> vars) =>
        Var().Replace(text, m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : "");

    public async Task NotifyUserAsync(Guid userId, string @event, IReadOnlyDictionary<string, string> variables, string link = "")
    {
        var user = await support.GetUserAsync(userId);
        if (user is null || user.DeletedAt != null) return;
        string subject, body;
        var tpl = await support.GetTemplateAsync(@event, "inapp");
        if (tpl != null)
        {
            if (!tpl.IsActive) return;
            (subject, body) = (tpl.Subject, tpl.Body);
        }
        else if (InApp.TryGetValue(@event, out var d)) (subject, body) = d;
        else return;
        var business = site.PublicBusiness(await site.GetSiteAsync());
        var vars = new Dictionary<string, string>
        {
            ["name"] = string.IsNullOrEmpty(user.Name) ? "there" : user.Name,
            ["brand"] = CatalogText.AsString(business["brand"]) ?? app.AppName,
            ["link"] = link.StartsWith('/') ? app.PublicWebUrl.TrimEnd('/') + link : link,
        };
        foreach (var (k, v) in variables) vars[k] = v;
        var now = DateTimeFunctions.UtcNow();
        var s = Render(subject, vars);
        await support.InsertNotificationAsync(new NotificationModel
        {
            Id = Guid.NewGuid(), UserId = user.Id, Event = @event, Channel = "inapp", Recipient = "",
            Subject = s.Length > 200 ? s[..200] : s, Body = Render(body, vars), Link = link.Length > 300 ? link[..300] : link,
            Variables = new JsonObject(vars.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value))).ToJsonString(),
            Status = "sent", Attempts = 0, Error = "", CreatedAt = now, SentAt = now,
        });
    }

    public async Task NotifySellerAsync(Guid sellerId, string @event, IReadOnlyDictionary<string, string> variables, string link = "")
    {
        var seller = await catalog.GetSellerAsync(sellerId);
        if (seller is null) return;
        await NotifyUserAsync(seller.UserId, @event, variables, link);
    }
}
