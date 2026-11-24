using System.Text.Json.Nodes;
using Model.DomainModel;

namespace BAL.Interface;

/// <summary>The shopper's saved delivery addresses (reference: routers/addresses.py).</summary>
public interface IAddressesBAL
{
    Task<JsonArray> ListAsync(Guid userId);
    Task<JsonObject> CreateAsync(Guid userId, AddressModel input, bool isDefault, decimal? lat, decimal? lng);
    Task<JsonObject> SetInstructionsAsync(Guid userId, Guid addressId, string instructions);
    Task<JsonObject> SetLocationAsync(Guid userId, Guid addressId, decimal? lat, decimal? lng);
    Task<JsonObject> UpdateAsync(Guid userId, Guid addressId, AddressModel input, bool isDefault, decimal? lat, decimal? lng);
    Task<JsonObject> DeleteAsync(Guid userId, Guid addressId);
    JsonObject Out(AddressModel a);
}
