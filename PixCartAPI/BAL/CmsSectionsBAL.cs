using System.Text.Json.Nodes;
using Model.DomainModel;
using Utils;
using BAL.Interface;
namespace BAL
{
public partial class CmsAdminBAL
{
    public async Task<JsonObject> SectionsAsync(UserModel user)
    {
        await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();var rows=(await data.SectionsAsync(tx)).ToList();if(rows.Count==0)
        {var now=DateTime.UtcNow;var i=0;foreach(var(kind,title,config)in Cms.DefaultSections()){var s=new HomeSectionModel{Id=Guid.NewGuid(),Kind=kind,Title=title,Config=config.ToJsonString(),Position=i*10,Device="all",IsActive=true,CreatedAt=now.AddTicks(i*10),UpdatedAt=now};await data.InsertSectionAsync(s,tx);rows.Add(s);i++;}}
        await tx.CommitAsync();return new(){["kinds"]=new JsonObject(site.SectionKinds.Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Key,JsonValue.Create(x.Value)))),["items"]=new JsonArray(rows.Select(x=>(JsonNode)site.SectionOut(x)).ToArray())};
    }
    public async Task<JsonObject> SaveSectionAsync(UserModel user,Guid? id,HomeSectionModel body)
    {
        await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();var rows=(await data.SectionsAsync(tx)).ToList();var old=id is null?null:rows.FirstOrDefault(x=>x.Id==id)??throw new NotFoundException("Section");var kind=old?.Kind??body.Kind;var cfg=site.ValidateSection(kind,JsonNode.Parse(body.Config) as JsonObject);body.Kind=kind;body.Config=cfg.ToJsonString();body.Id=id??Guid.NewGuid();
        if(old is null){body.Position=rows.Count>0?rows.Max(x=>x.Position)+10:10;body.CreatedAt=body.UpdatedAt=DateTime.UtcNow;await data.InsertSectionAsync(body,tx);await audit.AuditAsync(user,"storefront.section_add","section",kind,"",tx);}else{body.Position=old.Position;await data.UpdateSectionAsync(body,tx);}await tx.CommitAsync();return site.SectionOut(body);
    }
    public async Task<JsonObject> DeleteSectionAsync(UserModel user,Guid id)
    {await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();if((await data.SectionsAsync(tx)).Any(x=>x.Id==id)){await data.DeleteSectionAsync(id,tx);await audit.AuditAsync(user,"storefront.section_delete","section",id,"",tx);}await tx.CommitAsync();return new(){["ok"]=true};}
    public async Task<JsonObject> ReorderAsync(UserModel user,Guid[] ids)
    {await access.RequireAsync(user,"marketing");await using var tx=await db.BeginAsync();for(var i=0;i<ids.Length;i++)await data.PositionAsync(ids[i],(i+1)*10,tx);await tx.CommitAsync();return new(){["ok"]=true};}
}
}
