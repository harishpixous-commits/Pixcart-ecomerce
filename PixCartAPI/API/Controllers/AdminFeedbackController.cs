using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using DAL;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin")]
public class AdminFeedbackController(IAdminFeedbackBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("reviews")]public async Task<object> Reviews([FromQuery,RegularExpression("^(published|pending|hidden)$")]string? status=null,[FromQuery]int? rating=null,[FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery,StringLength(80)]string q="",[FromQuery]bool reported=false,[FromQuery]bool media=false,[FromQuery(Name="media_pending")]bool pending=false,[FromQuery(Name="seller_id")]Guid? seller=null)=>await bal.ReviewsAsync(await me.RequireAsync(),new(status,rating,reported,media,pending,seller,q.Trim(),(page-1)*30),page);
    [HttpGet("review-settings")]public async Task<object> Settings()=>await bal.SettingsAsync(await me.RequireAsync());
    [HttpPut("review-settings")]public async Task<object> Settings(JsonObject body)=>await bal.SettingsAsync(await me.RequireAsync(),body);
    [HttpGet("product-reports")]public async Task<object> Reports([FromQuery,RegularExpression("^(open|resolved|dismissed)$")]string? status="open",[FromQuery]string? reason=null,[FromQuery,StringLength(80)]string q="",[FromQuery(Name="seller_id")]Guid? seller=null,[FromQuery,Range(1,int.MaxValue)]int page=1)=>await bal.ReportsAsync(await me.RequireAsync(),new(status,reason,seller,q.Trim(),(page-1)*30),page);
    public record ResolveIn
    {
        [Required,RegularExpression("^(resolved|dismissed)$")]public string Status{get;init;}=null!;
        [StringLength(2000)]public string AdminNote{get;init;}="";
        public bool TakeDown{get;init;}
        public bool NotifySeller{get;init;}=true;
    }
    [HttpPost("product-reports/{id}")]public async Task<object> Resolve(Guid id,ResolveIn b)=>await bal.ResolveAsync(await me.RequireAsync(),id,b.Status,b.AdminNote,b.TakeDown,b.NotifySeller);
}
