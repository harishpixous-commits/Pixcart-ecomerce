using System.ComponentModel.DataAnnotations;
using System.Text.Json.Nodes;
using API.Infrastructure;
using BAL.Interface;
using Microsoft.AspNetCore.Mvc;
using Model.CustomeAttributes;
using Model.DomainModel;

namespace API.Controllers;

/// <summary>
/// The shopper's saved delivery addresses (reference: routers/addresses.py — same paths, bodies and payload).
/// </summary>
[ApiController]
[Route("/api/addresses")]
[SignedIn]
public class AddressesController(IAddressesBAL addresses, ICurrentUser current) : ControllerBase
{
    private const string Kinds = "home, work or other";

    /// <summary>Reference AddressIn: the whole card; a pin is both lat and lng or neither.</summary>
    public sealed record AddressIn(
        [param: Required, StringLength(120, MinimumLength = 2)] string FullName,
        [param: Required, Mobile] string Phone,
        [param: Required, StringLength(200, MinimumLength = 3)] string Line1,
        [param: StringLength(200)] string? Line2,
        [param: StringLength(120)] string? Landmark,
        [param: Required, StringLength(80, MinimumLength = 2)] string City,
        [param: Required, StateCode] string StateCode,
        [param: Required, PinCode] string Pincode,
        [param: RegularExpression("^(home|work|other)$", ErrorMessage = "kind must be home, work or other")] string? Kind,
        bool IsDefault,
        [param: StringLength(40)] string? Label,
        [param: StringLength(300)] string? Instructions,
        [param: Range(6.0, 38.0, ErrorMessage = "lat must be within India")] double? Lat,
        [param: Range(68.0, 98.0, ErrorMessage = "lng must be within India")] double? Lng)
    {
        public AddressModel Model() => new()
        {
            FullName = FullName,
            Phone = Phone,
            Line1 = Line1,
            Line2 = Line2 ?? "",
            Landmark = Landmark ?? "",
            City = City,
            StateCode = StateCode,
            Pincode = Pincode,
            Kind = Kind ?? "home",
            Label = Label ?? "",
            Instructions = Instructions ?? "",
        };

        public (decimal?, decimal?) Coords() => (Lat is null ? null : (decimal)Lat, Lng is null ? null : (decimal)Lng);
    }

    public sealed record InstructionsIn([param: StringLength(300)] string? Instructions);

    public sealed record LocationIn(
        [param: Range(6.0, 38.0, ErrorMessage = "lat must be within India")] double? Lat,
        [param: Range(68.0, 98.0, ErrorMessage = "lng must be within India")] double? Lng);

    [HttpGet("")]
    public async Task<JsonArray> List() => await addresses.ListAsync(await UserId());

    [HttpPost("")]
    public async Task<IActionResult> Create(AddressIn body)
    {
        var (lat, lng) = body.Coords();
        var result = await addresses.CreateAsync(await UserId(), body.Model(), body.IsDefault, lat, lng);
        return StatusCode(201, result);
    }

    /// <summary>Saves delivery instructions for next time (from checkout).</summary>
    [HttpPatch("{addressId:guid}/instructions")]
    public async Task<JsonObject> SetInstructions(Guid addressId, InstructionsIn body) =>
        await addresses.SetInstructionsAsync(await UserId(), addressId, body.Instructions ?? "");

    /// <summary>Pins (or un-pins, with nulls) an address on the map.</summary>
    [HttpPatch("{addressId:guid}/location")]
    public async Task<JsonObject> SetLocation(Guid addressId, LocationIn body)
    {
        var (lat, lng) = body.Lat is null || body.Lng is null ? (null, null) : ((decimal?)body.Lat, (decimal?)body.Lng);
        return await addresses.SetLocationAsync(await UserId(), addressId, lat, lng);
    }

    [HttpPut("{addressId:guid}")]
    public async Task<JsonObject> Update(Guid addressId, AddressIn body)
    {
        var (lat, lng) = body.Coords();
        return await addresses.UpdateAsync(await UserId(), addressId, body.Model(), body.IsDefault, lat, lng);
    }

    /// <summary>Soft delete: past orders keep their own snapshot, but the row stays for audit.</summary>
    [HttpDelete("{addressId:guid}")]
    public async Task<JsonObject> Delete(Guid addressId) => await addresses.DeleteAsync(await UserId(), addressId);

    private async Task<Guid> UserId() => (await current.RequireAsync()).Id;
}
