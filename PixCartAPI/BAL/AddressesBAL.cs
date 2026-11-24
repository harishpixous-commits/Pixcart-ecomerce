using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.CustomeAttributes;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Saved delivery addresses (reference: routers/addresses.py): at most 20 per shopper, soft-deleted so past orders
/// keep their snapshot, one default that moves to the newest address when the old default is deleted.
/// </summary>
public class AddressesBAL(AddressDAL addresses) : IAddressesBAL
{
    private const int MaxAddresses = 20;

    /// <summary>Reference field validators throw 422s; keep that contract if a bad value slips past the attributes.</summary>
    private static AddressModel Cleaned(AddressModel input)
    {
        try
        {
            return Clean(input);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "validation", 422);
        }
    }

    public async Task<JsonArray> ListAsync(Guid userId)
    {
        var rows = await addresses.ListAsync(userId);
        var arr = new JsonArray();
        foreach (var a in rows)
        {
            arr.Add(Out(a));
        }
        return arr;
    }

    public async Task<JsonObject> CreateAsync(Guid userId, AddressModel input, bool isDefault, decimal? lat, decimal? lng)
    {
        var count = await addresses.CountAsync(userId);
        if (count >= MaxAddresses)
        {
            throw new AppException($"You can save up to {MaxAddresses} addresses", "address_limit");
        }
        var makeDefault = isDefault || count == 0;
        if (makeDefault)
        {
            await addresses.ClearDefaultAsync(userId);
        }
        var a = Cleaned(input);
        a.Id = Guid.NewGuid();
        a.UserId = userId;
        a.IsDefault = makeDefault;
        (a.Lat, a.Lng) = Coords(lat, lng);
        await addresses.InsertAsync(a);
        return Out(a);
    }

    public async Task<JsonObject> SetInstructionsAsync(Guid userId, Guid addressId, string instructions)
    {
        var a = await OwnedAsync(userId, addressId);
        a.Instructions = Tidy(instructions);
        await addresses.UpdateAsync(a);
        return Out(a);
    }

    public async Task<JsonObject> SetLocationAsync(Guid userId, Guid addressId, decimal? lat, decimal? lng)
    {
        var a = await OwnedAsync(userId, addressId);
        (a.Lat, a.Lng) = Coords(lat, lng);
        await addresses.UpdateAsync(a);
        return Out(a);
    }

    public async Task<JsonObject> UpdateAsync(Guid userId, Guid addressId, AddressModel input, bool isDefault, decimal? lat, decimal? lng)
    {
        var a = await OwnedAsync(userId, addressId);
        var c = Cleaned(input);
        a.FullName = c.FullName;
        a.Phone = c.Phone;
        a.Line1 = c.Line1;
        a.Line2 = c.Line2;
        a.Landmark = c.Landmark;
        a.City = c.City;
        a.StateCode = c.StateCode;
        a.Pincode = c.Pincode;
        a.Kind = c.Kind;
        a.Label = c.Label;
        a.Instructions = c.Instructions;
        (a.Lat, a.Lng) = Coords(lat, lng);
        if (isDefault && !a.IsDefault)
        {
            await addresses.ClearDefaultAsync(userId);
            a.IsDefault = true;
        }
        await addresses.UpdateAsync(a);
        return Out(a);
    }

    public async Task<JsonObject> DeleteAsync(Guid userId, Guid addressId)
    {
        var a = await OwnedAsync(userId, addressId);
        a.IsDeleted = true;
        var wasDefault = a.IsDefault;
        a.IsDefault = false;
        await addresses.UpdateAsync(a);
        if (wasDefault)
        {
            var next = await addresses.NewestAsync(userId);
            if (next is not null)
            {
                next.IsDefault = true;
                await addresses.UpdateAsync(next);
            }
        }
        return new JsonObject { ["ok"] = true };
    }

    private async Task<AddressModel> OwnedAsync(Guid userId, Guid addressId)
    {
        var a = await addresses.GetAsync(addressId);
        if (a is null || a.UserId != userId || a.IsDeleted)
        {
            throw new NotFoundException("Address");
        }
        return a;
    }

    /// <summary>Reference field validators: stripped names/lines, tidied label/instructions, normalised phone, checked pin/state.</summary>
    private static AddressModel Clean(AddressModel input) => new()
    {
        FullName = input.FullName.Trim(),
        Phone = IndianFormats.NormalizeMobile(input.Phone),
        Line1 = input.Line1.Trim(),
        Line2 = input.Line2.Trim(),
        Landmark = input.Landmark.Trim(),
        City = input.City.Trim(),
        StateCode = IndianFormats.ValidateStateCode(input.StateCode),
        Pincode = IndianFormats.ValidatePincode(input.Pincode),
        Kind = input.Kind,
        Label = Tidy(input.Label),
        Instructions = Tidy(input.Instructions),
    };

    /// <summary>" ".join(v.split()): runs of whitespace become single spaces.</summary>
    private static string Tidy(string? v) => string.Join(' ', (v ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>Both or neither: a pin needs latitude and longitude, rounded to about 10 cm (6 dp).</summary>
    private static (decimal?, decimal?) Coords(decimal? lat, decimal? lng)
    {
        if (lat is null || lng is null)
        {
            return (null, null);
        }
        return (Math.Round(lat.Value, 6), Math.Round(lng.Value, 6));
    }

    /// <summary>Reference address_out: the flat card the account page and checkout render.</summary>
    public JsonObject Out(AddressModel a) => new()
    {
        ["id"] = a.Id.ToString(),
        ["full_name"] = a.FullName,
        ["phone"] = a.Phone,
        ["line1"] = a.Line1,
        ["line2"] = a.Line2,
        ["landmark"] = a.Landmark,
        ["city"] = a.City,
        ["state_code"] = a.StateCode,
        ["state"] = IndianStates.Name(a.StateCode),
        ["pincode"] = a.Pincode,
        ["kind"] = a.Kind,
        ["is_default"] = a.IsDefault,
        ["label"] = a.Label,
        ["instructions"] = a.Instructions,
        ["lat"] = a.Lat,
        ["lng"] = a.Lng,
    };
}
