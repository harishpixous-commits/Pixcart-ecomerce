using System.Text.Json.Nodes;
using BAL;
namespace Tests;
public class SellerLedgerTests(ApiFactory f):ApiTest(f)
{
    [Fact]
    public async Task Payouts_mask_snapshot_ledger_balances_paging_and_scope()
    {
        var u=await LoginPhone("9895000001","Synthetic Ledger Seller");var s=(await u.Post("/api/seller/register",new{display_name="Synthetic Ledger Store"})).Json["id"]!.GetValue<string>();
        var p=Guid.NewGuid().ToString();await ApiFactory.DbExecAsync("INSERT INTO payouts(id,number,seller_id,amount,status,mode,utr,provider_payout_id,failure_reason,bank_snapshot)VALUES(@p,'PO-SYNTHETIC',@s,3000,'pending','manual','','','','{\"holder\":\"Synthetic Holder\",\"account_last4\":\"1234\",\"ifsc\":\"TEST0000001\",\"account_enc\":\"synthetic-ciphertext-never-return\"}')",new{p,s});
        async Task Entry(string kind,long amount,int days,string? payout=null)=>await ApiFactory.DbExecAsync("INSERT INTO seller_ledger(id,seller_id,kind,amount,description,available_at,payout_id,created_at)VALUES(@id,@s,@kind,@amount,'Synthetic test',DATE_ADD(UTC_TIMESTAMP(6),INTERVAL @days DAY),@payout,UTC_TIMESTAMP(6))",new{id=Guid.NewGuid().ToString(),s,kind,amount,days,payout});
        await Entry("sale",10000,-1);await Entry("commission",-1000,-1);await Entry("sale",5000,1);await Entry("sale",3000,-1,p);
        var r=await u.Get("/api/seller/payouts");Assert.True(r.Status==200,r.ToString());Assert.Equal(9000,r.Json["balances"]!["available"]!.GetValue<long>());Assert.Equal(5000,r.Json["balances"]!["upcoming"]!.GetValue<long>());Assert.Equal(3000,r.Json["balances"]!["paid_out"]!.GetValue<long>());Assert.Single(r.Json["payouts"]!.AsArray());Assert.DoesNotContain("account_enc",r.Text);Assert.DoesNotContain("synthetic-ciphertext",r.Text);Assert.Equal("1234",r.Json["payouts"]![0]!["bank"]!["account_last4"]!.GetValue<string>());Assert.False(r.Json["payouts"]![0]!["bank_changed"]!.GetValue<bool>());Assert.Null(r.Json["schedule"]!["next_at"]);
        r=await u.Get("/api/seller/ledger");Assert.Equal(4,r.Json["items"]!.AsArray().Count);Assert.Contains(r.Json["items"]!.AsArray(),e=>e!["payout"]?.GetValue<string>()=="PO-SYNTHETIC");Assert.Contains(r.Json["items"]!.AsArray(),e=>!e!["available"]!.GetValue<bool>());Assert.Empty((await u.Get("/api/seller/ledger?page=2")).Json["items"]!.AsArray());Assert.Equal(422,(await u.Get("/api/seller/ledger?page=0")).Status);
        var other=await LoginPhone("9895000002");await other.Post("/api/seller/register",new{display_name="Other Ledger Store"});r=await other.Get("/api/seller/payouts");Assert.Empty(r.Json["payouts"]!.AsArray());Assert.Equal(0,r.Json["balances"]!["available"]!.GetValue<long>());Assert.Empty((await other.Get("/api/seller/ledger")).Json["items"]!.AsArray());
    }
    [Fact]
    public void Schedule_is_pure_IST_weekday_fortnight_and_strictly_future()
    {
        // 2026-11-24 is Tuesday, verified by DateOnly.DayOfWeek rather than presumed.
        var day=new DateOnly(2026,11,24);Assert.Equal(DayOfWeek.Tuesday,day.DayOfWeek);
        var bal=new PayoutsBAL(null!,null!,null!,null!,null!);var cfg=new JsonObject{["auto_payouts"]=true,["payout_weekday"]=1,["payout_every_weeks"]=1,["payout_min_paise"]=100};
        var before=new DateTime(2026,11,24,4,29,0,DateTimeKind.Utc);var next=DateTime.Parse(bal.Schedule(cfg,before)["next_at"]!.GetValue<string>()).ToUniversalTime();Assert.Equal(new DateTime(2026,11,24,4,30,0,DateTimeKind.Utc),next);
        next=DateTime.Parse(bal.Schedule(cfg,next)["next_at"]!.GetValue<string>()).ToUniversalTime();Assert.Equal(new DateTime(2026,12,1,4,30,0,DateTimeKind.Utc),next);
        cfg["payout_every_weeks"]=2;next=DateTime.Parse(bal.Schedule(cfg,before)["next_at"]!.GetValue<string>()).ToUniversalTime();Assert.True(bal.IsPayoutDay(cfg,DateOnly.FromDateTime(next.AddHours(5.5))));Assert.InRange((next-before).TotalDays,0,14);
        cfg["auto_payouts"]=false;Assert.Null(bal.Schedule(cfg,before)["next_at"]);
    }
}
