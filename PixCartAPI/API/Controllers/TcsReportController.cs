using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/reports/tcs")]
public class TcsReportController(ITcsReportBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("")]public async Task<object> Get([FromQuery,Required,RegularExpression(@"^\d{4}-(0[1-9]|1[0-2])$")]string month)=>await bal.ReadAsync(await me.RequireAsync(),month);
}
