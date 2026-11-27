using System.Text.Json.Nodes;
namespace Tests;
public class SellerProductsTests(ApiFactory f) : ApiTest(f)
{
    private async Task<(Api User,string Seller,string Product,string Variant,string Category)> Seed()
    {
        var user=await LoginPhone("9890000001","Seller");
        var r=await user.Post("/api/seller/register",new { display_name="Test Product Store" }); var seller=r.Json["id"]!.GetValue<string>();
        var cat=Guid.NewGuid().ToString(); var p=Guid.NewGuid().ToString(); var v=Guid.NewGuid().ToString();
        await ApiFactory.DbExecAsync("INSERT INTO categories (id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details) VALUES (@cat,'Clothes','clothes','',1000,500,0,1,'[\"brand\"]')",new { cat });
        await ApiFactory.DbExecAsync("INSERT INTO products (id,seller_id,category_id,title,slug,brand,description,highlights,specs,hsn_code,gst_bps,country_of_origin,return_window_days,status,rejection_reason,price_from,mrp_from,in_stock,rating_avg,rating_count,sold_count,details) VALUES (@p,@seller,@cat,'Cotton Shirt Listing','cotton-shirt','Acme','A long description with at least thirty characters for this shirt','[]','{}','6205',500,'India',7,'draft','',10000,20000,1,0,0,0,'{}')",new { p,seller,cat });
        await ApiFactory.DbExecAsync("INSERT INTO variants (id,product_id,seller_id,sku,options,mrp_paise,price_paise,stock,weight_grams,is_active) VALUES (@v,@p,@seller,'UNIQUE-SKU','{}',20000,10000,5,300,1)",new { v,p,seller });
        return (user,seller,p,v,cat);
    }
    [Fact]
    public async Task Seller_list_detail_requirements_and_lifecycle()
    {
        var (user,seller,p,v,cat)=await Seed(); var adminApi=await Admin();
        var r=await user.Get("/api/seller/products?q=UNIQUE-SKU&low_stock=true"); Assert.True(r.Status==200,r.ToString()); Assert.Equal(1,r.Json["total"]!.GetValue<int>());
        Assert.Equal(1,r.Json["status_counts"]!["draft"]!.GetValue<int>());
        Assert.Equal(0,(await user.Get("/api/seller/products?status=approved")).Json["total"]!.GetValue<int>());
        r=await user.Get($"/api/seller/listing-requirements?category_id={cat}"); Assert.Contains("brand",r.Json["required"]!.AsArray().Select(x=>x!.GetValue<string>()));
        r=await user.Get("/api/seller/categories"); Assert.Equal(cat,r.Json[0]!["id"]!.GetValue<string>()); Assert.Equal(1000,r.Json[0]!["commission_bps"]!.GetValue<int>());
        Assert.Equal(3,(await user.Get("/api/seller/fees")).Json.AsObject().Count);
        Assert.Equal("listing_incomplete",(await user.Post($"/api/seller/products/{p}/submit")).ErrorCode);
        await ApiFactory.DbExecAsync("INSERT INTO product_images (id,product_id,url,position) VALUES (@id,@p,'/media/products/test.webp',0)",new { id=Guid.NewGuid().ToString(),p });
        r=await user.Post($"/api/seller/products/{p}/submit"); Assert.True(r.Status==200,r.ToString()); Assert.Equal("pending",r.Json["status"]!.GetValue<string>());
        Assert.Contains((await adminApi.Get("/api/notifications")).Json["items"]!.AsArray(),n=>n!["title"]!.GetValue<string>()=="Listing waiting for review");
        Assert.Equal("invalid_status",(await user.Post($"/api/seller/products/{p}/submit")).ErrorCode);
        Assert.Equal("archived",(await user.Post($"/api/seller/products/{p}/archive")).Json["status"]!.GetValue<string>());
        Assert.Equal("draft",(await user.Post($"/api/seller/products/{p}/restore")).Json["status"]!.GetValue<string>());
        Assert.Equal("invalid_status",(await user.Post($"/api/seller/products/{p}/restore")).ErrorCode);
        var other=await LoginPhone("9890000002"); await other.Post("/api/seller/register",new { display_name="Other Product Store" });
        Assert.Equal(404,(await other.Get($"/api/seller/products/{p}")).Status);
        Assert.Equal(404,(await other.Patch($"/api/seller/variants/{v}",new { stock=1 })).Status);
        Assert.Equal(422,(await user.Get("/api/seller/products?page=0")).Status);
    }
    [Fact]
    public async Task Price_stock_patch_updates_aggregates_and_preserves_approved_state()
    {
        var (u,s,p,v,cat)=await Seed();
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@p",new { p });
        Assert.Equal("price_above_mrp",(await u.Patch($"/api/seller/variants/{v}",new { price_paise=30000 })).ErrorCode);
        var r=await u.Patch($"/api/seller/variants/{v}",new { price_paise=9000,stock=9 }); Assert.True(r.Status==200,r.ToString()); Assert.Equal(9,r.Json["stock"]!.GetValue<int>());
        r=await u.Get($"/api/seller/products/{p}"); Assert.Equal(9000,r.Json["price_from"]!.GetValue<long>()); Assert.Equal("approved",r.Json["status"]!.GetValue<string>());
        await u.Put("/api/seller/pickup-address",new { line1="1 Main Road",city="Coimbatore",state_code="33",pincode="641001" });
        r=await u.Patch($"/api/seller/variants/{v}",new { stock=12 }); Assert.True(r.Status==200,r.ToString()); Assert.Equal(12,r.Json["stock"]!.GetValue<int>());
        Assert.Equal(12,await ApiFactory.DbScalarAsync<long>("SELECT quantity FROM inventory_levels WHERE variant_id=@v",new { v }));
        Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM stock_movements WHERE variant_id=@v",new { v }));
        await ApiFactory.DbExecAsync("INSERT INTO deals (id,seller_id,product_id,variant_id,kind,deal_price_paise,regular_price_paise,starts_at,ends_at,sold_qty,status,note) VALUES (@id,@s,@p,@v,'limited',9000,10000,UTC_TIMESTAMP(6),DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY),0,'active','')",new { id=Guid.NewGuid().ToString(),s,p,v });
        Assert.Equal("deal_running",(await u.Patch($"/api/seller/variants/{v}",new { price_paise=8000 })).ErrorCode);
        Assert.Equal(200,(await u.Patch($"/api/seller/variants/{v}",new { stock=13 })).Status);
        Assert.Equal(422,(await u.Patch($"/api/seller/variants/{v}",new { stock=-1 })).Status);
    }
    private static JsonObject Payload(string cat,string sku="WRITE-SKU")=>new()
    {
        ["category_id"]=cat,["title"]="New Cotton Shirt Listing",["brand"]="Acme",["description"]="A sufficiently long cotton shirt description for review.",
        ["hsn_code"]="6205",["gst_bps"]=500,["images"]=new JsonArray("/media/products/synthetic.webp"),
        ["variants"]=new JsonArray(new JsonObject { ["sku"]=sku,["mrp_paise"]=20000,["price_paise"]=10000,["stock"]=5 }),
    };
    [Fact]
    public async Task Product_create_update_review_and_variant_replacement_are_transactional()
    {
        var (u,s,p,v,cat)=await Seed();var payload=Payload(cat);
        var r=await u.Post("/api/seller/products",payload);Assert.True(r.Status==201,r.ToString());
        var id=r.Json["id"]!.GetValue<string>();var vid=r.Json["variants"]![0]!["id"]!.GetValue<string>();
        Assert.Equal("draft",r.Json["status"]!.GetValue<string>());Assert.Equal(10000,r.Json["price_from"]!.GetValue<long>());
        Assert.Empty((await u.Post($"/api/seller/products/{id}/submit")).Json["missing_details"]!.AsArray());
        await ApiFactory.DbExecAsync("UPDATE products SET status='approved' WHERE id=@id",new {id});
        payload["details"]=r.Json["details"]!.DeepClone();payload["return_window_days"]=7;
        payload["variants"]![0]!["id"]=vid;payload["variants"]![0]!["price_paise"]=9000;
        r=await u.Put($"/api/seller/products/{id}",payload);Assert.True(r.Status==200,r.ToString());Assert.Equal("approved",r.Json["status"]!.GetValue<string>());
        payload["title"]="New Cotton Shirt Content Changed";
        r=await u.Put($"/api/seller/products/{id}",payload);Assert.Equal("pending",r.Json["status"]!.GetValue<string>());
        payload["variants"]![0]!["id"]=v; payload["variants"]![0]!["sku"]="NEW-MISMATCH-SKU"; // unique SKU reaches foreign-variant guard
        r=await u.Put($"/api/seller/products/{id}",payload);Assert.Equal("variant_mismatch",r.ErrorCode);
        Assert.Equal(9000,await ApiFactory.DbScalarAsync<long>("SELECT price_from FROM products WHERE id=@id",new {id}));
        payload["variants"]![0]!.AsObject().Remove("id");payload["variants"]![0]!["sku"]="REPLACEMENT-SKU";
        r=await u.Put($"/api/seller/products/{id}",payload);Assert.True(r.Status==200,r.ToString());Assert.Single(r.Json["variants"]!.AsArray());
        Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM variants WHERE id=@vid",new {vid}));
        await u.Post($"/api/seller/products/{id}/archive");Assert.Equal("archived",(await u.Put($"/api/seller/products/{id}",payload)).ErrorCode);
        var duplicate=Payload(cat,"UNIQUE-SKU");Assert.Equal("sku_taken",(await u.Post("/api/seller/products",duplicate)).ErrorCode);
        Assert.Equal(2,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM products WHERE seller_id=@s",new {s}));
    }
    [Fact]
    public async Task Product_payload_category_and_media_validation()
    {
        var (u,s,p,v,cat)=await Seed();var b=Payload(cat);
        b["images"]=new JsonArray("https://outside.invalid/photo.jpg");Assert.Equal(422,(await u.Post("/api/seller/products",b)).Status);
        b=Payload(cat);b["details"]=new JsonObject{["net_unit"]="invalid"};Assert.Equal(422,(await u.Post("/api/seller/products",b)).Status);
        b=Payload(cat);b["variants"]![0]!["price_paise"]=30000;Assert.Equal(422,(await u.Post("/api/seller/products",b)).Status);
        b=Payload(cat);b["variants"]![0]!["options"]=new JsonObject{["Size"]="M"};b["variants"]!.AsArray().Add(b["variants"]![0]!.DeepClone());
        Assert.Equal(422,(await u.Post("/api/seller/products",b)).Status);
        b=Payload(cat);b["category_id"]=Guid.NewGuid().ToString();Assert.Equal("invalid_category",(await u.Post("/api/seller/products",b)).ErrorCode);
        await ApiFactory.DbExecAsync("UPDATE categories SET min_return_window_days=7 WHERE id=@cat",new {cat});
        b=Payload(cat);b["return_window_days"]=0;Assert.Equal("return_window_too_short",(await u.Post("/api/seller/products",b)).ErrorCode);
        b=Payload(cat);b["videos"]=new JsonArray(new JsonObject{["url"]="/media/videos/test.mp4"});
        var admin=await Admin();Assert.Equal(200,(await admin.Put("/api/admin/settings",new {feature_product_videos=false})).Status);
        Assert.Equal("videos_off",(await u.Post("/api/seller/products",b)).ErrorCode);
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='suspended' WHERE id=@s",new {s});
        Assert.Equal("seller_suspended",(await u.Post("/api/seller/products",Payload(cat))).ErrorCode);
    }

    [Fact]
    public async Task Seller_media_uploads_use_local_storage_and_feature_gates()
    {
        var (u,s,p,v,cat)=await Seed();
        static MultipartFormDataContent FileBody(byte[] bytes,string name)
        {var form=new MultipartFormDataContent();form.Add(new ByteArrayContent(bytes),"file",name);return form;}
        using var bitmap=new SkiaSharp.SKBitmap(200,200);bitmap.Erase(SkiaSharp.SKColors.Blue);
        using var image=SkiaSharp.SKImage.FromBitmap(bitmap);using var encoded=image.Encode(SkiaSharp.SKEncodedImageFormat.Png,100);
        var png=encoded.ToArray();
        var r=await u.Post("/api/seller/images",FileBody(png,"synthetic.png"));Assert.True(r.Status==201,r.ToString());Assert.StartsWith("/media/products/",r.Json["url"]!.GetValue<string>());Assert.EndsWith(".webp",r.Json["url"]!.GetValue<string>());
        r=await u.Post("/api/seller/images",FileBody([0x4d,0x5a,0,0],"wrong.jpg"));Assert.Equal(400,r.Status);
        byte[] mp4=[0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0,0,0,0];
        r=await u.Post("/api/seller/videos",FileBody(mp4,"synthetic.mp4"));Assert.True(r.Status==201,r.ToString());Assert.StartsWith("/media/videos/",r.Json["url"]!.GetValue<string>());
        var admin=await Admin();await admin.Put("/api/admin/settings",new {feature_product_videos=false});
        Assert.Equal("videos_off",(await u.Post("/api/seller/videos",FileBody(mp4,"synthetic.mp4"))).ErrorCode);
        var other=await LoginPhone("9890000003");Assert.Equal(403,(await other.Post("/api/seller/images",FileBody(png,"synthetic.png"))).Status);
    }

}
