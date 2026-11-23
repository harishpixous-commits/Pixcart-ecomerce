using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Order placement and the shopper's order view (reference: services/orders.py + the checkout routes of
/// routers/orders.py).</summary>
public interface IOrdersBAL
{
    /// <summary>Places the order (reference: place_order). Idempotent on IdempotencyKey per shopper; throws
    /// AppException/ConflictException with the reference's codes and texts.</summary>
    Task<(OrderModel Order, PaymentModel? Payment)> PlaceOrderAsync(
        UserModel user,
        Guid addressId,
        string paymentMethod,
        string idempotencyKey,
        long? expectedTotal,
        string? couponCode = null,
        int tipPaise = 0,
        string buyerGstin = "",
        string buyerBusiness = "",
        string? instructions = null,
        bool noBag = false,
        string? currency = null);

    /// <summary>The order as its shopper sees it (reference: routers/orders.py order_detail with for_admin false).</summary>
    Task<JsonObject> DetailAsync(OrderModel order, bool forAdmin = false);

    /// <summary>What the payment window needs while the order is unpaid (reference: shopper_checkout +
    /// checkout_payload). Null for COD orders and paid ones.</summary>
    Task<JsonObject?> ShopperCheckoutAsync(OrderModel order, PaymentModel? payment, UserModel user);
}
