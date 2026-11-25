using System.Text.Json.Nodes;

namespace BAL.Interface;

/// <summary>Delivery fleet settings (reference: services/delivery_settings.py).</summary>
public interface IDeliverySettingsBAL
{
    Task<JsonObject> GetAsync();
    JsonObject Validate(JsonObject updates);
    Task<JsonObject> UpdateAsync(JsonObject updates);
    JsonObject Public(JsonObject cfg);
}
