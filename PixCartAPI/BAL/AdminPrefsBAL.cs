using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Admin panel: each staff member's own interface preferences (the reference version's routers/admin_prefs.py), stored
/// in <c>users.ui_prefs</c>: admin_layout (sidebar | topnav | rail | glass, or null for the owner's default), nav_collapsed
/// (folded menu sections, at most 20 of at most 40 characters) and sidebar_collapsed. Personal display settings: not audited.
/// </summary>
public interface IAdminPrefsBAL
{
    Task<Dictionary<string, object?>> ReadAsync(UserModel user);

    /// <summary>Fields left out keep their saved value; unknown fields are dropped; admin_layout null returns to the owner's default.</summary>
    Task<Dictionary<string, object?>> WriteAsync(UserModel user, JsonObject body);
}

/// <inheritdoc cref="IAdminPrefsBAL"/>
public class AdminPrefsBAL(AccountDAL accounts, SettingsDAL settings, AppSettings env) : IAdminPrefsBAL
{
    public static readonly string[] AdminLayouts = ["sidebar", "topnav", "rail", "glass"];
    public const string DefaultLayout = "sidebar";
    public const int MaxGroups = 20;
    public const int MaxGroupChars = 40;

    private static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>Section names, whitespace tidied, without blanks or repeats; anything invalid is left out.</summary>
    private static List<string> CleanGroups(JsonNode? raw)
    {
        var outp = new List<string>();
        if (raw is not JsonArray arr) return outp;
        foreach (var n in arr)
        {
            if (n?.GetValueKind() != JsonValueKind.String) continue;
            var name = Collapse(n.GetValue<string>());
            if (name.Length > 0 && name.Length <= MaxGroupChars && !outp.Contains(name)) outp.Add(name);
        }
        return outp.Take(MaxGroups).ToList();
    }

    /// <summary>The stored preferences with every field present and valid (old or damaged values fall back to the defaults).</summary>
    public static Dictionary<string, object?> Normalize(string? raw)
    {
        var o = JsonHelper.Node(raw) as JsonObject ?? [];
        var layout = o["admin_layout"] is JsonValue v && v.TryGetValue<string>(out var s) && AdminLayouts.Contains(s) ? s : null;
        return new Dictionary<string, object?>
        {
            ["admin_layout"] = layout,
            ["nav_collapsed"] = CleanGroups(o["nav_collapsed"]),
            ["sidebar_collapsed"] = o["sidebar_collapsed"]?.GetValueKind() == JsonValueKind.True,
        };
    }

    private async Task<string> DefaultLayoutAsync()
    {
        var v = await SiteSettingsReader.MarketplaceAsync(settings, "admin_layout_default", JsonValue.Create(DefaultLayout));
        return v is JsonValue jv && jv.TryGetValue<string>(out var s) && AdminLayouts.Contains(s) ? s : DefaultLayout;
    }

    private async Task<Dictionary<string, object?>> PrefsOutAsync(UserModel user)
    {
        var prefs = Normalize(user.UiPrefs);
        var fallback = await DefaultLayoutAsync();
        return new Dictionary<string, object?>
        {
            ["ui_prefs"] = prefs,
            ["admin_layout"] = (string?)prefs["admin_layout"] ?? fallback, // the layout this person sees
            ["default_layout"] = fallback, // the owner's default
            ["layouts"] = AdminLayouts,
            // shown as a badge in the admin header outside production, so nobody mistakes a test install for the live one
            ["environment"] = env.Environment,
        };
    }

    public Task<Dictionary<string, object?>> ReadAsync(UserModel user) => PrefsOutAsync(user);

    private static AppException Invalid(string field, string label, string message) =>
        new($"{label}: {message}", "validation_error", 422, new Dictionary<string, string> { [field] = message });

    public async Task<Dictionary<string, object?>> WriteAsync(UserModel user, JsonObject body)
    {
        var prefs = Normalize(user.UiPrefs);
        if (body.TryGetPropertyValue("admin_layout", out var layout))
        {
            string? value = null;
            if (layout is not null && layout.GetValueKind() != JsonValueKind.Null)
            {
                if (layout.GetValueKind() != JsonValueKind.String) throw Invalid("admin_layout", "Admin layout", "Input should be a valid string");
                value = layout.GetValue<string>();
                if (!AdminLayouts.Contains(value)) throw Invalid("admin_layout", "Admin layout", $"Choose one of: {string.Join(", ", AdminLayouts)}");
            }
            prefs["admin_layout"] = value;
        }
        if (body.TryGetPropertyValue("nav_collapsed", out var groups))
        {
            var outp = new List<string>();
            if (groups is not null && groups.GetValueKind() != JsonValueKind.Null)
            {
                if (groups is not JsonArray arr) throw Invalid("nav_collapsed", "Nav collapsed", "Input should be a valid list");
                if (arr.Count > MaxGroups) throw Invalid("nav_collapsed", "Nav collapsed", $"At most {MaxGroups} menu sections can be folded");
                foreach (var n in arr)
                {
                    if (n?.GetValueKind() != JsonValueKind.String) throw Invalid("nav_collapsed", "Nav collapsed", "Input should be a valid string");
                    var name = Collapse(n.GetValue<string>());
                    if (name.Length == 0 || name.Length > MaxGroupChars)
                        throw Invalid("nav_collapsed", "Nav collapsed", $"Each menu section name is 1 to {MaxGroupChars} characters");
                    if (!outp.Contains(name)) outp.Add(name);
                }
            }
            prefs["nav_collapsed"] = outp;
        }
        if (body.TryGetPropertyValue("sidebar_collapsed", out var side))
        {
            var kind = side?.GetValueKind();
            if (kind is not (null or JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False))
                throw Invalid("sidebar_collapsed", "Sidebar collapsed", "must be on or off");
            prefs["sidebar_collapsed"] = kind == JsonValueKind.True;
        }
        user.UiPrefs = JsonSerializer.Serialize(prefs);
        user.UpdatedAt = DateTimeFunctions.UtcNow();
        await accounts.SaveUserAsync(user);
        return await PrefsOutAsync(user);
    }
}
