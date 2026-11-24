using BAL.Interface;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.ShopAssistant;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>The reply pipeline and the customer tools (reference: shop_assistant/agent.py guided mode + tools.py).
/// Rules every tool follows: the customer is the signed-in session, never an argument; records are fetched with the
/// customer's id in the query itself; outputs come from the view whitelists; tools that change something only
/// prepare it - the customer confirms on screen.</summary>
public partial class ShopAssistantBAL
{
    private static readonly Dictionary<string, string> IntentFeature = new()
    {
        ["track"] = "orders", ["cancel"] = "cancel_orders", ["return"] = "returns_refunds", ["damaged"] = "returns_refunds",
        ["refund"] = "returns_refunds", ["tickets"] = "tickets", ["ticket_status"] = "tickets", ["human"] = "tickets",
        ["grievance"] = "tickets", ["search"] = "product_search",
    };
    private static readonly HashSet<string> LoginIntents = ["track", "cancel", "return", "damaged", "tickets", "ticket_status", "human", "grievance"];
    private static readonly Dictionary<string, string> GuestArticle = new()
    {
        ["track"] = "track order", ["cancel"] = "cancel order", ["return"] = "return product",
        ["damaged"] = "damaged wrong item", ["refund"] = "refund", ["tickets"] = "contact support",
        ["ticket_status"] = "contact support", ["human"] = "contact support", ["grievance"] = "grievance",
        ["payment"] = "payment failed money deducted",
    };
    private static readonly Dictionary<string, (string Label, string Link)> FeaturePage = new()
    {
        ["product_search"] = ("Search", "/search"), ["orders"] = ("My orders", "/orders"),
        ["cancel_orders"] = ("My orders", "/orders"), ["returns_refunds"] = ("My orders", "/orders"),
        ["tickets"] = ("Support", "/support"), ["help_articles"] = ("Help", "/contact"),
    };
    private static readonly Dictionary<string, string> StatusPhrase = new()
    {
        ["Order placed"] = "placed and waiting for the seller to confirm it",
        ["Confirmed by the seller"] = "confirmed by the seller", ["Packed"] = "packed and ready to ship",
        ["Shipped"] = "on the way", ["Partly delivered"] = "partly delivered", ["Delivered"] = "delivered",
        ["Cancelled"] = "cancelled", ["Waiting for payment"] = "waiting for payment",
    };

    private sealed class Ctx
    {
        public UserModel? User;
        public Guid ChatId;
        public string PagePath = "/";
        public Dictionary<string, bool> Features = [];
        public List<string> KbHits = [];
        public Dictionary<string, object?> Facts = [];
    }

    private static bool FeatureOn(Ctx ctx, string f) => !ctx.Features.TryGetValue(f, out var on) || on;

    private static JsonObject SignInCard(Ctx ctx, string reason)
    {
        var next = ctx.PagePath.StartsWith('/') && !ctx.PagePath.StartsWith("//") ? ctx.PagePath : "/";
        return new JsonObject { ["type"] = "signin", ["text"] = reason, ["link"] = $"/login?next={next}" };
    }

    // ------------------------------------------------------------------ tools

    private sealed record ToolOut(JsonObject Data, List<JsonObject> Cards);

