using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public class AdminFeedbackDAL(IMySqlDapperHelper db)
{
    private const string ReviewsWhere=" FROM reviews r JOIN products p ON p.id=r.product_id JOIN users u ON u.id=r.user_id WHERE (@status IS NULL OR r.status=@status) AND (@rating IS NULL OR @rating=0 OR r.rating=@rating) AND (@reported=0 OR r.report_count>0) AND (@media=0 OR JSON_LENGTH(r.media)>0) AND (@pending=0 OR (r.media_status='pending' AND JSON_LENGTH(r.media)>0)) AND (@seller IS NULL OR p.seller_id=@seller) AND (@q='' OR p.title LIKE @pat OR r.title LIKE @pat OR r.body LIKE @pat OR u.name LIKE @pat)";
    public Task<long> ReviewsCountAsync(AdminReviewQuery q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*)"+ReviewsWhere,q);
    public Task<IEnumerable<AdminReviewRow>> ReviewsAsync(AdminReviewQuery q)=>db.QueryAsync<AdminReviewRow>("SELECT r.*,p.title AS Product,p.slug,u.name AS Author,u.phone"+ReviewsWhere+" ORDER BY r.report_count DESC,r.created_at DESC LIMIT 30 OFFSET @offset",q);
    public Task<IEnumerable<ReviewReportModel>> OpenReportsAsync(Guid[] ids)=>db.QueryAsync<ReviewReportModel>("SELECT * FROM review_reports WHERE review_id IN @ids AND status='open'",new{ids});
    public Task<IEnumerable<FeedbackCount>> ReviewCountsAsync()=>db.QueryAsync<FeedbackCount>("SELECT status,COUNT(*) AS N FROM reviews GROUP BY status UNION ALL SELECT 'reported',COUNT(*) FROM reviews WHERE report_count>0 UNION ALL SELECT 'media_pending',COUNT(*) FROM reviews WHERE media_status='pending' AND JSON_LENGTH(media)>0");
    private const string ReportsWhere=" FROM product_reports r JOIN products p ON p.id=r.product_id JOIN sellers s ON s.id=r.seller_id LEFT JOIN users u ON u.id=r.user_id WHERE (@status IS NULL OR r.status=@status) AND (@reason IS NULL OR @reason='' OR r.reason=@reason) AND (@seller IS NULL OR r.seller_id=@seller) AND (@q='' OR p.title LIKE @pat OR r.note LIKE @pat OR s.display_name LIKE @pat)";
    public Task<long> ReportsCountAsync(AdminReportQuery q)=>db.ExecuteScalarAsync<long>("SELECT COUNT(*)"+ReportsWhere,q);
    public Task<IEnumerable<AdminReportRow>> ReportsAsync(AdminReportQuery q)=>db.QueryAsync<AdminReportRow>("SELECT r.*,p.title AS Product,p.slug,p.status AS ProductStatus,s.display_name AS Seller,u.name AS Customer,u.phone"+ReportsWhere+" ORDER BY r.created_at DESC LIMIT 30 OFFSET @offset",q);
    public Task<IEnumerable<FeedbackCount>> ReportCountsAsync()=>db.QueryAsync<FeedbackCount>("SELECT status,COUNT(*) AS N FROM product_reports GROUP BY status");
    public Task<IEnumerable<OpenProductCount>> ProductOpenCountsAsync()=>db.QueryAsync<OpenProductCount>("SELECT product_id,COUNT(*) AS N FROM product_reports WHERE status='open' GROUP BY product_id");
    public Task<ProductReportModel?> ReportAsync(Guid id,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<ProductReportModel>("SELECT * FROM product_reports WHERE id=@id",new{id});
    public Task<ProductModel?> ProductAsync(Guid id,IUnitOfWork tx)=>tx.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id=@id",new{id});
    public Task ResolveAsync(Guid id,string status,string note,Guid user,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE product_reports SET status=@status,admin_note=@note,resolved_at=UTC_TIMESTAMP(6),resolved_by=@user,updated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{id,status,note,user});
    public Task RejectProductAsync(Guid id,string reason,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE products SET status='rejected',rejection_reason=@reason,updated_at=UTC_TIMESTAMP(6) WHERE id=@id",new{id,reason});
    public Task ResolveOtherAsync(Guid product,Guid id,Guid user,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE product_reports SET status='resolved',resolved_at=UTC_TIMESTAMP(6),resolved_by=@user,admin_note='Listing taken down',updated_at=UTC_TIMESTAMP(6) WHERE product_id=@product AND status='open' AND id<>@id",new{product,id,user});
}
public record AdminReviewQuery(string? Status,int? Rating,bool Reported,bool Media,bool Pending,Guid? Seller,string Q,int Offset){public string Pat=>"%"+Q+"%";}
public record AdminReportQuery(string? Status,string? Reason,Guid? Seller,string Q,int Offset){public string Pat=>"%"+Q+"%";}
public class AdminReviewRow:ReviewModel{public string Product{get;set;}="";public string Slug{get;set;}="";public string Author{get;set;}="";public string Phone{get;set;}="";}
public class AdminReportRow:ProductReportModel{public string Product{get;set;}="";public string Slug{get;set;}="";public string ProductStatus{get;set;}="";public string Seller{get;set;}="";public string? Customer{get;set;}public string? Phone{get;set;}}
public class FeedbackCount{public string Status{get;set;}="";public long N{get;set;}}
public class OpenProductCount{public Guid ProductId{get;set;}public long N{get;set;}}
