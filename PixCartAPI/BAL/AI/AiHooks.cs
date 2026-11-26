using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using Microsoft.Extensions.Logging;

namespace BAL.AI;

/// <summary>
/// Whether an AI model is connected for a route ("studio", "translate", ...): the route's fallback chain in Admin →
/// AI providers is not empty (with no routes saved, the built-in Claude connection from Integrations counts).
/// </summary>
public sealed class AiAvailability(ILlmConfigBAL llm) : IAiAvailability
{
    public async Task<bool> ConfiguredAsync(string route) => (await llm.TargetsAsync(route)).Count > 0;
}

/// <summary>
/// Interface text translated by the AI on the "translate" route. Lines go in batches; the model must answer with a JSON
/// array of the same length and order. A batch that comes back in any other shape is dropped, and its lines simply stay
/// in English until the next try (the translation service saves only what came back).
/// </summary>
public sealed class AiTranslationEngine(ILlmRouterBAL router, ILogger<AiTranslationEngine> log) : ITranslationEngine
{
    private const int BatchSize = 40;
    private const int MaxTokens = 4000;
    private const int MaxSourceLength = 400;  // longer text is content (descriptions, reviews), not interface text

    private static readonly JsonSerializerOptions Unescaped = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private const string Rules = """
        You translate the interface text of an Indian online marketplace (shop, seller hub, delivery app, admin panel).
        Translate each string in the JSON array into {language}. Rules:
        - Return ONLY a JSON array of strings, the same length and order as the input. No notes.
        - Keep it short and natural, as a native app in {language} would say it. Use the polite form for customers.
        - Keep unchanged: brand names (PixCart, Razorpay, Google Pay, PhonePe, Paytm, UPI, GST, GSTIN, OTP, COD, UPI ID), numbers,
          amounts, currency symbols, codes, email addresses, web addresses, emoji and placeholders like {name}, {0} or %s.
        - Keep leading and trailing punctuation (… : · ?), and keep words in CAPITALS as they are when they are codes.
        - If a string is already in {language}, or is a name or code that should not change, return it unchanged.
        """;

    public async Task<IReadOnlyDictionary<string, string>> TranslateAsync(string lang, string languageName, IReadOnlyList<string> texts)
    {
        var system = new List<SystemBlock> { new(Rules.Replace("{language}", languageName), Cache: true) };
        var translated = new Dictionary<string, string>();
        foreach (var batch in texts.Chunk(BatchSize))
        {
            var (turn, _) = await router.CompleteAsync("translate", system, JsonSerializer.Serialize(batch, Unescaped), MaxTokens);
            if (ParseArray(TextOf(turn)) is not { } answer)
            {
                log.LogWarning("Translation to {Lang}: the model did not answer with a JSON array", lang);
                continue;
            }
            if (answer.Count != batch.Length)
            {
                log.LogWarning("Translation to {Lang}: {Got} strings back for {Sent}", lang, answer.Count, batch.Length);
                continue;
            }
            for (var i = 0; i < batch.Length; i++)
            {
                if (answer[i] is JsonValue value && value.TryGetValue<string>(out var line)
                    && line.Trim().Length > 0 && line.Length <= MaxSourceLength * 3)
                    translated[batch[i]] = line;
            }
        }
        return translated;
    }

    /// <summary>The answer's text blocks, joined.</summary>
    private static string TextOf(LlmTurn turn) => string.Concat(turn.Content.OfType<JsonObject>()
        .Where(b => b["type"]?.GetValue<string>() == "text")
        .Select(b => b["text"]?.GetValue<string>() ?? "")).Trim();

    /// <summary>The JSON array inside the answer (models sometimes wrap it in a sentence or a code fence), or null.</summary>
    private static JsonArray? ParseArray(string raw)
    {
        var start = raw.IndexOf('[');
        var end = raw.LastIndexOf(']');
        if (start >= 0 && end > start) raw = raw[start..(end + 1)];
        try { return JsonNode.Parse(raw) as JsonArray; }
        catch (JsonException) { return null; }
    }
}