    private async Task<ToolOut> CallToolAsync(Ctx ctx, string name, Dictionary<string, object?> args)
    {
        // Feature and sign-in gates (reference: tools.execute).
        var feature = name switch
        {
            "search_products" => "product_search",
            "help_articles" => "help_articles",
            "my_orders" or "order_details" => "orders",
            "my_returns_and_refunds" => "returns_refunds",
            "my_tickets" or "ticket_details" or "prepare_ticket" => "tickets",
            "prepare_cancellation" => "cancel_orders",
            _ => "",
        };
        var login = name is "my_orders" or "order_details" or "my_returns_and_refunds" or "my_tickets"
            or "ticket_details" or "prepare_ticket" or "prepare_cancellation";
        if (feature.Length > 0 && !FeatureOn(ctx, feature))
        {
            var (label, link) = FeaturePage.GetValueOrDefault(feature, ("Help", "/contact"));
            return new ToolOut(new JsonObject { ["error"] = $"This is not available in chat. The customer can use the {label} page." },
                [new JsonObject { ["type"] = "link", ["text"] = $"Open {label}", ["link"] = link }]);
        }
        if (login && ctx.User is null)
            return new ToolOut(new JsonObject { ["error"] = "sign_in_required", ["message"] = "The customer must sign in first." },
                [SignInCard(ctx, "Please sign in so I can see your orders, returns and requests.")]);
        return name switch
        {
            "search_products" => await SearchProductsToolAsync(ctx, args),
            "help_articles" => await HelpArticlesToolAsync(ctx, args),
            "my_orders" => await MyOrdersToolAsync(ctx, args),
            "order_details" => await OrderDetailsToolAsync(ctx, args),
            "my_returns_and_refunds" => await MyReturnsAndRefundsToolAsync(ctx),
            "my_tickets" => await MyTicketsToolAsync(ctx),
            "ticket_details" => await TicketDetailsToolAsync(ctx, args),
            "prepare_ticket" => await PrepareTicketToolAsync(ctx, args),
            "prepare_cancellation" => await PrepareCancellationToolAsync(ctx, args),
            _ => new ToolOut(new JsonObject { ["error"] = $"There is no tool called {name}." }, []),
        };
    }

    private static string? AStr(Dictionary<string, object?> a, string key) =>
        a.TryGetValue(key, out var v) ? v?.ToString() : null;

    private async Task<ToolOut> SearchProductsToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var query = (AStr(a, "query") ?? "")[..Math.Min(100, (AStr(a, "query") ?? "").Length)];
        long? minP = ToPaise(AStr(a, "min_price_rupees")), maxP = ToPaise(AStr(a, "max_price_rupees"));
        var rows = await FindProductsAsync(query, minP, maxP, AStr(a, "sort") ?? "relevance");
        var cards = (await catalogBal.ProductCardsAsync(rows)).Select(ShopCardView).ToList();
        if (cards.Count == 0) return new ToolOut(new JsonObject { ["products"] = new JsonArray(), ["note"] = "No matching products." }, []);
        var link = query.Length > 0 ? $"/search?q={query.Replace(' ', '+')}" : "/search";
        return new ToolOut(new JsonObject { ["products"] = new JsonArray(cards.Select(ProductData).ToArray()) },
            [new JsonObject
            {
                ["type"] = "products", ["title"] = query.Length > 0 ? $"Products for “{query}”" : "Products",
                ["items"] = new JsonArray(cards.Select(c => (JsonNode)c.DeepClone()).ToArray()), ["link"] = link,
            }]);

