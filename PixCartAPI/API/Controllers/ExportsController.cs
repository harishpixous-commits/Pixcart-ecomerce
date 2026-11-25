using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn]
public sealed class ExportsController(ExportsBAL exports,ICurrentUser current,IAccessBAL access,IOrdersBAL orders):ControllerBase
{
    private async Task<UserModel> Admin()
    {
        var user=await current.RequireAsync();if(!user.IsAdmin)throw new ForbiddenException("Admin access required");
        if(await access.TwoStepMissingAsync(user))throw new AppException("Turn on two-step sign-in in My account to use the admin panel. The owner requires it for all staff.","two_step_required",403);return user;
    }
    [HttpGet("/api/admin/exports")]
    public async Task<object> AdminList()=>await exports.ListAsync(await Admin(),false);
    [HttpGet("/api/seller/exports")]
    public async Task<object> SellerList(){var u=await current.RequireAsync();_=await orders.RequireSellerAsync(u,false);return await exports.ListAsync(u,true);}
    [HttpGet("/api/admin/exports/lookup/{kind}")]
    public async Task<object> AdminLookup(string kind,[FromQuery,MaxLength(60)]string q="")
    {var user=await Admin();if(!(await access.PermissionsForAsync(user)).Overlaps(["orders","reports","payouts","catalog","sellers"]))throw new ForbiddenException("Your role cannot use export filters");return await exports.LookupAsync(kind,q);}
    [HttpGet("/api/seller/exports/lookup/category")]
    public async Task<object> SellerLookup([FromQuery,MaxLength(60)]string q=""){_=await orders.RequireSellerAsync(await current.RequireAsync(),false);return await exports.LookupAsync("category",q);}
    [HttpGet("/api/admin/exports/{name}.{format}")]
    public async Task<IActionResult> AdminDownload(string name,string format,[FromQuery]ExportQuery query,CancellationToken ct)
    {
        var user=await Admin();var plan=await exports.PlanAsync(user,false,name,format,null,query.From,query.To,query.Status,query.Month,query.Extra(true),query.Columns);
        await exports.AuthorizeReadAsync(user,plan,"admin");return await Deliver(await exports.RenderAsync(user,plan,await exports.BrandAsync(),ct),ct);
    }
    [HttpGet("/api/seller/exports/{name}.{format}")]
    public async Task<IActionResult> SellerDownload(string name,string format,[FromQuery]ExportQuery query,CancellationToken ct)
    {
        var user=await current.RequireAsync();var seller=await orders.RequireSellerAsync(user,false);
        var plan=await exports.PlanAsync(user,true,name,format,seller.Id,query.From,query.To,query.Status,null,query.Extra(false),query.Columns);
        await exports.AuthorizeReadAsync(user,plan,"seller:"+seller.Id);return await Deliver(await exports.RenderAsync(user,plan,await exports.BrandAsync(),ct),ct);
    }
    [HttpPost("/api/admin/exports/bulk")]
    public async Task<IActionResult> Bulk([FromBody]ExportBulkIn body,CancellationToken ct)
    {
        var user=await Admin();var plans=new List<ExportsBAL.Plan>();
        foreach(var item in body.Items)plans.Add(await exports.PlanAsync(user,false,item.Name,item.Format,null,item.From,item.To,item.Status,item.Month,item.Extra(true),item.Columns,true));
        await exports.AuthorizeBulkAsync(user,plans);return await Deliver(await exports.BulkAsync(user,plans,await exports.BrandAsync(),ct),ct);
    }
    private async Task<IActionResult> Deliver(ExportsBAL.Download result,CancellationToken ct)
    {
        Response.Headers.CacheControl="no-store";Response.Headers["X-Content-Type-Options"]="nosniff";
        if(result.Stream is not null)return File(result.Stream,result.ContentType,result.Name);
        if(result.Bytes is not null)return File(result.Bytes,result.ContentType,result.Name);
        Response.ContentType=result.ContentType;Response.Headers.ContentDisposition="attachment; filename=\""+result.Name+"\"";
        await foreach(var chunk in result.Chunks!.WithCancellation(ct)){await Response.Body.WriteAsync(chunk,ct);await Response.Body.FlushAsync(ct);}return new EmptyResult();
    }
}
public class ExportQuery
{
    [FromQuery(Name="from"),System.Text.Json.Serialization.JsonPropertyName("from")]public DateOnly? From{get;set;}
    [FromQuery(Name="to"),System.Text.Json.Serialization.JsonPropertyName("to")]public DateOnly? To{get;set;}
    [FromQuery(Name="status"),MaxLength(30)]public string? Status{get;set;}
    [FromQuery(Name="month"),MaxLength(7)]public string? Month{get;set;}
    [FromQuery(Name="seller")]public Guid? Seller{get;set;}
    [FromQuery(Name="category")]public Guid? Category{get;set;}
    [FromQuery(Name="payment_method"),MaxLength(10)]public string? PaymentMethod{get;set;}
    [FromQuery(Name="q"),MaxLength(80)]public string? Q{get;set;}
    [FromQuery(Name="low_stock"),Range(0,100000)]public int? LowStock{get;set;}
    [FromQuery(Name="columns"),MaxLength(60)]public List<string> Columns{get;set;}=[];
    public Dictionary<string,string?> Extra(bool admin)=>new(){["seller"]=admin?Seller?.ToString():null,["category"]=Category?.ToString(),["payment_method"]=PaymentMethod,["q"]=Q,["low_stock"]=LowStock?.ToString(System.Globalization.CultureInfo.InvariantCulture)};
}

public sealed class ExportBulkIn
{
    [Required,MinLength(1),MaxLength(20)]public List<ExportBulkItem> Items{get;set;}=[];
}
public sealed class ExportBulkItem:ExportQuery
{
    [System.Text.Json.Serialization.JsonPropertyName("date_from")]
    public DateOnly? DateFromAlias{get=>null;set{From??=value;}}
    [System.Text.Json.Serialization.JsonPropertyName("date_to")]
    public DateOnly? DateToAlias{get=>null;set{To??=value;}}
    [Required,MaxLength(40)]public string Name{get;set;}="";
    [MaxLength(5)]public string Format{get;set;}="csv";
}
