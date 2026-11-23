using System.Text.Json.Nodes;
using Utils;

namespace DAL;

/// <summary>
/// The Claude key saved in Admin → Integrations ("AI provider"), read the way the reference integrations store does:
/// platform_settings["integrations"]["ai"] = {"values": {"api_key": {"enc": Fernet}, "api_base": "..."}, "enabled": bool};
/// a saved value wins over the server environment (App:AnthropicApiKey / App:AnthropicApiBase); switched off = no key.
/// <para>A small private reader until the integrations module is merged: switching to its service is a change in this
/// class only.</para>
/// </summary>
public class AnthropicKeyDAL(SettingsDAL settings, EncryptDecrypt crypto, AppSettings app)
{
    public sealed record AnthropicKey(string ApiKey, string ApiBase);

    public async Task<AnthropicKey> GetAsync()
    {
        var raw = await settings.GetAsync("integrations");
        var entry = raw["ai"] as JsonObject ?? [];
        var values = entry["values"] as JsonObject ?? [];
        var key = app.AnthropicApiKey;
        var apiBase = app.AnthropicApiBase;
        if (values["api_key"] is JsonObject enc && enc["enc"] is JsonValue ev && ev.TryGetValue<string>(out var token))
        {
            var plain = crypto.Decrypt(token);
            if (plain.Length > 0) key = plain; // a secret that no longer decrypts counts as not set
        }
        else if (values["api_key"] is JsonValue pv && pv.TryGetValue<string>(out var p) && p.Length > 0)
        {
            key = p;
        }
        if (values["api_base"] is JsonValue bv && bv.TryGetValue<string>(out var b) && b.Length > 0) apiBase = b;
        if (entry["enabled"] is JsonValue on && on.TryGetValue<bool>(out var enabled) && !enabled) key = "";
        return new AnthropicKey(key ?? "", string.IsNullOrEmpty(apiBase) ? "https://api.anthropic.com" : apiBase);
    }
}
