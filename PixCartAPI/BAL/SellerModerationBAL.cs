using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Staff seller KYC operations (reference: routers/admin.py seller endpoints and
/// routers/seller_onboarding.py seller_profile/checklist). The profile response is the reference shape,
/// including the masked-then-revealed PAN and bank account for staff.
/// </summary>
public class SellerModerationBAL(
    SellerModerationDAL sellersDal,
    IAccessBAL access,
    ICatalogNotifyBAL notify,
    EncryptDecrypt crypto,
    IMySqlDapperHelper db) : ISellerModerationBAL
{
    private static readonly string[] RequiredDocs = ["pan_card", "gst_certificate", "cancelled_cheque"];

    private static async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, Guid sellerId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'seller', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = sellerId.ToString(), detail, id = Guid.NewGuid() });

    /// <summary>Reference: seller_onboarding.checklist.</summary>
    private static JsonArray Checklist(SellerModel s, HashSet<string> docKinds)
    {
        var items = new JsonArray();
        void Item(string key, string label, bool done) =>
            items.Add(new JsonObject { ["key"] = key, ["label"] = label, ["done"] = done });
        Item("business", "Business details (legal name, GSTIN, PAN)",
            s.LegalName.Length > 0 && s.Gstin is { Length: > 0 } && s.PanEnc is { Length: > 0 });
        Item("pickup", "Pickup address",
            s.PickupLine1.Length > 0 && s.PickupPincode.Length > 0 && s.PickupStateCode.Length > 0);
        Item("bank", "Bank account for payouts", s.BankAccountEnc is { Length: > 0 } && s.BankIfsc.Length > 0);
        Item("grievance", "Grievance officer (Consumer Protection E-Commerce Rules 2020)",
            s.GrievanceName.Length > 0 && s.GrievanceEmail.Length > 0);
        foreach (var k in RequiredDocs)
            Item($"doc:{k}", $"Upload {k.Replace("_", " ")}", docKinds.Contains(k));
        return items;
    }

    /// <summary>Reference: seller_onboarding.seller_profile.</summary>
    private async Task<JsonObject> ProfileAsync(SellerModel s, bool reveal)
    {
        var docs = await sellersDal.DocsAsync(s.Id);
        var pan = crypto.Decrypt(s.PanEnc);
        var acct = crypto.Decrypt(s.BankAccountEnc);
        var docArray = new JsonArray();
        foreach (var d in docs)
            docArray.Add(new JsonObject
            {
                ["kind"] = d.Kind, ["filename"] = d.Filename, ["content_type"] = d.ContentType,
                ["size_bytes"] = d.SizeBytes,
                ["uploaded_at"] = d.UploadedAt.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            });
        return new JsonObject
        {
            ["id"] = s.Id.ToString(),
            ["status"] = s.Status,
            ["display_name"] = s.DisplayName,
            ["slug"] = s.Slug,
            ["description"] = s.Description,
            ["legal_name"] = s.LegalName,
            ["business_type"] = s.BusinessType,
            ["gstin"] = s.Gstin,
            ["pan"] = reveal ? pan : pan.Length >= 4 ? $"XXXXXX{pan[^4..]}" : pan,
            ["contact_email"] = s.ContactEmail,
            ["contact_phone"] = s.ContactPhone,
            ["pickup"] = new JsonObject
            {
                ["line1"] = s.PickupLine1, ["line2"] = s.PickupLine2, ["city"] = s.PickupCity,
                ["state_code"] = s.PickupStateCode, ["state"] = IndianStates.Name(s.PickupStateCode),
                ["pincode"] = s.PickupPincode,
            },
            ["bank"] = new JsonObject
            {
                ["holder_name"] = s.BankHolderName,
                ["account_number"] = reveal ? acct : acct.Length >= 4 ? $"XXXX{acct[^4..]}" : acct,
                ["ifsc"] = s.BankIfsc,
            },
            ["grievance"] = new JsonObject
            {
                ["name"] = s.GrievanceName, ["email"] = s.GrievanceEmail, ["phone"] = s.GrievancePhone,
            },
            ["documents"] = docArray,
            ["checklist"] = Checklist(s, docs.Select(d => d.Kind).ToHashSet()),
            ["rejection_reason"] = s.RejectionReason,
            ["submitted_at"] = s.SubmittedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["approved_at"] = s.ApprovedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00"),
            ["commission_bps_override"] = s.CommissionBpsOverride,
        };
    }

    private async Task<SellerModel> LockedAsync(Guid sellerId, IUnitOfWork uow) =>
        await sellersDal.SellerForUpdateAsync(sellerId, uow) ?? throw new NotFoundException("Seller");

    public async Task<JsonObject> GetAsync(UserModel admin, Guid sellerId)
    {
        await access.RequireAsync(admin, "sellers");
        var s = await sellersDal.SellerAsync(sellerId) ?? throw new NotFoundException("Seller");
        var data = await ProfileAsync(s, reveal: true);
        var owner = await sellersDal.UserAsync(s.UserId);
        data["owner"] = owner is null ? null : new JsonObject
        {
            ["id"] = owner.Id.ToString(), ["name"] = owner.Name, ["phone"] = owner.Phone, ["email"] = owner.Email,
        };
        var counts = await sellersDal.ProductCountsAsync(s.Id);
        var productCounts = new JsonObject();
        foreach (var (k, v) in counts) productCounts[k] = v;
        data["product_counts"] = productCounts;
        await using var uow = await db.BeginAsync();
        await AuditAsync(uow, admin, "seller.view_kyc", s.Id);
        await uow.CommitAsync();
        return data;
    }

    public async Task<JsonObject> ApproveAsync(UserModel admin, Guid sellerId)
    {
        await access.RequireAsync(admin, "sellers");
        await using var uow = await db.BeginAsync();
        var s = await LockedAsync(sellerId, uow);
        if (s.Status is not ("submitted" or "suspended" or "rejected"))
            throw new ConflictException($"A {s.Status} seller cannot be approved", "invalid_status");
        if (s.Status == "rejected")
        {
            var profile = await ProfileAsync(s, reveal: false);
            var missing = profile["checklist"]!.AsArray()
                .Where(c => c is JsonObject o && o["done"] is JsonValue v && !v.GetValue<bool>())
                .Select(c => c!["label"]!.GetValue<string>()).ToList();
            if (missing.Count > 0)
                throw new ConflictException($"Still missing: {string.Join(", ", missing)}", "kyc_incomplete");
        }
        var was = s.Status;
        await uow.ExecuteAsync(
            "UPDATE sellers SET status = 'approved', approved_at = COALESCE(approved_at, UTC_TIMESTAMP(6)), rejection_reason = '' WHERE id = @id",
            new { id = s.Id });
        await AuditAsync(uow, admin, "seller.approve", s.Id, $"from {was}");
        await uow.CommitAsync();
        await notify.NotifySellerAsync(s.Id, "seller_kyc_update", new Dictionary<string, string>
        {
            ["status"] = was != "suspended" ? "approved" : "active again",
            ["message"] = was != "suspended"
                ? "Your store is approved. You can list products and receive orders." : "Your store is active again.",
        }, "/seller");
        s.Status = "approved";
        s.ApprovedAt ??= DateTimeFunctions.UtcNow();
        s.RejectionReason = "";
        return await ProfileAsync(s, reveal: true);
    }

    public async Task<JsonObject> RejectAsync(UserModel admin, Guid sellerId, string reason)
    {
        await access.RequireAsync(admin, "sellers");
        await using var uow = await db.BeginAsync();
        var s = await LockedAsync(sellerId, uow);
        if (s.Status is not ("submitted" or "approved"))
            throw new ConflictException($"A {s.Status} seller cannot be sent back", "invalid_status");
        await uow.ExecuteAsync("UPDATE sellers SET status = 'rejected', rejection_reason = @reason WHERE id = @id",
            new { reason, id = s.Id });
        await AuditAsync(uow, admin, "seller.reject", s.Id, reason);
        await uow.CommitAsync();
        await notify.NotifySellerAsync(s.Id, "seller_kyc_update", new Dictionary<string, string>
        {
            ["status"] = "sent back for changes",
            ["message"] = $"Please update your details and submit again: {reason}",
        }, "/seller/onboarding");
        s.Status = "rejected";
        s.RejectionReason = reason;
        return await ProfileAsync(s, reveal: true);
    }

    public async Task<JsonObject> SuspendAsync(UserModel admin, Guid sellerId, string reason)
    {
        await access.RequireAsync(admin, "sellers");
        await using var uow = await db.BeginAsync();
        var s = await LockedAsync(sellerId, uow);
        if (s.Status != "approved")
            throw new ConflictException("Only approved sellers can be suspended", "invalid_status");
        await uow.ExecuteAsync("UPDATE sellers SET status = 'suspended', rejection_reason = @reason WHERE id = @id",
            new { reason, id = s.Id });
        await AuditAsync(uow, admin, "seller.suspend", s.Id, reason);
        await uow.CommitAsync();
        await notify.NotifySellerAsync(s.Id, "seller_kyc_update", new Dictionary<string, string>
        {
            ["status"] = "suspended",
            ["message"] = $"Your store is suspended: {reason}. Contact seller support.",
        }, "/seller/onboarding");
        s.Status = "suspended";
        s.RejectionReason = reason;
        return await ProfileAsync(s, reveal: true);
    }

    public async Task<JsonObject> CommissionAsync(UserModel admin, Guid sellerId, int? bpsOverride)
    {
        await access.RequireAsync(admin, "sellers");
        await using var uow = await db.BeginAsync();
        var s = await LockedAsync(sellerId, uow);
        await uow.ExecuteAsync("UPDATE sellers SET commission_bps_override = @bps WHERE id = @id",
            new { bps = bpsOverride, id = s.Id });
        await AuditAsync(uow, admin, "seller.commission", s.Id, bpsOverride?.ToString() ?? "None");
        await uow.CommitAsync();
        s.CommissionBpsOverride = bpsOverride;
        return await ProfileAsync(s, reveal: true);
    }
}
