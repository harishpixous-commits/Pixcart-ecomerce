using System.Text.Json.Nodes;
namespace Tests;
public class SellerCouponsTests(ApiFactory f):ApiTest(f)
{
    private async Task<(Api,string)> Seed()
    {var u=await LoginPhone("9894000001","Synthetic Coupon Seller");var s=(await u.Post("/api/seller/register",new{display_name="Synthetic Coupon Store"})).Json["id"]!.GetValue<string>();return(u,s);}
    [Fact]
    public async Task Seller_coupon_approval_validation_create_update_and_immutable_identity()
    {
        var(u,s)=await Seed();var b=new JsonObject{["code"]="seller10",["kind"]="percent",["value"]=1000};Assert.Equal(403,(await u.Get("/api/seller/coupons")).Status);Assert.Equal(403,(await u.Post("/api/seller/coupons",b)).Status);
        await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@s",new{s});b["value"]=10;Assert.Equal("invalid_value",(await u.Post("/api/seller/coupons",b)).ErrorCode);b["value"]=1000;b["usage_limit"]=0;Assert.Equal(422,(await u.Post("/api/seller/coupons",b)).Status);b.Remove("usage_limit");
        var r=await u.Post("/api/seller/coupons",b);Assert.True(r.Status==201,r.ToString());var id=r.Json["id"]!.GetValue<string>();Assert.Equal("SELLER10",r.Json["code"]!.GetValue<string>());Assert.Equal("seller",r.Json["funded_by"]!.GetValue<string>());Assert.Equal(s,r.Json["seller_id"]!.GetValue<string>());Assert.Equal(1,r.Json["per_user_limit"]!.GetValue<int>());Assert.True(r.Json["show_on_checkout"]!.GetValue<bool>());Assert.False(r.Json["first_order_only"]!.GetValue<bool>());
        Assert.Equal("code_taken",(await u.Post("/api/seller/coupons",b)).ErrorCode);Assert.Single((await u.Get("/api/seller/coupons")).Json.AsArray());
        b["code"]="IGNORED";b["kind"]="flat";b["value"]=15000;b["is_active"]=false;b["description"]="Synthetic updated offer";b["max_discount_paise"]=20000;b["min_order_paise"]=50000;b["per_user_limit"]=2;b["usage_limit"]=20;b["starts_at"]="2026-11-24T10:00:00Z";b["ends_at"]="2026-12-24T10:00:00Z";
        r=await u.Put($"/api/seller/coupons/{id}",b);Assert.Equal(200,r.Status);Assert.Equal("SELLER10",r.Json["code"]!.GetValue<string>());Assert.Equal(15000,r.Json["value"]!.GetValue<int>());Assert.False(r.Json["is_active"]!.GetValue<bool>());Assert.Equal(2,r.Json["per_user_limit"]!.GetValue<int>());Assert.Equal(1,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='coupon.create'"));Assert.Equal(0,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='coupon.update'"));
        var other=await LoginPhone("9894000002");var os=(await other.Post("/api/seller/register",new{display_name="Other Coupon Store"})).Json["id"]!.GetValue<string>();await ApiFactory.DbExecAsync("UPDATE sellers SET status='approved' WHERE id=@os",new{os});Assert.Equal(404,(await other.Put($"/api/seller/coupons/{id}",b)).Status);Assert.Empty((await other.Get("/api/seller/coupons")).Json.AsArray());Assert.Equal("code_taken",(await other.Post("/api/seller/coupons",new{code="SELLER10",kind="flat",value=100})).ErrorCode);
    }
}
