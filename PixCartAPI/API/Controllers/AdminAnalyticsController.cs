using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/analytics")]
public class AdminAnalyticsController(IAdminAnalyticsBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> Read([FromQuery,Range(7,365)]int days=30)=>await bal.ReadAsync(await me.RequireAsync(),days);
}
