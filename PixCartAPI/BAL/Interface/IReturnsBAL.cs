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

    /// <summary>A return as the customer, the seller or staff see it (reference: return_out).</summary>
    Task<JsonObject> ReturnOutAsync(ReturnRequestModel ret, string viewer = "customer", IUnitOfWork? uow = null,
        bool withUpi = false);
}
