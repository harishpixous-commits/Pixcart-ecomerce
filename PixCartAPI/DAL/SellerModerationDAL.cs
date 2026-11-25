using Model.DomainModel;
using Utils.Interface;

namespace DAL;

/// <summary>Seller moderation queries (reference: routers/admin.py seller endpoints and
/// routers/seller_onboarding.py seller_profile).</summary>
public class SellerModerationDAL(IMySqlDapperHelper db)
{
    /// <summary>One seller row, locked (reference: _seller(lock=True)).</summary>
    public Task<SellerModel?> SellerForUpdateAsync(Guid sellerId, IUnitOfWork uow) =>
        uow.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @sellerId FOR UPDATE", new { sellerId });

    public Task<SellerModel?> SellerAsync(Guid sellerId) =>
        db.QueryFirstOrDefaultAsync<SellerModel>("SELECT * FROM sellers WHERE id = @sellerId", new { sellerId });

    public async Task<List<SellerDocumentModel>> DocsAsync(Guid sellerId) =>
        (await db.QueryAsync<SellerDocumentModel>("SELECT * FROM seller_documents WHERE seller_id = @sellerId", new { sellerId })).ToList();

    /// <summary>Product counts by status (reference: get_seller's product_counts).</summary>
    public async Task<Dictionary<string, long>> ProductCountsAsync(Guid sellerId) =>
        (await db.QueryAsync<(string Status, long C)>(
            "SELECT status AS Status, COUNT(*) AS C FROM products WHERE seller_id = @sellerId GROUP BY status", new { sellerId }))
        .ToDictionary(x => x.Status, x => x.C);

    /// <summary>Reference: assistant/queries.resolve_seller — by id, exact display name / GSTIN / legal name, or
    /// unique partial display name.</summary>
    public async Task<SellerModel?> ResolveSellerAsync(string reference)
    {
        var r = reference.Trim();
        if (Guid.TryParse(r, out var id) && await SellerAsync(id) is { } byId) return byId;
        var exact = (await db.QueryAsync<SellerModel>(
            "SELECT * FROM sellers WHERE LOWER(display_name) = LOWER(@r) OR UPPER(gstin) = UPPER(@r) OR LOWER(legal_name) = LOWER(@r)",
            new { r })).ToList();
        if (exact.Count == 1) return exact[0];
        if (exact.Count > 1) return null;
        var partial = (await db.QueryAsync<SellerModel>(
            "SELECT * FROM sellers WHERE display_name LIKE @like LIMIT 2", new { like = $"%{r}%" })).ToList();
        return partial.Count == 1 ? partial[0] : null;
    }

    public Task<UserModel?> UserAsync(Guid userId) =>
        db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @userId", new { userId });
}
