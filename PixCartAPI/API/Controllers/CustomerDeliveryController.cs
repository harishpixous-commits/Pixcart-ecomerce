using BAL.Interface;
using API.Infrastructure;
using BAL;
using Microsoft.AspNetCore.Mvc;
using System.ComponentModel.DataAnnotations;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/orders")]
public class CustomerDeliveryController(ICustomerDeliveryBAL bal,ICurrentUser me):ControllerBase
{
    public record RatingIn
    {
        [Required]public Guid? SubOrderId{get;init;}
        [Required,Range(1,5)]public int? Rating{get;init;}
        [StringLength(500)]public string Comment{get;init;}="";
    }
    public record ComplaintIn
    {
        [Required]public Guid? SubOrderId{get;init;}
        [Required,RegularExpression("^(late|rude|damaged|not_received|extra_money|other)$")]public string Category{get;init;}="";
        [StringLength(1000)]public string Text{get;init;}="";
    }
    [HttpPost("{id}/delivery-rating")]public async Task<object> Rate(Guid id,RatingIn b)=>await bal.RateAsync(await me.RequireAsync(),id,b.SubOrderId!.Value,b.Rating!.Value,b.Comment);
    [HttpPost("{id}/delivery-complaint")]public async Task<IActionResult> Complaint(Guid id,ComplaintIn b)=>StatusCode(201,await bal.ComplainAsync(await me.RequireAsync(),id,b.SubOrderId!.Value,b.Category,b.Text));
    [HttpGet("{id}/delivery-proof/{sub}")]public async Task<IActionResult> Proof(Guid id,Guid sub){var(data,media)=await bal.ProofAsync(await me.RequireAsync(),id,sub);Response.Headers.CacheControl="private, no-store";Response.Headers["X-Content-Type-Options"]="nosniff";return File(data,media);}
}
