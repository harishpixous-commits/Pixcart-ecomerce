using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/payouts")]
public class AdminPayoutController(IAdminPayoutBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> List([FromQuery]string? status=null,[FromQuery(Name="seller_id")]Guid? seller=null,[FromQuery,Range(1,int.MaxValue)]int page=1)=>await bal.ListAsync(await me.RequireAsync(),status,seller,page);
    [HttpPost("{id:guid}/send")]public async Task<object> Send(Guid id)=>await bal.SendAsync(await me.RequireAsync(),id);
    [HttpPost("run")]public async Task<object> Run()=>await bal.RunAsync(await me.RequireAsync());
    [HttpGet("bank-file.csv")]public async Task<IActionResult> BankFile(){var(csv,name)=await bal.BankFileAsync(await me.RequireAsync());Response.Headers.CacheControl="no-store";return File(System.Text.Encoding.UTF8.GetBytes(csv),"text/csv; charset=utf-8",name);}
    public sealed class PaidIn{[Required,MinLength(6),MaxLength(40),RegularExpression("^[A-Za-z0-9]+$")]public string Utr{get;set;}="";}
    [HttpPost("{id:guid}/use-current-bank")]public async Task<object> Confirm(Guid id)=>await bal.ChangeAsync(await me.RequireAsync(),id,"use-current-bank");
    [HttpPost("{id:guid}/cancel")]public async Task<object> Cancel(Guid id)=>await bal.ChangeAsync(await me.RequireAsync(),id,"cancel");
    [HttpPost("{id:guid}/paid")]public async Task<object> Paid(Guid id,PaidIn body)=>await bal.ChangeAsync(await me.RequireAsync(),id,"paid",body.Utr);
}
