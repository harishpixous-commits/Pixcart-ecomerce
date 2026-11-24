namespace BAL.Interface;

/// <summary>The outbox dispatcher (reference: notify.dispatch_pending; jobs.py notify_job). Kept separate from
/// the template/notify side (CatalogNotifyBAL) so the worker has one narrow surface.</summary>
public interface INotifyDispatchBAL
{
    /// <summary>Sends the waiting email, SMS and WhatsApp rows (oldest first); failures are recorded and
    /// retried, and a row fails for good after 5 attempts. Returns how many were sent.</summary>
    Task<int> DispatchPendingAsync(int limit = 100);
}
