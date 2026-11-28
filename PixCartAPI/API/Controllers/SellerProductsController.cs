using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using System.ComponentModel.DataAnnotations;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/seller")]
public class SellerProductsController(ISellerProductsBAL bal,IOrdersBAL orders,ICurrentUser me,Utils.Interface.IImageUpload storage,AppSettings env,IPlatformSettingsBAL platform) : ControllerBase
{
    private async Task<Model.DomainModel.SellerModel> Seller()=>await orders.RequireSellerAsync(await me.RequireAsync(),false);
    [HttpPost("products")] public async Task<IActionResult> Create([FromBody]System.Text.Json.Nodes.JsonObject body)=>StatusCode(201,await bal.SaveAsync(await me.RequireAsync(),await Seller(),null,body));
    [HttpPut("products/{id}")] public async Task<object> Update(Guid id,[FromBody]System.Text.Json.Nodes.JsonObject body)=>await bal.SaveAsync(await me.RequireAsync(),await Seller(),id,body);
    [HttpGet("products")]
    public async Task<object> List([FromQuery]string? status,[FromQuery]string q="",[FromQuery(Name="low_stock")]bool lowStock=false,[FromQuery]int page=1,[FromQuery(Name="page_size")]int pageSize=20)
    {
        if(status!=null&&status is not ("draft" or "pending" or "approved" or "rejected" or "archived")||q.Length>100||page<1||pageSize<1||pageSize>100) throw new AppException("Invalid catalogue filter","validation",422);
        return await bal.ListAsync(await Seller(),status,q,lowStock,page,pageSize);
    }
    [HttpGet("products/import-template.csv")]
    public async Task<IActionResult> ImportTemplate() { await Seller();return File(System.Text.Encoding.UTF8.GetBytes(bal.ImportTemplate()),"text/csv; charset=utf-8","listing-upload-template.csv"); }
    [HttpPost("products/import")]
    public async Task<object> Import(IFormFile file,[FromQuery(Name="dry_run")]bool dryRun=true,CancellationToken ct=default)
    {var seller=await Seller();return await bal.ImportAsync(await me.RequireAsync(),seller,await ReadBoundedAsync(file,2*1024*1024,ct),file.FileName,dryRun);}
    [HttpGet("products/{id}")] public async Task<object> Detail(Guid id)=>await bal.DetailAsync(await Seller(),id);
    [HttpGet("listing-requirements")] public async Task<object> Requirements([FromQuery(Name="category_id")]Guid category)=>await bal.RequirementsAsync(await Seller(),category);
    [HttpGet("categories")] public async Task<object> Categories()=>await bal.CategoriesAsync(await Seller());
    [HttpGet("fees")] public async Task<object> Fees() { await Seller(); return await bal.FeesAsync(); }
    [HttpPost("products/{id}/submit")] public async Task<object> Submit(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"submit");
    [HttpPost("products/{id}/duplicate")] public async Task<IActionResult> Duplicate(Guid id)=>StatusCode(201,await bal.DuplicateAsync(await me.RequireAsync(),await Seller(),id));
    [HttpPost("products/{id}/archive")] public async Task<object> Archive(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"archive");
    [HttpPost("products/{id}/restore")] public async Task<object> Restore(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"restore");
    public record VariantPatch
    {
        [Range(1,100000000)]public long? PricePaise {get;init;}
        [Range(1,100000000)]public long? MrpPaise {get;init;}
        [Range(0,1000000)]public int? Stock {get;init;}
        public bool? IsActive {get;init;}
    }
    public record BulkEditIn{[Required,MinLength(1),MaxLength(5000)]public List<Guid> VariantIds{get;init;}=[];[Required]public string Action{get;init;}="";public int? Value{get;init;}public bool DryRun{get;init;}=true;}
    [HttpGet("variants/bulk-edit.csv"),RouteGuard("seller")] public async Task<IActionResult> BulkEditCsvDownload(){var s=await Seller();return File(System.Text.Encoding.UTF8.GetBytes(await bal.BulkEditCsvExportAsync(s)),"text/csv; charset=utf-8","my-versions.csv");}
    [HttpPost("variants/bulk-edit.csv"),RouteGuard("seller")] public async Task<object> BulkEditCsvUpload(IFormFile file,[FromQuery(Name="dry_run")]bool dryRun=true,CancellationToken ct=default){var s=await Seller();return await bal.BulkEditCsvApplyAsync(await me.RequireAsync(),s,await ReadBoundedAsync(file,1024*1024,ct),file.FileName,dryRun);}
    [HttpPost("variants/bulk-edit"),RouteGuard("seller")] public async Task<object> BulkEdit(BulkEditIn b)=>await bal.BulkEditAsync(await me.RequireAsync(),await Seller(),b.VariantIds,b.Action,b.Value,b.DryRun);
    [HttpPatch("variants/{id}")] public async Task<object> Patch(Guid id,VariantPatch b)=>await bal.PatchAsync(await Seller(),id,b.PricePaise,b.MrpPaise,b.Stock,b.IsActive);
    private static async Task<byte[]> ReadBoundedAsync(IFormFile file,long max,CancellationToken ct)
    {
        using var output=new MemoryStream();await using var input=file.OpenReadStream();var buffer=new byte[81920];
        while(output.Length<=max){var count=await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,max+1-output.Length)),ct);if(count==0)break;await output.WriteAsync(buffer.AsMemory(0,count),ct);}return output.ToArray();
    }
    [HttpPost("images")]
    public async Task<IActionResult> Image(IFormFile file,CancellationToken ct)
    {
        await Seller();var bytes=await ReadBoundedAsync(file,env.MaxImageBytes,ct);
        return StatusCode(201,new {url=await storage.SaveImageAsync(bytes,"products",ct)});
    }
    [HttpPost("videos")]
    public async Task<IActionResult> Video(IFormFile file,CancellationToken ct)
    {
        await Seller();var cfg=await platform.GetAsync();if(!cfg.Bool("feature_product_videos"))throw new AppException("Product videos are switched off on this marketplace","videos_off");
        var max=cfg.Long("max_video_mb")*1024*1024;var bytes=await ReadBoundedAsync(file,max,ct);
        return StatusCode(201,new {url=await storage.SaveVideoAsync(bytes,max,ct:ct)});
    }

}
