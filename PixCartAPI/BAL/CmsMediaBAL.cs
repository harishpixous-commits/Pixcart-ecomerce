using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class CmsMediaBAL(CmsMediaDAL data,IAccessBAL access,IImageUpload storage,IPlatformSettingsBAL settings,IAuditBAL audit,IMySqlDapperHelper db):ICmsMediaBAL
{
    private static JsonObject Out(MediaAssetModel m)=>new(){["id"]=m.Id.ToString(),["url"]=m.Url,["label"]=m.Label,["at"]=m.CreatedAt.ToString("o"),["kind"]=Regex.IsMatch(m.Url,@"\.(mp4|webm)([?#].*)?$",RegexOptions.IgnoreCase)?"video":"image"};
    public async Task<JsonArray> ListAsync(UserModel user,string? kind){await access.RequireAsync(user,"marketing");return new((await data.ListAsync(kind)).Select(x=>(JsonNode)Out(x)).ToArray());}
    public async Task<JsonObject> UploadAsync(UserModel user,byte[] bytes,string label,CancellationToken ct)
    {
        await access.RequireAsync(user,"marketing");var video=bytes.Length>12&&bytes.AsSpan(4,4).SequenceEqual("ftyp"u8)&&!new[]{"avif","avis","heic","heix","heim","heis","hevc","hevx","mif1","msf1"}.Contains(System.Text.Encoding.ASCII.GetString(bytes,8,4))||bytes.Length>=4&&bytes.AsSpan(0,4).SequenceEqual(new byte[]{0x1A,0x45,0xDF,0xA3});
        var limit=(await settings.GetAsync()).Long("max_video_mb")*1024*1024;var url=video?await storage.SaveVideoAsync(bytes,limit,ct:ct):await storage.SaveImageAsync(bytes,"products",ct);var m=new MediaAssetModel{Id=Guid.NewGuid(),Url=url,Label=label.Length>120?label[..120]:label,CreatedAt=DateTime.UtcNow};var output=Out(m);await using var tx=await db.BeginAsync();await data.InsertAsync(m,tx);await audit.AuditAsync(user,"storefront.media_upload","media",m.Id,output["kind"]!.GetValue<string>(),tx);await tx.CommitAsync();return output;
    }
}
