using System.Text.Json.Nodes;
using Utils.Interface;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>The own delivery fleet pipeline: route, seller hand-off, offers, trips and delivery (reference:
/// services/fleet.py plus the trip endpoints of routers/delivery.py), return pickups, staff assignment and the
/// stuck-trip check.</summary>
public interface IDeliveryFleetBAL
{
    Task<JsonObject> EarningsAsync(UserModel user);
    Task<JsonObject> HistoryAsync(UserModel user,DateOnly? from,DateOnly? to,string status,int page);
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

    /// <summary>Ask a partner to collect an approved fleet-delivered return (reference: request_return_pickup).</summary>
    Task RequestReturnPickupAsync(ReturnRequestModel ret, IUnitOfWork uow);

    /// <summary>Stop a return pickup (return cancelled or switched to courier) (reference: cancel_return_pickup).</summary>
    Task CancelReturnPickupAsync(ReturnRequestModel ret, string why, IUnitOfWork uow, UserModel? user = null);

    /// <summary>Close an open pickup trip when the seller marks the return received (reference: close_pickup_on_receive).</summary>
    Task ClosePickupOnReceiveAsync(ReturnRequestModel ret, IUnitOfWork uow, UserModel? user = null);

    /// <summary>A return pickup as one viewer sees it (reference: pickup_tracking).</summary>
    Task<JsonObject?> PickupTrackingAsync(ReturnRequestModel ret, string viewer, IUnitOfWork? uow = null);

    /// <summary>The partner hands a package back to the seller (reference: POST /api/delivery/trips/{id}/returned).</summary>
    Task<JsonObject> ReturnedAsync(UserModel user, Guid assignmentId, string code, decimal? lat, decimal? lng);

    /// <summary>Offer or assign a return pickup to a chosen partner (reference: delivery_admin assign_pickup).</summary>
    Task<JsonArray> ReturnCandidatesAsync(UserModel admin, Guid returnId);
    Task<JsonObject> AssignPickupByStaffAsync(UserModel admin, Guid returnId, Guid partnerId, bool direct, bool force);

    /// <summary>Run auto-assignment for a return pickup now (reference: delivery_admin auto_assign_pickup).</summary>
    Task<JsonObject> AutoAssignPickupByStaffAsync(UserModel admin, Guid returnId);

    /// <summary>The seller arranges the pickup instead (reference: delivery_admin pickup_by_courier).</summary>
    Task<JsonObject> PickupToCourierByStaffAsync(UserModel admin, Guid returnId);

    Task SweepExpiredAsync();
    Task<int> StuckCheckAsync();
    Task ReleaseAsync(Guid subOrderId, string why);
    Task<JsonObject> PickupPlaceForAsync(SubOrderModel sub);
    Task<JsonObject> AssignByStaffAsync(UserModel admin, Guid subOrderId, Guid partnerId, bool direct, bool force);
    Task<JsonObject> AutoAssignByStaffAsync(UserModel admin, Guid subOrderId);
    Task CancelByStaffAsync(UserModel admin, Guid assignmentId, string reason);
    /// <summary>Stops (or turns back) the trip of a fleet package that was just cancelled, inside the cancelling unit of work.</summary>
    Task OnCancelledAsync(SubOrderModel sub, string reason, IUnitOfWork uow);
    Task<JsonObject> ResolveFailedAsync(UserModel admin, Guid assignmentId, string action);
    Task ToCourierByStaffAsync(UserModel admin, Guid subOrderId);
    Task<JsonObject> TripViewStaffAsync(Guid assignmentId);
    Task<(byte[] Data, string Media)> ProofStaffAsync(Guid assignmentId);
    Task<List<JsonObject>> CandidatesAsync(SubOrderModel sub, OrderModel order, JsonObject cfg,
        IUnitOfWork uow, bool onlineOnly = true, ReturnRequestModel? ret = null);

    /// <summary>Staff confirm a hand-over the partner could not record (reference: fleet.staff_deliver): closes
    /// the package's active trip as delivered, or returns false when no active trip exists.</summary>
    Task<bool> StaffDeliverForSubAsync(UserModel admin, SubOrderModel sub, IUnitOfWork uow);
}
