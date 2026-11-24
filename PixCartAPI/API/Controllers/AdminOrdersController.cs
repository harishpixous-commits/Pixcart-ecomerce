using System.ComponentModel.DataAnnotations;
using System.Globalization;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/orders")]
public class AdminOrdersController(IAdminOrdersBAL bal,ICurrentUser me):ControllerBase
{
    private static DateTime? Date(string? value,bool end=false){if(value is null)return null;if(!DateTime.TryParseExact(value,"yyyy-MM-dd",CultureInfo.InvariantCulture,DateTimeStyles.None,out var d))throw new AppException("Dates must be valid (YYYY-MM-DD)","invalid_date");try{return DateTime.SpecifyKind((end?d.AddDays(1):d).AddMinutes(-330),DateTimeKind.Utc);}catch(ArgumentOutOfRangeException){throw new AppException("Dates must be valid (YYYY-MM-DD)","invalid_date");}}
    [HttpGet("")]public async Task<object> List(
        [FromQuery,RegularExpression("^(pending_payment|placed|cancelled)$")]string? status=null,[FromQuery,StringLength(60)]string q="",
        [FromQuery(Name="payment_method"),RegularExpression("^(cod|online)$")]string? method=null,
        [FromQuery(Name="payment_status"),RegularExpression("^(pending|paid|cod|failed|refunded|partially_refunded)$")]string? payment=null,
        [FromQuery(Name="package_status"),RegularExpression("^(pending_payment|placed|confirmed|packed|shipped|delivered|cancelled)$")]string? package=null,
        [FromQuery(Name="seller_id")]Guid? seller=null,[FromQuery(Name="customer_id")]Guid? customer=null,
        [FromQuery(Name="date_from"),RegularExpression(@"^\d{4}-\d{2}-\d{2}$")]string? from=null,[FromQuery(Name="date_to"),RegularExpression(@"^\d{4}-\d{2}-\d{2}$")]string? to=null,
        [FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery(Name="page_size"),Range(1,100)]int size=25)=>await bal.ListAsync(await me.RequireAsync(),new(status,q,method,payment,package,seller,customer,Date(from),Date(to,true),page,size));
    [HttpGet("{id:guid}")]public async Task<object> Detail(Guid id)=>await bal.DetailAsync(await me.RequireAsync(),id);
}
