using System.Text.Json.Nodes;
using BAL;
using BAL.Interface;
using Microsoft.Extensions.DependencyInjection;
using Model.DomainModel;
using Utils;
using Utils.Interface;
namespace Tests;

public class GiftPurchaseTests(ApiFactory f) : ApiTest(f)
{
    /// <summary>A gateway that reports whatever attempts the test sets. Never talks to a real provider.</summary>
    private sealed class FakePay : PaymentGateway
    {
        public List<GatewayAttempt> Now = [];
        public List<long> Created = [];
        public FakePay() : base(new HttpClient(), new Dictionary<string, string>()) { }
        public override string Code => "cashfree";
        public override bool Sandbox => true;
        public override Task<GatewayPayment> CreateAsync(long amount, string currency, string receipt, JsonObject c, string returnUrl, string notifyUrl)
        { Created.Add(amount); return Task.FromResult(new GatewayPayment($"ref_{Created.Count}", "redirect", new JsonObject { ["url"] = "https://pay.example/x" })); }
        public override Task<List<GatewayAttempt>> AttemptsAsync(string reference) => Task.FromResult(Now);
        public override Task PingAsync() => Task.CompletedTask;
        public override Task<GatewayRefund> RefundAsync(string reference, string paymentId, long amount, string refundId, string note) => throw new InvalidOperationException();
        public override string? VerifyWebhook(IReadOnlyDictionary<string, string> headers, byte[] body) => null;
        public override string? ReferenceFromReturn(IReadOnlyDictionary<string, string> p) => null;
    }

    private sealed class FakeGateways(FakePay pay) : IPaymentGatewayBAL
    {
        public Task<List<string>> EligibleAsync(string c) => Task.FromResult(new List<string> { "razorpay", "cashfree" });
        public Task<PaymentGateway> AdapterAsync(string code) => Task.FromResult<PaymentGateway>(pay);
        public Task<PaymentModel> StartAsync(OrderModel o, UserModel u, long a, long? c, string cc, IUnitOfWork uow, string? p = null, string? af = null) => throw new InvalidOperationException();
        public Task<JsonArray> AlternativesAsync(string c, string cur) => throw new InvalidOperationException();
        public Task<JsonObject> PayloadAsync(OrderModel o, PaymentModel p, UserModel u, string b) => throw new InvalidOperationException();
        public Task<JsonObject> CheckAsync(PaymentModel p, IUnitOfWork u, Func<PaymentModel, string, string, long, IUnitOfWork, Task<string>> m) => throw new InvalidOperationException();
        public Task<GatewayRefund> RefundAsync(PaymentModel p, string pp, long c, string r, string n) => throw new InvalidOperationException();
        public Task<JsonObject> GatewaysAsync(UserModel a) => throw new InvalidOperationException();
        public Task<JsonObject> UpdateRoutingAsync(UserModel a, JsonObject b) => throw new InvalidOperationException();
        public Task<JsonObject> TestAsync(UserModel a, string c) => throw new InvalidOperationException();
    }

