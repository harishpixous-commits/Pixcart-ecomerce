using System.Text.Json.Nodes;

namespace Tests.StorefrontCatalog;

/// <summary>Reference: tests/test_catalog.py (the storefront side: visibility, product page, search, facets, suggestions, home rails).</summary>
public class CatalogTests(CatalogFactory factory) : CatalogTestBase(factory)
{
    private static readonly V[] ShirtVariants =
    [
        new("SH-RED-M", 99900, 59900, 10, new Dictionary<string, string> { ["Size"] = "M", ["Colour"] = "Red" }),
        new("SH-RED-L", 99900, 64900, 0, new Dictionary<string, string> { ["Size"] = "L", ["Colour"] = "Red" }),
    ];

    [Fact]
    public async Task Listing_lifecycle_and_visibility()
    {
        var cats = await Seed.CategoriesAsync();
        var seller = await Seed.SellerAsync("9100000001", "Kavi Clothing");
        var p = await Seed.ProductAsync(seller, cats["shirts"], "Cotton Casual Shirt for Men", ShirtVariants, brand: "Kavi", status: "draft");
        Assert.Equal(59900, await Scalar<long>("SELECT price_from FROM products WHERE id = @id", new { id = p.Id }));
        Assert.True(await Scalar<bool>("SELECT in_stock FROM products WHERE id = @id", new { id = p.Id }));

        // Not public while draft/pending.
        Assert.Equal(404, (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Status);
        await Sql("UPDATE products SET status = 'pending' WHERE id = @id", new { id = p.Id });
        var r = await Visitor.Get($"/api/catalog/products/{p.Slug}");
        Assert.Equal(404, r.Status);
        Assert.Equal("not_found", r.ErrorCode);
        Assert.Equal("Product not found", r["error"]["message"]!.GetValue<string>());

        await Sql("UPDATE products SET status = 'approved', approved_at = UTC_TIMESTAMP(6) WHERE id = @id", new { id = p.Id });
        r = await Visitor.Get($"/api/catalog/products/{p.Slug}");
        Assert.Equal(200, r.Status);
        var page = r.Body!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"Size": ["M", "L"], "Colour": ["Red"]}"""), page["option_axes"]));
        Assert.False(string.IsNullOrEmpty(page["seller"]!["gstin"]!.GetValue<string>()));
        Assert.False(string.IsNullOrEmpty(page["seller"]!["grievance_officer"]!["email"]!.GetValue<string>()));
        Assert.Equal("India", page["country_of_origin"]!.GetValue<string>());
        Assert.Equal([true, false], page["variants"]!.AsArray().Select(v => v!["in_stock"]!.GetValue<bool>()));
        Assert.Equal("fashion", page["breadcrumbs"]![0]!["slug"]!.GetValue<string>());
        Assert.Equal("Tamil Nadu", page["seller"]!["state"]!.GetValue<string>());

        // A price change shows at once (aggregates refreshed by the seller module through ICatalogBAL).
        await Sql("UPDATE variants SET price_paise = 54900 WHERE id = @id", new { id = p.VariantIds[0] });
        await With<BAL.Interface.ICatalogBAL, bool>(async c => { await c.RefreshProductAggregatesAsync(p.Id); return true; });
        Assert.Equal(54900, (await Visitor.Get($"/api/catalog/products/{p.Slug}"))["price"].GetValue<long>());

        // Back in review: hidden.
        await Sql("UPDATE products SET status = 'pending' WHERE id = @id", new { id = p.Id });
        Assert.Equal(404, (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Status);

        // Suspending the seller (or holiday mode) hides their approved listings.
        await Sql("UPDATE products SET status = 'approved' WHERE id = @id", new { id = p.Id });
        Assert.Equal(200, (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Status);
        await Sql("UPDATE sellers SET holiday_mode = 1 WHERE id = @id", new { id = seller.Id });
        Assert.Equal(404, (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Status);
        await Sql("UPDATE sellers SET holiday_mode = 0, status = 'suspended' WHERE id = @id", new { id = seller.Id });
        Assert.Equal(404, (await Visitor.Get($"/api/catalog/products/{p.Slug}")).Status);
        Assert.Equal(404, (await Visitor.Get("/api/catalog/stores/kavi-clothing")).Status);
    }

    private async Task<Dictionary<string, Guid>> ThreeProductsAsync()
    {
        var cats = await Seed.CategoriesAsync();
        var s = await Seed.SellerAsync("9100000004", "Gadget Hub");
        await Seed.ProductAsync(s, cats["mobiles"], "Galaxy Phone 5G 128GB Black", [new("G1", 2499900, 1999900, 5)], brand: "Samsung");
        await Seed.ProductAsync(s, cats["mobiles"], "Redmi Note Phone 4G 64GB", [new("R1", 1299900, 999900, 5)], brand: "Xiaomi");
        await Seed.ProductAsync(s, cats["shirts"], "Printed Shirt Phone Pocket", [new("S1", 99900, 49900, 5)], brand: "Kavi");
        return cats;
    }

    [Fact]
    public async Task Search_facets_and_sort()
    {
        await ThreeProductsAsync();
        Assert.Equal(3, (await Visitor.Get("/api/catalog/products?q=phon"))["total"].GetValue<long>()); // prefix match
        var data = (await Visitor.Get("/api/catalog/products?q=phone&category=electronics&sort=price_asc")).Body!;
        Assert.Equal(["Xiaomi", "Samsung"], data["items"]!.AsArray().Select(i => i!["brand"]!.GetValue<string>()));
        Assert.Equal(new HashSet<string> { "Samsung", "Xiaomi" }, data["facets"]!["brands"]!.AsArray().Select(b => b!["name"]!.GetValue<string>()).ToHashSet());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""[{"name": "Electronics", "slug": "electronics"}]"""), data["breadcrumbs"]));
        Assert.Equal("electronics", data["category"]!["slug"]!.GetValue<string>());
        Assert.Equal(1, (await Visitor.Get("/api/catalog/products?category=electronics&brand=Samsung"))["total"].GetValue<long>());
        Assert.Equal(2, (await Visitor.Get("/api/catalog/products?max_price=1000000"))["total"].GetValue<long>());
        var typo = await Visitor.Get("/api/catalog/products?q=galxy"); // typo tolerance (trigram similarity)
        Assert.Contains(typo["items"].AsArray(), i => i!["title"]!.GetValue<string>().Contains("Galaxy"));
        var sugg = await Visitor.Get("/api/catalog/suggest?q=red");
        Assert.StartsWith("Redmi", sugg["products"][0]!["title"]!.GetValue<string>());
        var home = (await Visitor.Get("/api/catalog/home")).Body!;
        Assert.Equal(3, home["deals"]!.AsArray().Count);
        Assert.True(home["categories"]![0]!["product_count"]!.GetValue<int>() >= 1);
        var tree = (await Visitor.Get("/api/catalog/categories")).Body!.AsArray().ToDictionary(c => c!["slug"]!.GetValue<string>());
        Assert.Equal(2, tree["electronics"]!["product_count"]!.GetValue<int>());
        Assert.Equal("mobiles", tree["electronics"]!["children"]![0]!["slug"]!.GetValue<string>());
    }

    [Fact]
    public async Task Search_ordering_filters_and_validation()
    {
        await ThreeProductsAsync();
        // relevance: exact or prefix title matches first
        var r = await Visitor.Get("/api/catalog/products?q=redmi note");
        Assert.Equal("Redmi Note Phone 4G 64GB", r["items"][0]!["title"]!.GetValue<string>());
        var byPrice = await Visitor.Get("/api/catalog/products?sort=price_desc");
        Assert.Equal(1999900, byPrice["items"][0]!["price"]!.GetValue<long>());
        Assert.Equal(1, (await Visitor.Get("/api/catalog/products?seller=gadget-hub&brand=Kavi"))["total"].GetValue<long>());
        Assert.Equal(3, (await Visitor.Get("/api/catalog/products?min_discount=10"))["total"].GetValue<long>());
        Assert.Equal(0, (await Visitor.Get("/api/catalog/products?min_discount=60"))["total"].GetValue<long>());
        var facets = (await Visitor.Get("/api/catalog/products?q=phone&brand=Samsung")).Body!;
        Assert.Equal(1, facets["total"]!.GetValue<long>());
        Assert.Equal(2, facets["facets"]!["brands"]!.AsArray().Count); // facets ignore the brand filter
        Assert.Equal(49900, facets["facets"]!["price_min"]!.GetValue<long>());
        // delivery estimate per seller, and "arrives within N days"
        var near = (await Visitor.Get("/api/catalog/products?pincode=600028")).Body!;
        Assert.False(string.IsNullOrEmpty(near["items"]![0]!["delivery_by"]!.GetValue<string>()));
        Assert.Equal(3, (await Visitor.Get("/api/catalog/products?pincode=600028&delivery=7"))["total"].GetValue<long>());
        Assert.Equal(0, (await Visitor.Get("/api/catalog/products?pincode=110001&delivery=1"))["total"].GetValue<long>());
        // input checks
        Assert.Equal(422, (await Visitor.Get("/api/catalog/products?sort=cheapest")).Status);
        Assert.Equal(422, (await Visitor.Get("/api/catalog/products?page=0")).Status);
        Assert.Equal(422, (await Visitor.Get("/api/catalog/products?pincode=012345")).Status);
        Assert.Equal("validation_error", (await Visitor.Get("/api/catalog/products?page_size=61")).ErrorCode);
        Assert.Equal(404, (await Visitor.Get("/api/catalog/products?category=nope")).Status);
        Assert.Equal(422, (await Visitor.Get("/api/catalog/suggest")).Status);
    }

    [Fact]
    public async Task Store_platform_and_delivery_estimate()
    {
        var cats = await Seed.CategoriesAsync();
        var s = await Seed.SellerAsync("9100000011", "Kovai Textiles");
        var p = await Seed.ProductAsync(s, cats["shirts"], "Handloom Cotton Shirt Blue", [new("HL-1", 200000, 100000, 10)]);
        var store = (await Visitor.Get("/api/catalog/stores/kovai-textiles")).Body!;
        Assert.Equal("Kovai Textiles", store["name"]!.GetValue<string>());
        Assert.Equal(1, store["product_count"]!.GetValue<long>());
        Assert.Equal("Tamil Nadu", store["state"]!.GetValue<string>());
        var platform = (await Visitor.Get("/api/catalog/platform")).Body!;
        Assert.Equal("PixCart", platform["name"]!.GetValue<string>());
        Assert.True(platform["online_payments"]!.GetValue<bool>());
        Assert.Equal(49900, platform["free_shipping_threshold_paise"]!.GetValue<long>());

        var est = (await Visitor.Get($"/api/catalog/delivery-estimate?variant_id={p.VariantIds[0]}&pincode=641001")).Body!;
        Assert.True(est["serviceable"]!.GetValue<bool>());
        Assert.Equal("Tamil Nadu", est["state"]!.GetValue<string>());
        Assert.Equal(0, est["delivery_fee_paise"]!.GetValue<long>());
        Assert.Equal("state", est["zone"]!.GetValue<string>());
        Assert.True(est.AsObject().ContainsKey("order_within_min"));
        var bad = await Visitor.Get($"/api/catalog/delivery-estimate?variant_id={p.VariantIds[0]}&pincode=012345");
        Assert.Equal("invalid_pincode", bad.ErrorCode);
        Assert.Equal(404, (await Visitor.Get($"/api/catalog/delivery-estimate?variant_id={Guid.NewGuid()}&pincode=641001")).Status);
        Assert.Equal(422, (await Visitor.Get("/api/catalog/delivery-estimate?variant_id=x&pincode=641001")).Status);
    }
}
