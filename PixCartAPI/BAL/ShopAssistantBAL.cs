using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using Microsoft.Extensions.Logging;
using BAL.ShopAssistant;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IShopAssistantBAL"/>
/// <remarks>
/// Live mode (an AI model answering with the customer tools) is NOT ported: this environment has no live LLM, so
/// choose_mode always resolves to "guided" exactly as the reference does when no model is connected. The guided
/// pipeline (multilingual intents + help knowledge + tools + canned sentences) is fully ported, so the customer
/// always gets an answer. The missing live mode is tracked as a module gap with the other AI surfaces.
/// </remarks>
public partial class ShopAssistantBAL(
    ShopAssistantDAL dal, OrdersDAL orders, ReturnsDAL returns, SupportTicketDAL tickets, CatalogDAL catalog,
    SettingsDAL settings, IRateLimitBAL rateLimit, PlatformSettingsBAL platform, SiteBAL site, FeesBAL fees,
    SupportBAL support, OrdersBAL ordersBal, ReturnsBAL returnsBal, CatalogBAL catalogBal, IMySqlDapperHelper db,
    IAccessBAL access, IAuditBAL audit, ILogger<ShopAssistantBAL> log) : IShopAssistantBAL
{
    private const string SettingsKey = "shop_assistant";
    private static readonly TimeSpan ActionTtl = TimeSpan.FromMinutes(30);

    private static string Hash(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();

    // ------------------------------------------------------------------ settings (reference: shop_assistant/settings.py)

    private static JsonObject Defaults() => new()
    {
        ["enabled"] = true,
        ["name"] = "Help assistant",
        ["greeting"] = "Hi! I can track your orders, help with cancellations, returns and refunds, find products, or connect you with our support team.",
        ["allow_guests"] = true,
        ["ai"] = "auto", // auto = use the AI model when one is connected; guided = rules only. No model is connected here.
        ["instructions"] = "",
        ["quick_replies"] = new JsonArray("Track my order", "Return an item", "Refund status", "Find a product", "Talk to support"),
        ["features"] = new JsonObject
        {
            ["product_search"] = true, ["orders"] = true, ["cancel_orders"] = true,
            ["returns_refunds"] = true, ["tickets"] = true, ["help_articles"] = true,
        },
        ["max_steps"] = 5,
        ["max_output_tokens"] = 700,
        ["history_messages"] = 12,
        ["monthly_token_budget"] = 0,
        ["limits"] = new JsonObject { ["per_minute"] = 12, ["per_day_customer"] = 150, ["per_day_guest"] = 40 },
        ["voice"] = new JsonObject
        {
            ["enabled"] = true,
            ["languages"] = new JsonArray(
                new JsonObject { ["code"] = "en-IN", ["label"] = "English" },
                new JsonObject { ["code"] = "ta-IN", ["label"] = "தமிழ்" },
                new JsonObject { ["code"] = "hi-IN", ["label"] = "हिन्दी" }),
            ["default_language"] = "en-IN",
            ["speak_replies"] = false,
            ["rate"] = 1.0,
            ["pitch"] = 1.0,
            ["auto_listen"] = true,
        },
    };

    public async Task<JsonObject> GetSettingsAsync() => SettingsDAL.Merge(Defaults(), await settings.GetAsync(SettingsKey));

    /// <summary>choose_mode: the reference returns "live" only with a connected model on the shop_assistant route.
    /// No model is connected in this stack, so this always resolves to guided (the reference's no-model branch).</summary>
    private static string ChooseMode(JsonObject cfg) => "guided";

    // ------------------------------------------------------------------ chat ownership (reference: _own_chat)

    private async Task<ShopChatSessionModel> OwnChatAsync(Guid chatId, UserModel? user, string chatKey, bool write = false)
    {
        var chat = await dal.GetSessionAsync(chatId) ?? throw new NotFoundException("Chat");
        if (chat.UserId is not null)
        {
            if (user is null || chat.UserId != user.Id) throw new NotFoundException("Chat");
            return chat;
        }
        if (chatKey.Length == 0 || chat.GuestKeyHash.Length == 0
            || !CryptographicOperations.FixedTimeEquals(
                SHA256.HashData(Encoding.UTF8.GetBytes(chatKey)), Convert.FromHexString(chat.GuestKeyHash)))
            throw new NotFoundException("Chat");
        if (user is not null) // the guest signed in: the chat becomes theirs
        {
            chat.UserId = user.Id;
            chat.GuestKeyHash = "";
            if (write) await dal.UpdateSessionAsync(chat);
        }
        return chat;
    }

    // ------------------------------------------------------------------ endpoints

    public async Task<JsonObject> ConfigAsync(UserModel? user)
    {
        var cfg = await GetSettingsAsync();
        return new JsonObject
        {
            ["enabled"] = cfg.Bool("enabled") && (user is not null || cfg.Bool("allow_guests")),
            ["switched_on"] = cfg.Bool("enabled"),
            ["allow_guests"] = cfg.Bool("allow_guests"),
            ["signed_in"] = user is not null,
            ["name"] = cfg.Str("name"),
            ["greeting"] = cfg.Str("greeting"),
            ["quick_replies"] = cfg["quick_replies"]?.DeepClone(),
            ["voice"] = cfg["voice"]?.DeepClone(),
            ["mode"] = ChooseMode(cfg),
        };
    }

    public async Task<JsonObject> StartAsync(UserModel? user, JsonObject page, string ip)
    {
        var cfg = await GetSettingsAsync();
        if (!cfg.Bool("enabled"))
            throw new AppException("The help assistant is switched off right now. Please use the Support page.", "assistant_off", 409);
        if (user is null && !cfg.Bool("allow_guests"))
            throw new AppException("Please sign in to chat with us.", "sign_in_required", 401);
        await rateLimit.RateLimitAsync($"shopchat:new:{(user is null ? ip : user.Id.ToString())}", 30, 3600);
        var now = DateTimeFunctions.UtcNow();
        var key = user is null ? Convert.ToBase64String(RandomNumberGenerator.GetBytes(18)).Replace("+", "-").Replace("/", "_") : "";
        var chat = new ShopChatSessionModel
        {
            Id = Guid.NewGuid(), UserId = user?.Id, GuestKeyHash = key.Length > 0 ? Hash(key) : "", Title = "New chat",
            Page = new JsonObject
            {
                ["path"] = (page.Str("path") ?? "")[..Math.Min(200, (page.Str("path") ?? "").Length)],
                ["title"] = (page.Str("title") ?? "")[..Math.Min(120, (page.Str("title") ?? "").Length)],
            }.ToJsonString(),
            CreatedAt = now, UpdatedAt = now,
        };
        await dal.InsertSessionAsync(chat);
        return new JsonObject { ["id"] = chat.Id.ToString(), ["guest_key"] = key.Length > 0 ? key : null };
    }

    public async Task<JsonObject> MyChatsAsync(UserModel user)
    {
        var rows = await dal.MySessionsAsync(user.Id);
        return new JsonObject
        {
            ["items"] = new JsonArray(rows.Select(c => (JsonNode)new JsonObject
            {
                ["id"] = c.Id.ToString(), ["title"] = c.Title, ["updated_at"] = c.UpdatedAt.ToString("o"),
            }).ToArray()),
        };
    }

    public async Task<JsonObject> GetChatAsync(UserModel? user, Guid chatId, string chatKey)
    {
        var chat = await OwnChatAsync(chatId, user, chatKey, write: true);
        var msgs = await dal.MessagesAsync(chat.Id);
        return new JsonObject
        {
            ["id"] = chat.Id.ToString(), ["title"] = chat.Title, ["feedback"] = chat.Feedback,
            ["messages"] = new JsonArray(msgs.Select(m => (JsonNode)MessageOut(m)).ToArray()),
        };
    }

    public async Task<JsonObject> FeedbackAsync(UserModel? user, Guid chatId, string chatKey, int value)
    {
        if (value is not (1 or -1)) throw new AppException("Choose helpful or not helpful", "validation", 422);
        var chat = await OwnChatAsync(chatId, user, chatKey, write: true);
        chat.Feedback = value;
        await dal.UpdateSessionAsync(chat);
        return new JsonObject { ["ok"] = true };
    }

    internal static JsonObject MessageOut(ShopChatMessageModel m) => new()
    {
        ["id"] = m.Id.ToString(), ["role"] = m.Role, ["text"] = m.Text,
        ["blocks"] = JsonNode.Parse(m.Blocks ?? "[]")?.DeepClone(), ["status"] = m.Status, ["mode"] = m.Mode,
        ["created_at"] = m.CreatedAt == default ? null : m.CreatedAt.ToString("o"),
    };

    // ------------------------------------------------------------------ helpers

    private async Task<Dictionary<string, object?>> FactsAsync()
    {
        var cfg = await platform.GetAsync();
        var siteCfg = await site.GetSiteAsync();
        var checkout = await fees.GetAsync();
        return ShopKb.PublicFacts(cfg, siteCfg, checkout);
    }

    private async Task<List<ShopKb.Hit>> KbSearchAsync(string query, Dictionary<string, object?> facts, int limit = 3, double minScore = 2.0)
    {
        await EnsureStarterAsync();
        var arts = (await dal.PublishedArticlesAsync()).ToList();
        var pages = (await dal.PublishedPagesAsync()).ToList();
        return ShopKb.Search(query, arts, pages, facts, limit, minScore);
    }

    /// <summary>Adds the starter articles once to an empty knowledge base, and later-added starter articles once to
    /// bases seeded before (reference: kb.ensure_starter). Deleting them afterwards does not bring them back.</summary>
    private async Task EnsureStarterAsync()
    {
        var row = await settings.GetAsync(ShopStarter.SeededKey);
        if (row.Count > 0 && ShopKb.GetLong(row, "version", 1) >= ShopStarter.StarterVersion) return;
        await using var uow = await db.BeginAsync();
        var seeded = await settings.GetForUpdateAsync(ShopStarter.SeededKey, uow.Transaction);
        var done = seeded.Count > 0 ? ShopKb.GetLong(seeded, "version", 1) : 0;
        if (done >= ShopStarter.StarterVersion) { await uow.CommitAsync(); return; }
        var now = DateTimeFunctions.UtcNow();
        if (seeded.Count == 0)
        {
            if (!await dal.AnyArticleAsync())
            {
                var pos = 0;
                foreach (var (topic, title, link, body, kw) in ShopStarter.Starter)
                    await dal.InsertArticleAsync(new ShopKbArticleModel
                    {
                        Id = Guid.NewGuid(), Title = title, Body = body, Keywords = JsonSerializer.Serialize(kw),
                        Topic = topic, Link = link, IsPublished = true, Position = pos++, Uses = 0,
                        CreatedAt = now, UpdatedAt = now,
                    }, uow.Transaction);
            }
            await settings.SaveAsync(ShopStarter.SeededKey,
                new JsonObject { ["at"] = now.ToString("o"), ["version"] = ShopStarter.StarterVersion }, uow.Transaction);
        }
        else
        {
            var titles = Enumerable.Range((int)done + 1, (int)(ShopStarter.StarterVersion - done))
                .SelectMany(v => ShopStarter.NewInVersion.GetValueOrDefault(v, [])).ToHashSet();
            var have = (await dal.ArticleTitlesAsync(titles.ToList(), uow.Transaction)).ToHashSet();
            var last = await dal.MaxArticlePositionAsync(uow.Transaction);
            foreach (var (topic, title, link, body, kw) in ShopStarter.Starter)
            {
                if (!titles.Contains(title) || have.Contains(title)) continue;
                await dal.InsertArticleAsync(new ShopKbArticleModel
                {
                    Id = Guid.NewGuid(), Title = title, Body = body, Keywords = JsonSerializer.Serialize(kw),
                    Topic = topic, Link = link, IsPublished = true, Position = ++last, Uses = 0,
                    CreatedAt = now, UpdatedAt = now,
                }, uow.Transaction);
            }
            seeded["version"] = ShopStarter.StarterVersion;
            await settings.SaveAsync(ShopStarter.SeededKey, seeded, uow.Transaction);
        }
        await uow.CommitAsync();
    }
}
