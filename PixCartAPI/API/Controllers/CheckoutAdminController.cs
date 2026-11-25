using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/checkout")]
public class CheckoutAdminController(ICheckoutAdminBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> Read()=>await bal.ReadAsync(await me.RequireAsync());
    [HttpPut("")]public async Task<object> Save(JsonObject body)=>await bal.SaveAsync(await me.RequireAsync(),body);
    [HttpPost("preview")]public async Task<object> Preview(JsonObject body)=>await bal.PreviewAsync(await me.RequireAsync(),body);
}
