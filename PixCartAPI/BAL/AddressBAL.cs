using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Model.DomainModel.Auth;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IAddressBAL"/>
public class AddressBAL(AddressDAL dal, IMySqlDapperHelper db) : IAddressBAL
{
    public const int MaxAddresses = 20;

    private static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    public Dictionary<string, object?> AddressOut(AddressModel a) => new()
    {
        ["id"] = a.Id.ToString(), ["full_name"] = a.FullName, ["phone"] = a.Phone, ["line1"] = a.Line1, ["line2"] = a.Line2, ["landmark"] = a.Landmark,
        ["city"] = a.City, ["state_code"] = a.StateCode, ["state"] = IndianFormats.States.GetValueOrDefault(a.StateCode, ""), ["pincode"] = a.Pincode,
        ["kind"] = a.Kind, ["is_default"] = a.IsDefault, ["label"] = a.Label, ["instructions"] = a.Instructions,
        ["lat"] = a.Lat is null ? null : (double)a.Lat.Value, ["lng"] = a.Lng is null ? null : (double)a.Lng.Value,
    };

    public async Task<AddressModel> GetOwnedAddressAsync(Guid userId, Guid addressId)
    {
        var a = await dal.GetAsync(addressId);
        if (a is null || a.UserId != userId || a.IsDeleted) throw new NotFoundException("Address");
        return a;
    }

    /// <summary>Both or neither: a pin needs latitude and longitude, rounded to about 10 cm.</summary>
    private static (decimal? Lat, decimal? Lng) Coords(double? lat, double? lng) =>
        lat is null || lng is null ? (null, null) : ((decimal)Math.Round(lat.Value, 6), (decimal)Math.Round(lng.Value, 6));

    /// <summary>Copies the validated, tidied fields of the body onto the address.</summary>
    private static void Apply(AddressModel a, AddressIn b)
    {
        a.FullName = b.FullName!.Trim();
        a.Phone = IndianFormats.NormalizeMobile(b.Phone);
        a.Line1 = b.Line1!.Trim();
        a.Line2 = b.Line2.Trim();
        a.Landmark = b.Landmark.Trim();
        a.City = b.City!.Trim();
        a.StateCode = IndianFormats.ValidateStateCode(b.StateCode);
        a.Pincode = IndianFormats.ValidatePincode(b.Pincode);
        a.Kind = b.Kind;
        a.Label = Collapse(b.Label);
        a.Instructions = Collapse(b.Instructions);
        (a.Lat, a.Lng) = Coords(b.Lat, b.Lng);
    }

    public async Task<List<Dictionary<string, object?>>> ListAsync(UserModel user) => (await dal.ListAsync(user.Id)).Select(AddressOut).ToList();

    public async Task<Dictionary<string, object?>> CreateAsync(UserModel user, AddressIn body)
    {
        await using var uow = await db.BeginAsync();
        var count = await dal.CountAsync(user.Id, uow.Transaction);
        if (count >= MaxAddresses) throw new AppException($"You can save up to {MaxAddresses} addresses", "address_limit");
        var makeDefault = body.IsDefault || count == 0;
        if (makeDefault) await dal.ClearDefaultAsync(user.Id, uow.Transaction);
        var now = DateTimeFunctions.UtcNow();
        var a = new AddressModel { Id = Guid.NewGuid(), UserId = user.Id, IsDefault = makeDefault, CreatedAt = now, UpdatedAt = now };
        Apply(a, body);
        await dal.InsertAsync(a, uow.Transaction);
        await uow.CommitAsync();
        return AddressOut(a);
    }

    public async Task<Dictionary<string, object?>> SetInstructionsAsync(UserModel user, Guid id, string instructions)
    {
        var a = await GetOwnedAddressAsync(user.Id, id);
        a.Instructions = Collapse(instructions);
        a.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateAsync(a);
        return AddressOut(a);
    }

    public async Task<Dictionary<string, object?>> SetLocationAsync(UserModel user, Guid id, double? lat, double? lng)
    {
        var a = await GetOwnedAddressAsync(user.Id, id);
        (a.Lat, a.Lng) = Coords(lat, lng);
        a.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateAsync(a);
        return AddressOut(a);
    }

    public async Task<Dictionary<string, object?>> UpdateAsync(UserModel user, Guid id, AddressIn body)
    {
        var a = await GetOwnedAddressAsync(user.Id, id);
        await using var uow = await db.BeginAsync();
        Apply(a, body);
        if (body.IsDefault && !a.IsDefault)
        {
            await dal.ClearDefaultAsync(user.Id, uow.Transaction);
            a.IsDefault = true;
        }
        a.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateAsync(a, uow.Transaction);
        await uow.CommitAsync();
        return AddressOut(a);
    }

    public async Task DeleteAsync(UserModel user, Guid id)
    {
        var a = await GetOwnedAddressAsync(user.Id, id);
        await using var uow = await db.BeginAsync();
        // soft delete: past orders keep their own snapshot, but the row stays for audit
        var wasDefault = a.IsDefault;
        a.IsDeleted = true;
        a.IsDefault = false;
        a.UpdatedAt = DateTimeFunctions.UtcNow();
        await dal.UpdateAsync(a, uow.Transaction);
        if (wasDefault && await dal.NewestAsync(user.Id, uow.Transaction) is { } next)
        {
            next.IsDefault = true;
            await dal.UpdateAsync(next, uow.Transaction);
        }
        await uow.CommitAsync();
    }
}