    [Fact]
    public async Task Buying_a_gift_card_issues_it_once_and_only_after_the_gateway_says_paid()
    {
        var admin = await Admin(); var buyer = await LoginPhone("9880000091"); var other = await LoginPhone("9880000092");
        using var scope = Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IMySqlDapperHelper>();
        var integ = scope.ServiceProvider.GetRequiredService<IIntegrationBAL>();
        var user = (await db.QueryFirstOrDefaultAsync<UserModel>("SELECT * FROM users WHERE id = @id", new { id = buyer.Id }))!;
        var pay = new FakePay(); var gw = new FakeGateways(pay);

        async Task<T> Tx<T>(Func<IUnitOfWork, Task<T>> f) { await using var tx = await db.BeginAsync(); var r = await f(tx); await tx.CommitAsync(); return r; }
        async Task<string> Code(Func<Task> f) { try { await f(); return ""; } catch (AppException e) { return e.Code; } }

        Assert.False((await buyer.Get("/api/gift-cards/options")).Json["can_buy"]!.GetValue<bool>());
        // off by default; the purchase switch is separate from the staff-issue switch
        Assert.Equal("gift_cards_off", await Code(() => Tx(t => GiftCards.StartPurchaseAsync(t, gw, integ, user, 20000))));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { gift_cards = new { enabled = true, min_paise = 10000, max_paise = 100000 } })).Status);
        Assert.Equal("gift_cards_off", await Code(() => Tx(t => GiftCards.StartPurchaseAsync(t, gw, integ, user, 20000))));
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { gift_cards = new { allow_purchase = true } })).Status);
        var opts = (await buyer.Get("/api/gift-cards/options")).Json;
        Assert.True(opts["can_buy"]!.GetValue<bool>()); Assert.Equal(10000, opts["min_paise"]!.GetValue<int>());
        Assert.Equal("invalid_amount", await Code(() => Tx(t => GiftCards.StartPurchaseAsync(t, gw, integ, user, 500000))));

        var started = await Tx(t => GiftCards.StartPurchaseAsync(t, gw, integ, user, 20000));
        var pid = Guid.Parse(started["id"]!.GetValue<string>());
        Assert.Equal("cashfree", started["gateway"]!.GetValue<string>()); Assert.Null(started["code"]); // Razorpay skipped, no code before payment

        async Task<long> Cards() => await db.QueryFirstOrDefaultAsync<long>("SELECT COUNT(*) FROM gift_cards");
        Assert.Equal("created", (await Tx(t => GiftCards.CheckPurchaseAsync(t, gw, user.Id, pid)))["status"]!.GetValue<string>());
        pay.Now = [new GatewayAttempt("a1", "failed", "upi", 20000, "declined")];
        Assert.Equal("failed", (await Tx(t => GiftCards.CheckPurchaseAsync(t, gw, user.Id, pid)))["status"]!.GetValue<string>());
        Assert.Equal(0, await Cards());
        pay.Now = [new GatewayAttempt("a2", "captured", "upi", 100, "")];
        Assert.Equal("failed", (await Tx(t => GiftCards.CheckPurchaseAsync(t, gw, user.Id, pid)))["status"]!.GetValue<string>());
        Assert.Equal(0, await Cards());
        Assert.Equal("not_found", await Code(() => Tx(t => GiftCards.CheckPurchaseAsync(t, gw, Guid.Parse(other.Id), pid))));

        var pid2 = Guid.Parse((await Tx(t => GiftCards.StartPurchaseAsync(t, gw, integ, user, 20000)))["id"]!.GetValue<string>());
        pay.Now = [new GatewayAttempt("a3", "captured", "upi", 20000, "")];
        var a = await Tx(t => GiftCards.CheckPurchaseAsync(t, gw, user.Id, pid2));
        var b = await Tx(t => GiftCards.CheckPurchaseAsync(t, gw, user.Id, pid2));
        Assert.Equal("issued", a["status"]!.GetValue<string>());
        Assert.StartsWith("GC", a["code"]!.GetValue<string>());
        Assert.Equal(a["code"]!.GetValue<string>(), b["code"]!.GetValue<string>());
        Assert.Equal(1, await Cards());
        Assert.Equal(20000, (await buyer.Post("/api/gift-cards/balance", new { code = a["code"]!.GetValue<string>() })).Json["balance_paise"]!.GetValue<int>());
        // staff see every purchase with its state; a shopper does not
        var listed = (await admin.Get("/api/admin/growth/gift-card-purchases")).Json["items"]!.AsArray();
        Assert.Equal(1, listed.Count(x => x!["status"]!.GetValue<string>() == "issued"));
        Assert.Equal(2, listed.Count);
        Assert.NotNull(listed[0]!["gift_card_id"]);
        Assert.Equal(403, (await buyer.Get("/api/admin/growth/gift-card-purchases")).Status);
    }

    [Fact]
    public async Task A_gift_card_coupon_works_only_for_the_person_who_made_it()
    {
        var admin = await Admin(); var owner = await LoginPhone("9880000093"); var other = await LoginPhone("9880000094");
        Assert.Equal(200, (await admin.Put("/api/admin/growth/settings", new { gift_cards = new { enabled = true, min_paise = 10000, max_paise = 100000 } })).Status);
        var card = (await admin.Post("/api/admin/growth/gift-cards", new { amount_paise = 20000 })).Json["items"]![0]!["code"]!.GetValue<string>();
        var made = (await owner.Post("/api/gift-cards/redeem", new { code = card })).Json["code"]!.GetValue<string>();
        using var scope = Factory.Services.CreateScope();
        var coupons = scope.ServiceProvider.GetRequiredService<ICouponsBAL>();
        var ex = await Assert.ThrowsAsync<AppException>(() => coupons.EvaluateAsync(made, Guid.Parse(other.Id), []));
        Assert.Equal("coupon_invalid", ex.Code);
        try { await coupons.EvaluateAsync(made, Guid.Parse(owner.Id), []); } catch (AppException e) { Assert.NotEqual("coupon_invalid", e.Code); }
    }
}
