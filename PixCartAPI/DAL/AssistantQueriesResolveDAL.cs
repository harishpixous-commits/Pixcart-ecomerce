namespace DAL;

using Utils.Interface;

/// <summary>Named entity resolution for the assistant tools (reference: queries.resolve_seller / resolve_category).</summary>
public partial class AssistantQueriesDAL
{
    public sealed record SellerRef(string Id, string DisplayName);

    public sealed record CategoryRef(string Id, string Name);

    /// <summary>Reference: queries.resolve_seller, returning the display name as well.</summary>
    public async Task<SellerRef?> ResolveSellerAsync(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        var trimmed = reference.Trim();
        if (Guid.TryParse(trimmed, out var id))
        {
            var found = await db.QueryFirstOrDefaultAsync<SellerRef>(
                "SELECT CAST(id AS CHAR) AS Id, display_name AS DisplayName FROM sellers WHERE id = @Id", new { Id = id.ToString() });
            if (found is not null) return found;
        }
        var exact = (await db.QueryAsync<SellerRef>(
            "SELECT CAST(id AS CHAR) AS Id, display_name AS DisplayName FROM sellers WHERE display_name LIKE @R OR gstin = @G OR legal_name LIKE @R",
            new { R = trimmed, G = trimmed.ToUpperInvariant() })).ToList();
        if (exact.Count == 1) return exact[0];
        var partial = (await db.QueryAsync<SellerRef>(
            "SELECT CAST(id AS CHAR) AS Id, display_name AS DisplayName FROM sellers WHERE display_name LIKE @Q LIMIT 2", new { Q = Like(trimmed) })).ToList();
        return partial.Count == 1 ? partial[0] : null;
    }

    /// <summary>Reference: queries.resolve_category, returning the name as well.</summary>
    public async Task<CategoryRef?> ResolveCategoryAsync(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        var trimmed = reference.Trim();
        if (Guid.TryParse(trimmed, out var id))
        {
            var found = await db.QueryFirstOrDefaultAsync<CategoryRef>(
                "SELECT CAST(id AS CHAR) AS Id, name AS Name FROM categories WHERE id = @Id", new { Id = id.ToString() });
            if (found is not null) return found;
        }
        var exact = (await db.QueryAsync<CategoryRef>(
            "SELECT CAST(id AS CHAR) AS Id, name AS Name FROM categories WHERE name LIKE @R OR slug = @S",
            new { R = trimmed, S = trimmed.ToLowerInvariant() })).ToList();
        if (exact.Count == 1) return exact[0];
        var partial = (await db.QueryAsync<CategoryRef>(
            "SELECT CAST(id AS CHAR) AS Id, name AS Name FROM categories WHERE name LIKE @Q LIMIT 2", new { Q = Like(trimmed) })).ToList();
        return partial.Count == 1 ? partial[0] : null;
    }
}
