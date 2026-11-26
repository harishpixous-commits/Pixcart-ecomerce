using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
namespace API.Controllers;
public partial class CmsAdminController
{
    public record SectionIn
    {
        [Required(AllowEmptyStrings=true)]public string Kind{get;init;}=null!;
        [StringLength(120)]public string Title{get;init;}="";
        public JsonObject Config{get;init;}=new();
        public bool IsActive{get;init;}=true;
        [RegularExpression("^(all|mobile|desktop)$")]public string Device{get;init;}="all";
        public DateTime? StartsAt{get;init;}
        public DateTime? EndsAt{get;init;}
        public HomeSectionModel Model()=>new(){Kind=Kind,Title=Title,Config=Config.ToJsonString(),IsActive=IsActive,Device=Device,StartsAt=StartsAt,EndsAt=EndsAt};
    }
    [HttpGet("/api/admin/storefront/sections")]public async Task<object> Sections()=>await bal.SectionsAsync(await me.RequireAsync());
    [HttpPost("/api/admin/storefront/sections")]public async Task<IActionResult> AddSection(SectionIn b)=>StatusCode(201,await bal.SaveSectionAsync(await me.RequireAsync(),null,b.Model()));
    [HttpPut("/api/admin/storefront/sections/{id}")]public async Task<object> SaveSection(Guid id,SectionIn b)=>await bal.SaveSectionAsync(await me.RequireAsync(),id,b.Model());
    [HttpDelete("/api/admin/storefront/sections/{id}")]public async Task<object> DeleteSection(Guid id)=>await bal.DeleteSectionAsync(await me.RequireAsync(),id);
    public record OrderIn{[Required]public Guid[] Ids{get;init;}=null!;}
    [HttpPut("/api/admin/storefront/sections-order")]public async Task<object> Reorder(OrderIn b)=>await bal.ReorderAsync(await me.RequireAsync(),b.Ids);
}
