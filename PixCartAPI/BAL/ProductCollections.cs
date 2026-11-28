using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Collections: a page of chosen products (hand-picked, or by rules on category, brand and price). Mirror of routers/collections.py.</summary>
public static class ProductCollections
{
    public record Input
    {
        public string Title { get; init; } = "";
        public string Slug { get; init; } = "";
        public string Description { get; init; } = "";
        public string ImageUrl { get; init; } = "";
        public bool IsActive { get; init; } = true;
        public int Position { get; init; }
        public List<string>? ProductSlugs { get; init; }
        public string CategorySlug { get; init; } = "";
        public string Brand { get; init; } = "";
        public long? MinPricePaise { get; init; }
        public long? MaxPricePaise { get; init; }
    }
    sealed class Row
    {
        public Guid Id { get; set; } public string Slug { get; set; } = ""; public string Title { get; set; } = ""; public string Description { get; set; } = ""; public string ImageUrl { get; set; } = "";
        public bool IsActive { get; set; } public int Position { get; set; } public string ProductIds { get; set; } = "[]"; public string CategorySlug { get; set; } = ""; public string Brand { get; set; } = "";
        public long? MinPricePaise { get; set; } public long? MaxPricePaise { get; set; }
    }
    const string Cols = "id AS Id, slug AS Slug, title AS Title, description AS Description, image_url AS ImageUrl, is_active AS IsActive, position AS Position, CAST(product_ids AS CHAR) AS ProductIds, category_slug AS CategorySlug, brand AS Brand, min_price_paise AS MinPricePaise, max_price_paise AS MaxPricePaise";

    static AppException Bad(string message, string field) => new(message, "validation_error", 422, new Dictionary<string, string> { [field] = message });

