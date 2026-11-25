using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Model.DomainModel.Catalog;
using Utils;
using Utils.Interface;
namespace BAL;
public class SellerFeedbackBAL(SellerFeedbackDAL data,IReviewSettingsBAL settings,IReviewBAL reviews,IAuditBAL audit,AiDAL ai,IMySqlDapperHelper db):ISellerFeedbackBAL
{
    public async Task<JsonObject> ReviewsAsync(SellerModel s,int page,int? rating,bool unanswered,bool media,string q)
    {
        q=q.Trim();var total=await data.ReviewCountAsync(s.Id,rating,unanswered,media,q);var rows=(await data.ReviewsAsync(s.Id,rating,unanswered,media,q,(page-1)*20)).ToList();var cfg=await settings.GetAsync();var dist=(await data.DistributionAsync(s.Id)).ToDictionary(x=>x.Rating,x=>x.N);var reported=rows.Count>0?(await data.ReportedAsync(s.UserId,rows.Select(r=>r.Id))).ToHashSet():[];var distribution=new JsonObject();for(var k=5;k>=1;k--)distribution[k.ToString()]=dist.GetValueOrDefault(k);
        var items=new JsonArray();foreach(var r in rows)items.Add(new JsonObject{["id"]=r.Id.ToString(),["product"]=r.Product,["slug"]=r.Slug,["rating"]=r.Rating,["title"]=r.Title,["body"]=r.Body,["reply"]=r.SellerReply,["status"]=r.Status,["verified"]=r.Verified,["media"]=r.MediaStatus!="hidden"?JsonNode.Parse(r.Media):new JsonArray(),["media_status"]=r.MediaStatus,["helpful_count"]=r.HelpfulCount,["reported"]=reported.Contains(r.Id),["at"]=r.CreatedAt.ToString("o")});
        return new(){["rating_avg"]=s.RatingAvg,["rating_count"]=s.RatingCount,["distribution"]=distribution,["topics"]=cfg.Bool("topics_enabled")?await reviews.ReviewTopicsAsync(cfg["topics"] as JsonArray??[],sellerId:s.Id):new JsonArray(),["can_report"]=cfg.Bool("seller_can_report"),["report_reasons"]=new JsonObject(ReviewSettingsBAL.ReportReasons.Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Key,JsonValue.Create(x.Value)))),["items"]=items,["total"]=total,["page"]=page,["has_more"]=(long)page*20<total};
    }
    public async Task<JsonObject> ReportReviewAsync(SellerModel s,Guid id,ReviewReportIn body)
    {
        if(!(await settings.GetAsync()).Bool("seller_can_report"))throw new AppException("Reporting reviews is switched off","reports_off");var r=await data.OwnedReviewAsync(id,s.Id)??throw new NotFoundException("Review");return await reviews.FileReviewReportAsync(r,s.UserId,body);
    }
    public async Task<JsonObject> ReplyAsync(UserModel user,SellerModel s,Guid id,string reply,string? run)
    {
        _=await data.OwnedReviewAsync(id,s.Id)??throw new NotFoundException("Review");reply=reply.Trim();await using var tx=await db.BeginAsync();await data.UpdateReplyAsync(id,reply,tx);
        if(run is not null&&Guid.TryParse(run,out var rid)){var r=await ai.RunByIdAsync(rid);if(r is not null&&r.SellerId==s.Id&&r.Status=="draft")await ai.FinishRunAsync(r.Id,"applied",reply,user.Id,DateTime.UtcNow,tx);}
        await tx.CommitAsync();return new(){["ok"]=true};
    }
    public async Task<JsonObject> ProductReportsAsync(SellerModel s,string? status,int page)
    {
        var total=await data.ProductReportCountAsync(s.Id,status);var items=new JsonArray();foreach(var r in await data.ProductReportsAsync(s.Id,status,(page-1)*20))items.Add(new JsonObject{["id"]=r.Id.ToString(),["product_id"]=r.ProductId.ToString(),["product"]=r.Product,["slug"]=r.Slug,["reason"]=r.Reason,["reason_label"]=PlatformSettingsBAL.ProductReportReasons.GetValueOrDefault(r.Reason,r.Reason),["note"]=r.Note,["url"]=r.Url,["status"]=r.Status,["admin_note"]=r.AdminNote,["seller_note"]=r.SellerNote,["at"]=r.CreatedAt.ToString("o")});
        return new(){["items"]=items,["total"]=total,["page"]=page,["has_more"]=(long)page*20<total,["open"]=await data.OpenCountAsync(s.Id)};
    }
    public async Task<JsonObject> RespondAsync(UserModel user,SellerModel s,Guid id,string note)
    {await using var tx=await db.BeginAsync();_=await data.ProductReportAsync(id,s.Id,tx)??throw new NotFoundException("Report");await data.UpdateNoteAsync(id,note.Trim(),tx);await audit.AuditAsync(user,"product_report.seller_note","product_report",id,"",tx);await tx.CommitAsync();return new(){["ok"]=true};}
}
