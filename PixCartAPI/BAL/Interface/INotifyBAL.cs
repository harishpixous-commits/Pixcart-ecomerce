using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>
/// Notifications: an outbox table plus a dispatcher (the reference version's services/notify.py). Business code calls
/// <see cref="NotifyAsync"/> inside its own unit of work, so a message is recorded if and only if the change it describes
/// commits. In-app rows are visible at once; email, SMS and WhatsApp rows are sent by the dispatcher (BackgroundWorkerService
/// NotificationWorker) with retries; push notifications go out when the request finishes successfully. Templates live in
/// <c>notification_templates</c> (Admin → Notifications) with the defaults in <c>Model.Constants.NotificationEvents</c>.
/// Variables use {{name}} placeholders; name, brand and link are always available.
/// </summary>
public interface INotifyBAL
{
    /// <summary>All channels, in the reference order.</summary>
    static readonly string[] AllChannels = ["inapp", "push", "email", "sms", "whatsapp"];

    /// <summary>
    /// Sends one event to a user on each channel that has an active template, e.g.
    /// <c>NotifyAsync("order_placed", user, new() { ["order_number"] = o.Number, ["amount"] = "₹1,299" }, "/orders/" + o.Id, uow: uow)</c>.
    /// Email needs the user's email and SMTP; SMS needs MSG91 and a DLT template id on the template; WhatsApp a token and a
    /// template name; push needs Firebase (Admin → Integrations). Nothing happens for a missing or deleted user.
    /// The reference <c>notify.notify</c>.
    /// </summary>
    /// <param name="evt">An event of <c>NotificationEvents.Events</c> (or one with templates saved by admins).</param>
    /// <param name="link">A path ("/orders/…", made absolute with PublicWebUrl in messages) or a full address.</param>
    /// <param name="channels">Defaults to <see cref="AllChannels"/>.</param>
    Task NotifyAsync(string evt, UserModel? user, IDictionary<string, object?> variables, string link = "", IEnumerable<string>? channels = null,
        IUnitOfWork? uow = null);

    /// <summary>Notifies the owner of a seller account on all channels. The reference <c>notify.notify_seller</c>.</summary>
    Task NotifySellerAsync(Guid sellerId, string evt, IDictionary<string, object?> variables, string link = "", IUnitOfWork? uow = null);

    /// <summary>
    /// Tells every active staff member whose role has <paramref name="permission"/> (in-app and push). Returns how many were
    /// told. The reference <c>notify.notify_staff</c>.
    /// </summary>
    Task<int> NotifyStaffAsync(string permission, string evt, IDictionary<string, object?> variables, string link = "", IUnitOfWork? uow = null);

    /// <summary>
    /// Sends the waiting email, SMS and WhatsApp rows (oldest first, up to <paramref name="limit"/>); failures are recorded and
    /// retried, and a row fails for good after 5 attempts. Returns how many were sent. The reference <c>notify.dispatch_pending</c>.
    /// </summary>
    Task<int> DispatchPendingAsync(int limit = 100);

    /// <summary>
    /// Sends the push notifications queued by this scope now (in the background). Requests do this by themselves when they
    /// finish successfully; background workers call it after committing.
    /// </summary>
    void FlushPush();

    /// <summary>GET /api/notifications: the user's in-app notifications (20 per page) and the unread count.</summary>
    Task<object> MyNotificationsAsync(UserModel user, int page);

    /// <summary>POST /api/notifications/read-all.</summary>
    Task MarkAllReadAsync(UserModel user);
}
