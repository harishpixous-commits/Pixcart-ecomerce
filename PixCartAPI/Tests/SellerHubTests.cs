using System.Text.Json.Nodes;
namespace Tests;
public class SellerHubTests(ApiFactory f):ApiTest(f)
{
    private async Task<(Api,string)> Seed(bool approved=true)
    {var u=await LoginPhone("9892000001","Synthetic Hub Seller");var r=await u.Post("/api/seller/register",new{display_name="Synthetic Warehouse Store"});var id=r.Json["id"]!.GetValue<string>();if(approved)await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@id",new{id});return(u,id);}
    private static JsonObject Wh(string code="branch")=>new(){["code"]=code,["name"]="Synthetic Branch",["line1"]="1 Synthetic Road",["city"]="Coimbatore",["state_code"]="33",["pincode"]="641001"};
    [Fact]
    public async Task Preferences_required_fields_cutoff_omission_clear_and_audit()
    {
        var(u,s)=await Seed(false);var r=await u.Put("/api/seller/preferences",new{dispatch_days=2,holiday_mode=true,invoice_prefix="AB12",dispatch_cutoff="14:30"});Assert.True(r.Status==200,r.ToString());Assert.Equal("14:30",r.Json["dispatch_cutoff"]!.GetValue<string>());
        r=await u.Put("/api/seller/preferences",new{dispatch_days=1,holiday_mode=false});Assert.Equal("14:30",r.Json["dispatch_cutoff"]!.GetValue<string>());
        r=await u.Put("/api/seller/preferences",new{dispatch_days=0,holiday_mode=false,dispatch_cutoff=""});Assert.Equal("",r.Json["dispatch_cutoff"]!.GetValue<string>());
        Assert.Equal(422,(await u.Put("/api/seller/preferences",new{dispatch_days=1})).Status);Assert.Equal(422,(await u.Put("/api/seller/preferences",new{dispatch_days=11,holiday_mode=false})).Status);Assert.Equal(422,(await u.Put("/api/seller/preferences",new{dispatch_days=1,holiday_mode=false,dispatch_cutoff="24:00"})).Status);
        Assert.Equal(3,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='seller.preferences'"));
    }
    [Fact]
    public async Task Warehouse_default_locks_codes_ownership_and_approved_gate()
    {
        var(u,s)=await Seed(false);Assert.Equal(403,(await u.Post("/api/seller/warehouses",Wh())).Status);
        await u.Put("/api/seller/pickup-address",new{line1="1 Synthetic Road",city="Coimbatore",state_code="33",pincode="641001"});
        var r=await u.Get("/api/seller/warehouses");Assert.Equal(200,r.Status);var main=r.Json[0]!["id"]!.GetValue<string>();Assert.True(r.Json[0]!["is_default"]!.GetValue<bool>());
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@s",new{s});var b=Wh("MAIN");b["line1"]="Different address";Assert.Equal("default_locked",(await u.Put($"/api/seller/warehouses/{main}",b)).ErrorCode);
        b=Wh("MAIN");b["is_active"]=false;Assert.Equal("default_locked",(await u.Put($"/api/seller/warehouses/{main}",b)).ErrorCode);
        r=await u.Post("/api/seller/warehouses",Wh());Assert.True(r.Status==201,r.ToString());var branch=r.Json.AsArray().Single(w=>w!["code"]!.GetValue<string>()=="BRANCH")!["id"]!.GetValue<string>();
        Assert.Equal("code_taken",(await u.Post("/api/seller/warehouses",Wh("BRANCH"))).ErrorCode);
        b=Wh("IGNORED-NEW-CODE");b["name"]="Edited Branch";r=await u.Put($"/api/seller/warehouses/{branch}",b);Assert.Equal("BRANCH",r.Json.AsArray().Single(w=>w!["id"]!.GetValue<string>()==branch)!["code"]!.GetValue<string>());
        Assert.Equal(404,(await u.Put($"/api/seller/warehouses/{Guid.NewGuid()}",Wh())).Status);
        var other=await LoginPhone("9892000002");var otherId=(await other.Post("/api/seller/register",new{display_name="Other Warehouse Store"})).Json["id"]!.GetValue<string>();await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@id",new{id=otherId});Assert.Equal(404,(await other.Put($"/api/seller/warehouses/{branch}",Wh())).Status);
    }
    [Fact]
    public async Task Warehouse_switch_recomputes_stock_and_category_aggregates_with_gst_guards()
    {
        var(u,s)=await Seed();var r=await u.Post("/api/seller/warehouses",Wh());var w=r.Json[0]!["id"]!.GetValue<string>();
        var cat=Guid.NewGuid().ToString();await ApiFactory.DbExecAsync("INSERT INTO categories(id,name,slug,image_url,commission_bps,default_gst_bps,position,is_active,required_details)VALUES(@cat,'Synthetic Clothes','synthetic-clothes','',1000,500,0,1,'[]')",new{cat});
        var p=(await u.Post("/api/seller/products",new{category_id=cat,title="Synthetic Cotton Shirt Product",hsn_code="6205",gst_bps=500,variants=new[]{new{sku="HUB-SKU",mrp_paise=20000,price_paise=10000,stock=5}}})).Json;var pid=p["id"]!.GetValue<string>();var vid=p["variants"]![0]!["id"]!.GetValue<string>();
        await ApiFactory.DbExecAsync("INSERT INTO inventory_levels(variant_id,warehouse_id,quantity,updated_at)VALUES(@vid,@w,5,UTC_TIMESTAMP(6))",new{vid,w});
        var b=Wh();b["is_active"]=false;r=await u.Put($"/api/seller/warehouses/{w}",b);Assert.True(r.Status==200,r.ToString());Assert.Equal(5,r.Json[0]!["units"]!.GetValue<int>());Assert.Equal(1,r.Json[0]!["skus"]!.GetValue<int>());Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT stock FROM variants WHERE id=@vid",new{vid}));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT in_stock FROM products WHERE id=@pid",new{pid}));
        b["is_active"]=true;await u.Put($"/api/seller/warehouses/{w}",b);Assert.Equal(5,await ApiFactory.DbScalarAsync<long>("SELECT stock FROM variants WHERE id=@vid",new{vid}));Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT in_stock FROM products WHERE id=@pid",new{pid}));
        await ApiFactory.DbExecAsync("UPDATE sellers SET gstin='33ABCDE1234F1Z0' WHERE id=@s",new{s});b=Wh("KA");b["state_code"]="29";b["pincode"]="560001";Assert.Equal("gstin_required",(await u.Post("/api/seller/warehouses",b)).ErrorCode);
        b["gstin"]="33ABCDE1234F1Z"+Model.CustomeAttributes.IndianFormats.GstinCheckChar("33ABCDE1234F1Z");Assert.Equal("gstin_mismatch",(await u.Post("/api/seller/warehouses",b)).ErrorCode);
        b["gstin"]="29ABCDE1234F1Z"+Model.CustomeAttributes.IndianFormats.GstinCheckChar("29ABCDE1234F1Z");Assert.Equal(201,(await u.Post("/api/seller/warehouses",b)).Status);
        for(var i=2;i<20;i++)Assert.Equal(201,(await u.Post("/api/seller/warehouses",Wh("LIMIT-"+i))).Status);
        Assert.Equal("warehouse_limit",(await u.Post("/api/seller/warehouses",Wh("LIMIT-OVER"))).ErrorCode);
    }
}
