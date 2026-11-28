using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
using Utils;

namespace API.Controllers;

/// <summary>Platform coupon administration (reference: routers/admin_extras.py coupons endpoints).</summary>
[ApiController]
[Route("api/admin/coupons")]
public class AdminCouponsController(ICouponAdminBAL bal, ICurrentUser current) : ControllerBase
{
    /// <summary>Create a platform coupon (reference: POST /api/admin/coupons).</summary>
    [HttpPost("")]
    [Consumes("application/json")]
    public async Task<IActionResult> Create([FromBody] AdminCouponIn body)
    {
        var user = await current.RequireAsync();
        var c = await bal.CreateAsync(user, body.Code, body.Description, body.Kind, body.Value, body.MaxDiscountPaise,
            body.MinOrderPaise, body.StartsAt, body.EndsAt, body.UsageLimit, body.PerUserLimit, body.IsActive,
            body.CategoryId, body.FirstOrderOnly, body.ShowOnCheckout, body.IsAutomatic, body.BuyQty, body.GetQty);
        return StatusCode(201, c);
    }

    /// <summary>Update a coupon (reference: PUT /api/admin/coupons/{coupon_id}).</summary>
    [HttpPut("{coupon_id}")]
    [Consumes("application/json")]
    public async Task<IActionResult> Update(Guid coupon_id, [FromBody] AdminCouponIn body)
    {
        var user = await current.RequireAsync();
        var c = await bal.UpdateAsync(user, coupon_id, body.Description, body.Kind, body.Value, body.MaxDiscountPaise,
            body.MinOrderPaise, body.StartsAt, body.EndsAt, body.UsageLimit, body.PerUserLimit, body.IsActive,
            body.CategoryId, body.FirstOrderOnly, body.ShowOnCheckout, body.IsAutomatic, body.BuyQty, body.GetQty);
        return Ok(c);
    }
}

/// <summary>Reference: AdminCouponIn (extends SellerCouponIn).</summary>
public sealed record AdminCouponIn(
    [property: System.ComponentModel.DataAnnotations.StringLength(30, MinimumLength = 4)]
    [property: System.ComponentModel.DataAnnotations.RegularExpression("^[A-Za-z0-9]+$", ErrorMessage = "Code may only contain letters and digits")]
    string Code,
    [property: System.ComponentModel.DataAnnotations.StringLength(200)] string Description,
    [property: System.ComponentModel.DataAnnotations.CustomValidation(typeof(AdminCouponIn), "ValidateKind")]
    string Kind,
    [property: System.ComponentModel.DataAnnotations.Range(1, int.MaxValue)] int Value,
    long? MaxDiscountPaise,
    [property: System.ComponentModel.DataAnnotations.Range(0, long.MaxValue)] long MinOrderPaise,
    DateTime? StartsAt,
    DateTime? EndsAt,
    int? UsageLimit,
    [property: System.ComponentModel.DataAnnotations.Range(1, 10)] int PerUserLimit,
    bool IsActive,
    Guid? CategoryId,
    bool FirstOrderOnly,
    bool ShowOnCheckout,
    bool IsAutomatic = false,
    int BuyQty = 0,
    int GetQty = 0)
{
    public AdminCouponIn()
        : this("", "", "percent", 100, null, 0, null, null, null, 1, true, null, false, true)
    {
    }

    /// <summary>Reference: kind is Literal["percent", "flat", "bxgy"].</summary>
    public static System.ComponentModel.DataAnnotations.ValidationResult? ValidateKind(string? kind, System.ComponentModel.DataAnnotations.ValidationContext context)
        => kind is "percent" or "flat" or "bxgy"
            ? System.ComponentModel.DataAnnotations.ValidationResult.Success
            : new System.ComponentModel.DataAnnotations.ValidationResult("kind must be percent, flat or bxgy", ["Kind"]);
}
