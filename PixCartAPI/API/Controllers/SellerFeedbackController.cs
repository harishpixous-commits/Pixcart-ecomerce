using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Model.DomainModel.Catalog;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/seller")]
public class SellerFeedbackController(ISellerFeedbackBAL bal,IOrdersBAL orders,ICurrentUser me):ControllerBase
{
    private async Task<Model.DomainModel.SellerModel> Seller(bool approved=false)=>await orders.RequireSellerAsync(await me.RequireAsync(),approved);
    [HttpGet("reviews")]public async Task<object> Reviews([FromQuery,Range(1,int.MaxValue)]int page=1,[FromQuery,Range(1,5)]int? rating=null,[FromQuery]bool unanswered=false,[FromQuery]bool media=false,[FromQuery,StringLength(80)]string q="")=>await bal.ReviewsAsync(await Seller(),page,rating,unanswered,media,q);
    [HttpPost("reviews/{id:guid}/report")]public async Task<object> Report(Guid id,ReviewReportIn body)=>await bal.ReportReviewAsync(await Seller(true),id,body);
    public record ReplyIn
    {
        [Required(AllowEmptyStrings=true),StringLength(2000)]public string Reply{get;init;}=null!;
        [StringLength(40)]public string? AiRunId{get;init;}
    }
    [HttpPut("reviews/{id:guid}/reply")]public async Task<object> Reply(Guid id,ReplyIn body)=>await bal.ReplyAsync(await me.RequireAsync(),await Seller(true),id,body.Reply,body.AiRunId);
    [HttpGet("product-reports")]public async Task<object> Reports([FromQuery,RegularExpression("^(open|resolved|dismissed)$")]string? status=null,[FromQuery,Range(1,int.MaxValue)]int page=1)=>await bal.ProductReportsAsync(await Seller(),status,page);
    public record NoteIn{[Required,StringLength(2000,MinimumLength=2)]public string Note{get;init;}=null!;}
    [HttpPost("product-reports/{id:guid}/respond")]public async Task<object> Respond(Guid id,NoteIn body)=>await bal.RespondAsync(await me.RequireAsync(),await Seller(),id,body.Note);
}
