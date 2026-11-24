using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public partial class CmsAdminBAL(CmsDAL cms,CmsAdminDAL data,ISiteBAL site,IAccessBAL access,IAuditBAL audit,IMySqlDapperHelper db):ICmsAdminBAL
{
    public async Task<JsonObject> SiteAsync(UserModel user){await access.RequireAsync(user,"marketing");return await site.GetSiteAsync();}
    public async Task<JsonObject> SaveSiteAsync(UserModel user,JsonObject body)
    {await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();var saved=await site.SaveSiteAsync(body,tx.Transaction);await audit.AuditAsync(user,"storefront.site","settings","site","",tx);await tx.CommitAsync();return saved;}
    public async Task<JsonObject> SaveThemeAsync(UserModel user,string theme,JsonObject settings)
    {await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();var saved=await site.SaveThemeAsync(theme,settings,tx.Transaction);await audit.AuditAsync(user,"storefront.theme","settings","site","theme="+saved["theme"]!.GetValue<string>(),tx);await tx.CommitAsync();return saved;}
    public async Task<JsonArray> PagesAsync(UserModel user)
    {
        await access.RequireAsync(user,"marketing");var rows=(await cms.AllPagesAsync()).ToList();var list=rows.Select(p=>new JsonObject{["slug"]=p.Slug,["title"]=p.Title,["body"]=p.Body,["meta_description"]=p.MetaDescription,["is_published"]=p.IsPublished,["saved"]=true,["updated_at"]=p.UpdatedAt.ToString("o")}).ToList();var slugs=rows.Select(x=>x.Slug).ToHashSet();foreach(var(k,(title,body))in site.DefaultPages)if(!slugs.Contains(k))list.Add(new JsonObject{["slug"]=k,["title"]=title,["body"]=body,["meta_description"]="",["is_published"]=true,["saved"]=false,["updated_at"]=null});return new JsonArray(list.OrderBy(x=>x["title"]!.GetValue<string>(),StringComparer.Ordinal).Select(x=>(JsonNode)x).ToArray());
    }
    public async Task<JsonObject> SavePageAsync(UserModel user,string original,string slug,string title,string body,string description,bool published)
    {
        await access.RequireAsync(user,"marketing");var p=await cms.GetPageAsync(original);var exists=p is not null;if(p is not null&&slug!=original&&await cms.GetPageAsync(slug)is not null)throw new ConflictException("Another page uses this address","slug_taken");p??=new(){Id=Guid.NewGuid()};p.Slug=slug;p.Title=title;p.Body=body;p.MetaDescription=description;p.IsPublished=published;await using var tx=await db.BeginAsync();await data.SavePageAsync(p,exists,tx);await audit.AuditAsync(user,"storefront.page","page",slug,"",tx);await tx.CommitAsync();return new(){["ok"]=true,["slug"]=slug};
    }
    public async Task<JsonObject> DeletePageAsync(UserModel user,string slug){await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();await data.DeletePageAsync(slug,tx);await tx.CommitAsync();return new(){["ok"]=true};}
}
