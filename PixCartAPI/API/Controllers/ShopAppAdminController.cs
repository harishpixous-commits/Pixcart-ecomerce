using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/shop-app")]
public class ShopAppAdminController(IShopAppAdminBAL bal,IAccessBAL access,ICurrentUser me):ControllerBase
{
    [HttpPost("")]public async Task<object> Upload(IFormFile file,[FromQuery,StringLength(20)]string version="",CancellationToken ct=default)
    {var user=await me.RequireAsync();await access.RequireAsync(user,"settings");const long max=120*1024*1024;using var bytes=new MemoryStream();await using var input=file.OpenReadStream();var buffer=new byte[81920];while(bytes.Length<=max){var n=await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,max+1-bytes.Length)),ct);if(n==0)break;await bytes.WriteAsync(buffer.AsMemory(0,n),ct);}return await bal.UploadAsync(user,bytes.ToArray(),version,ct);}
}
