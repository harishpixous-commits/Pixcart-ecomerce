using Model.DomainModel;
using Model.DomainModel.Auth;

namespace BAL.Interface;

/// <summary>Customers' saved delivery addresses (the reference version's routers/addresses.py).</summary>
public interface IAddressBAL
{
    /// <summary>The user's address, or 404 "Address not found" (someone else's or deleted). Used by checkout.</summary>
    Task<AddressModel> GetOwnedAddressAsync(Guid userId, Guid addressId);

    /// <summary>An address as the API sends it.</summary>
    Dictionary<string, object?> AddressOut(AddressModel a);

    Task<List<Dictionary<string, object?>>> ListAsync(UserModel user);
    Task<Dictionary<string, object?>> CreateAsync(UserModel user, AddressIn body);
    Task<Dictionary<string, object?>> UpdateAsync(UserModel user, Guid id, AddressIn body);
    Task<Dictionary<string, object?>> SetInstructionsAsync(UserModel user, Guid id, string instructions);
    Task<Dictionary<string, object?>> SetLocationAsync(UserModel user, Guid id, double? lat, double? lng);
    Task DeleteAsync(UserModel user, Guid id);
}

/// <summary>Customer support tickets (services/support.py and the customer endpoints of routers/customer.py).</summary>
public interface ISupportTicketBAL
{
    /// <summary>What a request can be about (code → label).</summary>
    IReadOnlyDictionary<string, string> Categories { get; }

    /// <summary>
    /// Opens a ticket with the customer's first message (also used by the shop assistant). 400 "invalid_category",
    /// 404 for someone else's order, 400 "too_many_tickets" with 10 open requests.
    /// </summary>
    Task<SupportTicketModel> CreateTicketAsync(UserModel user, string category, string subject, string message, Guid? orderId = null, bool isGrievance = false);

    /// <summary>A ticket as the API sends it; <paramref name="staff"/> adds due dates and internal notes.</summary>
    Dictionary<string, object?> TicketOut(SupportTicketModel t, IEnumerable<TicketMessageModel>? messages = null, bool staff = false);

    Task<object> MyTicketsAsync(UserModel user);
    Task<Dictionary<string, object?>> GetTicketAsync(UserModel user, Guid id);
    Task<Dictionary<string, object?>> ReplyAsync(UserModel user, Guid id, string body);
    Task<Dictionary<string, object?>> CloseAsync(UserModel user, Guid id);
}

/// <summary>The wishlist (GET/PUT/DELETE /api/wishlist).</summary>
public interface IWishlistBAL
{
    Task<object> ListAsync(UserModel user);
    Task AddAsync(UserModel user, Guid productId);
    Task RemoveAsync(UserModel user, Guid productId);
}

/// <summary>Privacy (DPDP Act 2023): marketing consent, data export and account deletion.</summary>
public interface IAccountBAL
{
    Task<object> ConsentAsync(UserModel user, bool marketingOptIn);
    Task<object> ExportAsync(UserModel user);
    /// <summary>Right to erasure: the account is anonymised; order and tax records stay as the GST law requires.</summary>
    Task DeleteAsync(UserModel user);
}

/// <summary>The storefront beacon (POST /api/events): product views and add-to-cart counts per day.</summary>
public interface IProductEventBAL
{
    Task RecordAsync(string ip, string type, Guid productId);
}
