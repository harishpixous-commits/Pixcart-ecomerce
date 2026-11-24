using Model.DomainModel;
using Utils.Interface;
namespace DAL;
/// <summary>Seller-owned catalogue reads and locked lifecycle/variant writes.</summary>
public class SellerProductsDAL(IMySqlDapperHelper db)
{
    public Task<ProductModel?> OwnedAsync(Guid seller,Guid id,IUnitOfWork? tx=null) => tx is null
        ? db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id=@id AND seller_id=@seller",new { id,seller })
        : tx.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id=@id AND seller_id=@seller FOR UPDATE",new { id,seller });
    public Task<VariantModel?> VariantAsync(Guid seller,Guid id,IUnitOfWork tx) => tx.QueryFirstOrDefaultAsync<VariantModel>("SELECT * FROM variants WHERE id=@id AND seller_id=@seller FOR UPDATE",new { id,seller });
    public Task SetStatusAsync(ProductModel p,IUnitOfWork tx) => tx.ExecuteAsync("UPDATE products SET status=@Status,submitted_at=@SubmittedAt,rejection_reason=@RejectionReason,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",p);
    public Task SaveVariantAsync(VariantModel v,IUnitOfWork tx) => tx.ExecuteAsync("UPDATE variants SET price_paise=@PricePaise,mrp_paise=@MrpPaise,is_active=@IsActive,updated_at=UTC_TIMESTAMP(6) WHERE id=@Id",v);
    public Task<int> OtherStockAsync(Guid vid,Guid wid,IUnitOfWork tx) => tx.ExecuteScalarAsync<int>("SELECT COALESCE(SUM(l.quantity),0) FROM inventory_levels l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.variant_id=@vid AND l.warehouse_id<>@wid AND w.is_active=1",new { vid,wid });
    public sealed class CountRow { public string Status {get;set;}=""; public int Count {get;set;} }
    public async Task<(List<ProductModel> Rows,int Total,List<CountRow> Counts)> PageAsync(Guid seller,string? status,string q,bool low,int threshold,int page,int size)
    {
        const string filter="seller_id=@seller AND (@status IS NULL OR status=@status) AND (@q='' OR title LIKE @like OR id IN (SELECT product_id FROM variants WHERE sku LIKE @like)) AND (@low=0 OR id IN (SELECT product_id FROM variants WHERE is_active=1 AND stock<=@threshold))";
        var args=new { seller,status,q=q.Trim(),like="%"+q.Trim()+"%",low,threshold,offset=(long)(page-1)*size,size };
        var total=await db.ExecuteScalarAsync<int>("SELECT COUNT(*) FROM products WHERE "+filter,args);
        var rows=(await db.QueryAsync<ProductModel>("SELECT * FROM products WHERE "+filter+" ORDER BY updated_at DESC LIMIT @size OFFSET @offset",args)).ToList();
        var counts=(await db.QueryAsync<CountRow>("SELECT status,COUNT(*) AS count FROM products WHERE seller_id=@seller GROUP BY status",new { seller })).ToList();
        return (rows,total,counts);
    }
    public Task<IEnumerable<VariantModel>> VariantsForProductsAsync(IReadOnlyList<Guid> ids) => ids.Count==0
        ? Task.FromResult<IEnumerable<VariantModel>>([])
        : db.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id IN @ids AND is_active=1",new { ids });

}
