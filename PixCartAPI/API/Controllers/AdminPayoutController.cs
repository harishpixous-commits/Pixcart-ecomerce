using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/payouts")]
public class AdminPayoutController(IAdminPayoutBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> List([FromQuery]string? status=null,[FromQuery(Name="seller_id")]Guid? seller=null,[FromQuery,Range(1,int.MaxValue)]int page=1)=>await bal.ListAsync(await me.RequireAsync(),status,seller,page);
}
