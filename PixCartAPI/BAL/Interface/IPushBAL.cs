using Model.DomainModel;

namespace BAL.Interface;

/// <summary>
/// Push notifications through Firebase Cloud Messaging (the reference version's services/push.py and routers/push.py).
/// Devices register a token; <see cref="INotifyBAL"/> queues pushes and this sends them; tokens Firebase reports as gone are deleted.
/// </summary>
public interface IPushBAL
{
    /// <summary>GET /api/push/config: the public Firebase web settings the browser needs (no secrets), or {"enabled": false}.</summary>
    Task<object> ConfigAsync();

    /// <summary>POST /api/push/tokens: registers (or takes over) a device for the user; keeps the newest 10 devices.</summary>
    Task RegisterAsync(UserModel user, string token, string platform, string app);

    /// <summary>POST /api/push/tokens/remove: forgets the user's device (signing out).</summary>
    Task UnregisterAsync(UserModel user, string token);

    /// <summary>Sends each push to every device of its user. Never throws; returns how many were sent.</summary>
    Task<int> SendToUsersAsync(IReadOnlyList<BAL.PushItem> items);
}
