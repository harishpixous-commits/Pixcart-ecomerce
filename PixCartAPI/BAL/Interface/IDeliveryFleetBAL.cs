using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>The own delivery fleet pipeline: route, seller hand-off, offers, trips and delivery (reference:
/// services/fleet.py plus the trip endpoints of routers/delivery.py). Return pickups, payouts, the stuck sweep job
/// and the admin queue come with later slices.</summary>
public interface IDeliveryFleetBAL
{
    /// <summary>Rate-limited live position update (reference: POST /api/delivery/me/location).</summary>
    Task<JsonObject> SetLocationAsync(UserModel user, decimal lat, decimal lng);

    /// <summary>What the partner app polls: new offers, trips in hand, today's numbers (reference: GET /api/delivery/feed).</summary>
    Task<JsonObject> FeedAsync(UserModel user);

    /// <summary>Accept an offered request (reference: POST /api/delivery/offers/{id}/accept).</summary>
    Task<JsonObject> AcceptAsync(UserModel user, Guid assignmentId);

    /// <summary>Decline a request (reference: POST /api/delivery/offers/{id}/reject).</summary>
    Task<JsonObject> RejectAsync(UserModel user, Guid assignmentId, string reason, string note);

    /// <summary>One trip with its status log (reference: GET /api/delivery/trips/{id}).</summary>
    Task<JsonObject> TripAsync(UserModel user, Guid assignmentId);

    /// <summary>Advance a trip one step (reference: POST /api/delivery/trips/{id}/status).</summary>
    Task<JsonObject> StepAsync(UserModel user, Guid assignmentId, string to, string code, decimal? lat, decimal? lng);

    /// <summary>Hand the package over: OTP, proof photo and COD check (reference: POST /api/delivery/trips/{id}/deliver).</summary>
    Task<JsonObject> DeliverAsync(UserModel user, Guid assignmentId, string otp, byte[]? proofPhoto,
        long codCollected, string codMethod, decimal? lat, decimal? lng);

    /// <summary>A delivery attempt that failed (reference: POST /api/delivery/trips/{id}/fail).</summary>
    Task<JsonObject> FailAsync(UserModel user, Guid assignmentId, string reason, string note, decimal? lat, decimal? lng);

    /// <summary>The delivery proof photo of the partner's own trip (reference: GET /api/delivery/trips/{id}/proof).</summary>
    Task<(byte[] Data, string Media)> ProofAsync(UserModel user, Guid assignmentId);

    /// <summary>Hand a packed package to the fleet (reference: POST /api/seller/orders/{id}/ready-for-pickup).</summary>
    Task<JsonObject> ReadyForPickupAsync(UserModel user, SellerModel seller, Guid subOrderId);

    /// <summary>Take a package back from the fleet before pickup (reference: POST /api/seller/orders/{id}/use-courier).</summary>
    Task<JsonObject> UseCourierAsync(UserModel user, SellerModel seller, Guid subOrderId);

    /// <summary>The fleet block on the seller's order view (reference: fleet_info).</summary>
    Task<JsonObject> FleetInfoAsync(SellerModel seller, Guid subOrderId);

    /// <summary>Blocks courier ship/deliver steps the fleet owns (reference: seller_orders._act fleet guards).</summary>
    Task GuardSellerActAsync(SellerModel seller, Guid subOrderId, string dst);
}
