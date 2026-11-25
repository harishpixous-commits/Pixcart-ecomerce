using Microsoft.AspNetCore.Mvc;
using Utils;
namespace API.Controllers;
public partial class SellerHubController
{
    [HttpGet("analytics")]public async Task<object> Analytics([FromQuery]int days=30){if(days is <7 or >365)throw new AppException("Invalid analytics range","validation",422);return await bal.AnalyticsAsync(await Seller(),days);}
}
