using BAL.Interface;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using BAL.ShopAssistant;
using Microsoft.Extensions.Logging;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>The guided pipeline (reference: shop_assistant/agent.py guided + routers/shop_assistant.py endpoints):
/// the same tools, chosen by the intent, with sentences from replies. The customer always gets an answer.</summary>
public partial class ShopAssistantBAL
{
    private static readonly TimeZoneInfo Ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");

    private static string DateShort(string? iso)
    {
        if (string.IsNullOrEmpty(iso) || !DateTimeOffset.TryParse(iso, out var d)) return "";
        var ist = TimeZoneInfo.ConvertTime(d, Ist);
        return $"{ist.Day} {ist:MMM}";
    }

    private string OrderSentence(JsonObject v, string lang)
    {
        var parts = new List<string>
        {
            ShopReplies.T_("order_status", lang, ("number", v.Str("number")),
                ("status", StatusPhrase.GetValueOrDefault(v.Str("status"), v.Str("status").ToLowerInvariant()))),
        };
        foreach (var p in (v["packages"] as JsonArray ?? []).OfType<JsonObject>())
            if (p.Str("status") == "shipped")
            {
                var tr = p.Str("tracking_number").Length > 0 ? $", tracking {p.Str("tracking_number")}" : "";
                parts.Add(ShopReplies.T_("pkg_shipped", lang, ("number", p.Str("number")),
                    ("courier", p.Str("courier").Length > 0 ? p.Str("courier") : "the courier"), ("tracking", tr)));
            }
        var nxt = (v["packages"] as JsonArray ?? []).OfType<JsonObject>()
            .Where(p => p.Str("status") is not ("delivered" or "cancelled") && p.Str("expected_delivery_at").Length > 0)
            .Select(p => p.Str("expected_delivery_at")).OrderBy(x => x).FirstOrDefault();
        if (nxt is not null) parts.Add(ShopReplies.T_("pkg_expected", lang, ("date", DateShort(nxt))));
        return string.Join(' ', parts);
    }

    private async Task<string> TranscriptAsync(Guid chatId, string current)
    {
        var rows = (await dal.RecentUserTextsAsync(chatId, 6)).Reverse().Select(r => r.Trim()).Where(r => r.Length > 0).ToList();
        if (rows.Count == 0 || rows[^1] != current.Trim()) rows.Add(current.Trim());
        return string.Join('\n', rows.TakeLast(6).Select(line => $"- {line[..Math.Min(500, line.Length)]}"));
    }

