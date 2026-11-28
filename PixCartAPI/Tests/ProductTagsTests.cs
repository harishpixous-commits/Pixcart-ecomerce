using Microsoft.Extensions.DependencyInjection;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
namespace Tests;
public class ProductTagsTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Product_tags_are_tidied_filter_the_catalog_and_pick_collections()
    {
        var admin = await Admin(); var seller = await LoginPhone("9877100001", "Tag Owner");
        Assert.Equal(201, (await seller.Post("/api/seller/register", new { display_name = "Tag Store" })).Status);
        var cat = Guid.NewGuid();
        await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Tag Cat','tag-cat','',1000,500,0,1,'[]')", new { cat });
        object Body(object tags) => new { category_id = cat, title = "Tagged Cotton Shirt", hsn_code = "6205", gst_bps = 500, tags, variants = new[] { new { sku = "TAG-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } };
        Assert.Equal(422, (await seller.Post("/api/seller/products", Body(Enumerable.Range(0, 11).Select(i => "t" + i).ToArray()))).Status);
        var r = await seller.Post("/api/seller/products", Body(new[] { "  Summer   Sale ", "summer sale", "New" }));
        Assert.Equal(201, r.Status);
        var pid = r.Json["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved'");
        Assert.Equal("[\"summer sale\",\"new\"]", (await seller.Get($"/api/seller/products/{pid}")).Json["tags"]!.ToJsonString());
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@pid", new { pid = Guid.Parse(pid) });
        await using (var scope = Factory.Services.CreateAsyncScope()) await scope.ServiceProvider.GetRequiredService<BAL.Interface.ICatalogBAL>().RefreshProductAggregatesAsync(Guid.Parse(pid));
        var dup = await seller.Post($"/api/seller/products/{pid}/duplicate", new { });
        Assert.Equal(201, dup.Status);
        Assert.Equal("[\"summer sale\",\"new\"]", (await seller.Get($"/api/seller/products/{dup.Json["id"]!.GetValue<string>()}")).Json["tags"]!.ToJsonString());
        var seo = await seller.Put($"/api/seller/products/{pid}", new { category_id = cat, title = "Tagged Cotton Shirt", hsn_code = "6205", gst_bps = 500, tags = new[] { "summer sale", "new" }, seo_title = "  Cotton   shirt, Kovai ", seo_description = "Soft  cotton.", variants = new[] { new { id = r.Json["variants"]![0]!["id"]!.GetValue<string>(), sku = "TAG-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } });
        Assert.True(seo.Status == 200, seo.ToString());
        Assert.Equal("approved", seo.Json["status"]!.GetValue<string>());
        var v = Factory.CreateClient();
        var pub = (await v.GetFromJsonAsync<JsonObject>($"/api/catalog/products/{(await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id=@pid", new { pid = Guid.Parse(pid) }))}"))!;
        Assert.Equal("Cotton shirt, Kovai", pub["seo_title"]!.GetValue<string>());
        Assert.Equal("Soft cotton.", pub["seo_description"]!.GetValue<string>());
        Assert.Single((await v.GetFromJsonAsync<JsonObject>("/api/catalog/products?tag=Summer%20Sale"))!["items"]!.AsArray());
        Assert.Empty((await v.GetFromJsonAsync<JsonObject>("/api/catalog/products?tag=winter"))!["items"]!.AsArray());
        var c = await admin.Post("/api/admin/collections", new { title = "Summer picks", tag = "Summer Sale" });
        Assert.Equal(201, c.Status);
        Assert.Equal("summer sale", c.Json["tag"]!.GetValue<string>());
        var page = (await v.GetFromJsonAsync<JsonObject>($"/api/catalog/collections/{c.Json["slug"]!.GetValue<string>()}"))!;
        Assert.Single(page["products"]!.AsArray());
    }
}
