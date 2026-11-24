using System.Text.Json.Nodes;
using Model.CustomeAttributes;

namespace Model.DomainModel.Auth;

// Request bodies of the sign-in and account endpoints (/api/auth, /api/addresses, /api/push, /api/account ...).
// Field rules and messages follow the reference API's Pydantic models.

/// <summary>POST /api/auth/otp/request. purpose: signin (an existing account), signup (a new one) or any (older clients).</summary>
public record OtpRequestIn
{
    [Present, Mobile] public string? Phone { get; init; }
    [OneOf("signin", "signup", "any")] public string Purpose { get; init; } = "any";
    /// <summary>Creating an account to sell (checked against the seller sign-up switch).</summary>
    public bool ForSeller { get; init; }
}

/// <summary>POST /api/auth/otp/verify.</summary>
public record OtpVerifyIn : OtpRequestIn
{
    [Present, Len(4, 8)] public string? Code { get; init; }
    [Len(0, 120)] public string Name { get; init; } = "";
    [Email] public string? Email { get; init; }
    public bool AcceptTerms { get; init; }
    public bool MarketingOptIn { get; init; }
}

/// <summary>POST /api/auth/login (staff, email and password).</summary>
public record PasswordLoginIn
{
    [Present, Email] public string? Email { get; init; }
    [Present, Len(1, 200)] public string? Password { get; init; }
    [Len(0, 8)] public string Totp { get; init; } = "";
}

/// <summary>POST /api/auth/password.</summary>
public record PasswordChangeIn
{
    [Present, Len(1, 200)] public string? CurrentPassword { get; init; }
    /// <summary>The owner's policy (Admin → Sign-in) is checked on top.</summary>
    [Present, Len(8, 200)] public string? NewPassword { get; init; }
}

/// <summary>POST /api/auth/totp/enable and /disable.</summary>
public record TotpCodeIn
{
    [Present, Len(6, 8)] public string? Code { get; init; }
    /// <summary>Needed to turn two-step sign-in off (accounts with a password).</summary>
    [Len(0, 200)] public string Password { get; init; } = "";
}

/// <summary>PATCH /api/auth/me.</summary>
public record ProfileUpdateIn
{
    [Len(1, 120)] public string? Name { get; init; }
    [Email] public string? Email { get; init; }
}

/// <summary>POST and PUT /api/addresses.</summary>
public record AddressIn
{
    [Present, Len(2, 120)] public string? FullName { get; init; }
    [Present, Mobile] public string? Phone { get; init; }
    [Present, Len(3, 200)] public string? Line1 { get; init; }
    [Len(0, 200)] public string Line2 { get; init; } = "";
    [Len(0, 120)] public string Landmark { get; init; } = "";
    [Present, Len(2, 80)] public string? City { get; init; }
    [Present, StateCode] public string? StateCode { get; init; }
    [Present, PinCode] public string? Pincode { get; init; }
    [OneOf("home", "work", "other")] public string Kind { get; init; } = "home";
    public bool IsDefault { get; init; }
    /// <summary>The shopper's own name for it, e.g. "Amma's house".</summary>
    [Len(0, 40)] public string Label { get; init; } = "";
    /// <summary>For the delivery partner or courier.</summary>
    [Len(0, 300)] public string Instructions { get; init; } = "";
    /// <summary>Map pin (India only).</summary>
    [Between(6, 38, AsFloat = true)] public double? Lat { get; init; }
    [Between(68, 98, AsFloat = true)] public double? Lng { get; init; }
}

/// <summary>PATCH /api/addresses/{id}/instructions.</summary>
public record InstructionsIn
{
    [Len(0, 300)] public string Instructions { get; init; } = "";
}

/// <summary>PATCH /api/addresses/{id}/location (nulls remove the pin).</summary>
public record LocationIn
{
    [Between(6, 38, AsFloat = true)] public double? Lat { get; init; }
    [Between(68, 98, AsFloat = true)] public double? Lng { get; init; }
}

/// <summary>POST /api/push/tokens.</summary>
public record PushTokenIn
{
    [Present, Len(20, 400)] public string? Token { get; init; }
    [OneOf("web", "android", "ios")] public string Platform { get; init; } = "web";
    [OneOf("shop", "delivery", "seller", "admin")] public string App { get; init; } = "shop";
}

/// <summary>POST /api/push/tokens/remove.</summary>
public record PushTokenOut
{
    [Present, Len(20, 400)] public string? Token { get; init; }
}

/// <summary>PUT /api/account/consent.</summary>
public record ConsentIn
{
    [Present] public bool? MarketingOptIn { get; init; }
}

/// <summary>POST /api/events (storefront beacon).</summary>
public record EventIn
{
    [Present, OneOf("view", "add_to_cart")] public string? Type { get; init; }
    [Present] public Guid? ProductId { get; init; }
}

/// <summary>POST /api/support/tickets.</summary>
public record TicketIn
{
    [Present] public string? Category { get; init; }
    [Present, Len(5, 200)] public string? Subject { get; init; }
    [Present, Len(10, 5000)] public string? Message { get; init; }
    public Guid? OrderId { get; init; }
    public bool IsGrievance { get; init; }
}

/// <summary>POST /api/support/tickets/{id}/messages.</summary>
public record TicketMessageIn
{
    [Present, Len(1, 5000)] public string? Body { get; init; }
}

/// <summary>PUT /api/admin/integrations/{key}.</summary>
public record IntegrationSaveIn
{
    public JsonObject Values { get; init; } = [];
    [Len(0, 20)] public List<string> Clear { get; init; } = [];
    public bool? Enabled { get; init; }
    [Present, Len(1, 200)] public string? Password { get; init; }
    [Len(0, 8)] public string Totp { get; init; } = "";
}

/// <summary>POST /api/admin/integrations/{key}/test.</summary>
public record IntegrationTestIn
{
    [System.ComponentModel.DataAnnotations.RegularExpression("^([6-9][0-9]{9})?$", ErrorMessage = "use a 10-digit mobile number")]
    public string Phone { get; init; } = "";
    [Len(0, 200)] public string To { get; init; } = "";
}
