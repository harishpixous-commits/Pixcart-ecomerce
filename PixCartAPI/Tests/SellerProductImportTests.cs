using System.Text;
using System.Text.Json.Nodes;
namespace Tests;
public class SellerProductImportTests(ApiFactory f):ApiTest(f)
{
    private const string Header="product_key,title,category,brand,description,highlights,hsn_code,gst_rate,return_window_days,country_of_origin,sku,option_1_name,option_1_value,option_2_name,option_2_value,mrp,price,stock,weight_grams\r\n";
    private const string Good="SHIRT-1,Imported Cotton Shirt White,mens-shirts,Kovai,Crisp white cotton shirt for office wear.,100% cotton|Regular fit,6205,5,7,India,KS-W-M,Size,M,,,1299,799,20,250\r\nSHIRT-1,,,,,,,,,,KS-W-L,Size,L,,,1299,799,15,260\r\n";
    private async Task<(Api,string)> Seed()
    {
        var u=await LoginPhone("9891000001","Synthetic Import Seller");var r=await u.Post("/api/seller/register",new{display_name="Synthetic Bulk Store"});
        await ApiFactory.DbExecAsync("INSERT INTO categories (id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details,return_window_days) VALUES (@id,'Mens Shirts','mens-shirts','',1000,500,0,1,'[]',7)",new{id=Guid.NewGuid().ToString()});
        return (u,r.Json["id"]!.GetValue<string>());
    }
    private static MultipartFormDataContent Body(byte[] bytes)
    {var b=new MultipartFormDataContent();b.Add(new ByteArrayContent(bytes),"file","synthetic.csv");return b;}
    private static Task<Res> Upload(Api u,string rows,string query="")=>u.Post("/api/seller/products/import"+query,Body(Encoding.UTF8.GetBytes("\ufeff"+Header+rows)));
    [Fact]
    public async Task Template_dry_run_mixed_errors_create_and_duplicate_are_well_shaped()
    {
        var (u,s)=await Seed();var t=await u.Get("/api/seller/products/import-template.csv");Assert.Equal(200,t.Status);Assert.StartsWith("product_key,title,category",t.Text.TrimStart('\ufeff'));Assert.Contains("\r\n",t.Text);
        const string bad="PHONE-1,Feature phone,Nowhere,,,,8517,,,,FP-1,,,,,999,1200,5,\r\nSHIRT-2,Imported Linen Casual Shirt,mens-shirts,,,,62,5,,,BAD,,,,,abc,500,x,\r\n";
        var r=await Upload(u,Good+bad);Assert.True(r.Status==200,r.ToString());Assert.True(r.Json["dry_run"]!.GetValue<bool>());Assert.True(r.Json["valid"]!.GetValue<int>()==1,r.ToString());Assert.Equal(2,r.Json["invalid"]!.GetValue<int>());Assert.Empty(r.Json["created"]!.AsArray());
        Assert.Equal(2,r.Json["products"]![0]!["variants"]!.GetValue<int>());Assert.Null(r.Json["products"]![0]!["payload"]);
        var errors=r.Json["products"]![2]!["errors"]!.ToJsonString();Assert.Contains("mrp must be a number",errors);Assert.Contains("HSN code must be 4, 6 or 8 digits",errors);
        Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM products WHERE seller_id=@s",new{s}));
        r=await Upload(u,Good+bad,"?dry_run=false");Assert.True(r.Status==200,r.ToString());Assert.Single(r.Json["created"]!.AsArray());var id=r.Json["created"]![0]!["id"]!.GetValue<string>();
        var detail=(await u.Get($"/api/seller/products/{id}")).Json;Assert.Equal("draft",detail["status"]!.GetValue<string>());Assert.Equal(2,detail["variants"]!.AsArray().Count);Assert.Equal(129900,detail["variants"]![0]!["mrp_paise"]!.GetValue<long>());Assert.Equal(500,detail["gst_bps"]!.GetValue<int>());Assert.Equal(2,detail["highlights"]!.AsArray().Count);
        Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='product.import'"));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='product.create'"));
        r=await Upload(u,Good,"?dry_run=false");Assert.Empty(r.Json["created"]!.AsArray());Assert.Contains("already exists",r.Json["products"]![0]!["errors"]!.ToJsonString());
    }
    [Fact]
    public async Task File_errors_cross_product_skus_and_rounding()
    {
        var(u,s)=await Seed();var r=await u.Post("/api/seller/products/import",Body(Encoding.UTF8.GetBytes("title,price\nShirt,100\n")));Assert.Contains("Missing columns",r.Json["file_errors"]!.ToJsonString());
        r=await u.Post("/api/seller/products/import",Body([0xff,0xfe,0x30]));Assert.Contains("CSV UTF-8",r.Json["file_errors"]!.ToJsonString());
        r=await u.Post("/api/seller/products/import",Body(new byte[2*1024*1024+10]));Assert.Contains("larger than 2 MB",r.Json["file_errors"]!.ToJsonString());
        var extra="SHIRT-3,Imported Linen Casual Shirt,mens-shirts,,,,6205,,,,KS-W-M,,,,,999,699,4,\r\n";
        r=await Upload(u,Good+extra);Assert.Contains("also used by product SHIRT-1",r.Json["products"]![1]!["errors"]!.ToJsonString());
        r=await Upload(u,"ROUND,Imported Rounded Price Shirt,mens-shirts,,,,6205,,,,ROUND,,,,,100.005,99.995,1,\r\n","?dry_run=false");Assert.True(r.Status==200,r.ToString());Assert.True(r.Json["created"]!.AsArray().Count==1,r.ToString());var id=r.Json["created"]![0]!["id"]!.GetValue<string>();
        Assert.Equal(10000,await ApiFactory.DbScalarAsync<long>("SELECT price_from FROM products WHERE id=@id",new{id}));Assert.Equal(10000,await ApiFactory.DbScalarAsync<long>("SELECT mrp_from FROM products WHERE id=@id",new{id}));
    }
    [Fact]
    public async Task Entire_import_rolls_back_when_second_persistence_fails()
    {
        var(u,s)=await Seed();await u.Put("/api/seller/pickup-address",new {line1="1 Synthetic Road",city="Coimbatore",state_code="33",pincode="641001"});var rows=Good+"FAIL,Atomic Failure Cotton Shirt,mens-shirts,,,,6205,,,,FAIL-SKU,,,,,100,90,2,\r\n";
        var preview=await Upload(u,rows);Assert.True(preview.Json["valid"]!.GetValue<int>()==2,preview.ToString());
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON products FOR EACH ROW BEGIN IF NEW.title='Atomic Failure Cotton Shirt' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic import failure'; END IF; END");
        try
        {
            var r=await Upload(u,rows,"?dry_run=false");Assert.Equal(500,r.Status);
            Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM products WHERE seller_id=@s",new{s}));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM variants WHERE seller_id=@s",new{s}));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='product.import'"));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM inventory_levels"));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM stock_movements"));
        }finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_import_failure");}
    }
    [Fact]
    public async Task Limits_suspension_and_rate_are_enforced()
    {
        var(u,s)=await Seed();var rows=string.Concat(Enumerable.Range(0,301).Select(i=>$"K{i},Imported Cotton Shirt Number,mens-shirts,,,,6205,,,,SKU-{i},,,,,100,90,2,\r\n"));
        var r=await Upload(u,rows);Assert.Contains("at most 300 products",r.Json["file_errors"]!.ToJsonString());Assert.Empty(r.Json["products"]!.AsArray());
        rows=string.Concat(Enumerable.Repeat("A,Imported Cotton Shirt Number,mens-shirts,,,,6205,,,,DUP,,,,,100,90,2,\r\n",2001));r=await Upload(u,rows);Assert.Contains("first 2000 rows",r.Json["file_errors"]!.ToJsonString());
        for(var i=0;i<28;i++){r=await Upload(u,"");Assert.Equal(200,r.Status);}Assert.Equal(429,(await Upload(u,"")).Status);
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='suspended' WHERE id=@s",new{s});Assert.Equal("seller_suspended",(await Upload(u,Good)).ErrorCode);
    }
}
