using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin")]
public class AdminListsController(IAdminListsBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("customers")]public async Task<object> Customers([FromQuery,StringLength(80)]string q="",[FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery(Name="page_size"),Range(1,100)]int size=25,[FromQuery,RegularExpression("^(all|customers|sellers|staff|blocked)$")]string kind="all",[FromQuery,StringLength(30)]string tag="")=>await bal.CustomersAsync(await me.RequireAsync(),q,page,size,kind,tag);
    [HttpGet("audit")]public async Task<object> Audit([FromQuery(Name="entity_id"),StringLength(64)]string? entity=null,[FromQuery,Range(1,int.MaxValue)]int page=1)=>await bal.AuditAsync(await me.RequireAsync(),entity,page);
    [HttpGet("tickets")]public async Task<object> Tickets([FromQuery]string? status="open",[FromQuery]bool overdue=false,[FromQuery]bool grievance=false,[FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery,StringLength(60)]string q="")=>await bal.TicketsAsync(await me.RequireAsync(),Request.Query.ContainsKey("status")?Request.Query["status"].ToString():status,overdue,grievance,page,q);
}
