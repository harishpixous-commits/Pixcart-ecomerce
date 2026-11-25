using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Where a RazorpayX payout status goes (implemented by the payouts module: the reference ledger.apply_payout_webhook).
/// Register the implementation in DI under this interface.
/// </summary>
public interface IPayoutWebhookTarget
{
    /// <summary>Applies "processed", "failed", "reversed", "rejected" ... to the payout with this RazorpayX id (inside the unit of work).</summary>
    Task ApplyPayoutWebhookAsync(IUnitOfWork uow, string providerPayoutId, string status, string utr, string reason);
}

/// <summary>
/// Package state changes from courier tracking (implemented by the orders module: the reference orders.transition and
/// orders.cancel_sub_order). Register the implementation in DI under this interface.
/// </summary>
public interface IShipmentWebhookTarget
{
    /// <summary>Moves the package to <paramref name="to"/> ("shipped", "delivered") with the actor "system" and a note.</summary>
    Task TransitionAsync(IUnitOfWork uow, SubOrderModel sub, string to, string actor, string note);

    /// <summary>Cancels the package (return to origin), refunding and restocking as the orders module does.</summary>
    Task CancelSubOrderAsync(IUnitOfWork uow, SubOrderModel sub, string actor, string reason);
}

/// <summary>Inbound webhooks from RazorpayX (payout status) and Shiprocket (shipment tracking): routers/webhooks.py.</summary>
public interface IWebhookBAL
{
    Task<object> RazorpayAsync(byte[] body,string signature,string? eventIdHeader);
    Task<object> RazorpayxAsync(byte[] body, string signature, string? eventIdHeader);
    Task<object> ShiprocketAsync(byte[] body, string apiKey);
}

/// <inheritdoc cref="IWebhookBAL"/>
public partial class WebhookBAL(IntegrationDAL dal, IIntegrationBAL integrations, IMySqlDapperHelper db, IServiceProvider services) : IWebhookBAL
{
    private static readonly HashSet<string> Delivered = ["DELIVERED"];
    private static readonly HashSet<string> InTransit = ["PICKED UP", "SHIPPED", "IN TRANSIT", "OUT FOR DELIVERY", "REACHED AT DESTINATION HUB", "OUT FOR PICKUP"];
    private static readonly HashSet<string> RtoDone = ["RTO DELIVERED"];

    /// <summary>Shiprocket current_status text → our action (shipping.classify).</summary>
    public static string Classify(string? status)
    {
        var s = (status ?? "").ToUpperInvariant().Trim();
        if (Delivered.Contains(s)) return "delivered";
        if (RtoDone.Contains(s)) return "rto";
        if (InTransit.Contains(s)) return "shipped";
        return "ignore";
    }

    private static string Cut(string s, int n) => s.Length > n ? s[..n] : s;

    private static string S(JsonNode? n) => n?.GetValueKind() switch
    {
        JsonValueKind.String => n.GetValue<string>(),
        null or JsonValueKind.Null => "",
        _ => n.ToJsonString(),
    };

    private static AppException Unavailable() =>
        new("This webhook cannot be processed on this server yet. Please retry later.", "webhook_unavailable", 503);

    public async Task<object> RazorpayxAsync(byte[] body, string signature, string? eventIdHeader)
    {
        var secret = (await integrations.GetAsync()).RazorpayxWebhookSecret;
        if (secret.Length == 0 || !EncryptDecrypt.SafeEquals(EncryptDecrypt.HmacSha256Hex(secret, body), signature))
            throw new AppException("Invalid signature", "bad_signature", 400);
        JsonObject evt;
        try
        {
            evt = JsonNode.Parse(body) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            throw new AppException("The request could not be read", "bad_request", 400);
        }
        var etype = S(evt["event"]);
        var target = services.GetService<IPayoutWebhookTarget>();
        if (etype.StartsWith("payout.") && target is null) throw Unavailable(); // not recorded, so Razorpay retries it later
        var eid = !string.IsNullOrEmpty(eventIdHeader) ? eventIdHeader : Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(body));
        await using var uow = await db.BeginAsync();
        if (!await dal.RecordWebhookOnceAsync("razorpayx", Cut(eid, 80), Cut(etype, 60), DateTimeFunctions.UtcNow(), uow.Transaction))
            return new { ok = true, duplicate = true };
        if (etype.StartsWith("payout."))
        {
            var p = evt["payload"]?["payout"]?["entity"] as JsonObject ?? [];
            var status = etype.Split('.', 2)[1];
            var details = S(p["status_details"]?["description"]);
            await target!.ApplyPayoutWebhookAsync(uow, S(p["id"]), status, S(p["utr"]), details.Length > 0 ? details : S(p["failure_reason"]));
        }
        await uow.CommitAsync();
        return new { ok = true };
    }

    public async Task<object> ShiprocketAsync(byte[] body, string apiKey)
    {
        var token = (await integrations.GetAsync()).ShiprocketWebhookToken;
        if (token.Length == 0 || !EncryptDecrypt.SafeEquals(apiKey, token)) throw new AppException("Invalid token", "bad_token", 401);
        JsonObject data;
        try
        {
            data = JsonNode.Parse(body) as JsonObject ?? [];
        }
        catch (JsonException)
        {
            throw new AppException("The request could not be read", "bad_request", 400);
        }
        var awb = S(data["awb"]);
        var status = S(data["current_status"]);
        var eid = $"{awb}:{status}:{S(data["current_timestamp"])}";
        if (awb.Length == 0) return new { ok = true };
        var target = services.GetService<IShipmentWebhookTarget>();
        await using var uow = await db.BeginAsync();
        var sub = await dal.SubOrderByAwbForUpdateAsync(awb, uow.Transaction);
        var action = Classify(status);
        if (sub is not null && action != "ignore" && target is null) throw Unavailable(); // not recorded, so Shiprocket retries it later
        if (!await dal.RecordWebhookOnceAsync("shiprocket", Cut(eid, 80), Cut(status, 60), DateTimeFunctions.UtcNow(), uow.Transaction))
            return new { ok = true };
        if (sub is null)
        {
            await uow.CommitAsync();
            return new { ok = true };
        }
        if (action == "shipped" && sub.Status == "packed") await target!.TransitionAsync(uow, sub, "shipped", "system", $"Courier: {status}");
        else if (action == "delivered" && sub.Status is "packed" or "shipped")
        {
            if (sub.Status == "packed")
            {
                await target!.TransitionAsync(uow, sub, "shipped", "system", "Courier picked up");
                sub.Status = "shipped";
            }
            await target!.TransitionAsync(uow, sub, "delivered", "system", "Delivered (courier update)");
        }
        else if (action == "rto" && sub.Status == "shipped")
            await target!.CancelSubOrderAsync(uow, sub, "system", "Returned to the seller by the courier (not delivered)");
        await uow.CommitAsync();
        return new { ok = true };
    }
}
