using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Utils;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/media")]
public class CmsMediaController(ICmsMediaBAL bal,ICurrentUser me,IAccessBAL access,IPlatformSettingsBAL settings,AppSettings app):ControllerBase
{
    [HttpGet("")]public async Task<object> List([FromQuery,RegularExpression("^(image|video)$")]string? kind=null)=>await bal.ListAsync(await me.RequireAsync(),kind);
    [HttpPost("")]public async Task<IActionResult> Upload(IFormFile file,[FromQuery]string label="",CancellationToken ct=default)
    {
        var user=await me.RequireAsync();await access.RequireAsync(user,"marketing");var max=Math.Max(app.MaxImageBytes,(await settings.GetAsync()).Long("max_video_mb")*1024*1024);using var output=new MemoryStream();await using var input=file.OpenReadStream();var buffer=new byte[81920];while(output.Length<=max){var n=await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,max+1-output.Length)),ct);if(n==0)break;await output.WriteAsync(buffer.AsMemory(0,n),ct);}return StatusCode(201,await bal.UploadAsync(user,output.ToArray(),string.IsNullOrEmpty(label)?file.FileName:label,ct));
    }
}