    private async Task<(string Answer, List<JsonObject> Cards)> GuidedAsync(Ctx ctx, ShopIntents.Intent it, string text, JsonObject cfg, string lastIntent)
    {
        var lang = it.Lang;
        var signed = ctx.User is not null;
        var cards = new List<JsonObject>();
        var parts = new List<string>();
        var chips = lang == "en" ? (cfg["quick_replies"] as JsonArray ?? []).Select(q => q?.ToString() ?? "") : ShopReplies.Chips[lang];

        async Task<JsonObject> Call(string name, Dictionary<string, object?> args)
        {
            var outp = await CallToolAsync(ctx, name, args);
            cards.AddRange(outp.Cards);
            return outp.Data;
        }

        async Task<bool> Article(string query, bool asText)
        {
            if (!FeatureOn(ctx, "help_articles")) return false;
            var data = await Call("help_articles", new() { ["query"] = query });
            var arts = data["articles"] as JsonArray ?? [];
            if (arts.Count > 0 && asText)
            {
                var t = (arts[0] as JsonObject)!.Str("text");
                parts.Add(t[..Math.Min(700, t.Length)]);
                if (cards.Count > 0 && cards[^1].Str("type") == "article")
                    cards[^1] = (JsonObject)cards[^1].DeepClone();
                if (cards.Count > 0 && cards[^1].Str("type") == "article") cards[^1]["text"] = "";
            }
            return arts.Count > 0;
        }

        var name = it.Name;
        if (IntentFeature.TryGetValue(name, out var feature) && !FeatureOn(ctx, feature))
        {
            var (label, link) = FeaturePage[feature];
            parts.Add(ShopReplies.T_("feature_off", lang, ("page", label)));
            cards.Add(new JsonObject { ["type"] = "link", ["text"] = $"Open {label}", ["link"] = link });
            return (string.Join(' ', parts), cards);
        }
        switch (name)
        {
            case "greet":
                parts.Add(cfg.Str("greeting"));
                cards.Add(ShopReplies.ChipsCard(chips));
                break;
            case "thanks":
                parts.Add(ShopReplies.T_("thanks", lang));
                cards.Add(ShopReplies.ChipsCard(chips));
                break;
            case "bye":
                parts.Add(ShopReplies.T_("bye", lang, ("brand", ctx.Facts["brand"]!)));
                break;
            case not null when LoginIntents.Contains(name) && !signed:
                if (name is "human" or "grievance")
                    parts.Add(ShopReplies.T_("guest_ticket", lang,
                        ("grievance", name == "grievance" ? ctx.Facts["grievance_text"]!.ToString()! : "")));
                else
                {
                    await Article(GuestArticle.GetValueOrDefault(name, text), true);
                    parts.Add(ShopReplies.T_("sign_in", lang));
                }
                cards.Add(SignInCard(ctx, ShopReplies.T_("sign_in", lang)));
                break;
            case "track":
                if (it.OrderNumber is not null)
                {
                    var data = await Call("order_details", new() { ["order_number"] = it.PackageNumber ?? it.OrderNumber });
                    if (data.ContainsKey("error"))
                    {
                        parts.Add(ShopReplies.T_("order_not_found", lang, ("number", it.OrderNumber)));
                        await Call("my_orders", new());
                    }
                    else parts.Add(OrderSentence(data, lang));
                }
                else
                {
                    var openOrders = await orders.OrdersWithSubStatusAsync(ctx.User!.Id,
                        ["pending_payment", "placed", "confirmed", "packed", "shipped"], 5);
                    if (openOrders.Count == 1)
                        parts.Add(OrderSentence(await Call("order_details", new() { ["order_number"] = openOrders[0].Number }), lang));
                    else
                    {
                        var data = await Call("my_orders", new());
                        parts.Add(ShopReplies.T_((data["orders"] as JsonArray)?.Count > 0 ? "orders_list" : "no_orders", lang));
                    }
                }
                break;
            case "cancel":
                if (it.OrderNumber is not null)
                {
                    var data = await Call("prepare_cancellation", new() { ["order_number"] = it.PackageNumber ?? it.OrderNumber });
                    parts.Add(data.ContainsKey("error") ? data.Str("error") : ShopReplies.T_("cancel_ready", lang));
                }
                else
                {
                    var cancellable = OrdersBAL.CustomerCancellableAt(await platform.GetAsync());
                    var ordersAt = await orders.OrdersWithSubStatusAsync(ctx.User!.Id, [.. cancellable, "pending_payment"], 5);
                    if (ordersAt.Count == 1)
                    {
                        var data = await Call("prepare_cancellation", new() { ["order_number"] = ordersAt[0].Number });
                        parts.Add(data.ContainsKey("error") ? data.Str("error") : ShopReplies.T_("cancel_ready", lang));
                    }
                    else if (ordersAt.Count > 0)
                    {
                        cards.Add(new JsonObject
                        {
                            ["type"] = "orders", ["title"] = "",
                            ["items"] = new JsonArray((await OrderCardsAsync(ordersAt)).Select(c => (JsonNode)c).ToArray()),
                            ["link"] = "/orders",
                        });
                        parts.Add(ShopReplies.T_("cancel_pick", lang));
                    }
                    else parts.Add(ShopReplies.T_("cancel_none", lang));
                }
                break;
            case "return" or "damaged":
            {
                if (name == "damaged") parts.Add(ShopReplies.T_("damaged_sorry", lang));
                JsonObject? found = null;
                if (it.OrderNumber is not null)
                {
                    var o = await OwnOrderAsync(ctx, it.OrderNumber);
                    if (o is not null) found = await OrderViewAsync(o);
                }
                else
                {
                    foreach (var o in await orders.OrdersWithSubStatusAsync(ctx.User!.Id, ["delivered"], 5))
                    {
                        var v = await OrderViewAsync(o);
                        if ((v["packages"] as JsonArray ?? []).OfType<JsonObject>().Any(p => p.Bool("can_return"))) { found = v; break; }
                    }
                }
                var pkg = (found?["packages"] as JsonArray ?? []).OfType<JsonObject>().FirstOrDefault(p => p.Bool("can_return"));
                if (found is not null && pkg is not null)
                {
                    cards.Add(new JsonObject { ["type"] = "order", ["order"] = found.DeepClone() });
                    parts.Add(ShopReplies.T_("return_ready", lang, ("number", found.Str("number")), ("date", DateShort(pkg.Str("return_by")))));
                }
                else
                {
                    if (found is not null) cards.Add(new JsonObject { ["type"] = "order", ["order"] = found.DeepClone() });
                    parts.Add(ShopReplies.T_("return_none", lang));
                    await Article(name == "damaged" ? "damaged wrong item" : "return product", false);
                    parts.Add(ShopReplies.T_("handoff", lang));
                    cards.Add(ShopReplies.ChipsCard(lang == "en" ? ["Talk to support"] : [ShopReplies.Chips[lang][4]]));
                }
                break;
            }
            case "refund":
                if (signed)
                {
                    var data = await Call("my_returns_and_refunds", new());
                    parts.Add(ShopReplies.T_((data["returns"] as JsonArray)?.Count > 0 || (data["refunds"] as JsonArray)?.Count > 0 ? "refunds" : "no_refunds", lang));
                    await Article("refund", false);
                }
                else
                {
                    await Article("refund", true);
                    cards.Add(SignInCard(ctx, ShopReplies.T_("sign_in", lang)));
                }
                break;
            case "payment":
                await Article("payment failed money deducted", true);
                if (signed)
                {
                    var pending = await orders.OrdersWithSubStatusAsync(ctx.User!.Id, ["pending_payment"], 1);
                    if (pending.Count > 0) await Call("order_details", new() { ["order_number"] = pending[0].Number });
                }
                cards.Add(ShopReplies.ChipsCard(lang == "en" ? ["Talk to support"] : [ShopReplies.Chips[lang][4]]));
                break;
            case "tickets":
            {
                var data = await Call("my_tickets", new());
                parts.Add(ShopReplies.T_((data["tickets"] as JsonArray)?.Count > 0 ? "tickets" : "no_tickets", lang));
                break;
            }
            case "ticket_status":
            {
                var data = await Call("ticket_details", new() { ["ticket_number"] = it.TicketNumber });
                if (data.ContainsKey("error"))
                {
                    parts.Add(data.Str("error"));
                    await Call("my_tickets", new());
                }
                else
                {
                    var reply = data["last_team_reply"] as JsonObject;
                    parts.Add($"{data.Str("number")}: {data.Str("status_label")}."
                        + (reply is not null ? $" Latest reply from our team: “{reply.Str("text")[..Math.Min(300, reply.Str("text").Length)]}”" : ""));
                }
                break;
            }
            case "human" or "grievance":
            {
                var also = it.Also.ToHashSet();
                var transcript = await TranscriptAsync(ctx.ChatId, text);
                var mentioned = it.OrderNumber ?? ShopIntents.OrderRe.Matches(transcript).Cast<System.Text.RegularExpressions.Match>()
                    .LastOrDefault()?.Groups[1].Value.ToUpperInvariant();
                var cat = also.Overlaps(["payment", "refund"]) ? "payment"
                    : also.Overlaps(["return", "damaged"]) ? "return"
                    : also.Contains("track") ? "delivery"
                    : also.Contains("cancel") || mentioned is not null ? "order" : "other";
                var topic = cat switch
                {
                    "payment" => "Payment or refund",
                    "return" => also.Contains("damaged") ? "Damaged item" : "Return or replacement",
                    "delivery" => "Delivery problem",
                    "order" => "Problem with my order",
                    _ => "Help needed",
                };
                var subject = name == "grievance" ? "Grievance" : mentioned is not null ? $"{topic} ({mentioned})" : topic;
                await Call("prepare_ticket", new()
                {
                    ["category"] = cat, ["subject"] = subject, ["message"] = transcript,
                    ["order_number"] = mentioned ?? "", ["grievance"] = name == "grievance",
                });
                parts.Add(ShopReplies.T_("ticket_form", lang));
                break;
            }
            case "search":
                if (it.Query.Length == 0 && it.MaxPrice is null && it.MinPrice is null)
                    parts.Add(ShopReplies.T_("ask_product", lang));
                else
                {
                    var data = await Call("search_products", new()
                    {
                        ["query"] = it.Query,
                        ["max_price_rupees"] = it.MaxPrice is not null ? (it.MaxPrice.Value / 100m).ToString() : null,
                        ["min_price_rupees"] = it.MinPrice is not null ? (it.MinPrice.Value / 100m).ToString() : null,
                    });
                    var price = it.MaxPrice is not null ? $" under {ShopKb.Inr(it.MaxPrice.Value)}" : "";
                    parts.Add((data["products"] as JsonArray)?.Count > 0
                        ? ShopReplies.T_("products", lang, ("price", price))
                        : ShopReplies.T_("no_products", lang, ("query", it.Query.Length > 0 ? it.Query : text[..Math.Min(40, text.Length)])));
                }
                break;
            default: // a question: help articles first, then products, then a way out
                if (!await Article(text, true))
                {
                    var foundProducts = false;
                    if (it.Query.Length > 0)
                    {
                        var data = await Call("search_products", new() { ["query"] = it.Query });
                        foundProducts = (data["products"] as JsonArray)?.Count > 0;
                        if (foundProducts) parts.Add(ShopReplies.T_("products", lang, ("price", "")));
                    }
                    if (!foundProducts)
                    {
                        parts.Add(ShopReplies.T_("fallback", lang));
                        if (lastIntent == "unknown") parts.Add(ShopReplies.T_("handoff", lang));
                        cards.Add(ShopReplies.ChipsCard(chips));
                    }
                }
                break;
        }
        return (string.Join(' ', parts.Select(p => p.Trim()).Where(p => p.Length > 0)), cards);
    }

