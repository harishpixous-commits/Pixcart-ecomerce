using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/seller")]
public partial class SellerHubController(ISellerHubBAL bal,IOrdersBAL orders,ICurrentUser me):ControllerBase
{
    private async Task<Model.DomainModel.SellerModel> Seller(bool approved=false)=>await orders.RequireSellerAsync(await me.RequireAsync(),approved);
    public record PrefsIn
    {
        [Required]public int? DispatchDays{get;init;}
        [Required]public bool? HolidayMode{get;init;}
        public string InvoicePrefix{get;init;}="";
        public string? DispatchCutoff{get;init;}
        private long? _free;public bool FreeSet{get;private set;}
        /// <summary>Own free-delivery amount (paise). Left out = unchanged; null = back to the marketplace one.</summary>
        public long? FreeShippingThresholdPaise{get=>_free;init{_free=value;FreeSet=true;}}
    }
    [HttpGet("preferences")]public async Task<object> Preferences()=>await bal.PreferencesOfAsync(await Seller());
    [HttpPut("preferences")]public async Task<object> Preferences(PrefsIn b)=>await bal.PreferencesAsync(await me.RequireAsync(),await Seller(),b.DispatchDays!.Value,b.HolidayMode!.Value,b.InvoicePrefix,b.DispatchCutoff,b.FreeSet,b.FreeShippingThresholdPaise);
    [HttpGet("warehouses")]public async Task<object> Warehouses()=>await bal.WarehousesAsync(await Seller());
    [HttpPost("warehouses")]public async Task<IActionResult> Warehouse([FromBody]JsonObject b)=>StatusCode(201,await bal.WarehouseAsync(await me.RequireAsync(),await Seller(true),null,b));
    [HttpPut("warehouses/{id}")]public async Task<object> Warehouse(Guid id,[FromBody]JsonObject b)=>await bal.WarehouseAsync(await me.RequireAsync(),await Seller(true),id,b);
}
