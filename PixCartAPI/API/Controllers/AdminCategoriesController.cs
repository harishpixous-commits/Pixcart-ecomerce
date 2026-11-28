using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/categories")]
public class AdminCategoriesController(IAdminCategoriesBAL bal,ICurrentUser me):ControllerBase
{
    public record CategoryIn
    {
        [Required,StringLength(80,MinimumLength=2)]public string Name{get;init;}=null!;
        public Guid? ParentId{get;init;}
        [StringLength(400)]public string ImageUrl{get;init;}="";
        [Required,Range(0,5000)]public int? CommissionBps{get;init;}
        [Required]public int? DefaultGstBps{get;init;}
        [Range(0,10000)]public int Position{get;init;}
        public bool IsActive{get;init;}=true;
        [MaxLength(20)]public string[] RequiredDetails{get;init;}=[];
        [Range(0,30)]public int ReturnWindowDays{get;init;}=7;
        [Range(0,30)]public int MinReturnWindowDays{get;init;}
        [StringLength(2000)]public string SizeGuide{get;init;}="";
        public CategoryModel Model()=>new(){Name=Name,ParentId=ParentId,ImageUrl=ImageUrl,CommissionBps=CommissionBps!.Value,DefaultGstBps=DefaultGstBps!.Value,Position=Position,IsActive=IsActive,RequiredDetails=new JsonArray(RequiredDetails.Select(x=>(JsonNode)JsonValue.Create(x)).ToArray()).ToJsonString(),ReturnWindowDays=ReturnWindowDays,MinReturnWindowDays=MinReturnWindowDays,SizeGuide=SizeGuide??""};
    }
    [HttpGet("requirements")]public async Task<object> Requirements()=>await bal.RequirementsAsync(await me.RequireAsync());
    [HttpGet("")]public async Task<object> List()=>await bal.ListAsync(await me.RequireAsync());
    [HttpPost("")]public async Task<IActionResult> Add(CategoryIn body)=>StatusCode(201,await bal.SaveAsync(await me.RequireAsync(),null,body.Model()));
    [HttpPut("{id}")]public async Task<object> Save(Guid id,CategoryIn body)=>await bal.SaveAsync(await me.RequireAsync(),id,body.Model());
}