    // ------------------------------------------------------------------ the SSE endpoints

    public async IAsyncEnumerable<JsonObject> SendAsync(UserModel? user, Guid chatId, string chatKey, string text,
        bool voice, JsonObject? page, string ip, [EnumeratorCancellation] CancellationToken ct = default)
    {
        // Gates (reference: routers/shop_assistant.send).
        var cfg = await GetSettingsAsync();
        if (!cfg.Bool("enabled"))
            throw new AppException("The help assistant is switched off right now. Please use the Support page.", "assistant_off", 409);
        var chat = await OwnChatAsync(chatId, user, chatKey, write: true);
        var lim = cfg["limits"] as JsonObject ?? [];
        if (user is null && lim.Long("per_day_guest") == 0)
            throw new AppException("Please sign in to chat with us.", "sign_in_required", 401);
        var who = user is not null ? $"u:{user.Id}" : $"g:{chat.Id}";
        await rateLimit.RateLimitAsync($"shopchat:min:{who}", lim.Int("per_minute"), 60);
        await rateLimit.RateLimitAsync($"shopchat:day:{who}", (int)(user is not null ? lim.Long("per_day_customer") : lim.Long("per_day_guest")), 86400);
        if (user is null) await rateLimit.RateLimitAsync($"shopchat:ip:{ip}", (int)(lim.Long("per_day_guest") * 20), 86400);

        // Save the message, read the intent (reference: agent.run).
        var facts = await FactsAsync();
        var it = ShopIntents.Detect(text);
        var lastIntent = await dal.LastAssistantIntentAsync(chat.Id) ?? "";
        var now = DateTimeFunctions.UtcNow();
        await dal.InsertMessageAsync(new ShopChatMessageModel
        {
            Id = Guid.NewGuid(), SessionId = chat.Id, Role = "user", Text = text,
            Blocks = "[]", ModelContent = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = text }).ToJsonString(),
            Intent = it.Name, Voice = voice, Status = "done", CreatedAt = now,
        });
        if (chat.Title is "" or "New chat") chat.Title = string.Join(' ', text.Split(' ', StringSplitOptions.RemoveEmptyEntries))[..Math.Min(60, text.Trim().Length)] is { Length: > 0 } t ? t : "New chat";
        if (it.Lang != "en" || chat.Language.Length == 0) chat.Language = it.Lang;
        chat.UpdatedAt = now;
        if (page is not null)
            chat.Page = new JsonObject
            {
                ["path"] = page.Str("path")[..Math.Min(200, page.Str("path").Length)],
                ["title"] = page.Str("title")[..Math.Min(120, page.Str("title").Length)],
            }.ToJsonString();
        await dal.UpdateSessionAsync(chat);

        var reply = new ShopChatMessageModel
        {
            Id = Guid.NewGuid(), SessionId = chat.Id, Role = "assistant", Intent = it.Name, Voice = voice,
            Blocks = "[]", ModelContent = "[]", Status = "done", Mode = ChooseMode(cfg), CreatedAt = DateTimeFunctions.UtcNow(),
        };
        var mode = reply.Mode;
        yield return new JsonObject
        {
            ["type"] = "start", ["message_id"] = reply.Id.ToString(), ["session_id"] = chat.Id.ToString(),
            ["mode"] = mode, ["intent"] = it.Name, ["lang"] = it.Lang,
        };

        var ctx = new Ctx
        {
            User = user, ChatId = chat.Id, Facts = facts,
            PagePath = page is not null && page.Str("path").Length > 0 ? page.Str("path") : "/",
            Features = (cfg["features"] as JsonObject ?? []).ToDictionary(kv => kv.Key, kv => kv.Value?.GetValue<bool>() ?? true),
        };
        var blocks = new List<JsonObject>();
        var status = "done";
        var events = new List<JsonObject>();
        try
        {
            var (answer, replyCards) = await GuidedAsync(ctx, it, text, cfg, lastIntent);
            foreach (var c in replyCards)
            {
                blocks.Add(c);
                events.Add(new JsonObject { ["type"] = "card", ["card"] = c.DeepClone() });
            }
            if (answer.Length > 0)
            {
                blocks.Insert(0, new JsonObject { ["type"] = "text", ["text"] = answer });
                events.Add(new JsonObject { ["type"] = "text", ["delta"] = answer });
            }
            reply.Text = answer;
        }
        catch (AppException exc)
        {
            status = "error";
            blocks.Add(new JsonObject { ["type"] = "error", ["text"] = exc.Message });
            events.Add(new JsonObject { ["type"] = "error", ["message"] = exc.Message, ["code"] = exc.Code });
        }
        catch (Exception e)
        {
            log.LogError(e, "shop assistant turn failed");
            status = "error";
            const string msg = "Sorry, something went wrong while answering. Please try again.";
            blocks.Add(new JsonObject { ["type"] = "error", ["text"] = msg });
            events.Add(new JsonObject { ["type"] = "error", ["message"] = msg });
        }
        foreach (var ev in events) yield return ev;
        {
            reply.Blocks = new JsonArray(blocks.Select(b => (JsonNode)b.DeepClone()).ToArray()).ToJsonString();
            reply.Status = status;
            reply.ModelContent = new JsonArray(new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = reply.Text.Length > 0 ? reply.Text : "(shown cards)" }),
            }).ToJsonString();
            try
            {
                await dal.InsertMessageAsync(reply);
                chat.MessageCount += 2;
                chat.UpdatedAt = DateTimeFunctions.UtcNow();
                await dal.UpdateSessionAsync(chat);
                var ids = ctx.KbHits.Select(h => Guid.TryParse(h, out var g) ? g : Guid.Empty).Where(g => g != Guid.Empty).ToList();
                if (ids.Count > 0) await dal.BumpArticleUsesAsync(ids);
            }
            catch (Exception e) { log.LogError(e, "could not save shop assistant reply"); }
        }
        if (status == "done")
            yield return new JsonObject { ["type"] = "done", ["message"] = MessageOut(reply), ["mode"] = mode };
    }

    public async Task<JsonObject> RaiseTicketAsync(UserModel user, Guid chatId, string chatKey, string category,
        string subject, string message, Guid? orderId, bool grievance)
    {
        var chat = await OwnChatAsync(chatId, user, chatKey, write: true);
        await rateLimit.RateLimitAsync($"shopchat:ticket:{user.Id}", 5, 3600);
        var rows = (await dal.MessagesAsync(chat.Id)).OrderByDescending(m => m.CreatedAt).Take(20).Reverse().ToList();
        var transcript = string.Join('\n', rows.Where(m => m.Text.Length > 0).Select(m =>
            $"{(m.Role == "user" ? "Customer" : "Assistant")}: {string.Join(' ', m.Text.Split(' ', StringSplitOptions.RemoveEmptyEntries))[..Math.Min(400, m.Text.Length)]}"));
        var full = message.Trim();
        if (transcript.Length > 0)
            full += "\n\n— Chat with the help assistant —\n" + transcript[..Math.Min(4000, transcript.Length)];
        var t = await support.CreateTicketAsync(user, category, subject, full, orderId, grievance);
        chat.TicketId = t.Id;
        await dal.UpdateSessionAsync(chat);
        var v = TicketView((await tickets.GetAsync(t.Id))!);
        var m = new ShopChatMessageModel
        {
            Id = Guid.NewGuid(), SessionId = chat.Id, Role = "assistant",
            Text = $"Your request {t.Number} has been sent to our support team. They will reply within 48 hours; you can follow it under Support.",
            Blocks = new JsonArray(
                new JsonObject { ["type"] = "text", ["text"] = "" },
                new JsonObject { ["type"] = "tickets", ["title"] = "", ["items"] = new JsonArray(v.DeepClone()), ["link"] = v.Str("link") }).ToJsonString(),
            ModelContent = "[]", Intent = "ticket_sent", Mode = "guided", Status = "done", CreatedAt = DateTimeFunctions.UtcNow(),
        };
        m.Blocks = new JsonArray(
            new JsonObject { ["type"] = "text", ["text"] = m.Text },
            new JsonObject { ["type"] = "tickets", ["title"] = "", ["items"] = new JsonArray(v.DeepClone()), ["link"] = v.Str("link") }).ToJsonString();
        m.ModelContent = new JsonArray(new JsonObject
        {
            ["role"] = "assistant",
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = m.Text }),
        }).ToJsonString();
        await dal.InsertMessageAsync(m);
        chat.MessageCount += 1;
        chat.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateSessionAsync(chat);
        await MarkCardsAsync(chat.Id, b => b.Str("type") == "ticket_form",
            new JsonObject { ["status"] = "sent", ["ticket_number"] = t.Number });
        return new JsonObject { ["ticket"] = v, ["message"] = MessageOut(m) };
    }

    /// <summary>Updates a card in the saved chat so the chat reloads the way it looks now (reference: _mark_cards).</summary>
    private async Task MarkCardsAsync(Guid sessionId, Func<JsonObject, bool> match, JsonObject patch)
    {
        var rows = (await dal.MessagesAsync(sessionId)).ToList();
        foreach (var m in rows)
        {
            var blocks = JsonHelper.Array(m.Blocks);
            if (blocks.OfType<JsonObject>().Any(match))
            {
                var outp = new JsonArray();
                foreach (var b in blocks)
                {
                    if (b is JsonObject bo && match(bo))
                    {
                        var merged = (JsonObject)bo.DeepClone();
                        foreach (var (k, val) in patch) merged[k] = val?.DeepClone();
                        outp.Add(merged);
                    }
                    else outp.Add(b?.DeepClone());
                }
                m.Blocks = outp.ToJsonString();
                await dal.UpdateMessageAsync(m);
            }
        }
    }

    private async Task<ShopChatActionModel> LoadActionAsync(Guid actionId, UserModel user)
    {
        await using var uow = await db.BeginAsync();
        var act = await dal.GetActionForUpdateAsync(actionId, uow.Transaction);
        if (act is null || act.UserId != user.Id) throw new NotFoundException("Request");
        if (act.Status != "pending")
            throw new AppException("This was already handled.", "action_done", 409);
        if (DateTimeFunctions.UtcNow() - act.CreatedAt > ActionTtl)
        {
            act.Status = "expired";
            await dal.UpdateActionAsync(act, uow.Transaction);
            await uow.CommitAsync();
            throw new AppException("This expired. Please ask again.", "action_expired", 409);
        }
        return act;
    }

    public async Task<JsonObject> ConfirmActionAsync(UserModel user, Guid actionId)
    {
        var act = await LoadActionAsync(actionId, user);
        var args = JsonHelper.Object(act.Params);
        if (act.Kind != "cancel_order") throw new AppException("Unknown request", "action_unknown", 400);
        var orderId = Guid.Parse(args.Str("order_id"));
        var own = await orders.GetOrderAsync(orderId);
        if (own is null || own.UserId != user.Id) throw new NotFoundException("Order");
        Func<JsonObject, bool> match = b => b.Str("type") == "confirm" && b.Str("action_id") == act.Id.ToString();
        JsonObject detail;
        try
        {
            var subId = args.Str("sub_order_id").Length > 0 ? Guid.Parse(args.Str("sub_order_id")) : (Guid?)null;
            detail = await ordersBal.CancelAsync(user, orderId, args.Str("reason").Length > 0 ? args.Str("reason") : "Changed my mind", subId);
        }
        catch (AppException exc)
        {
            act.Status = "failed";
            act.Result = new JsonObject { ["error"] = exc.Message }.ToJsonString();
            act.DecidedAt = DateTimeFunctions.UtcNow();
            await dal.UpdateActionAsync(act);
            await MarkCardsAsync(act.SessionId, match, new JsonObject { ["status"] = "failed", ["error"] = exc.Message });
            throw;
        }
        var refunds = detail["refunds"] as JsonArray;
        var refundCount = own.PaymentMethod == "online" ? Math.Max(1, refunds?.Count ?? 0) : refunds?.Count ?? 0;
        act.Status = "done";
        act.Result = new JsonObject { ["refunds"] = refundCount }.ToJsonString();
        act.DecidedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateActionAsync(act);
        await MarkCardsAsync(act.SessionId, match, new JsonObject { ["status"] = "done" });
        var v = await OrderViewAsync(own);
        var note = refundCount > 0 ? " Your refund has been started and reaches the original payment method in 5 to 7 working days." : "";
        var chat = await dal.GetSessionAsync(act.SessionId);
        var text = $"Done. {(args.Str("target").Length > 0 ? args.Str("target") : "Your order")} is cancelled.{note}";
        var m = new ShopChatMessageModel
        {
            Id = Guid.NewGuid(), SessionId = act.SessionId, Role = "assistant", Text = text,
            Blocks = new JsonArray(
                new JsonObject { ["type"] = "text", ["text"] = text },
                new JsonObject { ["type"] = "order", ["order"] = v }).ToJsonString(),
            ModelContent = new JsonArray(new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
            }).ToJsonString(),
            Intent = "cancelled", Mode = "guided", Status = "done", CreatedAt = DateTimeFunctions.UtcNow(),
        };
        await dal.InsertMessageAsync(m);
        if (chat is not null)
        {
            chat.MessageCount += 1;
            chat.UpdatedAt = DateTimeFunctions.UtcNow();
            await dal.UpdateSessionAsync(chat);
        }
        return new JsonObject { ["status"] = "done", ["message"] = MessageOut(m) };
    }

    public async Task<JsonObject> DismissActionAsync(UserModel user, Guid actionId)
    {
        var act = await LoadActionAsync(actionId, user);
        act.Status = "cancelled";
        act.DecidedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateActionAsync(act);
        await MarkCardsAsync(act.SessionId,
            b => b.Str("type") == "confirm" && b.Str("action_id") == act.Id.ToString(),
            new JsonObject { ["status"] = "cancelled" });
        return new JsonObject { ["status"] = "cancelled" };
    }
}
