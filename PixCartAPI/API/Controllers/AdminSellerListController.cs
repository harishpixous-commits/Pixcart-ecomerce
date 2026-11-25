using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/sellers")]
public class AdminSellerListController(IAdminSellerListBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> List([FromQuery,RegularExpression("^(draft|submitted|approved|rejected|suspended)$")]string? status=null,[FromQuery,StringLength(80)]string q="",[FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery(Name="page_size"),Range(1,100)]int size=25)=>await bal.ListAsync(await me.RequireAsync(),status,q,page,size);
}
