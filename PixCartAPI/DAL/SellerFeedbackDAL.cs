using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class SellerFeedbackDAL(IMySqlDapperHelper db)
{
    private const string ReviewWhere=" FROM reviews r JOIN products p ON p.id=r.product_id WHERE p.seller_id=@sid AND (@rating IS NULL OR r.rating=@rating) AND (@unanswered=0 OR r.seller_reply='') AND (@media=0 OR JSON_LENGTH(r.media)>0) AND (@q='' OR p.title LIKE @likeq OR r.title LIKE @likeq OR r.body LIKE @likeq)";
    public Task<long> ReviewCountAsync(Guid sid,int? rating,bool unanswered,bool media,string q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*)"+ReviewWhere,new{sid,rating,unanswered,media,q,likeq="%"+q+"%"});
    public Task<IEnumerable<SellerReviewRow>> ReviewsAsync(Guid sid,int? rating,bool unanswered,bool media,string q,int offset)=>db.QueryAsync<SellerReviewRow>("SELECT r.*,p.title AS Product,p.slug AS Slug"+ReviewWhere+" ORDER BY r.created_at DESC LIMIT 20 OFFSET @offset",new{sid,rating,unanswered,media,q,likeq="%"+q+"%",offset});
    public Task<IEnumerable<RatingCountRow>> DistributionAsync(Guid sid)=>db.QueryAsync<RatingCountRow>("SELECT r.rating,COUNT(*) AS N FROM reviews r JOIN products p ON p.id=r.product_id WHERE p.seller_id=@sid AND r.status='published' GROUP BY r.rating",new{sid});
    public Task<IEnumerable<Guid>> ReportedAsync(Guid user,IEnumerable<Guid> ids)=>db.QueryAsync<Guid>("SELECT review_id FROM review_reports WHERE user_id=@user AND review_id IN @ids",new{user,ids});
    public Task<ReviewModel?> OwnedReviewAsync(Guid id,Guid sid)=>db.QueryFirstOrDefaultAsync<ReviewModel>("SELECT r.* FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.id=@id AND p.seller_id=@sid",new{id,sid});
    public Task UpdateReplyAsync(Guid id,string reply,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE reviews SET seller_reply=@reply,updated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{id,reply});
    private const string ReportWhere=" FROM product_reports r JOIN products p ON p.id=r.product_id WHERE r.seller_id=@sid AND (@status IS NULL OR r.status=@status)";
    public Task<long> ProductReportCountAsync(Guid sid,string? status)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*)"+ReportWhere,new{sid,status});
    public Task<IEnumerable<SellerProductReportRow>> ProductReportsAsync(Guid sid,string? status,int offset)=>db.QueryAsync<SellerProductReportRow>("SELECT r.*,p.title AS Product,p.slug AS Slug"+ReportWhere+" ORDER BY r.created_at DESC LIMIT 20 OFFSET @offset",new{sid,status,offset});
    public Task<long> OpenCountAsync(Guid sid)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*) FROM product_reports WHERE seller_id=@sid AND status='open'",new{sid});
    public Task<ProductReportModel?> ProductReportAsync(Guid id,Guid sid,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<ProductReportModel>("SELECT * FROM product_reports WHERE id=@id AND seller_id=@sid",new{id,sid});
    public Task UpdateNoteAsync(Guid id,string note,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE product_reports SET seller_note=@note,updated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{id,note});
}
public class SellerReviewRow:ReviewModel{public string Product{get;set;}="";public string Slug{get;set;}="";}
public class RatingCountRow{public int Rating{get;set;}public long N{get;set;}}
public class SellerProductReportRow:ProductReportModel{public string Product{get;set;}="";public string Slug{get;set;}="";}