        static long? ToPaise(string? v)
        {
            if (string.IsNullOrWhiteSpace(v)) return null;
            return double.TryParse(v, out var d) ? Math.Max(0, (long)(d * 100)) : null;
        }
    }

    private static readonly string[] CardFields =
        ["id", "slug", "title", "brand", "image", "price", "mrp", "discount_pct", "rating_avg", "rating_count", "in_stock", "seller_name"];

    /// <summary>The chat shows only these product fields (a whitelist). Reference: tools.CARD_FIELDS.</summary>
    private static JsonObject ShopCardView(JsonObject card)
    {
        var outp = new JsonObject();
        foreach (var k in CardFields)
            if (card.ContainsKey(k)) outp[k] = card[k]?.DeepClone();
        return outp;
    }

    private static JsonNode ProductData(JsonObject c) => new JsonObject
    {
        ["title"] = c.Str("title"), ["brand"] = c.Str("brand"), ["price"] = ShopKb.Inr(c.Long("price")),
        ["mrp"] = c.Long("mrp") > c.Long("price") ? ShopKb.Inr(c.Long("mrp")) : "",
        ["discount_pct"] = c.Long("discount_pct"), ["rating"] = c["rating_avg"]?.DeepClone(),
        ["ratings"] = c.Long("rating_count"), ["in_stock"] = c.Bool("in_stock"), ["seller"] = c.Str("seller_name"),
        ["link"] = $"/p/{c.Str("slug")}",
    };

    private async Task<ToolOut> HelpArticlesToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var query = (AStr(a, "query") ?? "")[..Math.Min(300, (AStr(a, "query") ?? "").Length)];
        var hits = await KbSearchAsync(query, ctx.Facts, 3, 1.5);
        ctx.KbHits.AddRange(hits.Select(h => h.Id));
        if (hits.Count == 0)
            return new ToolOut(new JsonObject { ["articles"] = new JsonArray(), ["note"] = "No help article matches. Offer to open a support request." }, []);
        return new ToolOut(new JsonObject
        {
            ["articles"] = new JsonArray(hits.Select(h => (JsonNode)new JsonObject
            {
                ["title"] = h.Title, ["text"] = h.Body[..Math.Min(1500, h.Body.Length)], ["link"] = h.Link,
            }).ToArray()),
        }, [new JsonObject { ["type"] = "article", ["title"] = hits[0].Title, ["text"] = hits[0].Body, ["link"] = hits[0].Link }]);
    }

    /// <summary>The customer's order by number (or package number); null when it is not theirs or does not exist.</summary>
    private async Task<OrderModel?> OwnOrderAsync(Ctx ctx, string? number)
    {
        if (number is { Length: > 0 })
        {
            var m = ShopIntents.OrderRe.Match(number);
            if (!m.Success) return null;
            return await orders.OwnByNumberAsync(ctx.User!.Id, m.Groups[1].Value.ToUpperInvariant());
        }
        return (await orders.RecentForUserAsync(ctx.User!.Id, 1)).FirstOrDefault();
    }

    private async Task<ToolOut> MyOrdersToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var limit = 5;
        if (a.TryGetValue("limit", out var lv) && int.TryParse(lv?.ToString(), out var l)) limit = Math.Clamp(l, 1, 10);
        var rows = await orders.RecentForUserAsync(ctx.User!.Id, limit);
        var cards = await OrderCardsAsync(rows);
        if (cards.Count == 0) return new ToolOut(new JsonObject { ["orders"] = new JsonArray(), ["note"] = "The customer has no orders yet." }, []);
        return new ToolOut(new JsonObject
        {
            ["orders"] = new JsonArray(cards.Select(c => (JsonNode)new JsonObject
            {
                ["number"] = c.Str("number"), ["placed_at"] = c.Str("placed_at"), ["status"] = c.Str("status"),
                ["total_text"] = c.Str("total_text"), ["payment"] = c.Str("payment"), ["item_count"] = c.Long("item_count"),
                ["items"] = new JsonArray((c["items"] as JsonArray ?? []).Select(i => (JsonNode)JsonValue.Create((i as JsonObject)!.Str("title"))).ToArray()),
            }).ToArray()),
        }, [new JsonObject
        {
            ["type"] = "orders", ["title"] = "Your recent orders",
            ["items"] = new JsonArray(cards.Select(c => (JsonNode)c.DeepClone()).ToArray()), ["link"] = "/orders",
        }]);
    }

    private async Task<ToolOut> OrderDetailsToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var raw = AStr(a, "order_number");
        var o = await OwnOrderAsync(ctx, string.IsNullOrWhiteSpace(raw) ? null : raw);
        if (o is null)
            return new ToolOut(new JsonObject { ["error"] = "No order with that number on this account. Ask the customer to check the number, or show their recent orders." }, []);
        var v = await OrderViewAsync(o);
        return new ToolOut(v, [new JsonObject { ["type"] = "order", ["order"] = v.DeepClone() }]);
    }

    private async Task<ToolOut> MyReturnsAndRefundsToolAsync(Ctx ctx)
    {
        var rets = await ReturnListAsync(ctx.User!.Id);
        var refunded = await orders.RefundedForUserAsync(ctx.User.Id, 5);
        var refunds = new List<JsonObject>();
        foreach (var o in refunded)
        {
            var v = await OrderViewAsync(o);
            foreach (var r in v["refunds"] as JsonArray ?? [])
                if (r is JsonObject ro) refunds.Add(new JsonObject { ["order"] = o.Number, ["amount"] = ro.Str("amount"), ["status"] = ro.Str("status"), ["at"] = ro.Str("at") });
        }
        var data = new JsonObject
        {
            ["returns"] = new JsonArray(rets.Select(r => (JsonNode)r.DeepClone()).ToArray()),
            ["refunds"] = new JsonArray(refunds.Select(r => (JsonNode)r).ToArray()),
        };
        if (rets.Count == 0 && refunds.Count == 0)
        {
            data["note"] = "No returns or refunds on this account.";
            return new ToolOut(data, []);
        }
        return new ToolOut(data, [new JsonObject
        {
            ["type"] = "returns", ["title"] = "Your returns and refunds",
            ["returns"] = new JsonArray(rets.Select(r => (JsonNode)r.DeepClone()).ToArray()),
            ["refunds"] = new JsonArray(refunds.Select(r => (JsonNode)r.DeepClone()).ToArray()),
        }]);
    }

    private async Task<ToolOut> MyTicketsToolAsync(Ctx ctx)
    {
        var rows = (await tickets.ForUserAsync(ctx.User!.Id, 8)).ToList();
        var items = rows.Select(t => TicketView(t)).ToList();
        if (items.Count == 0) return new ToolOut(new JsonObject { ["tickets"] = new JsonArray(), ["note"] = "No support requests yet." }, []);
        return new ToolOut(new JsonObject
        {
            ["tickets"] = new JsonArray(items.Select(t => (JsonNode)new JsonObject
            {
                ["number"] = t.Str("number"), ["subject"] = t.Str("subject"),
                ["status_label"] = t.Str("status_label"), ["updated_at"] = t.Str("updated_at"),
            }).ToArray()),
        }, [new JsonObject
        {
            ["type"] = "tickets", ["title"] = "Your support requests",
            ["items"] = new JsonArray(items.Select(t => (JsonNode)t.DeepClone()).ToArray()), ["link"] = "/support",
        }]);
    }

    private async Task<ToolOut> TicketDetailsToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var m = ShopIntents.TicketRe.Match(AStr(a, "ticket_number") ?? "");
        SupportTicketModel? t = null;
        if (m.Success)
            t = (await tickets.ForUserAsync(ctx.User!.Id, 100)).FirstOrDefault(x => x.Number == m.Groups[1].Value.ToUpperInvariant());
        if (t is null) return new ToolOut(new JsonObject { ["error"] = "No request with that number on this account." }, []);
        var msgs = (await tickets.MessagesAsync(t.Id)).ToList();
        var v = TicketView(t, msgs);
        return new ToolOut(v, [new JsonObject { ["type"] = "tickets", ["title"] = "", ["items"] = new JsonArray(v.DeepClone()), ["link"] = v.Str("link") }]);
    }

    private async Task<ToolOut> PrepareTicketToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var cat = AStr(a, "category") ?? "other";
        if (!SupportTicketBAL.CategoryLabels.ContainsKey(cat)) cat = "other";
        var recent = await orders.RecentForUserAsync(ctx.User!.Id, 10);
        OrderModel? order = null;
        if (!string.IsNullOrWhiteSpace(AStr(a, "order_number"))) order = await OwnOrderAsync(ctx, AStr(a, "order_number"));
        var card = new JsonObject
        {
            ["type"] = "ticket_form", ["category"] = cat,
            ["categories"] = new JsonArray(SupportTicketBAL.CategoryLabels.Select(kv => (JsonNode)new JsonObject { ["code"] = kv.Key, ["label"] = kv.Value }).ToArray()),
            ["subject"] = (AStr(a, "subject") ?? "")[..Math.Min(120, (AStr(a, "subject") ?? "").Length)],
            ["message"] = (AStr(a, "message") ?? "")[..Math.Min(3000, (AStr(a, "message") ?? "").Length)],
            ["order_id"] = order?.Id.ToString() ?? "",
            ["orders"] = new JsonArray(recent.Select(o => (JsonNode)new JsonObject { ["id"] = o.Id.ToString(), ["number"] = o.Number }).ToArray()),
            ["grievance"] = a.TryGetValue("grievance", out var gv) && gv?.ToString() == "True" || a.TryGetValue("grievance", out var gv2) && gv2?.ToString() == "true",
        };
        return new ToolOut(new JsonObject { ["status"] = "The form is on the customer's screen. It is sent only when they press Send. Do not say it was created." }, [card]);
    }

    private async Task<ToolOut> PrepareCancellationToolAsync(Ctx ctx, Dictionary<string, object?> a)
    {
        var raw = AStr(a, "order_number") ?? "";
        var o = await OwnOrderAsync(ctx, raw);
        if (o is null) return new ToolOut(new JsonObject { ["error"] = "No order with that number on this account." }, []);
        var v = await OrderViewAsync(o);
        var m = ShopIntents.OrderRe.Match(raw);
        var pkgNo = m.Success && m.Groups[2].Success ? (m.Groups[1].Value + m.Groups[2].Value).ToUpperInvariant() : null;
        var pkgs = (v["packages"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(p => p.Bool("can_cancel") && (pkgNo is null || p.Str("number") == pkgNo)).ToList();
        if (pkgs.Count == 0)
        {
            var shipped = (v["packages"] as JsonArray ?? []).OfType<JsonObject>().Any(p => p.Str("status") is "shipped" or "delivered");
            var why = shipped ? "It has already shipped; it can be returned after delivery if returnable." : "Nothing in it can be cancelled now.";
            return new ToolOut(new JsonObject { ["error"] = $"This order cannot be cancelled. {why}", ["order"] = v.Str("number") },
                [new JsonObject { ["type"] = "order", ["order"] = v.DeepClone() }]);
        }
        var subId = pkgNo is not null ? Guid.Parse(pkgs[0].Str("id")) : (Guid?)null;
        var reason = ((AStr(a, "reason") ?? "").Trim() is { Length: > 0 } r ? r : "Changed my mind")[..Math.Min(200, ((AStr(a, "reason") ?? "").Trim() is { Length: > 0 } r2 ? r2 : "Changed my mind").Length)];
        var titles = pkgs.SelectMany(p => (p["items"] as JsonArray ?? []).OfType<JsonObject>().Select(i => i.Str("title"))).ToList();
        var target = pkgNo is not null ? $"Package {pkgNo}" : $"Order {o.Number}";
        var summary = $"Cancel {char.ToLower(target[0]) + target[1..]}: {string.Join(", ", titles)[..Math.Min(180, string.Join(", ", titles).Length)]}";
        var act = new ShopChatActionModel
        {
            Id = Guid.NewGuid(), SessionId = ctx.ChatId, UserId = ctx.User!.Id, Kind = "cancel_order",
            Params = new JsonObject
            {
                ["order_id"] = o.Id.ToString(), ["sub_order_id"] = subId?.ToString(), ["reason"] = reason, ["target"] = target,
            }.ToJsonString(),
            Summary = summary[..Math.Min(300, summary.Length)], Status = "pending", CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await dal.InsertActionAsync(act);
        var refundNote = v.Str("payment") == "Paid online"
            ? "Your online payment will be refunded to the original method within 5 to 7 working days." : "";
        var card = new JsonObject
        {
            ["type"] = "confirm", ["action_id"] = act.Id.ToString(), ["title"] = "Cancel this?", ["summary"] = summary,
            ["items"] = new JsonArray(titles.Take(6).Select(t => (JsonNode)JsonValue.Create(t)).ToArray()),
            ["note"] = refundNote, ["confirm_label"] = "Yes, cancel", ["status"] = "pending",
        };
        return new ToolOut(new JsonObject { ["status"] = "Waiting for the customer to press Confirm. Nothing is cancelled yet.", ["summary"] = summary }, [card]);
    }

    /// <summary>find_products (reference: tools.find_products): every word first, then any word, over the public catalog.</summary>
    private async Task<IReadOnlyList<ProductModel>> FindProductsAsync(string query, long? minPrice, long? maxPrice, string sort, int limit = 6)
    {
        var words = ShopKb.Tokens(query);
        if (words.Count == 0)
            return await dal.FindProductsNoWordsAsync(minPrice, maxPrice, sort, limit);
        foreach (var anyWord in new[] { false, true })
        {
            var rows = await dal.FindProductsAsync(query.Trim()[..Math.Min(60, query.Trim().Length)], words.Take(8).ToList(), anyWord,
                minPrice, maxPrice, sort, limit);
            if (rows.Count > 0) return rows;
        }
        return [];
    }
}
