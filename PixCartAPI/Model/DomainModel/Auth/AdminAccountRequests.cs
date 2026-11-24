using Model.CustomeAttributes;

namespace Model.DomainModel.Auth;

// Request bodies of Admin → Staff and roles, Admin → Customers and sellers created or corrected by staff.

/// <summary>POST /api/admin/roles and PUT /api/admin/roles/{code}.</summary>
public record RoleIn
{
    [Present, Len(2, 80)] public string? Name { get; init; }
    [Len(0, 300)] public string Description { get; init; } = "";
    [Len(0, 23)] public List<string> Permissions { get; init; } = [];
}

/// <summary>POST /api/admin/staff.</summary>
public record StaffIn
{
    [Present, Email] public string? Email { get; init; }
    [Present, Len(2, 120)] public string? Name { get; init; }
    [Present, Len(2, 40)] public string? Role { get; init; }
    /// <summary>Plus the owner's password policy.</summary>
    [Present, Len(8, 200)] public string? Password { get; init; }
}

/// <summary>PATCH /api/admin/staff/{id}.</summary>
public record StaffPatchIn
{
    [Len(0, 40)] public string? Role { get; init; }
    public bool? IsActive { get; init; }
    [Len(2, 120)] public string? Name { get; init; }
    public bool ResetTwoStep { get; init; }
}

/// <summary>POST /api/admin/customers (e.g. a phone order).</summary>
public record CustomerIn
{
    [Present, Len(2, 120)] public string? Name { get; init; }
    [Present] public string? Phone { get; init; }
    [Email] public string? Email { get; init; }
    public bool MarketingOptIn { get; init; }
}

/// <summary>PATCH /api/admin/customers/{id}.</summary>
public record CustomerPatchIn
{
    [Len(2, 120)] public string? Name { get; init; }
    public string? Phone { get; init; }
    [Email] public string? Email { get; init; }
    public bool ClearEmail { get; init; }
    public bool? MarketingOptIn { get; init; }
}

/// <summary>POST /api/admin/sellers: a seller account opened by staff (starts as a draft).</summary>
public record SellerCreateIn
{
    [Present] public string? Phone { get; init; }
    /// <summary>The owner's name.</summary>
    [Present, Len(2, 120)] public string? Name { get; init; }
    [Present, Len(2, 80)] public string? StoreName { get; init; }
    [Email] public string? Email { get; init; }
}

/// <summary>Business, GSTIN and PAN details of a seller.</summary>
public record SellerProfileIn
{
    [Present, Len(3, 80)] public string? DisplayName { get; init; }
    [Len(0, 2000)] public string Description { get; init; } = "";
    [Present, Len(3, 160)] public string? LegalName { get; init; }
    [Present, OneOf("individual", "proprietorship", "partnership", "llp", "private_limited", "public_limited")] public string? BusinessType { get; init; }
    [Present, Gstin] public string? Gstin { get; init; }
    [Present, Pan] public string? Pan { get; init; }
    [Present, Email] public string? ContactEmail { get; init; }
    [Present, Mobile] public string? ContactPhone { get; init; }
}

/// <summary>A seller's pickup address.</summary>
public record SellerPickupIn
{
    [Present, Len(3, 200)] public string? Line1 { get; init; }
    [Len(0, 200)] public string Line2 { get; init; } = "";
    [Present, Len(2, 80)] public string? City { get; init; }
    [Present, StateCode] public string? StateCode { get; init; }
    [Present, PinCode] public string? Pincode { get; init; }
}

/// <summary>A seller's payout bank account, changed by staff (who confirm with their password and authenticator code).</summary>
public record SellerBankIn
{
    [Present, Len(3, 120)] public string? HolderName { get; init; }
    [Present, BankAccount] public string? AccountNumber { get; init; }
    [Present, BankAccount] public string? ConfirmAccountNumber { get; init; }
    [Present, Ifsc] public string? Ifsc { get; init; }
    [Len(0, 200)] public string Password { get; init; } = "";
    [Len(0, 8)] public string Totp { get; init; } = "";
}

/// <summary>A seller's grievance officer.</summary>
public record SellerGrievanceIn
{
    [Present, Len(3, 120)] public string? Name { get; init; }
    [Present, Email] public string? Email { get; init; }
    [Present, Mobile] public string? Phone { get; init; }
}
