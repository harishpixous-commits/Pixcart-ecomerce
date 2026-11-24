using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;
public class AdminFeedbackBAL(AdminFeedbackDAL data,IAccessBAL access,IReviewSettingsBAL reviews,IPlatformSettingsBAL platform,CatalogSupportDAL support,INotifyBAL notify,IAuditBAL audit,IMySqlDapperHelper db):IAdminFeedbackBAL
{
    public async Task<JsonObject> ReviewsAsync(UserModel user,AdminReviewQuery q,int page)
    {
        await access.RequireAsync(user,"catalog");var total=await data.ReviewsCountAsync(q);var rows=(await data.ReviewsAsync(q)).ToList();var reports=rows.Count==0?new List<ReviewReportModel>():(await data.OpenReportsAsync(rows.Select(x=>x.Id).ToArray())).ToList();var counts=(await data.ReviewCountsAsync()).ToDictionary(x=>x.Status,x=>x.N);var items=new JsonArray();
        foreach(var r in rows)items.Add(new JsonObject{["id"]=r.Id.ToString(),["product"]=r.Product,["slug"]=r.Slug,["author"]=r.Author,["phone"]=r.Phone,["rating"]=r.Rating,["title"]=r.Title,["body"]=r.Body,["status"]=r.Status,["verified"]=r.Verified,["media"]=JsonNode.Parse(r.Media),["media_status"]=r.MediaStatus,["seller_reply"]=r.SellerReply,["helpful_count"]=r.HelpfulCount,["report_count"]=r.ReportCount,["reports"]=new JsonArray(reports.Where(x=>x.ReviewId==r.Id).Select(x=>(JsonNode)new JsonObject{["reason"]=ReviewSettingsBAL.ReportReasons.GetValueOrDefault(x.Reason,x.Reason),["note"]=x.Note}).ToArray()),["at"]=r.CreatedAt.ToString("o")});
        return new(){["items"]=items,["total"]=total,["page"]=page,["page_size"]=30,["counts"]=new JsonObject(new[]{"published","pending","hidden","reported","media_pending"}.Select(k=>KeyValuePair.Create<string,JsonNode?>(k,JsonValue.Create(counts.GetValueOrDefault(k)))))};
    }
    public async Task<JsonObject> ReportsAsync(UserModel user,AdminReportQuery q,int page)
    {
        await access.RequireAsync(user,"catalog");var total=await data.ReportsCountAsync(q);var counts=(await data.ReportCountsAsync()).ToDictionary(x=>x.Status,x=>x.N);var per=(await data.ProductOpenCountsAsync()).ToDictionary(x=>x.ProductId,x=>x.N);var items=new JsonArray();foreach(var r in await data.ReportsAsync(q))items.Add(new JsonObject{["id"]=r.Id.ToString(),["product_id"]=r.ProductId.ToString(),["product"]=r.Product,["slug"]=r.Slug,["product_status"]=r.ProductStatus,["seller"]=r.Seller,["seller_id"]=r.SellerId.ToString(),["customer"]=string.IsNullOrEmpty(r.Customer)?"Deleted account":r.Customer,["phone"]=r.Phone??"",["reason"]=r.Reason,["reason_label"]=PlatformSettingsBAL.ProductReportReasons.GetValueOrDefault(r.Reason,r.Reason),["note"]=r.Note,["url"]=r.Url,["status"]=r.Status,["admin_note"]=r.AdminNote,["seller_note"]=r.SellerNote,["open_for_product"]=per.GetValueOrDefault(r.ProductId),["at"]=r.CreatedAt.ToString("o"),["resolved_at"]=r.ResolvedAt?.ToString("o")});return new(){["items"]=items,["total"]=total,["page"]=page,["page_size"]=30,["reasons"]=new JsonObject(PlatformSettingsBAL.ProductReportReasons.Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Key,JsonValue.Create(x.Value)))),["counts"]=new JsonObject(new[]{"open","resolved","dismissed"}.Select(k=>KeyValuePair.Create<string,JsonNode?>(k,JsonValue.Create(counts.GetValueOrDefault(k)))))};
    }
    public async Task<JsonObject> SettingsAsync(UserModel user)
    {await access.RequireAsync(user,"catalog");var cfg=(JsonObject)(await reviews.GetAsync()).DeepClone();var market=await platform.GetAsync();cfg["feature_reviews"]=market["feature_reviews"]?.DeepClone();cfg["reviews_need_approval"]=market["reviews_need_approval"]?.DeepClone();cfg["report_reasons"]=new JsonObject(ReviewSettingsBAL.ReportReasons.Select(x=>KeyValuePair.Create<string,JsonNode?>(x.Key,JsonValue.Create(x.Value))));cfg["default_topics"]=ReviewSettingsBAL.DefaultTopics();cfg["default_guidelines"]=ReviewSettingsBAL.DefaultGuidelines;return cfg;}
    public async Task<JsonObject> SettingsAsync(UserModel user,JsonObject body)
    {await access.RequireAsync(user,"catalog");var input=(JsonObject)body.DeepClone();var market=new JsonObject();foreach(var k in new[]{"feature_reviews","reviews_need_approval"})if(input.Remove(k,out var v))market[k]=v;var cm=platform.Validate(market);var cr=ReviewSettingsBAL.ValidateUpdates(input);await using var tx=await db.BeginAsync();if(cm.Count>0)await platform.MergeValidatedAsync(cm,tx);await support.MergeSettingsAsync(ReviewSettingsBAL.Key,cr,tx);var detail=string.Join(", ",body.Select(x=>x.Key).Order());await audit.AuditAsync(user,"settings.reviews","settings","reviews",detail[..Math.Min(200,detail.Length)],tx);await tx.CommitAsync();platform.InvalidateCache();return await SettingsAsync(user);}
    public async Task<JsonObject> ResolveAsync(UserModel user,Guid id,string status,string note,bool takeDown,bool tellSeller)
    {
        await access.RequireAsync(user,"catalog");await using var tx=await db.BeginAsync();var r=await data.ReportAsync(id,tx)??throw new NotFoundException("Report");var p=await data.ProductAsync(r.ProductId,tx)??throw new NotFoundException("Product");note=note.Trim();await data.ResolveAsync(id,status,note,user.Id,tx);var reason=PlatformSettingsBAL.ProductReportReasons.GetValueOrDefault(r.Reason,r.Reason);
        if(takeDown&&p.Status=="approved")
        {p.Status="rejected";p.RejectionReason=($"Taken down after a customer report ({reason.ToLowerInvariant()}). "+note).Trim();await data.RejectProductAsync(p.Id,p.RejectionReason,tx);await notify.NotifySellerAsync(p.SellerId,"listing_update",new Dictionary<string,object?>{["status"]="taken down",["title"]=p.Title,["message"]=$"Reason: {p.RejectionReason} Fix the listing and send it for review again."},"/seller/products/"+p.Id,tx);await data.ResolveOtherAsync(p.Id,id,user.Id,tx);}
        else if(status=="resolved"&&tellSeller)await notify.NotifySellerAsync(p.SellerId,"listing_update",new Dictionary<string,object?>{["status"]="reported by a customer",["title"]=p.Title,["message"]=reason+". "+(note.Length>0?note:"Please check the listing.")},"/seller/product-reports",tx);
        await audit.AuditAsync(user,"product_report."+status,"product",p.Id,reason+(takeDown?" + take down":""),tx);await tx.CommitAsync();return new(){["ok"]=true,["product_status"]=p.Status};
    }
}
