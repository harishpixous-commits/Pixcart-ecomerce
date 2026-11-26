using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/seller")]
public class SellerDocumentsController(IOrdersBAL orders,IInvoicesBAL invoices,IIntegrationBAL integrations,ICurrentUser me):ControllerBase
{
    [HttpGet("shipping")]public async Task<object> Shipping(){_=await orders.RequireSellerAsync(await me.RequireAsync(),false);var cfg=await integrations.GetAsync();return new{provider=cfg.ShippingProvider=="shiprocket"&&cfg.ShiprocketEmail.Length>0&&cfg.ShiprocketPassword.Length>0?"shiprocket":"manual"};}
    [HttpGet("orders/{id}/invoice.pdf")]public async Task<IActionResult> Invoice(Guid id){var s=await orders.RequireSellerAsync(await me.RequireAsync(),false);var(pdf,filename)=await invoices.SellerInvoicePdfAsync(s.Id,id);Response.Headers.CacheControl="private, no-store";Response.Headers.ContentDisposition=$"inline; filename=\"{filename}\"";return File(pdf,"application/pdf");}
    [HttpGet("returns/{id}/credit-note.pdf")]public async Task<IActionResult> Credit(Guid id){var s=await orders.RequireSellerAsync(await me.RequireAsync(),false);var(pdf,filename)=await invoices.SellerCreditNotePdfAsync(s.Id,id);Response.Headers.ContentDisposition=$"inline; filename=\"{filename}\"";return File(pdf,"application/pdf");}
}
