using System.Text.Json.Nodes;
using BAL.Interface;

namespace Tests.StorefrontCatalog;

/// <summary>Reference: tests/test_regional.py — regional settings and region suggestion, charge plan, saved cards, translations.</summary>
public class RegionalTests(CatalogFactory factory) : CatalogTestBase(factory)
{
    [Fact]
    public async Task Settings_and_region_suggestion()
    {
        var admin = await Admin();
        var r = await admin.Get("/api/admin/regional");
        Assert.Equal(200, r.Status);
        Assert.Equal("INR", r["currencies"][0]!["code"]!.GetValue<string>());
        Assert.False(r["ai_ready"].GetValue<bool>());
        r = await admin.Put("/api/admin/regional", JsonNode.Parse("""
            {"currencies": [{"code": "INR"}, {"code": "USD", "rate": "0.012", "enabled": true}, {"code": "KWD", "rate": "0.0037", "enabled": true}],
             "languages": [{"code": "en"}, {"code": "ta", "enabled": true}, {"code": "ar", "enabled": true}],
             "regions": [{"country": "US", "currency": "USD", "language": "en"}, {"country": "KW", "currency": "KWD", "language": "ar"}],
             "markup_bps": 200}
            """)!);
        Assert.Equal(200, r.Status);
        Assert.Equal(1, await Scalar<long>("SELECT COUNT(*) FROM audit_logs WHERE action = 'regional.update' AND detail = 'currencies, languages, markup_bps, regions'"));
        var pub = (await Visitor.Get("/api/regional?country=KW")).Body!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"currency": "KWD", "language": "ar"}"""), pub["suggest"]));
        Assert.Equal(new HashSet<string> { "INR", "USD", "KWD" }, pub["currencies"]!.AsArray().Select(c => c!["code"]!.GetValue<string>()).ToHashSet());
        var kwd = pub["currencies"]!.AsArray().First(c => c!["code"]!.GetValue<string>() == "KWD")!;
        Assert.Equal(3, kwd["digits"]!.GetValue<int>());
        Assert.True(Math.Abs(kwd["rate"]!.GetValue<double>() - 0.0037 * 1.02) < 1e-9); // the 2% conversion charge is included
        Assert.True(pub["languages"]!.AsArray().First(x => x!["code"]!.GetValue<string>() == "ar")!["rtl"]!.GetValue<bool>());
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"currency": "INR", "language": "en"}"""), (await Visitor.Get("/api/regional?country=FR"))["suggest"]));
        Assert.Equal(422, (await Visitor.Get("/api/regional?country=KWT")).Status);
        // mistakes are explained
        var bad = await admin.Put("/api/admin/regional", JsonNode.Parse("""{"currencies": [{"code": "US", "rate": "1"}]}""")!);
        Assert.Equal(400, bad.Status);
        Assert.Contains("3-letter", bad["error"]["message"]!.GetValue<string>());
        Assert.Equal(400, (await admin.Put("/api/admin/regional", JsonNode.Parse("""{"default_currency": "EUR"}""")!)).Status);
        var noPay = await admin.Put("/api/admin/regional", JsonNode.Parse("""{"pay_methods": {"upi": false, "card": false, "netbanking": false, "wallet": false, "emi": false, "paylater": false}}""")!);
        Assert.Equal("no_pay_method", noPay.ErrorCode);
        Assert.Equal("invalid_rate", (await admin.Put("/api/admin/regional", JsonNode.Parse("""{"currencies": [{"code": "USD", "rate": "-1"}]}""")!)).ErrorCode);
        // only staff with the settings permission
        var buyer = await User("9770000001");
        Assert.Equal(403, (await buyer.Get("/api/admin/regional")).Status);
        Assert.Equal(401, (await Visitor.Get("/api/admin/regional")).Status);
        // refreshing rates with no automatic currency says so (no network call)
        var rates = await admin.Post("/api/admin/regional/rates");
        Assert.False(rates["changed"].GetValue<bool>());
        Assert.Equal("No currency is set to update automatically", rates["message"].GetValue<string>());
    }

    [Fact]
    public async Task Charge_plan_in_rupees_or_the_shoppers_currency()
    {
        var cfg = await With<IRegionalBAL, JsonObject>(r => r.UpdateAsync(JsonNode.Parse("""{"currencies": [{"code": "INR"}, {"code": "USD", "rate": "0.012", "enabled": true}]}""")!.AsObject()));
        var (cur, rate, amount) = await With<IRegionalBAL, (string, decimal, long?)>(r => Task.FromResult(r.ChargePlan(cfg, "USD", 125000)));
        Assert.Equal(("INR", 1m, (long?)null), (cur, rate, amount)); // charge in rupees by default
        cfg = await With<IRegionalBAL, JsonObject>(r => r.UpdateAsync(JsonNode.Parse("""{"charge_in": "shopper"}""")!.AsObject()));
        (cur, rate, amount) = await With<IRegionalBAL, (string, decimal, long?)>(r => Task.FromResult(r.ChargePlan(cfg, "USD", 125000)));
        Assert.Equal("USD", cur);
        Assert.Equal((long)Math.Round(125000 / 100.0 * 0.012 * 100), amount);
        (cur, _, amount) = await With<IRegionalBAL, (string, decimal, long?)>(r => Task.FromResult(r.ChargePlan(cfg, "JPY", 125000))); // not switched on
        Assert.Equal("INR", cur);
        Assert.Null(amount);
        Assert.Equal(15000, await With<IRegionalBAL, long>(r => Task.FromResult(r.ConvertMinor(125000, 0.012m, "KWD"))));
    }

    [Fact]
    public async Task Payment_methods_and_saved_cards()
    {
        var admin = await Admin();
        var r = await admin.Put("/api/admin/regional", JsonNode.Parse("""{"pay_methods": {"emi": false, "paylater": false}, "card_networks": ["visa", "rupay", "nope"]}""")!);
        Assert.False(r["pay_methods"]["emi"]!.GetValue<bool>());
        Assert.True(r["pay_methods"]["upi"]!.GetValue<bool>());
        Assert.Equal(["visa", "rupay"], r["card_networks"].AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal(["visa", "rupay"], (await Visitor.Get("/api/regional"))["card_networks"].AsArray().Select(x => x!.GetValue<string>()));

        var buyer = await User("9770000005");
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"enabled": true, "items": []}"""), (await buyer.Get("/api/account/cards")).Body));
        // the payments module gave the shopper a Razorpay customer at checkout
        var cust = Factory.Gateway.AddCustomer();
        await Sql("UPDATE users SET razorpay_customer_id = @cust WHERE id = @id", new { cust, id = buyer.UserId });
        // the shopper saves a card in Razorpay's window; their account lists it (never the number)
        var tid = Factory.Gateway.SaveCard(cust, "4242");
        var cards = (await buyer.Get("/api/account/cards")).Body!;
        var card = cards["items"]![0]!;
        Assert.Equal("4242", card["last4"]!.GetValue<string>());
        Assert.Equal("visa", card["network"]!.GetValue<string>());
        Assert.Equal(12, card["expiry_month"]!.GetValue<int>());
        Assert.False(card.AsObject().ContainsKey("number"));
        // another shopper cannot see or remove it
        var other = await User("9770000006");
        Assert.Empty((await other.Get("/api/account/cards"))["items"].AsArray());
        Assert.Equal(404, (await other.Delete($"/api/account/cards/{tid}")).Status);
        Assert.Equal(404, (await buyer.Delete("/api/account/cards/card_123")).Status);
        // Razorpay failing is reported, not hidden
        Factory.Gateway.FailNext = "Server busy";
        var failed = await buyer.Get("/api/account/cards");
        Assert.Equal(502, failed.Status);
        Assert.Equal("Could not load your saved cards right now: Server busy", failed["error"]["message"]!.GetValue<string>());
        Assert.Equal(200, (await buyer.Delete($"/api/account/cards/{tid}")).Status);
        Assert.Empty((await buyer.Get("/api/account/cards"))["items"].AsArray());
        Assert.Equal(1, await Scalar<long>("SELECT COUNT(*) FROM audit_logs WHERE action = 'card.remove'"));
        // saving cards switched off is reported to the account page
        await admin.Put("/api/admin/regional", JsonNode.Parse("""{"save_cards": false}""")!);
        Assert.False((await buyer.Get("/api/account/cards"))["enabled"].GetValue<bool>());
        Assert.Equal(401, (await Visitor.Get("/api/account/cards")).Status);
    }

    [Fact]
    public async Task Translations()
    {
        var admin = await Admin();
        await admin.Put("/api/admin/regional", JsonNode.Parse("""{"languages": [{"code": "en"}, {"code": "ta", "enabled": true}]}""")!);
        Factory.Ai.Ready = true;
        Assert.True((await admin.Get("/api/admin/regional"))["ai_ready"].GetValue<bool>());
        var r = await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = new[] { "Wrap as a gift", "₹499", "Wrap as a gift", "  " } });
        Assert.Equal(200, r.Status);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"Wrap as a gift": "[ta] Wrap as a gift"}"""), r["translations"])); // amounts and blanks are left alone
        // a staff correction wins, and the AI never overwrites it
        Assert.Equal(200, (await admin.Put("/api/admin/translations", new { lang = "ta", source = "Wrap as a gift", text = "பரிசாகக் கட்டு" })).Status);
        r = await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = new[] { "Wrap as a gift" } });
        Assert.Equal("பரிசாகக் கட்டு", r["translations"]["Wrap as a gift"]!.GetValue<string>());
        var lst = (await admin.Get("/api/admin/translations?lang=ta&q=gift")).Body!;
        Assert.Equal(1, lst["total"]!.GetValue<long>());
        Assert.Equal("manual", lst["items"]![0]!["origin"]!.GetValue<string>());
        // AI lines can be cleared to translate again; corrections stay
        await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = new[] { "Notify me" } });
        Assert.Equal(1, (await admin.Delete("/api/admin/translations?lang=ta"))["removed"].GetValue<int>());
        Assert.Equal(1, (await admin.Get("/api/admin/translations?lang=ta"))["total"].GetValue<long>());
        Assert.Equal(422, (await admin.Get("/api/admin/translations?lang=ta&origin=robot")).Status);
        // a language that is off is refused; daily AI limit respected
        var off = await Visitor.Post("/api/i18n/translate", new { lang = "fr", texts = new[] { "Hello" } });
        Assert.Equal(404, off.Status);
        Assert.Equal("language_off", off.ErrorCode);
        await admin.Put("/api/admin/regional", JsonNode.Parse("""{"ai_translate_daily_max": 0}""")!);
        Assert.Empty((await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = new[] { "Track order" } }))["translations"].AsObject());
        Assert.Equal(422, (await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = Enumerable.Repeat("x", 81).ToArray() })).Status);
    }

    [Fact]
    public async Task Builtin_tamil_and_hindi_without_ai()
    {
        var admin = await Admin();
        await admin.Put("/api/admin/regional", JsonNode.Parse("""{"languages": [{"code": "en"}, {"code": "ta", "enabled": true}, {"code": "hi", "enabled": true}]}""")!);
        var r = (await Visitor.Post("/api/i18n/translate",
            new { lang = "ta", texts = new[] { "Add to cart", "Free delivery on orders over {0} from a seller", "Unknown words" } }))["translations"];
        Assert.Equal("கார்ட்டில் சேர்", r["Add to cart"]!.GetValue<string>());
        Assert.Contains("{0}", r["Free delivery on orders over {0} from a seller"]!.GetValue<string>());
        Assert.False(r.AsObject().ContainsKey("Unknown words"));
        Assert.Equal("अभी खरीदें", (await Visitor.Post("/api/i18n/translate", new { lang = "hi", texts = new[] { "Buy now" } }))["translations"]["Buy now"]!.GetValue<string>());
        // a staff correction wins over the built-in line
        await admin.Put("/api/admin/translations", new { lang = "ta", source = "Buy now", text = "உடனே வாங்கு" });
        Assert.Equal("உடனே வாங்கு", (await Visitor.Post("/api/i18n/translate", new { lang = "ta", texts = new[] { "Buy now" } }))["translations"]["Buy now"]!.GetValue<string>());
    }
}
