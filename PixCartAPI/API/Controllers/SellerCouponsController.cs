using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
namespace API.Controllers;
public partial class SellerHubController
{
    [HttpGet("coupons")]public async Task<object> Coupons()=>await bal.CouponsAsync(await Seller(true));
    [HttpPost("coupons")]public async Task<IActionResult> Coupon(SellerCouponIn b)=>StatusCode(201,await bal.CouponAsync(await me.RequireAsync(),await Seller(true),null,b));
    [HttpPut("coupons/{id}")]public async Task<object> Coupon(Guid id,SellerCouponIn b)=>await bal.CouponAsync(await me.RequireAsync(),await Seller(true),id,b);
}
