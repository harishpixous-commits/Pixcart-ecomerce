using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/dashboard")]
public class AdminDashboardController(IAdminDashboardBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> Get()=>await bal.ReadAsync(await me.RequireAsync());
}
