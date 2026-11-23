using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using DAL;
using Utils;

namespace BAL.AI;

/// <summary>A connection or route change that is not valid; the message is shown to the admin.</summary>
public sealed class LlmConfigException(string message) : Exception(message);

public interface ILlmConfigBAL
{
    Task<JsonObject> RawAsync();
    Task<List<LlmConnection>> ConnectionsAsync();
    Task<List<LlmTarget>> TargetsAsync(string route);
    Task<JsonObject> ViewAsync();
    Task<JsonObject> SaveConnectionAsync(JsonObject data, string? connId);
    Task DeleteConnectionAsync(string connId);
    Task<JsonObject> SaveRoutesAsync(JsonObject routes);
    Task RecordTestAsync(string connId, bool ok, string message);
}

/// <summary>
/// LLM connections and routes, edited in Admin → AI providers, stored in platform_settings["llm"]:
/// <c>{"connections": [{"id","name","type","base_url","models","enabled","timeout_s","keys":[{"id","label","enc","added_at"}]}],
/// "routes": {"assistant": [{"connection","model"}], ...}}</c>. API keys are Fernet-encrypted (the browser only sees the last
/// 4 characters). When nothing is configured, the Claude key from Admin → Integrations is a built-in connection.
/// </summary>
public class LlmConfigBAL(AiDAL dal, AnthropicKeyDAL anthropic, EncryptDecrypt crypto, AppSettings env) : ILlmConfigBAL
{
    public const string Key = "llm";
    public const string BuiltinId = "claude-default";
    public const int MaxConnections = 30;
    public const int MaxKeys = 10;
    public const int MaxTargets = 8;
    public static readonly Regex ModelName = new(@"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,120}$");

    public async Task<JsonObject> RawAsync()
    {
        var raw = await dal.SettingAsync(Key);
        if (raw.Count == 0 && !await dal.SettingExistsAsync(Key)) return J.O(("connections", new JsonArray()), ("routes", new JsonObject()));
        return raw;
    }

    private async Task<LlmConnection?> BuiltinAsync()
    {
        var cfg = await anthropic.GetAsync();
        if (string.IsNullOrEmpty(cfg.ApiKey)) return null;
        var model = J.S((await AiSettings.GetAsync(dal, env))["model"]);
        return new LlmConnection
        {
            Id = BuiltinId, Name = "Claude (key from Integrations)", Type = "anthropic", BaseUrl = cfg.ApiBase, Keys = [cfg.ApiKey],
            KeyIds = ["integrations"], Models = [model], Builtin = true,
        };
    }

    private LlmConnection FromJson(JsonObject c)
    {
        var keys = new List<string>();
        var ids = new List<string>();
        foreach (var k in c["keys"] as JsonArray ?? [])
        {
            if (k is not JsonObject ko) continue;
            var v = crypto.Decrypt(J.S(ko["enc"]));
            if (v.Length == 0) continue;
            keys.Add(v);
            ids.Add(J.S(ko["id"]));
        }
        var headers = new Dictionary<string, string>();
        foreach (var (hk, hv) in c["extra_headers"] as JsonObject ?? []) headers[hk] = J.S(hv);
        var timeout = J.Long(c["timeout_s"]) ?? 0;
        return new LlmConnection
        {
            Id = J.S(c["id"]), Name = J.S(c["name"]), Type = J.S(c["type"]), BaseUrl = J.S(c["base_url"]), Keys = keys, KeyIds = ids,
            Models = (c["models"] as JsonArray ?? []).Select(J.S).ToList(), Enabled = c["enabled"] is null || J.Truthy(c["enabled"]),
            TimeoutS = timeout > 0 ? (int)timeout : 60, ExtraHeaders = headers,
        };
    }

    public async Task<List<LlmConnection>> ConnectionsAsync()
    {
        var raw = await RawAsync();
        var outp = (raw["connections"] as JsonArray ?? []).OfType<JsonObject>().Select(FromJson).ToList();
        if (await BuiltinAsync() is { } b) outp.Insert(0, b);
        return outp;
    }

