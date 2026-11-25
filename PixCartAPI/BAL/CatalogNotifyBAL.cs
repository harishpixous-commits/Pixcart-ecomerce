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
public partial class CatalogNotifyBAL(CatalogSupportDAL support, CatalogDAL catalog, ISiteBAL site, AppSettings app, INotifyBAL notify) : ICatalogNotifyBAL
{
    /// <summary>event → (in-app title, in-app body).</summary>
    public static readonly IReadOnlyDictionary<string, (string Subject, string Body)> InApp = new Dictionary<string, (string, string)>
    {
        ["back_in_stock"] = ("Back in stock", "{{item}} is available again. Order before it sells out."),
        ["ticket_reply"] = ("Reply on ticket {{ticket_number}}", "Our team replied to your request: {{subject}}."),
        ["price_drop"] = ("Price dropped", "{{item}} in your wishlist is now {{price}} (was {{old_price}})."),
        ["question_answered"] = ("Your question was answered", "{{answerer}} answered your question about {{item}}."),
        ["seller_new_question"] = ("New customer question", "A shopper asked about {{item}}: {{question}}"),
        ["order_placed"] = ("Order placed", "Your order {{order_number}} for {{amount}} is placed."),
        ["seller_new_order"] = ("New order {{order_number}}", "{{items}} for {{amount}}. Confirm it from your orders page."),
        ["order_cancelled"] = ("Order cancelled", "{{item}} was cancelled: {{reason}}."),
        ["seller_order_cancelled"] = ("Order {{order_number}} cancelled", "The customer cancelled {{order_number}}. Do not ship it."),
        ["refund_processed"] = ("Refund started", "We have refunded {{amount}} for order {{order_number}}. It reaches your account in 5 to 7 working days."),
        ["order_shipped"] = ("Package shipped", "{{item}} has shipped with {{courier}}, tracking {{awb}}."),
        ["staff_delivery_kyc"] = ("Delivery partner to verify", "{{name}} ({{city}}) submitted documents. Check them in Delivery → Partners."),
        ["security_notice"] = ("Security notice: {{what}}", "{{message}} If this was not you or someone you asked, contact {{brand}} support at once."),
        ["delivery_payout_paid"] = ("Payout {{amount}} paid", "Your earnings for {{period}} were paid. Reference {{reference}}."),
        ["delivery_kyc_update"] = ("Delivery partner account {{status}}", "{{message}}"),
        ["delivery_new_offer"] = ("New delivery request", "Pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}. {{fee}}{{cod}}. Accept within {{seconds}} seconds."),
        ["delivery_assigned"] = ("Delivery assigned to you", "{{order_number}}: pick up from {{store}} ({{pickup_area}}) and deliver to {{drop_area}}."),
        ["delivery_trip_cancelled"] = ("Delivery cancelled: {{order_number}}", "{{message}}"),
        ["delivery_partner_assigned"] = ("Delivery partner assigned", "{{partner}} will deliver {{item}}. You can track the delivery on your order page."),
        ["seller_pickup_assigned"] = ("Pickup assigned: {{order_number}}", "{{partner}} ({{vehicle}}) will pick up {{order_number}}. Give the package against pickup code {{code}}."),
        ["delivery_out_for_delivery"] = ("Out for delivery", "{{item}} is on the way with {{partner}}. Share OTP {{otp}} only when you receive the package."),
        ["delivery_arriving"] = ("Your delivery partner has arrived", "{{partner}} is at your address with {{item}}. Keep OTP {{otp}} ready."),
        ["seller_package_delivered"] = ("Delivered: {{order_number}}", "{{partner}} delivered {{order_number}} to the customer."),
        ["seller_package_returned"] = ("Package returned: {{order_number}}", "{{partner}} returned {{order_number}} to your store ({{reason}}). The stock is back in your inventory."),
        ["return_update"] = ("Return {{return_number}}: {{status}}", "{{message}}"),
        ["seller_return_requested"] = ("Return requested on {{order_number}}", "Reason: {{reason}}. Review it from your returns page."),
        ["seller_return_arriving"] = ("Return on its way: {{return_number}}", "{{partner}} collected return {{return_number}} ({{order_number}}) and is bringing it to you. Give pickup code {{code}} when you receive it."),
        ["seller_return_delivered"] = ("Return delivered: {{return_number}}", "{{partner}} brought return {{return_number}} to your store. Check the item, then mark it received to refund the customer."),
        ["delivery_new_return_pickup"] = ("New return pickup", "Collect a return from a customer in {{drop_area}} and bring it to {{store}} ({{pickup_area}}). {{fee}}. Accept within {{seconds}} seconds."),
        ["seller_kyc_update"] = ("Seller account {{status}}", "{{message}}"),
        ["listing_update"] = ("Listing {{status}}", "{{title}}: {{message}}"),
        ["delivery_return_pickup_assigned"] = ("Return pickup assigned to you", "{{order_number}}: collect the return from a customer in {{drop_area}} and bring it to {{store}}."),
        ["return_pickup_scheduled"] = ("Return pickup on the way", "{{partner}} will collect your return {{return_number}}. Keep the item packed and give pickup code {{code}} when you hand it over."),
        ["return_pickup_failed"] = ("Return pickup missed: {{return_number}}", "We could not collect your return ({{reason}}). We will arrange another pickup."),
        ["delivery_rate"] = ("How was your delivery?", "Rate {{partner}}'s delivery of {{item}}. It takes a second."),
        ["delivery_failed"] = ("Delivery attempt failed", "We could not deliver {{item}}: {{reason}}. We will try again or contact you."),
        ["staff_delivery_unassigned"] = ("No delivery partner took {{order_number}}", "{{reason}} Assign it by hand in Delivery → Queue."),
        ["staff_delivery_ready"] = ("Ready for pickup: {{order_number}}", "{{store}} has a package ready for pickup ({{pickup_area}} to {{drop_area}}). Assign a partner in Delivery → Queue."),
        ["staff_delivery_stuck"] = ("Delivery stuck: {{order_number}}", "It has been '{{status}}' for {{minutes}} minutes with {{partner}}."),
        ["low_stock"] = ("Low stock", "{{count}} of your product options have {{threshold}} or fewer units left."),
        ["staff_delivery_failed"] = ("Delivery failed: {{order_number}}", "{{partner}} could not deliver: {{reason}}. Choose to try again or return it to the seller."),
        ["staff_delivery_bank"] = ("Partner payout details changed", "{{name}} ({{phone}}) changed their bank or UPI details. Check them before the next payout."),
        ["order_delivered"] = ("Delivered", "{{item}} was delivered. Tell others what you think by writing a review."),
        // Reference also sends this by email; the email channel is not ported, so the message goes in-app only.
        ["staff_message"] = ("{{subject}}", "{{message}}"),
    };