    static List<Guid> Ids(string json) => (JsonNode.Parse(string.IsNullOrEmpty(json) ? "[]" : json) as JsonArray ?? []).Select(x => Guid.TryParse(x?.GetValue<string>(), out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();

    static async Task<JsonObject> OutAsync(IMySqlDapperHelper db, Row c)
    {
        var ids = Ids(c.ProductIds);
        var names = ids.Count == 0 ? new Dictionary<Guid, string>() : (await db.QueryAsync<(Guid Id, string Slug)>("SELECT id AS Id, slug AS Slug FROM products WHERE id IN @ids", new { ids })).ToDictionary(r => r.Id, r => r.Slug);
        return new JsonObject
        {
            ["id"] = c.Id.ToString(), ["slug"] = c.Slug, ["title"] = c.Title, ["description"] = c.Description, ["image_url"] = c.ImageUrl, ["is_active"] = c.IsActive, ["position"] = c.Position,
            ["product_slugs"] = new JsonArray(ids.Where(names.ContainsKey).Select(i => (JsonNode)JsonValue.Create(names[i])).ToArray()),
            ["category_slug"] = c.CategorySlug, ["brand"] = c.Brand, ["min_price_paise"] = c.MinPricePaise, ["max_price_paise"] = c.MaxPricePaise,
        };
    }

    static async Task<string> UniqueSlugAsync(IMySqlDapperHelper db, string wanted, Guid? but)
    {
        var b = IndianFormats.Slugify(wanted, 70); var slug = b; var n = 1;
        while (await db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM product_collections WHERE slug = @slug AND (@but IS NULL OR id <> @but))", new { slug, but })) { n++; slug = $"{b}-{n}"; }
        return slug;
    }

    static async Task<(string Json, string Category, string Brand, string Title, string Description, string Image)> CheckAsync(IMySqlDapperHelper db, Input b)
    {
        var title = (b.Title ?? "").Trim();
        if (title.Length is < 2 or > 120) throw Bad("A title is 2 to 120 characters", "title");
        if ((b.Description ?? "").Length > 1000) throw Bad("A description is up to 1000 characters", "description");
        if ((b.ImageUrl ?? "").Length > 500) throw Bad("An image address is up to 500 characters", "image_url");
        if ((b.Brand ?? "").Length > 80 || (b.CategorySlug ?? "").Length > 120 || (b.Slug ?? "").Length > 80) throw Bad("A value is too long", "brand");
        var slugs = (b.ProductSlugs ?? []).Select(s => { s = s.Trim().ToLowerInvariant(); var i = s.LastIndexOf('/'); return i >= 0 ? s[(i + 1)..] : s; }).Where(s => s.Length > 0).Distinct().ToList();
        if (slugs.Count > 60) throw Bad("A collection takes up to 60 chosen products", "product_slugs");
        if (b.MinPricePaise is < 0 or > 100_000_000 || b.MaxPricePaise is < 0 or > 100_000_000) throw Bad("A price is between 0 and 1,00,000 rupees", "min_price_paise");
        if (b.MinPricePaise is { } lo && b.MaxPricePaise is { } hi && lo > hi) throw Bad("The lowest price is above the highest price", "min_price_paise");
        var category = (b.CategorySlug ?? "").Trim(); var brand = (b.Brand ?? "").Trim();
        if (slugs.Count == 0 && category.Length == 0 && brand.Length == 0 && b.MinPricePaise is null && b.MaxPricePaise is null) throw Bad("Pick products by link name, or give a category, brand or price range", "product_slugs");
        if (category.Length > 0 && !await db.ExecuteScalarAsync<bool>("SELECT EXISTS(SELECT 1 FROM categories WHERE slug = @category)", new { category })) throw new AppException($"No category with the link name: {category}", "category_not_found", 400);
        var found = slugs.Count == 0 ? [] : (await db.QueryAsync<(Guid Id, string Slug)>("SELECT id AS Id, slug AS Slug FROM products WHERE LOWER(slug) IN @slugs", new { slugs })).ToDictionary(r => r.Slug.ToLowerInvariant(), r => r.Id);
        var missing = slugs.Where(s => !found.ContainsKey(s)).ToList();
        if (missing.Count > 0) throw new AppException($"No product with the link name: {string.Join(", ", missing)}", "product_not_found", 400);
        return (new JsonArray(slugs.Select(s => (JsonNode)JsonValue.Create(found[s].ToString())).ToArray()).ToJsonString(), category, brand, title, (b.Description ?? "").Trim(), (b.ImageUrl ?? "").Trim());
    }

    static Task AuditAsync(IMySqlDapperHelper db, UserModel admin, string action, string slug) =>
        db.ExecuteAsync("INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) VALUES (@by, @action, 'collection', @slug, '', UTC_TIMESTAMP(6), @aid)", new { by = admin.Id, action, slug, aid = Guid.NewGuid() });

    public static async Task<JsonObject> AdminListAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<Row>($"SELECT {Cols} FROM product_collections ORDER BY position, created_at");
        var items = new JsonArray(); foreach (var r in rows) items.Add(await OutAsync(db, r));
        return new JsonObject { ["items"] = items };
    }

    public static async Task<JsonObject> CreateAsync(IMySqlDapperHelper db, UserModel admin, Input b)
    {
        var (ids, category, brand, title, desc, image) = await CheckAsync(db, b);
        var id = Guid.NewGuid(); var slug = await UniqueSlugAsync(db, string.IsNullOrWhiteSpace(b.Slug) ? title : b.Slug, null);
        await db.ExecuteAsync("INSERT INTO product_collections (id, slug, title, description, image_url, is_active, position, product_ids, category_slug, brand, min_price_paise, max_price_paise) VALUES (@id, @slug, @title, @desc, @image, @active, @pos, CAST(@ids AS JSON), @category, @brand, @min, @max)",
            new { id, slug, title, desc, image, active = b.IsActive, pos = b.Position, ids, category, brand, min = b.MinPricePaise, max = b.MaxPricePaise });
        await AuditAsync(db, admin, "collection.create", slug);
        return await OutAsync(db, (await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE id = @id", new { id }))!);
    }

    public static async Task<JsonObject> EditAsync(IMySqlDapperHelper db, UserModel admin, Guid id, Input b)
    {
        var cur = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE id = @id", new { id }) ?? throw new NotFoundException("Collection");
        var (ids, category, brand, title, desc, image) = await CheckAsync(db, b);
        var slug = cur.Slug;
        if (!string.IsNullOrWhiteSpace(b.Slug) && IndianFormats.Slugify(b.Slug, 70) != cur.Slug) slug = await UniqueSlugAsync(db, b.Slug, id);
        await db.ExecuteAsync("UPDATE product_collections SET slug=@slug, title=@title, description=@desc, image_url=@image, is_active=@active, position=@pos, product_ids=CAST(@ids AS JSON), category_slug=@category, brand=@brand, min_price_paise=@min, max_price_paise=@max, updated_at=UTC_TIMESTAMP(6) WHERE id=@id",
            new { id, slug, title, desc, image, active = b.IsActive, pos = b.Position, ids, category, brand, min = b.MinPricePaise, max = b.MaxPricePaise });
        await AuditAsync(db, admin, "collection.edit", slug);
        return await OutAsync(db, (await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE id = @id", new { id }))!);
    }

    public static async Task<JsonObject> DeleteAsync(IMySqlDapperHelper db, UserModel admin, Guid id)
    {
        var cur = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE id = @id", new { id }) ?? throw new NotFoundException("Collection");
        await db.ExecuteAsync("DELETE FROM product_collections WHERE id = @id", new { id });
        await AuditAsync(db, admin, "collection.delete", cur.Slug);
        return new JsonObject { ["ok"] = true };
    }

    public static async Task<JsonObject> PublicListAsync(IMySqlDapperHelper db)
    {
        var rows = await db.QueryAsync<Row>($"SELECT {Cols} FROM product_collections WHERE is_active = 1 ORDER BY position, created_at");
        return new JsonObject { ["items"] = new JsonArray(rows.Select(c => (JsonNode)new JsonObject { ["slug"] = c.Slug, ["title"] = c.Title, ["description"] = c.Description, ["image_url"] = c.ImageUrl }).ToArray()) };
    }

    /// <summary>The products a collection shows (also used by home page rows set to "a collection").</summary>
    static async Task<List<ProductModel>> ProductsOfAsync(IMySqlDapperHelper db, ICatalogBAL catalog, CatalogDAL dal, Row c)
    {
        var ids = Ids(c.ProductIds);
        List<ProductModel> products;
        if (ids.Count > 0)
        {
            var found = (await dal.PublicProductsByIdsAsync(ids)).ToDictionary(p => p.Id);
            products = ids.Where(found.ContainsKey).Select(i => found[i]).Take(60).ToList();
        }
        else
        {
            var sql = $"SELECT p.* FROM products p WHERE {CatalogDAL.PublicFilter}"; var args = new Dictionary<string, object?>();
            if (c.CategorySlug.Length > 0)
            {
                var cat = await dal.CategoryBySlugAsync(c.CategorySlug, activeOnly: false);
                if (cat is null) return [];
                sql += " AND p.category_id IN @cats"; args["cats"] = await catalog.CategoryDescendantIdsAsync(cat.Id);
            }
            if (c.Brand.Length > 0) { sql += " AND LOWER(p.brand) = LOWER(@brand)"; args["brand"] = c.Brand; }
            if (c.MinPricePaise is not null) { sql += " AND p.price_from >= @min"; args["min"] = c.MinPricePaise; }
            if (c.MaxPricePaise is not null) { sql += " AND p.price_from <= @max"; args["max"] = c.MaxPricePaise; }
            products = (await db.QueryAsync<ProductModel>(sql + " ORDER BY p.sold_count DESC, p.id LIMIT 60", args)).ToList();
        }
        return products;
    }

    /// <summary>Products of an active collection by link name; empty when it is missing or hidden.</summary>
    public static async Task<List<ProductModel>> ProductsBySlugAsync(IMySqlDapperHelper db, ICatalogBAL catalog, CatalogDAL dal, string slug)
    {
        var c = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE slug = @slug AND is_active = 1", new { slug = (slug ?? "").ToLowerInvariant() });
        return c is null ? [] : await ProductsOfAsync(db, catalog, dal, c);
    }

    public static async Task<JsonObject> PublicPageAsync(IMySqlDapperHelper db, ICatalogBAL catalog, CatalogDAL dal, string slug)
    {
        var c = await db.QueryFirstOrDefaultAsync<Row>($"SELECT {Cols} FROM product_collections WHERE slug = @slug AND is_active = 1", new { slug = (slug ?? "").ToLowerInvariant() }) ?? throw new NotFoundException("Collection");
        JsonObject Page(List<JsonObject> cards) => new() { ["slug"] = c.Slug, ["title"] = c.Title, ["description"] = c.Description, ["image_url"] = c.ImageUrl, ["products"] = new JsonArray(cards.Select(x => (JsonNode)x).ToArray()) };
        var products = await ProductsOfAsync(db, catalog, dal, c);
        return Page(await catalog.ProductCardsAsync(products));
    }
}
