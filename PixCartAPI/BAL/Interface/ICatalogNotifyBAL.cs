namespace BAL.Interface;

/// <summary>
/// The notifications the storefront sends (new question for the seller, question answered, back in stock, price
/// drop). The default implementation writes in-app notifications from the event's template (Admin → Templates or the
/// built-in text). When the notifications module is merged, point this at its notify() so email, SMS, WhatsApp and
/// push follow the same rules.
/// </summary>
public interface ICatalogNotifyBAL
{
    /// <summary>Sends one event to a user (nothing for a deleted or unknown user).</summary>
    Task NotifyUserAsync(Guid userId, string @event, IReadOnlyDictionary<string, string> variables, string link = "");

    /// <summary>Sends one event to the seller account's owner.</summary>
    Task NotifySellerAsync(Guid sellerId, string @event, IReadOnlyDictionary<string, string> variables, string link = "");
}
