using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Product moderation queries (reference: routers/admin.py product endpoints and
/// routers/seller_products.py product_detail).</summary>
public class ProductModerationDAL(IMySqlDapperHelper db)
{
    /// <summary>One product row, locked (reference: _product(lock=True)).</summary>
    public Task<ProductModel?> ProductForUpdateAsync(Guid productId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @productId FOR UPDATE", new { productId });

    /// <summary>All variants of a product, including inactive, in creation order (reference: product_detail).</summary>
    public async Task<List<VariantModel>> VariantsAsync(Guid productId) =>
        (await db.QueryAsync<VariantModel>(
            "SELECT * FROM variants WHERE product_id = @productId ORDER BY created_at", new { productId })).ToList();

    /// <summary>Reference: assistant/actions._product — by id, or exactly one listing with that exact title.</summary>
    public async Task<ProductModel?> ResolveProductAsync(string reference)
    {
        var r = reference.Trim();
        if (Guid.TryParse(r, out var id)
            && await db.QueryFirstOrDefaultAsync<ProductModel>("SELECT * FROM products WHERE id = @id", new { id }) is { } byId)
            return byId;
        var rows = (await db.QueryAsync<ProductModel>(
            "SELECT * FROM products WHERE LOWER(title) = LOWER(@r) LIMIT 2", new { r })).ToList();
        return rows.Count == 1 ? rows[0] : null;
    }

}
