using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class ShopAppAdminBAL(IAccessBAL access,IImageUpload storage,IPlatformSettingsBAL settings,IAuditBAL audit,IMySqlDapperHelper db):IShopAppAdminBAL
{
    public async Task<JsonObject> UploadAsync(UserModel user,byte[] bytes,string version,CancellationToken ct)
    {await access.RequireAsync(user,"settings");version=version.Trim();if(!Regex.IsMatch(version,@"^[0-9A-Za-z.\-+ ]{0,20}$"))throw new AppException("Use a version like 1.0.3","invalid_version");var name="pixcart-shop"+(version.Length>0?"-"+Regex.Replace(version,"[^0-9A-Za-z.]+","-"):"");var url=await storage.SaveAppPackageAsync(bytes,120*1024*1024,name,ct);var updates=new JsonObject{["shop_android_apk_url"]=url};if(version.Length>0)updates["shop_app_version"]=version;var clean=settings.Validate(updates);await using var tx=await db.BeginAsync();await settings.MergeValidatedAsync(clean,tx);await audit.AuditAsync(user,"settings.shop_app_upload","settings","marketplace",$"{(version.Length>0?version:"no version")} {bytes.Length/1024} KB",tx);await tx.CommitAsync();settings.InvalidateCache();return new(){["settings"]=await settings.GetAsync(),["size"]=bytes.Length};}
}
