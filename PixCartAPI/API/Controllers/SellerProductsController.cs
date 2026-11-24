using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using System.ComponentModel.DataAnnotations;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/seller")]
public class SellerProductsController(ISellerProductsBAL bal,IOrdersBAL orders,ICurrentUser me) : ControllerBase
{
    private async Task<Model.DomainModel.SellerModel> Seller()=>await orders.RequireSellerAsync(await me.RequireAsync(),false);
    [HttpPost("products")] public async Task<IActionResult> Create([FromBody]System.Text.Json.Nodes.JsonObject body)=>StatusCode(201,await bal.SaveAsync(await me.RequireAsync(),await Seller(),null,body));
    [HttpPut("products/{id:guid}")] public async Task<object> Update(Guid id,[FromBody]System.Text.Json.Nodes.JsonObject body)=>await bal.SaveAsync(await me.RequireAsync(),await Seller(),id,body);
    [HttpGet("products")]
    public async Task<object> List([FromQuery]string? status,[FromQuery]string q="",[FromQuery(Name="low_stock")]bool lowStock=false,[FromQuery]int page=1,[FromQuery(Name="page_size")]int pageSize=20)
    {
        if(status!=null&&status is not ("draft" or "pending" or "approved" or "rejected" or "archived")||q.Length>100||page<1||pageSize<1||pageSize>100) throw new AppException("Invalid catalogue filter","validation",422);
        return await bal.ListAsync(await Seller(),status,q,lowStock,page,pageSize);
    }
    [HttpGet("products/{id:guid}")] public async Task<object> Detail(Guid id)=>await bal.DetailAsync(await Seller(),id);
    [HttpGet("listing-requirements")] public async Task<object> Requirements([FromQuery(Name="category_id")]Guid category)=>await bal.RequirementsAsync(await Seller(),category);
    [HttpGet("categories")] public async Task<object> Categories()=>await bal.CategoriesAsync(await Seller());
    [HttpGet("fees")] public async Task<object> Fees() { await Seller(); return await bal.FeesAsync(); }
    [HttpPost("products/{id:guid}/submit")] public async Task<object> Submit(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"submit");
    [HttpPost("products/{id:guid}/archive")] public async Task<object> Archive(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"archive");
    [HttpPost("products/{id:guid}/restore")] public async Task<object> Restore(Guid id)=>await bal.LifecycleAsync(await me.RequireAsync(),await Seller(),id,"restore");
    public record VariantPatch
    {
        [Range(1,100000000)]public long? PricePaise {get;init;}
        [Range(1,100000000)]public long? MrpPaise {get;init;}
        [Range(0,1000000)]public int? Stock {get;init;}
        public bool? IsActive {get;init;}
    }
    [HttpPatch("variants/{id:guid}")] public async Task<object> Patch(Guid id,VariantPatch b)=>await bal.PatchAsync(await Seller(),id,b.PricePaise,b.MrpPaise,b.Stock,b.IsActive);
}