    /// <summary>The ordered fallback chain for a route; empty routes fall back to the assistant route, then Claude.</summary>
    public async Task<List<LlmTarget>> TargetsAsync(string route)
    {
        var raw = await RawAsync();
        var conns = (await ConnectionsAsync()).GroupBy(c => c.Id).ToDictionary(g => g.Key, g => g.First());
        var routes = raw["routes"] as JsonObject ?? [];
        var chain = routes[route] as JsonArray ?? [];
        if (chain.Count == 0 && route != "assistant") chain = routes["assistant"] as JsonArray ?? [];
        var outp = new List<LlmTarget>();
        foreach (var t in chain.OfType<JsonObject>())
        {
            var cid = J.S(t["connection"]);
            if (conns.TryGetValue(cid, out var c) && c.Enabled) outp.Add(new LlmTarget(c, J.S(t["model"])));
        }
        if (outp.Count == 0 && conns.TryGetValue(BuiltinId, out var b)) outp = [new LlmTarget(b, b.Models[0])];
        return outp.Where(t => t.Connection.Keys.Count > 0 || !(LlmCatalog.Types.TryGetValue(t.Connection.Type, out var pt) ? pt : LlmCatalog.Types["custom"]).NeedsKey).ToList();
    }

    // ---------------------------------------------------------------- admin view and edits

    private static string Hint(string v) => v.Length >= 8 ? "••••" + v[^4..] : "••••";

