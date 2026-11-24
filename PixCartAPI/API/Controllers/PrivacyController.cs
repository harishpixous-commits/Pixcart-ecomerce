using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;

namespace API.Controllers;

/// <summary>Privacy rights (reference: routers/customer.py consent, export_data, delete_account).</summary>
[ApiController]
[Route("/api/account")]
[SignedIn]
public class PrivacyController(IPrivacyBAL bal, ICurrentUser current) : ControllerBase
{
    [HttpPut("consent")]
    public async Task<JsonObject> Consent([FromBody] ConsentIn body) =>
        await bal.ConsentAsync(await current.RequireAsync(), body.MarketingOptIn);

    [HttpGet("export")]
    public async Task<JsonObject> Export() => await bal.ExportAsync(await current.RequireAsync());

    [HttpDelete("")]
    public async Task<JsonObject> Delete() => await bal.DeleteAccountAsync(await current.RequireAsync());

    /// <summary>Reference: ConsentIn.</summary>
    public class ConsentIn
    {
        public bool MarketingOptIn { get; set; }
    }
}
