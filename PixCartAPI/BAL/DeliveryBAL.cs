using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Delivery partner registration and profile (reference: routers/delivery.py registration/profile endpoints with
/// services/fleet.py partner_out/checklist/zone_of/partner_for_user). Aadhaar numbers are never stored (only the
/// last 4 digits and the photo); other ID numbers and bank account numbers are encrypted (reference: _apply_id and
/// set_bank). Offers, trips and the fleet come with the delivery module's assignment slice.
/// </summary>
public partial class DeliveryBAL(
    DeliveryDAL delivery,
    AccountDAL accounts,
    StaffDAL staff,
    IDeliverySettingsBAL deliverySettings,
    IAccessBAL access,
    ICatalogNotifyBAL notify,
    IImageUpload images,
    EncryptDecrypt crypto) : IDeliveryBAL
{
    public static readonly IReadOnlyDictionary<string, string> KycLabel = new Dictionary<string, string>
    {
        ["draft"] = "Not submitted", ["submitted"] = "Under review",
        ["approved"] = "Approved", ["rejected"] = "Needs changes",
    };

    public static readonly IReadOnlyDictionary<string, string> DocFields = new Dictionary<string, string>
    {
        ["license"] = "license_doc", ["id_proof"] = "id_proof_doc", ["vehicle_rc"] = "vehicle_doc",
    };

    [GeneratedRegex(@"^[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{0,3}[ -]?\d{1,4}$")]
    private static partial Regex VehicleNo();

    [GeneratedRegex(@"^[A-Z0-9 -]{8,20}$")]
    private static partial Regex License();

    [GeneratedRegex(@"^[\w.\-]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,40}$")]
    private static partial Regex Upi();

    [GeneratedRegex(@"^\d{9,18}$")]
    private static partial Regex AccountNo();

    [GeneratedRegex(@"^[A-Z]{4}0[A-Z0-9]{6}$")]
    private static partial Regex Ifsc();

    [GeneratedRegex(@"[\s\-]")]
    private static partial Regex IdSpaces();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();

    private static string Tidy(string text) => Spaces().Replace(text, " ").Trim();

    // ------------------------------------------------------------------------- deps (reference: current_partner / approved_partner)

    /// <summary>The signed-in user's partner record (reference: current_partner).</summary>
    public async Task<DeliveryBoyModel> RequirePartnerAsync(UserModel user) =>
        await delivery.PartnerForUserAsync(user.Id)
        ?? throw new AppException("Register as a delivery partner first", "not_registered", 404);

    /// <summary>An approved, active partner while deliveries run (reference: approved_partner).</summary>
    public async Task<DeliveryBoyModel> RequireApprovedAsync(UserModel user)
    {
        var b = await RequirePartnerAsync(user);
        var cfg = await deliverySettings.GetAsync();
        if (!cfg.Bool("enabled")) throw new AppException("Deliveries are paused right now", "delivery_off", 403);
        if (b.KycStatus != "approved") throw new ForbiddenException("Your account is not approved yet");
        if (!b.IsActive) throw new ForbiddenException("Your account is switched off. Contact the delivery team.");
        return b;
    }

    // ------------------------------------------------------------------------- options and profile

    /// <summary>For the join page and the registration form, no sign-in needed (reference: GET /options).</summary>
    public async Task<JsonObject> OptionsAsync()
    {
        var cfg = await deliverySettings.GetAsync();
        var o = deliverySettings.Public(cfg);
        o["zones"] = new JsonArray((await delivery.ActiveZonesAsync()).Select(z => (JsonNode)new JsonObject
        {
            ["id"] = z.Id.ToString(), ["name"] = z.Name, ["city"] = z.City,
        }).ToArray());
        return o;
    }

    public async Task<JsonObject> MeAsync(UserModel user)
    {
        var b = await RequirePartnerAsync(user);
        return PartnerOut(b, await ZoneOfAsync(b), await deliverySettings.GetAsync());
    }

    /// <summary>Sign up as a partner (reference: register). 201 in the controller.</summary>
    public async Task<JsonObject> RegisterAsync(UserModel user, DeliveryProfile profile)
    {
        var cfg = await deliverySettings.GetAsync();
        if (!cfg.Bool("enabled") || !cfg.Bool("registration_open"))
            throw new AppException("New delivery partner registrations are closed right now", "registration_closed", 403);
        if (await delivery.PartnerForUserAsync(user.Id) is not null)
            throw new AppException("You are already registered", "already_registered", 409);
        if (user.IsAdmin)
            throw new AppException("Staff accounts cannot register as delivery partners", "staff_account");
        var now = DateTimeFunctions.UtcNow();
        var b = new DeliveryBoyModel
        {
            Id = Guid.NewGuid(), UserId = user.Id,
            Name = Tidy(profile.Name ?? user.Name ?? ""), Phone = user.Phone ?? "",
            KycStatus = "draft", BankDetails = "{}", CreatedAt = now, UpdatedAt = now,
        };
        if (b.Name.Length == 0)
            throw new AppException("Enter your name", "name_required",
                fields: new Dictionary<string, string> { ["name"] = "Required" });
        await ApplyAsync(b, profile);
        await delivery.InsertPartnerAsync(b);
        if (profile.Name is not null && string.IsNullOrEmpty(user.Name))
            await accounts.UpdateUserNameAsync(user.Id, Tidy(profile.Name));
        return PartnerOut(b, await ZoneOfAsync(b), cfg);
    }

    /// <summary>Edit the profile (reference: update_me). After review only the home address can change here.</summary>
    public async Task<JsonObject> UpdateMeAsync(UserModel user, DeliveryProfile profile)
    {
        var b = await RequirePartnerAsync(user);
        if (b.KycStatus is not ("draft" or "rejected") &&
            (profile.Name is not null || profile.City is not null || profile.ZoneId is not null ||
             profile.VehicleType is not null || profile.VehicleNo is not null || profile.LicenseNo is not null ||
             profile.IdProofType is not null || profile.IdProofNo is not null))
            throw new AppException("Your details are verified. Ask the delivery team to change them.", "locked", 409);
        await ApplyAsync(b, profile);
        await delivery.UpdatePartnerAsync(b);
        return PartnerOut(b, await ZoneOfAsync(b), await deliverySettings.GetAsync());
    }

    /// <summary>Reference: _apply. Null fields stay; the vehicle and licence numbers are normalised and checked.</summary>
    private async Task ApplyAsync(DeliveryBoyModel b, DeliveryProfile p)
    {
        if (p.Name is not null) b.Name = Tidy(p.Name);
        if (p.City is not null) b.City = Tidy(p.City);
        if (p.Address is not null) b.Address = p.Address;
        if (p.VehicleType is not null) b.VehicleType = p.VehicleType;
        if (p.VehicleNo is not null) b.VehicleNo = NormalizeVehicleNo(p.VehicleNo);
        if (p.LicenseNo is not null) b.LicenseNo = NormalizeLicense(p.LicenseNo);
        if (p.ZoneId is Guid zoneId)
        {
            var zone = await delivery.ZoneAsync(zoneId);
            if (zone is null || !zone.IsActive)
                throw new AppException("Choose one of the delivery areas", "invalid_zone");
            b.ZoneId = zone.Id;
        }
        if (p.IdProofType is not null && p.IdProofNo is not null)
            ApplyId(b, p.IdProofType, p.IdProofNo);
        else if (p.IdProofType is not null && p.IdProofType != b.IdProofType)
            (b.IdProofType, b.IdProofLast4, b.IdProofEnc) = (p.IdProofType, "", "");
    }

    /// <summary>Reference: ProfileIn._vehicle. Blank clears the field.</summary>
    private static string NormalizeVehicleNo(string v)
    {
        if (v.Trim().Length == 0) return "";
        var n = Tidy(v.ToUpperInvariant());
        if (!VehicleNo().IsMatch(n))
            throw new AppException("Enter the vehicle number as on the number plate, e.g. TN 38 AB 1234", "validation", 422,
                new Dictionary<string, string> { ["vehicle_no"] = "Enter the vehicle number as on the number plate, e.g. TN 38 AB 1234" });
        return n;
    }

    /// <summary>Reference: ProfileIn._license.</summary>
    private static string NormalizeLicense(string v)
    {
        var n = v.ToUpperInvariant().Trim();
        if (n.Length > 0 && !License().IsMatch(n))
            throw new AppException("Enter the driving licence number as printed, e.g. TN38 20190012345", "validation", 422,
                new Dictionary<string, string> { ["license_no"] = "Enter the driving licence number as printed, e.g. TN38 20190012345" });
        return n;
    }

    /// <summary>Reference: _apply_id. Aadhaar numbers are not stored (last 4 + photo only); other IDs are encrypted.</summary>
    private void ApplyId(DeliveryBoyModel b, string kind, string number)
    {
        var clean = IdSpaces().Replace(number, "").ToUpperInvariant();
        var (pattern, message) = kind switch
        {
            "aadhaar" => (@"^\d{12}$", "Enter the 12-digit Aadhaar number"),
            "pan" => (@"^[A-Z]{5}\d{4}[A-Z]$", "Enter a valid PAN, e.g. ABCDE1234F"),
            "voter" => (@"^[A-Z]{3}\d{7}$", "Enter a valid voter ID, e.g. ABC1234567"),
            _ => (@"^[A-Z]\d{7}$", "Enter a valid passport number, e.g. K1234567"),
        };
        if (!Regex.IsMatch(clean, pattern))
            throw new AppException(message, "invalid_id",
                fields: new Dictionary<string, string> { ["id_proof_no"] = "Invalid" });
        b.IdProofType = kind;
        b.IdProofLast4 = clean[^4..];
        b.IdProofEnc = kind == "aadhaar" ? "" : crypto.Encrypt(clean);
    }

    // ------------------------------------------------------------------------- bank

    /// <summary>Payout details (reference: set_bank). The account number is stored encrypted; staff review changes
    /// made after approval.</summary>
    public async Task<JsonObject> SetBankAsync(UserModel user, string holder, string accountNumber, string confirmAccountNumber, string ifsc, string upi)
    {
        var b = await RequirePartnerAsync(user);
        var bank = new JsonObject { ["holder"] = Tidy(holder) };
        if (accountNumber.Length > 0)
        {
            var acct = Spaces().Replace(accountNumber, "");
            if (!AccountNo().IsMatch(acct))
                throw new AppException("Bank account number must be 9 to 18 digits", "invalid_bank");
            var ifscClean = ifsc.Trim().ToUpperInvariant();
            if (!Ifsc().IsMatch(ifscClean))
                throw new AppException("Enter a valid IFSC (e.g. SBIN0001234)", "invalid_bank");
            if (acct != Regex.Replace(confirmAccountNumber, @"\D", ""))
                throw new AppException("The two account numbers do not match", "account_mismatch",
                    fields: new Dictionary<string, string> { ["confirm_account_number"] = "Does not match" });
            bank["account_enc"] = crypto.Encrypt(acct);
            bank["account_last4"] = acct[^4..];
            bank["ifsc"] = ifscClean;
        }
        var upiClean = upi.Trim();
        if (upiClean.Length > 0)
        {
            if (!Upi().IsMatch(upiClean))
                throw new AppException("Enter a UPI ID like name@okaxis", "invalid_upi",
                    fields: new Dictionary<string, string> { ["upi"] = "Invalid" });
            bank["upi"] = upiClean;
        }
        if (bank["account_enc"] is null && bank["upi"] is null)
            throw new AppException("Add a bank account or a UPI ID for your payouts", "bank_required");
        var changed = b.BankDetails is not (null or "" or "{}") && b.KycStatus == "approved";
        b.BankDetails = bank.ToJsonString();
        await delivery.UpdatePartnerAsync(b);
        if (changed) // staff check payout details that change after approval
            await NotifyStaffAsync("delivery", "staff_delivery_bank",
                new Dictionary<string, string> { ["name"] = b.Name, ["phone"] = b.Phone },
                $"/admin/delivery/partners/{b.Id}");
        return PartnerOut(b, await ZoneOfAsync(b), await deliverySettings.GetAsync());
    }

    // ------------------------------------------------------------------------- review and availability

    /// <summary>Send the registration for review (reference: submit).</summary>
    public async Task<JsonObject> SubmitAsync(UserModel user)
    {
        var b = await RequirePartnerAsync(user);
        var cfg = await deliverySettings.GetAsync();
        if (b.KycStatus is not ("draft" or "rejected"))
            throw new AppException("Already sent for review", "already_submitted", 409);
        var missing = Checklist(b, cfg).Where(i => !i.Done).Select(i => i.Label).ToList();
        if (missing.Count > 0)
            throw new AppException($"Complete these first: {string.Join(", ", missing)}", "incomplete",
                fields: new Dictionary<string, string> { ["missing"] = string.Join(", ", missing) });
        b.KycStatus = "submitted";
        b.KycNote = "";
        await delivery.UpdatePartnerAsync(b);
        await NotifyStaffAsync("delivery", "staff_delivery_kyc",
            new Dictionary<string, string> { ["name"] = b.Name, ["city"] = b.City },
            "/admin/delivery/partners?status=submitted");
        return PartnerOut(b, await ZoneOfAsync(b), cfg);
    }

    /// <summary>Go online/offline for offers (reference: set_online).</summary>
    public async Task<JsonObject> SetOnlineAsync(UserModel user, bool online)
    {
        var b = await RequireApprovedAsync(user);
        if (online && b.ZoneId is null)
            throw new AppException("Your delivery area is not set yet. Ask the delivery team to assign one.", "no_zone");
        var now = DateTimeFunctions.UtcNow();
        if (online && !b.IsOnline) b.OnlineSince = now;
        b.IsOnline = online;
        await delivery.UpdatePartnerAsync(b);
        return new JsonObject
        {
            ["is_online"] = b.IsOnline,
            ["online_since"] = b.IsOnline && b.OnlineSince is not null ? b.OnlineSince.Value.ToString("o") : null,
        };
    }

    // ------------------------------------------------------------------------- documents

    /// <summary>Upload a KYC document or the profile photo (reference: upload_doc). The photo is re-encoded (strips
    /// EXIF/GPS); documents are sniffed by magic bytes and stored privately, never served from the public media URL.</summary>
    public async Task<JsonObject> UploadDocAsync(UserModel user, string kind, byte[] data)
    {
        var b = await RequirePartnerAsync(user);
        if (kind != "photo" && b.KycStatus is not ("draft" or "rejected"))
            throw new AppException("Your documents are verified. Ask the delivery team to change them.", "locked", 409);
        if (kind == "photo")
            b.Photo = await images.SaveImageAsync(data, $"delivery/{b.Id}");
        else
        {
            var (key, _) = await images.SavePrivateAsync(data, $"delivery-kyc/{b.Id}");
            switch (kind)
            {
                case "license": b.LicenseDoc = key; break;
                case "id_proof": b.IdProofDoc = key; break;
                default: b.VehicleDoc = key; break;
            }
        }
        await delivery.UpdatePartnerAsync(b);
        return PartnerOut(b, await ZoneOfAsync(b), await deliverySettings.GetAsync());
    }

    /// <summary>The partner reads their own document (reference: my_doc; the admin read comes with delivery_admin).</summary>
    public async Task<(byte[] Data, string Media, string FileName)> ReadDocAsync(UserModel user, string kind)
    {
        var b = await RequirePartnerAsync(user);
        var key = kind switch
        {
            "license" => b.LicenseDoc, "id_proof" => b.IdProofDoc, "vehicle_rc" => b.VehicleDoc, _ => "",
        };
        if (key.Length == 0) throw new NotFoundException("Document");
        var data = await images.ReadPrivateAsync(key);
        var ext = key[(key.LastIndexOf('.') + 1)..];
        var media = ext switch { "pdf" => "application/pdf", "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg" };
        return (data, media, $"{kind}.{ext}");
    }

    // ------------------------------------------------------------------------- shared shape (reference: fleet.partner_out / checklist / zone_of)

    /// <summary>Reference: fleet.checklist — what a partner must fill in before sending the registration for review.</summary>
    public static List<(string Key, string Label, bool Done)> Checklist(DeliveryBoyModel b, JsonObject cfg)
    {
        var bank = ParseBank(b);
        var items = new List<(string, string, bool)>
        {
            ("profile", "Name, city and address", b.Name.Length > 0 && b.City.Length > 0 && b.Address.Length > 0),
            ("photo", "Your photo", b.Photo.Length > 0),
            ("vehicle", "Vehicle type and number", b.VehicleType.Length > 0 && (b.VehicleNo.Length > 0 || b.VehicleType == "cycle")),
            ("license", "Driving licence number and photo", (b.LicenseNo.Length > 0 && b.LicenseDoc.Length > 0) || b.VehicleType == "cycle"),
            ("id_proof", "ID proof number and photo", b.IdProofType.Length > 0 && b.IdProofLast4.Length > 0 && b.IdProofDoc.Length > 0),
            ("bank", "Bank account or UPI for payouts", (bank["account_enc"] is not null && bank["ifsc"] is not null) || bank["upi"] is not null),
        };
        if (cfg.Bool("require_vehicle_doc") && b.VehicleType != "cycle")
            items.Add(("vehicle_rc", "Vehicle registration (RC) photo", b.VehicleDoc.Length > 0));
        return items;
    }

    private static JsonObject ParseBank(DeliveryBoyModel b)
    {
        try { return JsonNode.Parse(b.BankDetails is "" or "null" ? "{}" : b.BankDetails) as JsonObject ?? []; }
        catch (System.Text.Json.JsonException) { return []; }
    }

    private async Task<DeliveryZoneModel?> ZoneOfAsync(DeliveryBoyModel b) =>
        b.ZoneId is Guid z ? await delivery.ZoneAsync(z) : null;

    /// <summary>Reference: fleet.partner_out (admin: false — the admin variant comes with delivery_admin).</summary>
    public JsonObject PartnerOut(DeliveryBoyModel b, DeliveryZoneModel? zone, JsonObject cfg)
    {
        var bank = ParseBank(b);
        var items = Checklist(b, cfg);
        return new JsonObject
        {
            ["id"] = b.Id.ToString(), ["name"] = b.Name, ["phone"] = b.Phone, ["photo"] = b.Photo,
            ["city"] = b.City, ["address"] = b.Address,
            ["license_no"] = b.LicenseNo, ["id_proof_type"] = b.IdProofType,
            ["id_proof_label"] = DeliverySettingsBAL.IdProofs.TryGetValue(b.IdProofType, out var pl) ? pl : "",
            ["id_proof_last4"] = b.IdProofLast4,
            ["vehicle_type"] = b.VehicleType,
            ["vehicle_label"] = DeliverySettingsBAL.VehicleLabels.TryGetValue(b.VehicleType, out var vl) ? vl : b.VehicleType,
            ["vehicle_no"] = b.VehicleNo,
            ["zone"] = zone is null ? null : new JsonObject { ["id"] = zone.Id.ToString(), ["name"] = zone.Name, ["city"] = zone.City },
            ["is_online"] = b.IsOnline, ["is_active"] = b.IsActive,
            ["kyc_status"] = b.KycStatus,
            ["kyc_label"] = KycLabel.TryGetValue(b.KycStatus, out var kl) ? kl : b.KycStatus,
            ["kyc_note"] = b.KycNote,
            ["approved_at"] = b.ApprovedAt?.ToString("o"),
            ["docs"] = new JsonObject(DocFields.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key,
                JsonValue.Create(DocField(b, kv.Key).Length > 0))).ToArray()),
            ["bank"] = new JsonObject
            {
                ["holder"] = bank["holder"]?.GetValue<string>() ?? "",
                ["ifsc"] = bank["ifsc"]?.GetValue<string>() ?? "",
                ["account_last4"] = bank["account_last4"]?.GetValue<string>() ?? "",
                ["upi"] = bank["upi"]?.GetValue<string>() ?? "",
                ["set"] = (bank["account_enc"] is not null && bank["ifsc"] is not null) || bank["upi"] is not null,
            },
            ["rating_avg"] = Math.Round(b.RatingAvg, 2), ["rating_count"] = b.RatingCount,
            ["checklist"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject
            {
                ["key"] = i.Key, ["label"] = i.Label, ["done"] = i.Done,
            }).ToArray()),
            ["can_submit"] = b.KycStatus is "draft" or "rejected" && items.All(i => i.Done),
            ["editable"] = b.KycStatus is "draft" or "rejected",
            ["location"] = new JsonObject
            {
                ["lat"] = b.Lat is null ? null : (double)b.Lat, ["lng"] = b.Lng is null ? null : (double)b.Lng,
                ["at"] = b.LocationAt?.ToString("o"),
            },
            ["created_at"] = b.CreatedAt.ToString("o"),
        };
    }

    private static string DocField(DeliveryBoyModel b, string kind) => kind switch
    {
        "license" => b.LicenseDoc, "id_proof" => b.IdProofDoc, _ => b.VehicleDoc,
    };

    /// <summary>Tells every active staff member whose role has the permission, in-app (reference: notify_staff).</summary>
    private async Task<int> NotifyStaffAsync(string permission, string @event, IReadOnlyDictionary<string, string> variables, string link = "")
    {
        var told = 0;
        foreach (var u in await staff.ActiveStaffAsync())
            if ((await access.PermissionsForAsync(u)).Contains(permission))
            {
                await notify.NotifyUserAsync(u.Id, @event, variables, link);
                told++;
            }
        return told;
    }
}
