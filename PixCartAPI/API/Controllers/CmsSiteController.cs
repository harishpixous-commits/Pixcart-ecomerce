using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
public partial class CmsAdminController
{
    public record ThemeIn
    {
        [Required(AllowEmptyStrings=true),StringLength(24)]public string Theme{get;init;}=null!;
        public JsonObject Settings{get;init;}=new();
    }
    [HttpGet("/api/admin/storefront/site")]public async Task<object> Site()=>await bal.SiteAsync(await me.RequireAsync());
    [HttpPut("/api/admin/storefront/site")]public async Task<object> SaveSite(JsonObject body)=>await bal.SaveSiteAsync(await me.RequireAsync(),body);
    [HttpPut("/api/admin/storefront/theme")]public async Task<object> SaveTheme(ThemeIn body)=>await bal.SaveThemeAsync(await me.RequireAsync(),body.Theme,body.Settings);
}
