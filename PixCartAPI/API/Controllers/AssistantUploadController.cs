using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/assistant/uploads")]
public class AssistantUploadController(IAssistantUploadBAL bal,ICurrentUser me):ControllerBase
{
    [HttpPost(""),RequestSizeLimit(6*1024*1024)]public async Task<IActionResult> Upload(IFormFile file){using var stream=file.OpenReadStream();using var memory=new MemoryStream();var buffer=new byte[8192];int count;while(memory.Length<=5*1024*1024&&(count=await stream.ReadAsync(buffer))>0)await memory.WriteAsync(buffer.AsMemory(0,Math.Min(count,5*1024*1024+1-(int)memory.Length)));return StatusCode(201,await bal.StoreAsync(await me.RequireAsync(),file.FileName.Length>0?file.FileName:"file",file.ContentType??"",memory.ToArray()));}
    [HttpDelete("{id}")]public async Task<object> Delete(Guid id)=>await bal.DeleteAsync(await me.RequireAsync(),id);
}