    public async Task<JsonObject> ViewAsync()
    {
        var raw = await RawAsync();
        var conns = new JsonArray();
        if (await BuiltinAsync() is { } b)
            conns.Add(J.O(("id", b.Id), ("name", b.Name), ("type", b.Type), ("base_url", b.BaseUrl), ("models", J.Strings(b.Models)), ("enabled", true),
                ("timeout_s", 60), ("builtin", true),
                ("keys", new JsonArray(J.O(("id", "integrations"), ("label", "Integrations key"), ("hint", Hint(b.Keys[0])))))));
        foreach (var c in (raw["connections"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var keys = new JsonArray();
            foreach (var k in (c["keys"] as JsonArray ?? []).OfType<JsonObject>())
            {
                var plain = crypto.Decrypt(J.S(k["enc"]));
                keys.Add(J.O(("id", k["id"]), ("label", J.S(k["label"])), ("hint", plain.Length > 0 ? Hint(plain) : "unreadable — add again"), ("added_at", k["added_at"])));
            }
            var item = new JsonObject();
            foreach (var f in new[] { "id", "name", "type", "base_url", "models", "enabled", "timeout_s", "last_test" }) item[f] = c[f]?.DeepClone();
            item["keys"] = keys;
            item["builtin"] = false;
            conns.Add(item);
        }
        var routes = new JsonObject();
        var saved = raw["routes"] as JsonObject ?? [];
        foreach (var (r, _, _) in LlmCatalog.Routes) routes[r] = saved[r]?.DeepClone() ?? new JsonArray();
        var types = new JsonArray();
        foreach (var t in LlmCatalog.ProviderTypes)
            types.Add(J.O(("key", t.Key), ("name", t.Name), ("protocol", t.Protocol), ("base_url", t.BaseUrl), ("needs_key", t.NeedsKey), ("local", t.Local),
                ("example_models", J.Strings(t.ExampleModels ?? [])), ("docs_url", t.DocsUrl), ("notes", t.Notes)));
        return J.O(("connections", conns), ("routes", routes), ("route_info", LlmCatalog.RouteInfo()), ("types", types));
    }

    public static string CheckUrl(string typeKey, string url)
    {
        url = url.Trim().TrimEnd('/');
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u) || (u.Scheme != "https" && u.Scheme != "http") || string.IsNullOrEmpty(u.Host))
            throw new LlmConfigException("Enter the full address, starting with https://");
        var host = u.Host.Trim('[', ']').ToLowerInvariant();
        var local = LlmCatalog.Types.TryGetValue(typeKey, out var t) && t.Local;
        if (u.Scheme == "http" && !(local || typeKey is "custom" or "vllm")) throw new LlmConfigException("Cloud providers must use https://");
        if (host == "metadata.google.internal" || (host.EndsWith(".internal") && !local)) throw new LlmConfigException("That address is not allowed");
        if (IPAddress.TryParse(host, out var ip))
        {
            var linkLocal = ip.AddressFamily == AddressFamily.InterNetwork
                ? ip.GetAddressBytes() is [169, 254, ..]
                : ip.IsIPv6LinkLocal;
            var multicast = ip.AddressFamily == AddressFamily.InterNetwork ? ip.GetAddressBytes()[0] is >= 224 and <= 239 : ip.IsIPv6Multicast;
            if (linkLocal || multicast || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any))
                throw new LlmConfigException("That address is not allowed"); // e.g. 169.254.169.254 (cloud metadata)
        }
        if (url.Contains("YOUR-RESOURCE")) throw new LlmConfigException("Replace YOUR-RESOURCE with your Azure resource name");
        return url;
    }

    private static JsonObject Empty() => J.O(("connections", new JsonArray()), ("routes", new JsonObject()));

    public async Task<JsonObject> SaveConnectionAsync(JsonObject data, string? connId)
    {
        await using var uow = await dal.BeginAsync();
        var value = await dal.LockSettingAsync(uow, Key) ?? Empty();
        var items = (value["connections"] as JsonArray ?? []).OfType<JsonObject>().Select(c => (JsonObject)c.DeepClone()).ToList();
        var current = connId != null ? items.FirstOrDefault(c => J.S(c["id"]) == connId) : null;
        if (connId != null && current is null) throw new LlmConfigException("Connection not found");
        string Pick(string k, string fallback) => J.S(data[k]) is { Length: > 0 } s ? s : (current != null && J.S(current[k]) is { Length: > 0 } cs ? cs : fallback);
        var typeKey = Pick("type", "");
        if (!LlmCatalog.Types.TryGetValue(typeKey, out var type)) throw new LlmConfigException("Choose a provider");
        var name = string.Join(' ', Pick("name", type.Name).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        name = J.Cut(name, 60);
        var baseUrl = CheckUrl(typeKey, Pick("base_url", type.BaseUrl));
        var modelsSrc = data["models"] is JsonArray dm ? dm : current?["models"] as JsonArray ?? [];
        var models = modelsSrc.Select(m => J.S(m).Trim()).Where(m => m.Length > 0).ToList();
        if (models.FirstOrDefault(m => !ModelName.IsMatch(m)) is { } bad) throw new LlmConfigException($"Model name not valid: {bad}");
        if (models.Count == 0) throw new LlmConfigException("Add at least one model name");
        var timeoutL = J.Long(data["timeout_s"]) is { } dt && dt != 0 ? dt : (J.Long(current?["timeout_s"]) is { } ct && ct != 0 ? ct : 60);
        if (timeoutL is < 5 or > 300) throw new LlmConfigException("Timeout must be 5 to 300 seconds");
        var keys = (current?["keys"] as JsonArray ?? []).OfType<JsonObject>().Select(k => (JsonObject)k.DeepClone()).ToList();
        var remove = (data["remove_keys"] as JsonArray ?? []).Select(J.S).ToHashSet();
        keys = keys.Where(k => !remove.Contains(J.S(k["id"]))).ToList();
        foreach (var k in data["add_keys"] as JsonArray ?? [])
        {
            var text = (k is JsonObject ko ? J.S(ko["key"]) : J.S(k)).Trim();
            if (text.Length == 0) continue;
            if (text.Any(ch => ch < 33) || text.Length > 400) throw new LlmConfigException("An API key contains spaces or hidden characters");
            keys.Add(J.O(("id", Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(4))), ("label", k is JsonObject lo ? J.Cut(J.S(lo["label"]), 40) : ""),
                ("enc", crypto.Encrypt(text)), ("added_at", DateTimeFunctions.Iso(DateTimeFunctions.UtcNow()))));
        }
        if (keys.Count > MaxKeys) throw new LlmConfigException($"At most {MaxKeys} keys per connection");
        if (type.NeedsKey && keys.Count == 0) throw new LlmConfigException("Add an API key");
        var enabled = data["enabled"] is { } de ? J.Truthy(de) : current?["enabled"] is not { } ce || J.Truthy(ce);
        var record = J.O(("id", connId ?? Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6))), ("name", name), ("type", typeKey), ("base_url", baseUrl),
            ("models", J.Strings(models.Take(40))), ("enabled", enabled), ("timeout_s", (int)timeoutL), ("keys", new JsonArray(keys.Select(x => (JsonNode)x).ToArray())),
            ("last_test", current?["last_test"]?.DeepClone()));
        if (current != null)
        {
            items = items.Select(c => J.S(c["id"]) == connId ? record : c).ToList();
        }
        else
        {
            if (items.Count >= MaxConnections) throw new LlmConfigException($"At most {MaxConnections} connections");
            items.Add(record);
        }
        value["connections"] = new JsonArray(items.Select(x => (JsonNode)x.DeepClone()).ToArray());
        await dal.SaveSettingAsync(uow, Key, value);
        await uow.CommitAsync();
        return record;
    }

    public async Task DeleteConnectionAsync(string connId)
    {
        await using var uow = await dal.BeginAsync();
        var value = await dal.LockSettingAsync(uow, Key) ?? Empty();
        value["connections"] = new JsonArray((value["connections"] as JsonArray ?? []).OfType<JsonObject>().Where(c => J.S(c["id"]) != connId)
            .Select(c => (JsonNode)c.DeepClone()).ToArray());
        var routes = new JsonObject();
        foreach (var (r, chain) in value["routes"] as JsonObject ?? [])
            routes[r] = new JsonArray((chain as JsonArray ?? []).OfType<JsonObject>().Where(t => J.S(t["connection"]) != connId).Select(t => (JsonNode)t.DeepClone()).ToArray());
        value["routes"] = routes;
        await dal.SaveSettingAsync(uow, Key, value);
        await uow.CommitAsync();
    }

    public async Task<JsonObject> SaveRoutesAsync(JsonObject routes)
    {
        var known = (await ConnectionsAsync()).GroupBy(c => c.Id).ToDictionary(g => g.Key, g => g.First());
        var clean = new JsonObject();
        foreach (var (r, chainNode) in routes)
        {
            if (!LlmCatalog.IsRoute(r)) throw new LlmConfigException($"Unknown route {r}");
            var chain = chainNode as JsonArray ?? [];
            if (chain.Count > MaxTargets) throw new LlmConfigException($"At most {MaxTargets} fallbacks per route");
            var outp = new JsonArray();
            foreach (var t in chain.OfType<JsonObject>())
            {
                if (!known.TryGetValue(J.S(t["connection"]), out var c)) throw new LlmConfigException("A route points to a connection that does not exist");
                var model = J.S(t["model"]).Trim();
                if (!ModelName.IsMatch(model)) throw new LlmConfigException($"Model name not valid: {model}");
                outp.Add(J.O(("connection", c.Id), ("model", model)));
            }
            clean[r] = outp;
        }
        await using var uow = await dal.BeginAsync();
        var value = await dal.LockSettingAsync(uow, Key) ?? Empty();
        value["routes"] = clean.DeepClone();
        await dal.SaveSettingAsync(uow, Key, value);
        await uow.CommitAsync();
        return clean;
    }

    public async Task RecordTestAsync(string connId, bool ok, string message)
    {
        await using var uow = await dal.BeginAsync();
        var value = await dal.LockSettingAsync(uow, Key) ?? Empty();
        var items = new JsonArray();
        foreach (var c in (value["connections"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var copy = (JsonObject)c.DeepClone();
            if (J.S(c["id"]) == connId)
                copy["last_test"] = J.O(("ok", ok), ("message", J.Cut(message, 300)), ("at", DateTimeFunctions.Iso(DateTimeFunctions.UtcNow())));
            items.Add(copy);
        }
        value["connections"] = items;
        await dal.SaveSettingAsync(uow, Key, value);
        await uow.CommitAsync();
    }
}
