using API.Infrastructure;
using Microsoft.AspNetCore.Mvc;
using System.ComponentModel.DataAnnotations;
using Utils;
namespace API.Controllers;
public partial class SellerHubController
{
    public record AdjustIn
    {
        [Required]public Guid? VariantId{get;init;}
        [Required]public Guid? WarehouseId{get;init;}
        [Required]public string Mode{get;init;}="";
        [Required,Range(0,1000000)]public int? Quantity{get;init;}
        [StringLength(300)]public string Note{get;init;}="";
    }
    public record TransferIn
    {
        [Required]public Guid? VariantId{get;init;}
        [Required]public Guid? FromWarehouseId{get;init;}
        [Required]public Guid? ToWarehouseId{get;init;}
        [Required,Range(1,1000000)]public int? Quantity{get;init;}
    }
    [HttpGet("inventory")]
    public async Task<object> Inventory([FromQuery]string q="",[FromQuery(Name="low_stock")]bool low=false,[FromQuery]int page=1)
    {if(q.Length>100||page<1)throw new AppException("Invalid inventory filter","validation",422);return await bal.InventoryAsync(await Seller(),q,low,page);}
    [HttpPost("inventory/adjust")]
    public async Task<object> Adjust(AdjustIn b)
    {if(b.Mode is not ("set" or "add" or "remove"))throw new AppException("Invalid adjustment mode","validation",422);return await bal.AdjustAsync(await me.RequireAsync(),await Seller(),b.VariantId!.Value,b.WarehouseId!.Value,b.Mode,b.Quantity!.Value,b.Note);}
    [HttpPost("inventory/transfer")]
    public async Task<object> Transfer(TransferIn b)=>await bal.TransferAsync(await me.RequireAsync(),await Seller(),b.VariantId!.Value,b.FromWarehouseId!.Value,b.ToWarehouseId!.Value,b.Quantity!.Value);
    [HttpGet("inventory/{id:guid}/movements")]
    public async Task<object> Movements(Guid id)=>await bal.MovementsAsync(await Seller(),id);
    [HttpPost("inventory/import")]
    public async Task<object> ImportStock(IFormFile file,CancellationToken ct)
    {var seller=await Seller();using var bytes=new MemoryStream();await using var input=file.OpenReadStream();var buffer=new byte[81920];while(bytes.Length<=2*1024*1024){var n=await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,2*1024*1024+1-bytes.Length)),ct);if(n==0)break;await bytes.WriteAsync(buffer.AsMemory(0,n),ct);}return await bal.ImportStockAsync(await me.RequireAsync(),seller,bytes.ToArray());}
}
