using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>Platform coupon administration (reference: routers/admin_extras.py coupons endpoints).</summary>
public interface ICouponAdminBAL
{
    /// <summary>Create a platform coupon (reference: POST /api/admin/coupons).</summary>
    Task<JsonObject> CreateAsync(UserModel admin, string code, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout);

    /// <summary>Update a coupon, code unchanged (reference: PUT /api/admin/coupons/{coupon_id}).</summary>
    Task<JsonObject> UpdateAsync(UserModel admin, Guid couponId, string description, string kind, int value,
        long? maxDiscountPaise, long minOrderPaise, DateTime? startsAt, DateTime? endsAt, int? usageLimit,
        int perUserLimit, bool isActive, Guid? categoryId, bool firstOrderOnly, bool showOnCheckout);

    /// <summary>Switch a coupon on or off (reference: assistant/actions.py set_coupon_active).</summary>
    Task<JsonObject> SetActiveAsync(UserModel admin, Guid couponId, bool active);
}
