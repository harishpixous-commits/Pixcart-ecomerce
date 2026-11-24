using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin")]
public class NotificationAdminController(INotificationAdminBAL bal,ICurrentUser me):ControllerBase
{
    [HttpGet("coupons")]public async Task<object> Coupons()=>await bal.CouponsAsync(await me.RequireAsync());
    [HttpGet("notifications/templates")]public async Task<object> Templates()=>await bal.TemplatesAsync(await me.RequireAsync());
    public record TemplateIn
    {
        [StringLength(200)]public string Subject{get;init;}="";
        [Required(AllowEmptyStrings=true),StringLength(5000)]public string Body{get;init;}=null!;
        [StringLength(80)]public string ProviderTemplate{get;init;}="";
        public bool IsActive{get;init;}=true;
    }
    [HttpPut("notifications/templates/{evt}/{channel}")]public async Task<object> Save(string evt,[RegularExpression("^(inapp|email|sms|whatsapp)$")]string channel,TemplateIn b)=>await bal.SaveAsync(await me.RequireAsync(),evt,channel,b.Subject,b.Body,b.ProviderTemplate,b.IsActive);
}
