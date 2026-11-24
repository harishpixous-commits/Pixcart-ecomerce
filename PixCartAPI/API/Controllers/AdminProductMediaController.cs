using System.ComponentModel.DataAnnotations;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace API.Controllers;
[ApiController,SignedIn,Route("/api/admin/products")]
public class AdminProductMediaController(IAdminProductMediaBAL bal,ICurrentUser me,IAccessBAL access,IImageUpload storage,IPlatformSettingsBAL settings,AppSettings app):ControllerBase
{
    public record ImagesIn{[Required,MinLength(1),MaxLength(8)]public string[] Images{get;init;}=null!;}
    public record VideoIn
    {
        [Required]public string Url{get;init;}=null!;
        public string PosterUrl{get;init;}="";
        [StringLength(120)]public string Title{get;init;}="";
        [Range(0,3600)]public int DurationS{get;init;}
        public ProductVideoModel Model()=>new(){Url=Url,PosterUrl=PosterUrl,Title=Title,DurationS=DurationS};
    }
    public record VideosIn{[MaxLength(10)]public VideoIn[] Videos{get;init;}=[];}
    [HttpPut("{id:guid}/images")]public async Task<object> Images(Guid id,ImagesIn body)=>await bal.SaveAsync(await me.RequireAsync(),id,body.Images,null);
    [HttpPut("{id:guid}/videos")]public async Task<object> Videos(Guid id,VideosIn body)=>await bal.SaveAsync(await me.RequireAsync(),id,null,body.Videos.Select(v=>v.Model()).ToArray());
    private static async Task<byte[]> Bytes(IFormFile file,long max,CancellationToken ct){using var output=new MemoryStream();await using var input=file.OpenReadStream();var buffer=new byte[81920];while(output.Length<=max){var n=await input.ReadAsync(buffer.AsMemory(0,(int)Math.Min(buffer.Length,max+1-output.Length)),ct);if(n==0)break;await output.WriteAsync(buffer.AsMemory(0,n),ct);}return output.ToArray();}
    [HttpPost("images")]public async Task<IActionResult> Image(IFormFile file,CancellationToken ct){await access.RequireAsync(await me.RequireAsync(),"catalog");return StatusCode(201,new{url=await storage.SaveImageAsync(await Bytes(file,app.MaxImageBytes,ct),"products",ct)});}
    [HttpPost("videos")]public async Task<IActionResult> Video(IFormFile file,CancellationToken ct){await access.RequireAsync(await me.RequireAsync(),"catalog");var max=(await settings.GetAsync()).Long("max_video_mb")*1024*1024;return StatusCode(201,new{url=await storage.SaveVideoAsync(await Bytes(file,max,ct),max,ct:ct)});}
}
