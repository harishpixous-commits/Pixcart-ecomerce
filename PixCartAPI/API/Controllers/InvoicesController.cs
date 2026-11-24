using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>GST documents as PDF (reference: routers/customer.py invoice, fee_invoice, credit_note).
/// Every document is inline, private and never cached.</summary>
[ApiController]
[SignedIn]
public class InvoicesController(IInvoicesBAL bal, ICurrentUser current) : ControllerBase
{
    [HttpGet("/api/invoices/{subId:guid}.pdf")]
    public async Task<IActionResult> Invoice(Guid subId)
    {
        var (pdf, filename) = await bal.InvoicePdfAsync((await current.RequireAsync()).Id, subId);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.ContentDisposition = $"inline; filename=\"{filename}\"";
        return File(pdf, "application/pdf");
    }

    [HttpGet("/api/orders/{orderId:guid}/fee-invoice.pdf")]
    public async Task<IActionResult> FeeInvoice(Guid orderId)
    {
        var (pdf, filename) = await bal.FeeInvoicePdfAsync((await current.RequireAsync()).Id, orderId);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.ContentDisposition = $"inline; filename=\"{filename}\"";
        return File(pdf, "application/pdf");
    }

    [HttpGet("/api/credit-notes/{returnId:guid}.pdf")]
    public async Task<IActionResult> CreditNote(Guid returnId)
    {
        var (pdf, filename) = await bal.CreditNotePdfAsync((await current.RequireAsync()).Id, returnId);
        Response.Headers.CacheControl = "private, no-store";
        Response.Headers.ContentDisposition = $"inline; filename=\"{filename}\"";
        return File(pdf, "application/pdf");
    }
}
