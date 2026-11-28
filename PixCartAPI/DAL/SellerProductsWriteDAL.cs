using Model.DomainModel;
using Utils.Interface;
namespace DAL;
public partial class SellerProductsDAL
{
    public Task<bool> SlugTakenAsync(string slug,IUnitOfWork tx)=>tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM products WHERE slug=@slug)",new {slug});
    public Task<bool> HasChildrenAsync(Guid cat,IUnitOfWork tx)=>tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id=@cat)",new {cat});
    public Task<bool> SkuTakenAsync(Guid seller,string sku,Guid? except,IUnitOfWork tx)=>tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM variants WHERE seller_id=@seller AND LOWER(sku)=LOWER(@sku) AND (@except IS NULL OR id<>@except))",new {seller,sku,except});
    public Task InsertProductAsync(ProductModel p,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO products (id,seller_id,category_id,title,slug,brand,description,highlights,specs,hsn_code,gst_bps,country_of_origin,size_guide,tags,seo_title,seo_description,return_window_days,status,rejection_reason,price_from,mrp_from,in_stock,rating_avg,rating_count,sold_count,details,created_at,updated_at) VALUES (@Id,@SellerId,@CategoryId,@Title,@Slug,@Brand,@Description,@Highlights,@Specs,@HsnCode,@GstBps,@CountryOfOrigin,@SizeGuide,@Tags,@SeoTitle,@SeoDescription,@ReturnWindowDays,@Status,@RejectionReason,@PriceFrom,@MrpFrom,@InStock,@RatingAvg,@RatingCount,@SoldCount,@Details,@CreatedAt,@UpdatedAt)",p);
    public Task UpdateProductAsync(ProductModel p,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE products SET category_id=@CategoryId,title=@Title,brand=@Brand,description=@Description,highlights=@Highlights,specs=@Specs,hsn_code=@HsnCode,gst_bps=@GstBps,country_of_origin=@CountryOfOrigin,size_guide=@SizeGuide,tags=@Tags,seo_title=@SeoTitle,seo_description=@SeoDescription,return_window_days=@ReturnWindowDays,details=@Details,status=@Status,submitted_at=@SubmittedAt,updated_at=@UpdatedAt WHERE id=@Id",p);
    public Task<IEnumerable<VariantModel>> ProductVariantsAsync(Guid pid,IUnitOfWork tx)=>tx.QueryAsync<VariantModel>("SELECT * FROM variants WHERE product_id=@pid",new {pid});
    public Task InsertVariantAsync(VariantModel v,IUnitOfWork tx)=>tx.ExecuteAsync("INSERT INTO variants (id,product_id,seller_id,sku,options,mrp_paise,price_paise,stock,weight_grams,net_qty,is_active,created_at,updated_at) VALUES (@Id,@ProductId,@SellerId,@Sku,@Options,@MrpPaise,@PricePaise,@Stock,@WeightGrams,@NetQty,@IsActive,@CreatedAt,@UpdatedAt)",v);
    public Task UpdateVariantAsync(VariantModel v,IUnitOfWork tx)=>tx.ExecuteAsync("UPDATE variants SET sku=@Sku,options=@Options,mrp_paise=@MrpPaise,price_paise=@PricePaise,weight_grams=@WeightGrams,net_qty=@NetQty,is_active=@IsActive,updated_at=@UpdatedAt WHERE id=@Id",v);
    public async Task RemoveUnusedVariantAsync(Guid id,IUnitOfWork tx)
    {
        if(await tx.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM order_items WHERE variant_id=@id)",new {id})) await tx.ExecuteAsync("UPDATE variants SET is_active=0 WHERE id=@id",new {id});
        else await tx.ExecuteAsync("DELETE FROM variants WHERE id=@id",new {id});
    }
    public async Task ReplaceMediaAsync(Guid id,List<string> images,List<ProductVideoModel> videos,IUnitOfWork tx)
    {
        await tx.ExecuteAsync("DELETE FROM product_images WHERE product_id=@id",new {id});
        for(var i=0;i<images.Count;i++) await tx.ExecuteAsync("INSERT INTO product_images (id,product_id,url,position) VALUES (@key,@id,@url,@i)",new {key=Guid.NewGuid(),id,url=images[i],i});
        await tx.ExecuteAsync("DELETE FROM product_videos WHERE product_id=@id",new {id});
        for(var i=0;i<videos.Count;i++) {var v=videos[i]; await tx.ExecuteAsync("INSERT INTO product_videos (id,product_id,url,poster_url,title,duration_s,position) VALUES (@key,@id,@Url,@PosterUrl,@Title,@DurationS,@i)",new {key=Guid.NewGuid(),id,v.Url,v.PosterUrl,v.Title,v.DurationS,i});}
    }
}
