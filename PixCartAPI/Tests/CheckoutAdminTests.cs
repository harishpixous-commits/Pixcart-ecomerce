using System.Text.Json.Nodes;
namespace Tests;
public class CheckoutAdminTests(ApiFactory f):ApiTest(f)
{
    [Fact]public async Task Checkout_settings_atomic_market_and_fees_and_unsaved_bill_preview()
    {
        var admin=await Admin();var shopper=await LoginPhone("9885000001");Assert.Equal(403,(await shopper.Get("/api/admin/checkout")).Status);var catalog=await Staff(admin,"checkoutcatalog@example.test","catalog");Assert.Equal(403,(await catalog.Get("/api/admin/checkout")).Status);
        var r=await admin.Get("/api/admin/checkout");Assert.True(r.Status==200,r.ToString());Assert.Equal(4000,r.Json["marketplace"]!["shipping_fee_paise"]!.GetValue<long>());
        var body=new{marketplace=new{shipping_fee_paise=2000,free_shipping_threshold_paise=20000,cod_fee_paise=300,not_allowed=123},fees=new{handling_enabled=true,handling_paise=100,handling_list_paise=200,handling_label="  Pack   safely  ",tip_presets=new[]{1000,500,1000},surge_enabled=true,surge_paise=150,surge_hours=2,late_night_enabled=true,late_night_paise=250}};
        r=await admin.Put("/api/admin/checkout",body);Assert.True(r.Status==200,r.ToString());Assert.Equal(2000,r.Json["marketplace"]!["shipping_fee_paise"]!.GetValue<long>());Assert.Equal("Pack safely",r.Json["fees"]!["handling_label"]!.GetValue<string>());Assert.Equal(2,r.Json["fees"]!["tip_presets"]!.AsArray().Count);Assert.Equal(500,r.Json["fees"]!["tip_presets"]![0]!.GetValue<int>());Assert.NotEmpty(r.Json["fees"]!["surge_until"]!.GetValue<string>());Assert.Null(r.Json["marketplace"]!["not_allowed"]);
        r=await admin.Post("/api/admin/checkout/preview",new{items_total=10000,cod=true,night=true});Assert.True(r.Status==200,r.ToString());Assert.Equal(12800,r.Json["total"]!.GetValue<long>());Assert.Equal(3,r.Json["fees"]!.AsArray().Count);Assert.Equal(2000,r.Json["shipping"]!.GetValue<long>());
        r=await admin.Post("/api/admin/checkout/preview",new{items_total=10000,night=true,marketplace=new{shipping_fee_paise=50},fees=new{late_night_from="bad"}});Assert.Equal(10300,r.Json["total"]!.GetValue<long>());Assert.Equal(2000,(await admin.Get("/api/admin/checkout")).Json["marketplace"]!["shipping_fee_paise"]!.GetValue<long>());
        Assert.Equal("invalid_setting",(await admin.Put("/api/admin/checkout",new{marketplace=new{shipping_fee_paise=999},fees=new{handling_paise=300}})).ErrorCode);Assert.Equal(2000,(await admin.Get("/api/admin/checkout")).Json["marketplace"]!["shipping_fee_paise"]!.GetValue<long>());
        foreach(var fees in new object[]{new{surge_hours=73},new{surge_hours=true},new{surge_until="2026-11-24T12:00:00"},new{late_night_from="25:00"},new{handling_enabled=1},new{tip_presets=new[]{99}},new{fee_invoice_prefix="a"},new{unknown_key=true},new{handling_label="x"}})Assert.Equal("invalid_setting",(await admin.Put("/api/admin/checkout",new{fees})).ErrorCode);
        Assert.Equal("invalid_setting",(await admin.Post("/api/admin/checkout/preview",new{fees=new{surge_hours=100}})).ErrorCode);
        await ApiFactory.DbExecAsync("CREATE TRIGGER synthetic_checkout_fail BEFORE UPDATE ON platform_settings FOR EACH ROW BEGIN IF NEW.`key`='checkout' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic checkout rollback'; END IF; END");
        try{Assert.Equal(500,(await admin.Put("/api/admin/checkout",new{marketplace=new{shipping_fee_paise=111},fees=new{handling_paise=50}})).Status);Assert.Equal(2000,(await admin.Get("/api/admin/checkout")).Json["marketplace"]!["shipping_fee_paise"]!.GetValue<long>());}finally{await ApiFactory.DbExecAsync("DROP TRIGGER synthetic_checkout_fail");}
        r=await admin.Put("/api/admin/checkout",new{fees=new{surge_enabled=false}});Assert.Equal("",r.Json["fees"]!["surge_until"]!.GetValue<string>());Assert.Equal(2,await ApiFactory.DbScalarAsync<long>("SELECT COUNT(*) FROM audit_logs WHERE action='settings.checkout'"));
        Assert.Equal(0,(await admin.Post("/api/admin/checkout/preview",new{items_total=-5})).Json["total"]!.GetValue<long>());
    }
}
