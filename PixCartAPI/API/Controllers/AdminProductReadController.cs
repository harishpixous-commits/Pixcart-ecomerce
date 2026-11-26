using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/products")]
public class AdminProductReadController(IAdminProductReadBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> List([FromQuery,RegularExpression("^(draft|pending|approved|rejected|archived)$")]string? status="pending",[FromQuery,StringLength(100)]string q="",[FromQuery(Name="seller_id")]Guid? seller=null,[FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery(Name="page_size"),Range(1,100)]int size=25)=>await bal.ListAsync(await me.RequireAsync(),status,q,seller,page,size);
    [HttpGet("{id}")]public async Task<object> Detail(Guid id)=>await bal.DetailAsync(await me.RequireAsync(),id);
    [HttpPost("{id}/ai-check")]public async Task<object> AiCheck(Guid id)=>await bal.AiCheckAsync(await me.RequireAsync(),id);
}
