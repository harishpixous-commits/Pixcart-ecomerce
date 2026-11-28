using Microsoft.Extensions.DependencyInjection;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
namespace Tests;
public class ProductPublishAtTests(ApiFactory f) : ApiTest(f)
{
    [Fact]
    public async Task Scheduled_publish_hides_an_approved_product_until_its_time()
    {
        var seller = await LoginPhone("9877100002", "Schedule Owner");
        Assert.Equal(201, (await seller.Post("/api/seller/register", new { display_name = "Schedule Store" })).Status);
        var cat = Guid.NewGuid();
        await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Pub Cat','pub-cat','',1000,500,0,1,'[]')", new { cat });
        object Body(object? publishAt, string vid = "") => vid.Length == 0
            ? new { category_id = cat, title = "Scheduled Cotton Shirt", hsn_code = "6205", gst_bps = 500, publish_at = publishAt, variants = new[] { new { sku = "PUB-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } }
            : (object)new { category_id = cat, title = "Scheduled Cotton Shirt", hsn_code = "6205", gst_bps = 500, publish_at = publishAt, variants = new[] { new { id = vid, sku = "PUB-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } };
        var r = await seller.Post("/api/seller/products", Body(null));
        Assert.Equal(201, r.Status);
        var pid = r.Json["id"]!.GetValue<string>(); var vid = r.Json["variants"]![0]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved'");
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@pid", new { pid = Guid.Parse(pid) });
        await using (var scope = Factory.Services.CreateAsyncScope()) await scope.ServiceProvider.GetRequiredService<BAL.Interface.ICatalogBAL>().RefreshProductAggregatesAsync(Guid.Parse(pid));
        var slug = await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id=@pid", new { pid = Guid.Parse(pid) });
        var v = Factory.CreateClient();
        var buyer = await LoginPhone("9877100003", "Schedule Buyer");
        Assert.Null((await seller.Get($"/api/seller/products/{pid}")).Json["publish_at"]);
        var soon = DateTime.UtcNow.AddDays(2).ToString("o");
        var put = await seller.Put($"/api/seller/products/{pid}", Body(soon, vid));
        Assert.True(put.Status == 200, put.ToString());
        Assert.Equal("approved", put.Json["status"]!.GetValue<string>());                       // no new approval round
        Assert.NotNull((await seller.Get($"/api/seller/products/{pid}")).Json["publish_at"]);
        Assert.Equal(404, (int)(await v.GetAsync($"/api/catalog/products/{slug}")).StatusCode);
        Assert.DoesNotContain((await v.GetFromJsonAsync<JsonObject>("/api/catalog/products"))!["items"]!.AsArray(), p => p!["slug"]!.GetValue<string>() == slug);
        Assert.Equal(404, (await buyer.Post("/api/cart/items", new { variant_id = vid, qty = 1 })).Status);
        await ApiFactory.DbExecAsync("UPDATE products SET publish_at = UTC_TIMESTAMP(6) - INTERVAL 1 MINUTE WHERE id=@pid", new { pid = Guid.Parse(pid) });   // the time passes
        Assert.Equal(200, (int)(await v.GetAsync($"/api/catalog/products/{slug}")).StatusCode);
        Assert.Contains((await v.GetFromJsonAsync<JsonObject>("/api/catalog/products"))!["items"]!.AsArray(), p => p!["slug"]!.GetValue<string>() == slug);
        Assert.Contains((await buyer.Post("/api/cart/items", new { variant_id = vid, qty = 1 })).Status, new[] { 200, 201 });
        await using (var scope = Factory.Services.CreateAsyncScope())
        {
            var inv = scope.ServiceProvider.GetRequiredService<BAL.Interface.IInventoryBAL>();
            Assert.Equal(1, await inv.ProductLiveNotifyAsync());
            Assert.Equal(0, await inv.ProductLiveNotifyAsync());                               // told once
        }
        var notes = (await seller.Get("/api/notifications")).Json["items"]!.AsArray();
        Assert.Single(notes, x => x!["title"]!.GetValue<string>() == "Your product is live" && x["body"]!.GetValue<string>().Contains("Scheduled Cotton Shirt"));
        Assert.Equal(422, (await seller.Put($"/api/seller/products/{pid}", new { category_id = cat, title = "Scheduled Cotton Shirt", hsn_code = "6205", gst_bps = 500, details = new { min_qty = 3, max_qty = 2 }, variants = new[] { new { id = vid, sku = "PUB-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } })).Status);   // the limit cannot be below the minimum
        Assert.Equal(422, (await seller.Put($"/api/seller/products/{pid}", Body(DateTime.UtcNow.AddDays(400).ToString("o"), vid))).Status);
        Assert.Null((await seller.Put($"/api/seller/products/{pid}", Body(null, vid))).Json["publish_at"]);
        var dup = await seller.Post($"/api/seller/products/{pid}/duplicate", new { });
        Assert.Null((await seller.Get($"/api/seller/products/{dup.Json["id"]!.GetValue<string>()}")).Json["publish_at"]);
    }

    [Fact]
    public async Task Staff_can_set_the_go_live_time_and_approval_says_when_it_goes_live()
    {
        var admin = await Admin();
        var seller = await LoginPhone("9877100004", "Staff Schedule Owner");
        Assert.Equal(201, (await seller.Post("/api/seller/register", new { display_name = "Staff Schedule Store" })).Status);
        var cat = Guid.NewGuid();
        await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Pub Cat 2','pub-cat-2','',1000,500,0,1,'[]')", new { cat });
        object Body(string vid, object? publishAt, object? details) => new { category_id = cat, title = "Staff Scheduled Shirt", hsn_code = "6205", gst_bps = 500, publish_at = publishAt, details, variants = new[] { vid.Length == 0 ? (object)new { sku = "STF-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } : new { id = vid, sku = "STF-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } };
        var r = await seller.Post("/api/seller/products", Body("", null, new { }));
        Assert.Equal(201, r.Status);
        var pid = r.Json["id"]!.GetValue<string>(); var vid = r.Json["variants"]![0]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved'");
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@pid", new { pid = Guid.Parse(pid) });
        await using (var scope = Factory.Services.CreateAsyncScope()) await scope.ServiceProvider.GetRequiredService<BAL.Interface.ICatalogBAL>().RefreshProductAggregatesAsync(Guid.Parse(pid));
        var slug = await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id=@pid", new { pid = Guid.Parse(pid) });
        var v = Factory.CreateClient();
        var path = $"/api/admin/products/{pid}/publish-at";
        var soon = DateTime.UtcNow.AddDays(3).ToString("o");
        var put = await admin.Put(path, new { publish_at = soon });
        Assert.True(put.Status == 200, put.ToString());
        Assert.NotNull(put.Json["seller"]!["name"]); Assert.NotNull(put.Json["publish_at"]); Assert.Equal("approved", put.Json["status"]!.GetValue<string>());
        Assert.Equal(404, (int)(await v.GetAsync($"/api/catalog/products/{slug}")).StatusCode);
        Assert.NotNull((await seller.Get($"/api/seller/products/{pid}")).Json["publish_at"]);
        Assert.Equal(400, (await admin.Put(path, new { publish_at = DateTime.UtcNow.AddDays(400).ToString("o") })).Status);
        put = await admin.Put(path, new { publish_at = (string?)null });
        Assert.Null(put.Json["publish_at"]);
        Assert.Equal(200, (int)(await v.GetAsync($"/api/catalog/products/{slug}")).StatusCode);
        Assert.Contains((await v.PutAsJsonAsync(path, new { publish_at = (string?)null })).StatusCode, new[] { System.Net.HttpStatusCode.Unauthorized, System.Net.HttpStatusCode.Forbidden });
        var up = await seller.Put($"/api/seller/products/{pid}", Body(vid, soon, new { max_qty = 4 }));
        Assert.Equal("pending", up.Json["status"]!.GetValue<string>());
        Assert.Equal(200, (await admin.Post($"/api/admin/products/{pid}/approve", new { })).Status);
        var notes = (await seller.Get("/api/notifications")).Json["items"]!.AsArray();
        Assert.Contains(notes, n => n!["body"]!.GetValue<string>().Contains("goes live on the store on"));
    }

    [Fact]
    public async Task Staff_can_set_the_unit_limit_without_a_new_approval_round()
    {
        var admin = await Admin();
        var seller = await LoginPhone("9877100005", "Unit Limit Owner");
        Assert.Equal(201, (await seller.Post("/api/seller/register", new { display_name = "Unit Limit Store" })).Status);
        var cat = Guid.NewGuid();
        await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Pub Cat 3','pub-cat-3','',1000,500,0,1,'[]')", new { cat });
        var r = await seller.Post("/api/seller/products", new { category_id = cat, title = "Unit Limit Shirt", hsn_code = "6205", gst_bps = 500, details = new { }, variants = new[] { new { sku = "UL-SKU", mrp_paise = 20000, price_paise = 10000, stock = 5 } } });
        Assert.Equal(201, r.Status);
        var pid = r.Json["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved'");
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@pid", new { pid = Guid.Parse(pid) });
        await using (var scope = Factory.Services.CreateAsyncScope()) await scope.ServiceProvider.GetRequiredService<BAL.Interface.ICatalogBAL>().RefreshProductAggregatesAsync(Guid.Parse(pid));
        var slug = await ApiFactory.DbScalarAsync<string>("SELECT slug FROM products WHERE id=@pid", new { pid = Guid.Parse(pid) });
        var v = Factory.CreateClient();
        var path = $"/api/admin/products/{pid}/unit-limit";
        var put = await admin.Put(path, new { max_qty = 3 });
        Assert.True(put.Status == 200, put.ToString());
        Assert.Equal("approved", put.Json["status"]!.GetValue<string>());
        Assert.NotNull(put.Json["seller"]!["name"]);
        Assert.Equal(3, (await v.GetFromJsonAsync<JsonObject>($"/api/catalog/products/{slug}"))!["max_qty"]!.GetValue<int>());
        Assert.Equal(422, (await admin.Put(path, new { max_qty = 101 })).Status);
        Assert.Equal(422, (await admin.Put(path, new { max_qty = -1 })).Status);
        Assert.Contains((await v.PutAsJsonAsync(path, new { max_qty = 2 })).StatusCode, new[] { System.Net.HttpStatusCode.Unauthorized, System.Net.HttpStatusCode.Forbidden });
        Assert.Equal(200, (await admin.Put(path, new { max_qty = 0 })).Status);
        Assert.Null((await v.GetFromJsonAsync<JsonObject>($"/api/catalog/products/{slug}"))!["max_qty"]);
    }
}
