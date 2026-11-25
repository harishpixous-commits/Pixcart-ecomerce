using API.Infrastructure;
using BAL;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.CustomeAttributes;
using Model.DomainModel.Auth;
using Utils;
namespace API.Controllers;
[ApiController, SignedIn, Route("/api/seller")]
public class SellerOnboardingController(ISellerOnboardingBAL bal, ICurrentUser current, AppSettings settings) : ControllerBase
{
    public record RegisterIn { [Present, Len(3,80)] public string DisplayName { get; init; } = ""; }
    public record StoreIn
    {
        [Present, Len(3,80)] public string DisplayName { get; init; } = "";
        [Len(0,2000)] public string Description { get; init; } = "";
        [Present, Email] public string ContactEmail { get; init; } = "";
        [Present, Mobile] public string ContactPhone { get; init; } = "";
    }
    [HttpPost("register")] public async Task<IActionResult> Register(RegisterIn b) => StatusCode(201, await bal.RegisterAsync(await current.RequireAsync(), b.DisplayName));
    [HttpGet("me")] public async Task<object> Me() => await bal.MeAsync(await current.RequireAsync());
    [HttpPut("profile")] public async Task<object> Profile(SellerProfileIn b) => await bal.ProfileAsync(await current.RequireAsync(), b);
    [HttpPut("store")] public async Task<object> Store(StoreIn b) => await bal.StoreAsync(await current.RequireAsync(), b.DisplayName,b.Description,b.ContactEmail,b.ContactPhone);
    [HttpPut("pickup-address")] public async Task<object> Pickup(SellerPickupIn b) => await bal.PickupAsync(await current.RequireAsync(), b);
    [HttpPut("bank")] public async Task<object> Bank(SellerBankIn b) => await bal.BankAsync(await current.RequireAsync(), b);
    [HttpPut("grievance-officer")] public async Task<object> Grievance(SellerGrievanceIn b) => await bal.GrievanceAsync(await current.RequireAsync(), b);
    [HttpPost("submit")] public async Task<object> Submit() => await bal.SubmitAsync(await current.RequireAsync());
    [HttpPost("documents/{kind}")]
    public async Task<object> Upload(string kind, IFormFile file, CancellationToken ct)
    {
        var user = await current.RequireAsync();
        await bal.OwnAsync(user);
        using var bytes = new MemoryStream();
        await using var input = file.OpenReadStream();
        var buffer = new byte[81920];
        while (bytes.Length <= settings.MaxDocumentBytes)
        {
            var read = await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length, settings.MaxDocumentBytes + 1 - bytes.Length)), ct);
            if (read == 0) break;
            await bytes.WriteAsync(buffer.AsMemory(0,read),ct);
        }
        return await bal.UploadAsync(user,kind,bytes.ToArray(),file.FileName.Length > 0 ? file.FileName : kind,ct);
    }
    [HttpGet("documents/{kind}")]
    public async Task<IActionResult> Download(string kind,CancellationToken ct)
    {
        var d = await bal.DownloadAsync(await current.RequireAsync(),kind,ct);
        Response.Headers.CacheControl = "private, no-store"; Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers.ContentDisposition = $"inline; filename=\"{d.Name}\"";
        return File(d.Bytes,d.Type);
    }
    [HttpGet("/api/admin/sellers/{sellerId:guid}/documents/{kind}")]
    public async Task<IActionResult> AdminDocument(Guid sellerId,string kind,CancellationToken ct)
    {
        var d = await bal.AdminDocumentAsync(await current.RequireAsync(),sellerId,kind,ct);
        Response.Headers.CacheControl = "private, no-store"; Response.Headers.XContentTypeOptions = "nosniff";
        Response.Headers.ContentDisposition = $"inline; filename=\"{d.Name}\"";
        return File(d.Bytes,d.Type);
    }

}
