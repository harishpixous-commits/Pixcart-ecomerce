using System.Text;
using System.Text.Json.Nodes;
namespace Tests;
public class SellerInventoryTests(ApiFactory f):ApiTest(f)
{
    private async Task<(Api U,string S,string P,string V,string A,string B)> Seed()
    {
        var u=await LoginPhone("9893000001","Synthetic Stock Seller");var s=(await u.Post("/api/seller/register",new{display_name="Synthetic Stock Store"})).Json["id"]!.GetValue<string>();await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@s",new{s});
        async Task<string> Warehouse(string code){var r=await u.Post("/api/seller/warehouses",new{code,name="Synthetic Warehouse",line1="1 Synthetic Road",city="Coimbatore",state_code="33",pincode="641001"});Assert.True(r.Status==201,r.ToString());return r.Json.AsArray().Single(w=>w!["code"]!.GetValue<string>()==code)!["id"]!.GetValue<string>();}
        var a=await Warehouse("A1");var b=await Warehouse("B1");var cat=Guid.NewGuid().ToString();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Synthetic Stock','synthetic-stock','',1000,500,0,1,'[]')",new{cat});
        var r=await u.Post("/api/seller/products",new{category_id=cat,title="Synthetic Stock Cotton Shirt",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="STOCK-SKU",options=new{Size="M"},mrp_paise=20000,price_paise=10000,stock=0}}});Assert.True(r.Status==201,r.ToString());return(u,s,r.Json["id"]!.GetValue<string>(),r.Json["variants"]![0]!["id"]!.GetValue<string>(),a,b);
    }
    private static Task<Res> Adjust(Api u,string v,string w,string mode,int qty)=>u.Post("/api/seller/inventory/adjust",new{variant_id=v,warehouse_id=w,mode,quantity=qty,note="Synthetic test"});
    private static MultipartFormDataContent File(string csv){var b=new MultipartFormDataContent();b.Add(new ByteArrayContent(Encoding.UTF8.GetBytes(csv)),"file","synthetic.csv");return b;}
    [Fact]
    public async Task Grid_adjust_transfer_movements_and_rollback()
    {
        var(u,s,p,v,a,b)=await Seed();var r=await Adjust(u,v,a,"set",10);Assert.True(r.Status==200,r.ToString());Assert.Equal(10,r.Json["total"]!.GetValue<int>());r=await Adjust(u,v,a,"remove",2);Assert.Equal(8,r.Json["quantity"]!.GetValue<int>());r=await Adjust(u,v,b,"add",3);Assert.Equal(11,r.Json["total"]!.GetValue<int>());
        Assert.Equal("insufficient_stock",(await Adjust(u,v,a,"remove",9)).ErrorCode);
        r=await u.Post("/api/seller/inventory/transfer",new{variant_id=v,from_warehouse_id=a,to_warehouse_id=b,quantity=4});Assert.True(r.Status==200,r.ToString());Assert.Equal(11,r.Json["total"]!.GetValue<int>());
        r=await u.Get("/api/seller/inventory?q=stock-sku");Assert.Equal(1,r.Json["total"]!.GetValue<int>());Assert.Equal("size: M",r.Json["items"]![0]!["label"]!.GetValue<string>());Assert.Equal(4,r.Json["items"]![0]!["levels"]![a]!.GetValue<int>());Assert.Equal(7,r.Json["items"]![0]!["levels"]![b]!.GetValue<int>());
        Assert.Empty((await u.Get("/api/seller/inventory?low_stock=true")).Json["items"]!.AsArray());
        r=await u.Get($"/api/seller/inventory/{v}/movements");Assert.Equal(5,r.Json["items"]!.AsArray().Count);Assert.Equal(2,r.Json["items"]!.AsArray().Count(m=>m!["kind"]!.GetValue<string>()=="transfer"));
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_transfer_failure BEFORE UPDATE ON inventory_levels FOR EACH ROW BEGIN IF NEW.warehouse_id='"+b+"' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic transfer failure'; END IF; END");
        try{r=await u.Post("/api/seller/inventory/transfer",new{variant_id=v,from_warehouse_id=a,to_warehouse_id=b,quantity=1});Assert.Equal(500,r.Status);Assert.Equal(4,await ApiFactory.DbScalarAsync<long>("SELECT quantity FROM inventory_levels WHERE variant_id=@v AND warehouse_id=@a",new{v,a}));Assert.Equal(5,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM stock_movements WHERE variant_id=@v",new{v}));}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_transfer_failure");}
        Assert.Equal("same_warehouse",(await u.Post("/api/seller/inventory/transfer",new{variant_id=v,from_warehouse_id=a,to_warehouse_id=a,quantity=1})).ErrorCode);
        Assert.Equal(422,(await Adjust(u,v,a,"bogus",1)).Status);Assert.Equal(422,(await Adjust(u,v,a,"set",-1)).Status);Assert.Equal(422,(await u.Get("/api/seller/inventory?page=0")).Status);
    }
    [Fact]
    public async Task Duplicate_makes_a_draft_copy_with_fresh_skus_and_no_stock()
    {
        var(u,s,p,v,a,b)=await Seed();await Adjust(u,v,a,"set",10);
        var before=(await u.Get($"/api/seller/products/{p}")).Json;
        var r=await u.Post($"/api/seller/products/{p}/duplicate");Assert.True(r.Status==201,r.ToString());
        var c=r.Json;Assert.NotEqual(p,c["id"]!.GetValue<string>());Assert.Equal("draft",c["status"]!.GetValue<string>());Assert.Equal("Copy of "+before["title"]!.GetValue<string>(),c["title"]!.GetValue<string>());
        Assert.Equal("STOCK-SKU-COPY",c["variants"]![0]!["sku"]!.GetValue<string>());Assert.Equal(0,c["variants"]![0]!["stock"]!.GetValue<int>());Assert.Equal(10000,c["variants"]![0]!["price_paise"]!.GetValue<long>());
        Assert.Equal(before["description"]!.GetValue<string>(),c["description"]!.GetValue<string>());Assert.Equal(before["category_id"]!.GetValue<string>(),c["category_id"]!.GetValue<string>());
        var c2=(await u.Post($"/api/seller/products/{p}/duplicate")).Json;Assert.Equal("STOCK-SKU-COPY2",c2["variants"]![0]!["sku"]!.GetValue<string>());
        var after=(await u.Get($"/api/seller/products/{p}")).Json;Assert.Equal(10,after["variants"]![0]!["stock"]!.GetValue<int>());Assert.Equal(before["status"]!.GetValue<string>(),after["status"]!.GetValue<string>());
        var other=await LoginPhone("9893000003");await other.Post("/api/seller/register",new{display_name="Copy Other Store"});Assert.Equal(404,(await other.Post($"/api/seller/products/{p}/duplicate")).Status);
    }
    [Fact]
    public async Task Stock_import_partial_row_errors_and_ownership()
    {
        var(u,s,p,v,a,b)=await Seed();var r=await u.Post("/api/seller/inventory/import",File("\ufeff SKU , warehouse_code , QUANTITY \r\nstock-sku,a1,12\r\nunknown,A1,1\r\nSTOCK-SKU,NO,1\r\nSTOCK-SKU,A1,-1\r\nSTOCK-SKU,B1,0000002\r\n"));Assert.True(r.Status==200,r.ToString());Assert.Equal(2,r.Json["updated"]!.GetValue<int>());Assert.Equal(3,r.Json["errors"]!.AsArray().Count);Assert.Equal(14,await ApiFactory.DbScalarAsync<long>("SELECT stock FROM variants WHERE id=@v",new{v}));Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT in_stock FROM products WHERE id=@p",new{p}));
        Assert.Equal("bad_csv",(await u.Post("/api/seller/inventory/import",File("sku,quantity\nSTOCK-SKU,1"))).ErrorCode);
        var other=await LoginPhone("9893000002");await other.Post("/api/seller/register",new{display_name="Other Stock Store"});Assert.Equal(404,(await Adjust(other,v,a,"add",1)).Status);Assert.Equal(404,(await other.Get($"/api/seller/inventory/{v}/movements")).Status);
        r=await Adjust(u,v,Guid.NewGuid().ToString(),"add",1);Assert.Equal(404,r.Status);
        var errors="sku,warehouse_code,quantity\n"+string.Concat(Enumerable.Repeat("NO,A1,x\n",250));r=await u.Post("/api/seller/inventory/import",File(errors));Assert.Equal(200,r.Json["errors"]!.AsArray().Count);
        await u.Post($"/api/seller/products/{p}/archive");Assert.Empty((await u.Get("/api/seller/inventory")).Json["items"]!.AsArray());
    }
    [Fact]
    public async Task Transfer_into_inactive_warehouse_preserves_aggregate_gap()
    {
        var(u,s,p,v,a,b)=await Seed();await Adjust(u,v,a,"set",5);await ApiFactory.DbExecAsync("UPDATE warehouses SET is_active=0 WHERE id=@b",new{b});
        var r=await u.Post("/api/seller/inventory/transfer",new{variant_id=v,from_warehouse_id=a,to_warehouse_id=b,quantity=5});Assert.True(r.Status==200,r.ToString());Assert.Equal(0,r.Json["total"]!.GetValue<int>());Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT stock FROM variants WHERE id=@v",new{v}));
        // Deliberately pins a source defect rather than silently changing the reference contract.
        Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT in_stock FROM products WHERE id=@p",new{p}));
        await Adjust(u,v,b,"set",5);Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT in_stock FROM products WHERE id=@p",new{p}));
    }
}
