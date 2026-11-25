namespace BAL.Interface;

using System.Text.Json.Nodes;
using Model.DomainModel;

public interface IAiBAL
{
    /// <summary>Reference: ai.settings.get_ai_settings (platform_settings key "ai", defaults merged).</summary>
    Task<JsonObject> GetSettingsAsync();

    /// <summary>Reference: ai.settings.save_ai_settings + validate; audits ai.settings.</summary>
    Task<JsonObject> SaveSettingsAsync(UserModel actor, JsonObject data);

    /// <summary>Reference: routers/ai.py _inputs — validated task inputs from the request fields.</summary>
    Task<JsonObject> InputsAsync(string task, string notes, Guid? categoryId, string brand, string tone, string intent);

    /// <summary>Reference: ai.service.mode — "live" when a provider is configured (never in this environment), else "sandbox".</summary>
    Task<string> ModeAsync();

    /// <summary>Reference: ai.client.configured — any enabled target on the "studio" route (builtin key counts).</summary>
    Task<bool> ConfiguredAsync();

    /// <summary>Reference: ai.service.usage_this_month (IST month, live runs only).</summary>
    Task<JsonObject> UsageThisMonthAsync();

    DateTime MonthStart();

    /// <summary>Reference: ai.service.run — one task, recorded as an ai_runs row (caller commits nothing; it commits).</summary>
    Task<(AiRunModel Run, JsonObject Output)> RunAsync(string taskKey, UserModel? actor, JsonObject inputs,
        string subjectId = "", Guid? sellerId = null);

    /// <summary>Reference: ai.service.run_out.</summary>
    JsonObject RunOut(AiRunModel r, JsonObject? cfg = null, string? byName = null, bool includeInputs = false);

    /// <summary>Reference: ai.service.finish — records what a person did with a draft.</summary>
    Task<AiRunModel?> FinishAsync(string runId, string status, UserModel actor, string finalText = "", Guid? sellerId = null);

    /// <summary>Reference: routers/ai.py studio — settings, status, models, usage and task cards.</summary>
    Task<JsonObject> StudioAsync();

    /// <summary>Reference: routers/ai.py runs list.</summary>
    Task<JsonObject> RunsPageAsync(string? task, string? status, int page);

    /// <summary>Reference: ai.briefs.seller_risk (deterministic, no model call).</summary>
    Task<JsonObject> SellerRiskAsync(Guid sellerId);

    /// <summary>Reference: ai.briefs.order_risk (deterministic, no model call).</summary>
    Task<JsonObject> OrderRiskAsync(Guid orderId);

    /// <summary>Reference: jobs.review_summary_job — live mode only; a no-op under the sandbox.</summary>
    Task<int> ReviewSummariesAsync();

    /// <summary>Reference: ai.settings.cost_usd.</summary>
    double CostUsd(JsonObject cfg, long inputTokens, long outputTokens);
}
