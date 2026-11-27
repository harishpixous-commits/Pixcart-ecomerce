using System.Security.Cryptography;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Model.DomainModel.Auth;
using Utils;
using Utils.Interface;
namespace BAL;

/// <summary>Seller-side KYC workflow from routers/seller_onboarding.py. No payout-provider calls.</summary>
public class SellerOnboardingBAL(SellerAccountDAL dal, AccountDAL accounts, SellerModerationBAL profiles,
    IAuthSettingsBAL auth, IAuditBAL audit, EncryptDecrypt crypto, IMySqlDapperHelper db, IImageUpload storage, IAccessBAL access, INotifyBAL notifier) : ISellerOnboardingBAL
{
    private static readonly string[] DocumentKinds = ["pan_card", "gst_certificate", "cancelled_cheque", "address_proof"];
    public async Task<SellerModel> OwnAsync(UserModel user) => await accounts.GetSellerByUserAsync(user.Id)
        ?? throw new ForbiddenException("Register as a seller first");
    private static void Editable(SellerModel s)
    {
        if (s.Status is not ("draft" or "rejected")) throw new ConflictException(
            "KYC details are locked while your application is under review or approved. Contact seller support to change them.", "kyc_locked");
    }
    public async Task<JsonObject> MeAsync(UserModel u) => await profiles.ProfileAsync(await OwnAsync(u), false);
    public async Task<JsonObject> RegisterAsync(UserModel u, string name)
    {
        var existing = await accounts.GetSellerByUserAsync(u.Id);
        if (existing is not null) return await profiles.ProfileAsync(existing, false);
        if (!(await auth.GetAsync())["seller_signup"]!.GetValue<bool>()) throw new AppException(
            "New seller registrations are paused right now. Please try again later.", "seller_signup_closed", 403);
        var slug = IndianFormats.Slugify(name, 70); var root = slug;
        while (await dal.SlugTakenAsync(slug)) slug = $"{root}-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(2))}";
        var now = DateTimeFunctions.UtcNow();
        var s = new SellerModel { Id = Guid.NewGuid(), UserId = u.Id, Status = "draft", DisplayName = name.Trim(), Slug = slug,
            BusinessType = "proprietorship", ContactPhone = u.Phone ?? "", ContactEmail = u.Email ?? "", DispatchDays = 2, CreatedAt = now, UpdatedAt = now };
        await using var tx = await db.BeginAsync();
        await dal.InsertAsync(s, tx.Transaction);
        await audit.AuditAsync(u, "seller.register", "seller", s.Id, uow: tx);
        await tx.CommitAsync();
        await notifier.NotifyStaffAsync("sellers", "staff_review", new Dictionary<string, object?> { ["subject"] = "Seller waiting for review", ["message"] = s.DisplayName + " submitted their documents. Check them in Sellers." }, "/admin/sellers/" + s.Id);
        return await profiles.ProfileAsync(s, false);
    }
    public async Task<JsonObject> ProfileAsync(UserModel u, SellerProfileIn b)
    {
        var s = await OwnAsync(u); Editable(s);
        var gst = IndianFormats.ValidateGstin(b.Gstin); var pan = IndianFormats.ValidatePan(b.Pan);
        if (gst.Substring(2, 10) != pan) throw new AppException(
            "The PAN inside your GSTIN (characters 3 to 12) must match the PAN you entered", "pan_gstin_mismatch", fields: new Dictionary<string,string> { ["pan"] = "Does not match GSTIN" });
        if (await dal.GstinTakenAsync(gst, s.Id)) throw new ConflictException("This GSTIN is already registered with another seller account", "gstin_taken");
        s.DisplayName = b.DisplayName!.Trim(); s.Description = b.Description.Trim(); s.LegalName = b.LegalName!.Trim(); s.BusinessType = b.BusinessType!;
        s.Gstin = gst; s.PanEnc = crypto.Encrypt(pan); s.PanLast4 = pan[^4..]; s.ContactEmail = b.ContactEmail!.ToLowerInvariant(); s.ContactPhone = IndianFormats.NormalizeMobile(b.ContactPhone);
        return await SaveAsync(s);
    }
    public async Task<JsonObject> StoreAsync(UserModel u, string name, string desc, string email, string phone)
    {
        var s = await OwnAsync(u); s.DisplayName = name.Trim(); s.Description = desc.Trim(); s.ContactEmail = email.ToLowerInvariant(); s.ContactPhone = IndianFormats.NormalizeMobile(phone);
        return await SaveAsync(s);
    }
    private async Task<JsonObject> SaveAsync(SellerModel s)
    { s.UpdatedAt = DateTimeFunctions.UtcNow(); await dal.UpdateKycAsync(s); return await profiles.ProfileAsync(s, false); }
    public async Task<JsonObject> PickupAsync(UserModel u, SellerPickupIn b)
    {
        var s = await OwnAsync(u); Editable(s);
        s.PickupLine1 = b.Line1!.Trim(); s.PickupLine2 = b.Line2.Trim(); s.PickupCity = b.City!.Trim();
        s.PickupStateCode = IndianFormats.ValidateStateCode(b.StateCode); s.PickupPincode = IndianFormats.ValidatePincode(b.Pincode); s.UpdatedAt = DateTimeFunctions.UtcNow();
        await using var tx = await db.BeginAsync();
        await dal.UpdateKycAsync(s, tx.Transaction);
        var wh = await dal.DefaultWarehouseAsync(s.Id, tx.Transaction);
        if (wh is null) await dal.InsertWarehouseAsync(new WarehouseModel { Id = Guid.NewGuid(), SellerId = s.Id, Code = "MAIN", Name = "Main warehouse",
            Line1 = s.PickupLine1, Line2 = s.PickupLine2, City = s.PickupCity, StateCode = s.PickupStateCode, Pincode = s.PickupPincode,
            ContactName = s.DisplayName, ContactPhone = s.ContactPhone, IsDefault = true, IsActive = true, CreatedAt = s.UpdatedAt, UpdatedAt = s.UpdatedAt }, tx.Transaction);
        else { wh.Line1 = s.PickupLine1; wh.Line2 = s.PickupLine2; wh.City = s.PickupCity; wh.StateCode = s.PickupStateCode; wh.Pincode = s.PickupPincode; wh.UpdatedAt = s.UpdatedAt; await dal.UpdateWarehouseAddressAsync(wh, tx.Transaction); }
        await tx.CommitAsync(); return await profiles.ProfileAsync(s, false);
    }
    public async Task<JsonObject> BankAsync(UserModel u, SellerBankIn b)
    {
        var s = await OwnAsync(u); Editable(s);
        var number = IndianFormats.ValidateAccountNumber(b.AccountNumber);
        if (number != IndianFormats.ValidateAccountNumber(b.ConfirmAccountNumber)) throw new AppException("Account numbers do not match", "account_mismatch", fields: new Dictionary<string,string> { ["confirm_account_number"] = "Does not match" });
        s.BankHolderName = b.HolderName!.Trim(); s.BankAccountEnc = crypto.Encrypt(number); s.BankAccountLast4 = number[^4..]; s.BankIfsc = IndianFormats.ValidateIfsc(b.Ifsc); s.PayoutFundAccountId = "";
        return await SaveAsync(s);
    }
    public async Task<JsonObject> GrievanceAsync(UserModel u, SellerGrievanceIn b)
    {
        var s = await OwnAsync(u); s.GrievanceName = b.Name!.Trim(); s.GrievanceEmail = b.Email!.ToLowerInvariant(); s.GrievancePhone = IndianFormats.NormalizeMobile(b.Phone); return await SaveAsync(s);
    }
    public async Task<JsonObject> UploadAsync(UserModel u, string kind, byte[] bytes, string filename, CancellationToken ct)
    {
        if (!DocumentKinds.Contains(kind)) throw new NotFoundException("Document type");
        var s = await OwnAsync(u); Editable(s);
        var (key, type) = await storage.SavePrivateAsync(bytes, $"kyc/{s.Id}", ct);
        await dal.UpsertDocumentAsync(new SellerDocumentModel { Id = Guid.NewGuid(), SellerId = s.Id, Kind = kind, StorageKey = key,
            Filename = filename[..Math.Min(200, filename.Length)], ContentType = type, SizeBytes = bytes.Length, UploadedAt = DateTimeFunctions.UtcNow() });
        return await profiles.ProfileAsync(s, false);
    }
    public async Task<(byte[] Bytes, string Type, string Name)> DownloadAsync(UserModel u, string kind, CancellationToken ct)
    {
        var s = await OwnAsync(u); var d = (await dal.DocumentsAsync(s.Id)).FirstOrDefault(d => d.Kind == kind) ?? throw new NotFoundException("Document");
        return (await storage.ReadPrivateAsync(d.StorageKey, ct), d.ContentType, $"{kind}.{d.StorageKey.Split('.').Last()}");
    }
    public async Task<(byte[] Bytes, string Type, string Name)> AdminDocumentAsync(UserModel user, Guid sellerId, string kind, CancellationToken ct)
    {
        await access.RequireAsync(user, "sellers");
        await audit.AuditAsync(user, "seller.view_document", "seller", sellerId, kind);
        var d = (await dal.DocumentsAsync(sellerId)).FirstOrDefault(d => d.Kind == kind) ?? throw new NotFoundException("Document");
        return (await storage.ReadPrivateAsync(d.StorageKey, ct), d.ContentType, $"{kind}.{d.StorageKey.Split('.').Last()}");
    }
    public async Task<JsonObject> SubmitAsync(UserModel u)
    {
        var s = await OwnAsync(u); Editable(s);
        var docs = (await dal.DocumentsAsync(s.Id)).Select(d => d.Kind).ToHashSet();
        var missing = SellerModerationBAL.Checklist(s, docs).OfType<JsonObject>().Where(i => !i["done"]!.GetValue<bool>()).Select(i => i["label"]!.GetValue<string>()).ToList();
        if (missing.Count > 0) throw new AppException("Please complete: " + string.Join("; ", missing), "onboarding_incomplete");
        if (!string.IsNullOrEmpty(s.Gstin) && s.Gstin[..2] != s.PickupStateCode) throw new AppException("Your pickup address must be in the state of your GSTIN registration (GST registration is state-wise)", "gstin_state_mismatch");
        s.Status = "submitted"; s.SubmittedAt = DateTimeFunctions.UtcNow(); s.RejectionReason = ""; s.UpdatedAt = DateTimeFunctions.UtcNow();
        await using var tx = await db.BeginAsync(); await dal.UpdateSubmissionAsync(s, tx.Transaction); await audit.AuditAsync(u, "seller.submit", "seller", s.Id, uow: tx); await tx.CommitAsync();
        return await profiles.ProfileAsync(s, false);
    }
}
