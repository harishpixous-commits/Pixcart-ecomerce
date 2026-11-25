using Microsoft.AspNetCore.Mvc;
using Utils;
namespace API.Controllers;
public partial class SellerHubController
{
    [HttpGet("payouts")]public async Task<object> Payouts()=>await bal.PayoutsAsync(await Seller());
    [HttpGet("ledger")]public async Task<object> Ledger([FromQuery]int page=1){if(page<1)throw new AppException("Invalid page","validation",422);return await bal.LedgerAsync(await Seller(),page);}
}
