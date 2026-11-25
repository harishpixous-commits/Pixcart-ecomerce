using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils.Interface;

namespace BAL.Interface;

/// <summary>Returns after delivery: request, approve/reject, pickup, receipt with restock and ledger reversal,
/// refund (reference: services/returns.py + routers/customer.py returns endpoints).</summary>
public interface IReturnsBAL
{
    /// <summary>What can still be returned from a delivered package (reference: returnable_items).</summary>
    Task<List<JsonObject>> ReturnableItemsAsync(SubOrderModel sub, IUnitOfWork uow);

    /// <summary>The customer's return request (reference: POST /api/returns).</summary>
    Task<ReturnRequestModel> CreateAsync(UserModel user, Guid subOrderId, IReadOnlyList<(Guid OrderItemId, int Qty)> lines,
        string reason, string comment, string refundUpi);

    /// <summary>Moves a return forward inside the caller's transaction; returns refund ids to process after commit
    /// (reference: set_status).</summary>
    Task<List<Guid>> SetStatusAsync(ReturnRequestModel ret, string dst, IUnitOfWork uow, string note = "",
        string courier = "", string tracking = "", bool byFleet = false, IReadOnlyDictionary<Guid, string>? conditions = null,
        UserModel? actor = null);

    /// <summary>The shopper's returnable items and returns for one order (reference: GET /api/orders/{id}/returnable).</summary>
    Task<JsonObject> ReturnableAsync(UserModel user, Guid orderId);

    /// <summary>The customer cancels their own return (reference: POST /api/returns/{id}/cancel).</summary>
    Task<JsonObject> CancelAsync(UserModel user, Guid returnId);

    /// <summary>The seller's returns page (reference: GET /api/seller/returns).</summary>
    Task<JsonObject> SellerListAsync(UserModel user, string? status, int page);

    /// <summary>The seller decides on a return (reference: POST /api/seller/returns/{return_id}).</summary>
    Task<JsonObject> SellerActAsync(UserModel user, Guid returnId, string action, string note,
        string courier, string tracking, IReadOnlyDictionary<Guid, string> conditions);

    /// <summary>Staff returns search (reference: GET /api/admin/returns).</summary>
    Task<JsonObject> AdminListAsync(UserModel admin, string? status, string q, Guid? sellerId, int page);

    /// <summary>Staff view of what can still be returned from an order (reference: GET /api/admin/orders/{id}/returnable).</summary>
    Task<JsonObject> AdminReturnableAsync(UserModel admin, Guid orderId);

    /// <summary>Staff open a return for the customer (reference: POST /api/admin/returns).</summary>
    Task<JsonObject> AdminCreateAsync(UserModel admin, Guid subOrderId,
        IReadOnlyList<(Guid OrderItemId, int Qty)> lines, string reason, string comment, string refundUpi);

    /// <summary>Staff act on a return, including marking a COD refund paid (reference: POST /api/admin/returns/{id}).</summary>
    Task<JsonObject> AdminActAsync(UserModel admin, Guid returnId, string action, string note, string reference);

    /// <summary>A return as the customer, the seller or staff see it (reference: return_out).</summary>
    Task<JsonObject> ReturnOutAsync(ReturnRequestModel ret, string viewer = "customer", IUnitOfWork? uow = null,
        bool withUpi = false);
}
