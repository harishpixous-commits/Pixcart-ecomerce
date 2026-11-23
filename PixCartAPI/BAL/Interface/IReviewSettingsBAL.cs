using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>
/// Ratings and reviews settings (Admin → Reviews → Settings, <c>platform_settings['reviews']</c>): who may review,
/// photos and videos, reports that hide a review, shortest text, "what customers talk about" topics, guidelines.
/// The on/off switch for reviews and "hold every review" stay in the marketplace settings.
/// </summary>
public interface IReviewSettingsBAL
{
    /// <summary>Defaults with the saved values on top.</summary>
    Task<JsonObject> GetAsync();

    /// <summary>Checks and saves changes; 400 "invalid_setting" with the reference message when a value is not allowed.</summary>
    Task<JsonObject> UpdateAsync(JsonObject data);

    /// <summary>What the storefront needs (no internal thresholds).</summary>
    JsonObject Public(JsonObject cfg);
}
