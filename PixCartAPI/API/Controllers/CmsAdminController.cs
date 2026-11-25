using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/storefront/pages")]
public partial class CmsAdminController(ICmsAdminBAL bal,ICurrentUser me):ControllerBase
{
    public record PageIn
    {
        [Required,StringLength(80,MinimumLength=2),RegularExpression("^[a-z0-9\\-]+$")]public string Slug{get;init;}=null!;
        [Required,StringLength(160,MinimumLength=2)]public string Title{get;init;}=null!;
        [Required(AllowEmptyStrings=true),StringLength(100000)]public string Body{get;init;}=null!;
        [StringLength(300)]public string MetaDescription{get;init;}="";
        public bool IsPublished{get;init;}=true;
    }
    [HttpGet("")]public async Task<object> Pages()=>await bal.PagesAsync(await me.RequireAsync());
    [HttpPut("{slug}")]public async Task<object> Save(string slug,PageIn b)=>await bal.SavePageAsync(await me.RequireAsync(),slug,b.Slug,b.Title,b.Body,b.MetaDescription,b.IsPublished);
    [HttpDelete("{slug}")]public async Task<object> Delete(string slug)=>await bal.DeletePageAsync(await me.RequireAsync(),slug);
}