    [GeneratedRegex(@"\{\{\s*(\w+)\s*\}\}")]
    private static partial Regex Var();

    public static string Render(string text, IReadOnlyDictionary<string, string> vars) =>
        Var().Replace(text, m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : "");

    /// <summary>
    /// Sends the event on every channel that has an active template (in-app, push, email, SMS, WhatsApp), with the
    /// reference texts (Model.Constants.NotificationEvents) unless an admin changed them, exactly like the reference
    /// notify(). Earlier this wrote the in-app row only, with its own texts (see <see cref="InApp"/>), so order and
    /// delivery messages never reached email, SMS, WhatsApp or the phone, and five texts differed from the reference.
    /// </summary>
    public async Task NotifyUserAsync(Guid userId, string @event, IReadOnlyDictionary<string, string> variables, string link = "")
    {
        var user = await support.GetUserAsync(userId);
        if (user is null || user.DeletedAt != null) return;
        await notify.NotifyAsync(@event, user, variables.ToDictionary(kv => kv.Key, kv => (object?)kv.Value), link);
    }

    public async Task NotifySellerAsync(Guid sellerId, string @event, IReadOnlyDictionary<string, string> variables, string link = "")
    {
        var seller = await catalog.GetSellerAsync(sellerId);
        if (seller is null) return;
        await NotifyUserAsync(seller.UserId, @event, variables, link);
    }
}
