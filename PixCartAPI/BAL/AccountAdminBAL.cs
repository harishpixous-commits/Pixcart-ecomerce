using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.CustomeAttributes;
using Model.DomainModel;
using Model.DomainModel.Auth;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Admin → Customers (account details and management), accounts created by staff, seller details corrected by staff,
/// and Admin → Sign-in and accounts (the reference version's routers/admin_accounts.py). Permissions: customers,
/// sellers, settings. Every change is written to the audit log.
/// </summary>
public interface IAccountAdminBAL
{
    Task<Dictionary<string, object?>> GetAuthSettingsAsync();
    Task<Dictionary<string, object?>> PutAuthSettingsAsync(UserModel admin, JsonObject body);
    Task<object> CreateCustomerAsync(UserModel admin, CustomerIn body);
    Task<Dictionary<string, object?>> CustomerDetailAsync(Guid userId);
    Task<Dictionary<string, object?>> EditCustomerAsync(UserModel admin, Guid userId, CustomerPatchIn body);
    Task<object> SignOutCustomerAsync(UserModel admin, Guid userId);
    Task<object> CreateSellerAsync(UserModel admin, SellerCreateIn body);
    Task<Dictionary<string, object?>> SellerBusinessAsync(UserModel admin, Guid sellerId, SellerProfileIn body);
    Task<Dictionary<string, object?>> SellerPickupAsync(UserModel admin, Guid sellerId, SellerPickupIn body);
    Task<Dictionary<string, object?>> SellerBankAsync(UserModel admin, Guid sellerId, SellerBankIn body);
    Task<Dictionary<string, object?>> SellerGrievanceAsync(UserModel admin, Guid sellerId, SellerGrievanceIn body);
}

/// <inheritdoc cref="IAccountAdminBAL"/>
public class AccountAdminBAL(
    AccountDAL accounts, CustomerAccountDAL customers, AddressDAL addresses, SellerAccountDAL sellers, AuditDAL auditDal, IMySqlDapperHelper db,
    IAuthSettingsBAL authSettings, IIntegrationBAL integrations, IAccessBAL access, IAuditBAL audit, INotifyBAL notify, IStepUpBAL stepUp,
    EncryptDecrypt crypto, AppSettings env) : IAccountAdminBAL
{
    private static string Collapse(string s) => string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string Mobile(string? v)
    {
        try
        {
            return IndianFormats.NormalizeMobile(v);
        }
        catch (ArgumentException e)
        {
            throw new AppException(e.Message, "invalid_phone", fields: new Dictionary<string, string> { ["phone"] = "Enter a 10-digit Indian mobile number" });
        }
    }

    // ---------------------------------------------------------------- sign-in settings

    public async Task<Dictionary<string, object?>> GetAuthSettingsAsync()
    {
        var dev = await authSettings.DevOtpStatusAsync();
        return new Dictionary<string, object?>
        {
            ["settings"] = await authSettings.GetAsync(),
            ["dev_otp"] = new { active = dev.Active, reason = dev.Reason },
            ["environment"] = env.Environment,
            ["sms_provider"] = (await integrations.GetAsync()).SmsProvider,
            ["limits"] = authSettings.Limits.ToDictionary(kv => kv.Key, kv => new[] { kv.Value.Min, kv.Value.Max }),
        };
    }

    private static string LiteralOf(JsonNode? v) => v?.GetValueKind() switch
    {
        null or JsonValueKind.Null => "None",
        JsonValueKind.True => "True",
        JsonValueKind.False => "False",
        JsonValueKind.String => v.GetValue<string>(),
        _ => v.ToJsonString(),
    };

    public async Task<Dictionary<string, object?>> PutAuthSettingsAsync(UserModel admin, JsonObject body)
    {
        if (body["staff_require_two_step"]?.GetValueKind() == JsonValueKind.True && !admin.TotpEnabled)
            throw new AppException("Turn on two-step sign-in for your own account first (My account), so you are not locked out.", "two_step_self");
        var cfg = await authSettings.UpdateAsync(body);
        await audit.AuditAsync(admin, "auth.settings", "settings", AuthSettingsBAL.Key, string.Join(", ", body.Select(kv => $"{kv.Key}={LiteralOf(kv.Value)}")));
        var outp = await GetAuthSettingsAsync();
        outp["settings"] = cfg;
        return outp;
    }

    // ---------------------------------------------------------------- customers

    private async Task PhoneFreeAsync(string phone, Guid? but = null)
    {
        if (await accounts.PhoneTakenAsync(phone, but))
            throw new AppException("Another account already uses this mobile number", "phone_taken", fields: new Dictionary<string, string> { ["phone"] = "Already in use" });
    }

    private async Task EmailFreeAsync(string email, Guid? but = null)
    {
        if (await accounts.EmailTakenAsync(email, but))
            throw new AppException("Another account already uses this email", "email_taken", fields: new Dictionary<string, string> { ["email"] = "Already in use" });
    }

    /// <summary>Creates a customer account (e.g. a phone order). The customer signs in with an OTP on their mobile.</summary>
    public async Task<object> CreateCustomerAsync(UserModel admin, CustomerIn body)
    {
        var phone = Mobile(body.Phone);
        await PhoneFreeAsync(phone);
        var email = body.Email?.ToLowerInvariant();
        if (!string.IsNullOrEmpty(email)) await EmailFreeAsync(email);
        var now = DateTimeFunctions.UtcNow();
        var u = new UserModel
        {
            Id = Guid.NewGuid(), Phone = phone, Name = Collapse(body.Name!), Email = string.IsNullOrEmpty(email) ? null : email, MarketingOptIn = body.MarketingOptIn,
            IsActive = true, UiPrefs = "{}", CreatedAt = now, UpdatedAt = now,
        };
        await using var uow = await db.BeginAsync();
        await accounts.InsertUserAsync(u, uow.Transaction);
        await audit.AuditAsync(admin, "user.create", "user", u.Id, $"{phone} by staff", uow);
        await uow.CommitAsync();
        return new { id = u.Id.ToString() };
    }

    /// <summary>"Phone · Chrome": the kind of device and browser of a session.</summary>
    private static string Ua(string? ua)
    {
        ua ??= "";
        var device = new[] { "Android", "iPhone", "Mobile" }.Any(ua.Contains) ? "Phone" : "Computer";
        var browser = new[] { "Edg", "Chrome", "Firefox", "Safari" }.FirstOrDefault(ua.Contains) ?? "Browser";
        return $"{device} · {(browser == "Edg" ? "Edge" : browser)}";
    }

    /// <summary>An order in a list (the reference orders.order_summary).</summary>
    private static Dictionary<string, object?> OrderSummary(OrderModel o, List<SubOrderModel> subs, Dictionary<Guid, List<OrderItemModel>> bySub)
    {
        var items = subs.SelectMany(s => bySub.GetValueOrDefault(s.Id) ?? []).ToList();
        return new Dictionary<string, object?>
        {
            ["id"] = o.Id.ToString(), ["number"] = o.Number, ["status"] = o.Status, ["payment_method"] = o.PaymentMethod, ["payment_status"] = o.PaymentStatus,
            ["grand_total"] = o.GrandTotal, ["created_at"] = DateTimeFunctions.Iso(o.CreatedAt), ["item_count"] = items.Sum(i => i.Qty),
            ["items"] = items.Take(4).Select(i => new Dictionary<string, object?> { ["title"] = i.Title, ["image"] = i.ImageUrl, ["qty"] = i.Qty }).ToList(),
            ["sub_statuses"] = subs.Select(s => s.Status).ToList(),
        };
    }

    private static readonly Dictionary<string, string> ReturnReasons = new()
    {
        ["damaged"] = "Item arrived damaged", ["defective"] = "Item does not work", ["wrong_item"] = "Received a different item",
        ["not_as_described"] = "Not as described or shown", ["size_fit"] = "Size or fit is not right", ["missing_parts"] = "Parts or accessories missing",
        ["quality"] = "Quality is not as expected",
    };

    private static readonly string[] OnTrip = ["accepted", "at_store", "picked", "on_the_way", "reached"];
    private static readonly Dictionary<string, string> VehicleLabels = new()
    {
        ["bike"] = "Motorbike", ["scooter"] = "Scooter", ["ev"] = "Electric bike or scooter", ["cycle"] = "Bicycle", ["auto"] = "Auto", ["van"] = "Van",
    };

    /// <summary>A return as staff see it (the reference returns.return_out with viewer "admin").</summary>
    private async Task<Dictionary<string, object?>> ReturnOutAsync(ReturnRequestModel ret)
    {
        var ritems = (await customers.ReturnItemsAsync(ret.Id)).ToList();
        var oitems = ritems.Count > 0 ? (await customers.OrderItemsByIdAsync(ritems.Select(r => r.OrderItemId))).ToDictionary(i => i.Id) : [];
        var sub = await customers.SubOrderAsync(ret.SubOrderId);
        Dictionary<string, object?>? fleet = null;
        if (ret.FleetRequestedAt is not null || ret.PickupOtp.Length > 0)
        {
            var a = await customers.LatestReturnAssignmentAsync(ret.Id);
            var boy = a is null ? null : await customers.DeliveryBoyAsync(a.DeliveryBoyId);
            var live = a is not null && OnTrip.Contains(a.Status);
            var waiting = ret.Status == "approved" && ret.FleetRequestedAt is not null && (a is null || !OnTrip.Contains(a.Status));
            var label = waiting ? "Finding a delivery partner" : a is null ? "" : a.Status switch
            {
                "accepted" => "Partner on the way to collect", "reached" => "Partner at the door", "picked" => "Collected", "on_the_way" => "On the way to the seller",
                "delivered" => "Handed to the seller", "failed" => "Not collected", _ => "",
            };
            fleet = new Dictionary<string, object?>
            {
                ["requested"] = ret.FleetRequestedAt is not null, ["status"] = a?.Status ?? "waiting", ["label"] = label, ["assignment_id"] = a?.Id.ToString(),
                ["fail_reason"] = a is { Status: "failed" } ? a.FailReason : "",
                ["partner"] = boy is not null && live
                    ? new Dictionary<string, object?>
                    {
                        ["name"] = boy.Name, ["vehicle"] = VehicleLabels.GetValueOrDefault(boy.VehicleType, ""), ["vehicle_no"] = boy.VehicleNo, ["phone"] = boy.Phone, ["photo"] = boy.Photo,
                    }
                    : null,
            };
        }
        string Upi(string upi) => upi.Length == 0 ? "" : upi[..Math.Min(2, upi.Length)] + "…@" + upi.Split('@')[^1];
        return new Dictionary<string, object?>
        {
            ["fleet_pickup"] = fleet,
            ["id"] = ret.Id.ToString(), ["number"] = ret.Number, ["status"] = ret.Status, ["reason"] = ret.Reason, ["reason_label"] = ReturnReasons.GetValueOrDefault(ret.Reason, ret.Reason),
            ["comment"] = ret.Comment, ["seller_note"] = ret.SellerNote, ["refund_amount"] = ret.RefundAmount, ["refund_upi"] = Upi(ret.RefundUpi),
            ["pickup_courier"] = ret.PickupCourier, ["pickup_tracking"] = ret.PickupTracking, ["credit_note_number"] = ret.CreditNoteNumber,
            ["sub_order_id"] = ret.SubOrderId.ToString(), ["sub_order_number"] = sub?.Number ?? "", ["order_id"] = sub?.OrderId.ToString() ?? "",
            ["created_at"] = DateTimeFunctions.Iso(ret.CreatedAt), ["approved_at"] = DateTimeFunctions.Iso(ret.ApprovedAt),
            ["received_at"] = DateTimeFunctions.Iso(ret.ReceivedAt), ["refunded_at"] = DateTimeFunctions.Iso(ret.RefundedAt),
            ["items"] = ritems.Where(ri => oitems.ContainsKey(ri.OrderItemId)).Select(ri =>
            {
                var it = oitems[ri.OrderItemId];
                return new Dictionary<string, object?>
                {
                    ["order_item_id"] = it.Id.ToString(), ["title"] = it.Title, ["variant_label"] = it.VariantLabel, ["image"] = it.ImageUrl, ["qty"] = ri.Qty, ["amount"] = ri.Amount,
                    ["condition"] = ri.Condition,
                    ["suggested_condition"] = ret.Reason is "damaged" or "defective" or "missing_parts" or "wrong_item" ? "damaged" : "sellable",
                };
            }).ToList(),
        };
    }

    public async Task<Dictionary<string, object?>> CustomerDetailAsync(Guid userId)
    {
        var u = await accounts.GetUserAsync(userId) ?? throw new NotFoundException("Customer");
        var seller = await accounts.GetSellerByUserAsync(u.Id);
        var orders = (await customers.RecentOrdersAsync(u.Id, 10)).ToList();
        var subs = orders.Count > 0 ? (await customers.SubOrdersAsync(orders.Select(o => o.Id))).ToList() : [];
        var items = subs.Count > 0 ? (await customers.ItemsAsync(subs.Select(s => s.Id))).ToList() : [];
        var bySub = items.GroupBy(i => i.SubOrderId).ToDictionary(g => g.Key, g => g.ToList());
        var addr = await addresses.ListOldestFirstAsync(u.Id);
        var rets = await customers.RecentReturnsAsync(u.Id, 10);
        var tickets = await customers.RecentTicketsAsync(u.Id, 10);
        var sessions = await accounts.ActiveSessionsAsync(u.Id, DateTimeFunctions.UtcNow(), 10);
        var history = (await auditDal.ForEntityAsync("user", u.Id.ToString(), 15)).ToList();
        var actorIds = history.Where(h => h.ActorUserId is not null).Select(h => h.ActorUserId!.Value).Distinct().ToList();
        var actors = actorIds.Count > 0 ? await customers.UserNamesAsync(actorIds) : [];
        var returnsOut = new List<Dictionary<string, object?>>();
        foreach (var r in rets) returnsOut.Add(await ReturnOutAsync(r));
        return new Dictionary<string, object?>
        {
            ["id"] = u.Id.ToString(), ["name"] = u.Name, ["phone"] = u.Phone, ["email"] = u.Email, ["is_active"] = u.IsActive, ["is_admin"] = u.IsAdmin,
            ["marketing_opt_in"] = u.MarketingOptIn, ["staff_note"] = u.StaffNote, ["staff_tags"] = System.Text.Json.Nodes.JsonNode.Parse(string.IsNullOrEmpty(u.StaffTags) ? "[]" : u.StaffTags), ["created_at"] = DateTimeFunctions.Iso(u.CreatedAt), ["last_login_at"] = DateTimeFunctions.Iso(u.LastLoginAt),
            ["terms_accepted_at"] = DateTimeFunctions.Iso(u.TermsAcceptedAt),
            ["seller"] = seller is null ? null : new Dictionary<string, object?> { ["id"] = seller.Id.ToString(), ["name"] = seller.DisplayName, ["status"] = seller.Status },
            ["stats"] = new Dictionary<string, object?>
            {
                ["orders"] = await customers.PlacedOrdersAsync(u.Id), ["spent"] = await customers.SpentAsync(u.Id), ["returns"] = await customers.ReturnsAsync(u.Id),
                ["tickets"] = await customers.TicketsAsync(u.Id), ["open_tickets"] = await customers.TicketsAsync(u.Id, openOnly: true),
                ["wishlist"] = await customers.WishlistAsync(u.Id), ["reviews"] = await customers.ReviewsAsync(u.Id),
            },
            ["addresses"] = addr.Select(a => new Dictionary<string, object?>
            {
                ["id"] = a.Id.ToString(), ["name"] = a.FullName, ["phone"] = a.Phone, ["kind"] = a.Kind, ["is_default"] = a.IsDefault,
                ["text"] = string.Join(", ", new[] { a.Line1, a.Line2, a.Landmark, a.City, IndianFormats.States.GetValueOrDefault(a.StateCode, a.StateCode), a.Pincode }.Where(x => x.Length > 0)),
            }).ToList(),
            ["orders"] = orders.Select(o => OrderSummary(o, subs.Where(s => s.OrderId == o.Id).ToList(), bySub)).ToList(),
            ["returns"] = returnsOut,
            ["tickets"] = tickets.Select(t => new Dictionary<string, object?>
            {
                ["id"] = t.Id.ToString(), ["number"] = t.Number, ["subject"] = t.Subject, ["status"] = t.Status, ["updated_at"] = DateTimeFunctions.Iso(t.UpdatedAt),
            }).ToList(),
            ["sessions"] = sessions.Select(s => new Dictionary<string, object?>
            {
                ["device"] = Ua(s.UserAgent), ["signed_in_at"] = DateTimeFunctions.Iso(s.CreatedAt), ["expires_at"] = DateTimeFunctions.Iso(s.ExpiresAt),
            }).ToList(),
            ["history"] = history.Select(h => new Dictionary<string, object?>
            {
                ["action"] = h.Action, ["detail"] = h.Detail, ["by"] = h.ActorUserId is { } id ? actors.GetValueOrDefault(id, "") : "", ["at"] = DateTimeFunctions.Iso(h.CreatedAt),
            }).ToList(),
        };
    }

    public async Task<Dictionary<string, object?>> EditCustomerAsync(UserModel admin, Guid userId, CustomerPatchIn body)
    {
        var u = await accounts.GetUserAsync(userId) ?? throw new NotFoundException("Customer");
        if (u.IsAdmin && u.Id != admin.Id) throw new ConflictException("Staff accounts are edited in Staff and roles", "invalid_target");
        var before = u.Copy();
        var newPhone = body.Phone is not null ? Mobile(body.Phone) : u.Phone;
        var newEmail = body.ClearEmail ? null : body.Email is not null ? body.Email.ToLowerInvariant() : u.Email;
        var signInChanges = new List<string>();
        if (newPhone != u.Phone) signInChanges.Add("mobile number");
        if (newEmail != u.Email) signInChanges.Add("email");
        if (signInChanges.Count > 0 && await accounts.GetSellerByUserAsync(u.Id) is not null && !(await access.PermissionsForAsync(admin)).Contains("sellers"))
            // whoever controls the owner's mobile signs in as the seller: only staff who manage sellers may change it
            throw new ForbiddenException("This person owns a seller account. Only staff who manage sellers can change their mobile number or email.");
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        if (signInChanges.Count > 0)
            // told on the old number and email before they change, so a change nobody asked for is noticed
            await notify.NotifyAsync("security_notice", u, new Dictionary<string, object?>
            {
                ["what"] = "sign-in details changed",
                ["message"] = $"Our team changed the {string.Join(" and ", signInChanges)} you use to sign in.",
            }, channels: ["inapp", "email", "sms"], uow: uow);
        var changes = new List<string>();
        if (body.Name is not null)
        {
            u.Name = Collapse(body.Name);
            changes.Add("name");
        }
        if (newPhone != u.Phone)
        {
            await PhoneFreeAsync(newPhone!, u.Id);
            u.Phone = newPhone;
            changes.Add("mobile");
            // a new number must sign in again with an OTP sent to it
            await accounts.RevokeAllSessionsAsync(u.Id, now, uow.Transaction);
        }
        if (body.ClearEmail && !string.IsNullOrEmpty(u.Email))
        {
            u.Email = null;
            changes.Add("email removed");
        }
        else if (newEmail != u.Email && !string.IsNullOrEmpty(newEmail))
        {
            await EmailFreeAsync(newEmail, u.Id);
            u.Email = newEmail;
            changes.Add("email");
        }
        if (body.MarketingOptIn is { } m)
        {
            u.MarketingOptIn = m;
            changes.Add($"marketing {(m ? "on" : "off")}");
        }
        if (body.StaffNote is { } sn && sn.Trim() != u.StaffNote)
        {
            u.StaffNote = sn.Trim();
            changes.Add("staff note");
        }
        if (body.StaffTags is { } st)
        {
            var tags = st.Select(t => string.Join(" ", t.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))).Where(t => t.Length > 0)
                .Select(t => t.Length > 30 ? t[..30] : t).Distinct().ToList();
            var json = System.Text.Json.JsonSerializer.Serialize(tags);
            if (json != u.StaffTags) { u.StaffTags = json; changes.Add("tags"); }
        }
        await accounts.SaveUserChangesAsync(before, u, now, uow.Transaction);
        await audit.AuditAsync(admin, "user.edit", "user", u.Id, changes.Count > 0 ? string.Join(", ", changes) : "no change", uow);
        await uow.CommitAsync();
        return await CustomerDetailAsync(userId);
    }

    public async Task<object> SignOutCustomerAsync(UserModel admin, Guid userId)
    {
        var u = await accounts.GetUserAsync(userId) ?? throw new NotFoundException("Customer");
        if (u.IsAdmin) throw new ConflictException("Staff accounts are managed in Staff and roles", "invalid_target");
        await using var uow = await db.BeginAsync();
        var n = await accounts.RevokeAllSessionsAsync(u.Id, DateTimeFunctions.UtcNow(), uow.Transaction);
        await audit.AuditAsync(admin, "user.sign_out", "user", u.Id, $"{n} session(s)", uow);
        await uow.CommitAsync();
        return new { ok = true, sessions = n };
    }

    // ---------------------------------------------------------------- sellers created and corrected by staff

    /// <summary>
    /// Opens a seller account for someone (e.g. onboarded by the sales team). It starts as a draft: the seller signs in with
    /// an OTP on this mobile and completes business, PAN, GST, pickup and bank details; then the application comes back for approval.
    /// </summary>
    public async Task<object> CreateSellerAsync(UserModel admin, SellerCreateIn body)
    {
        var phone = Mobile(body.Phone);
        var storeName = Collapse(body.StoreName!);
        var user = await accounts.GetUserByPhoneAsync(phone);
        var email = body.Email?.ToLowerInvariant();
        var now = DateTimeFunctions.UtcNow();
        await using var uow = await db.BeginAsync();
        if (user is null)
        {
            if (!string.IsNullOrEmpty(email)) await EmailFreeAsync(email);
            user = new UserModel
            {
                Id = Guid.NewGuid(), Phone = phone, Name = Collapse(body.Name!), Email = string.IsNullOrEmpty(email) ? null : email, IsActive = true, UiPrefs = "{}",
                CreatedAt = now, UpdatedAt = now,
            };
            await accounts.InsertUserAsync(user, uow.Transaction);
            await audit.AuditAsync(admin, "user.create", "user", user.Id, $"{phone} for a seller account", uow);
        }
        else if (await accounts.GetSellerByUserAsync(user.Id, uow.Transaction) is not null)
            throw new AppException("This mobile number already has a seller account", "seller_exists", 409);
        var baseSlug = IndianFormats.Slugify(storeName, 70);
        var slug = baseSlug;
        while (await sellers.SlugTakenAsync(slug, uow.Transaction)) slug = $"{baseSlug}-{Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(2))}";
        var seller = new SellerModel
        {
            Id = Guid.NewGuid(), UserId = user.Id, Status = "draft", DisplayName = storeName, Slug = slug, BusinessType = "proprietorship", ContactPhone = phone,
            ContactEmail = !string.IsNullOrEmpty(email) ? email : user.Email ?? "", DispatchDays = 2, CreatedAt = now, UpdatedAt = now,
        };
        await sellers.InsertAsync(seller, uow.Transaction);
        await audit.AuditAsync(admin, "seller.create", "seller", seller.Id, $"{storeName} for {phone}", uow);
        await uow.CommitAsync();
        return new { id = seller.Id.ToString(), user_id = user.Id.ToString() };
    }

    private static readonly string[] RequiredDocs = ["pan_card", "gst_certificate", "cancelled_cheque"];

    /// <summary>The seller's profile with KYC revealed (the reference seller_onboarding.seller_profile(reveal=True)).</summary>
    private async Task<Dictionary<string, object?>> SellerProfileAsync(SellerModel s)
    {
        var docs = (await sellers.DocumentsAsync(s.Id)).ToList();
        var kinds = docs.Select(d => d.Kind).ToHashSet();
        var checklist = new List<(string Key, string Label, bool Done)>
        {
            ("business", "Business details (legal name, GSTIN, PAN)", s.LegalName.Length > 0 && !string.IsNullOrEmpty(s.Gstin) && !string.IsNullOrEmpty(s.PanEnc)),
            ("pickup", "Pickup address", s.PickupLine1.Length > 0 && s.PickupPincode.Length > 0 && s.PickupStateCode.Length > 0),
            ("bank", "Bank account for payouts", !string.IsNullOrEmpty(s.BankAccountEnc) && s.BankIfsc.Length > 0),
            ("grievance", "Grievance officer (Consumer Protection E-Commerce Rules 2020)", s.GrievanceName.Length > 0 && s.GrievanceEmail.Length > 0),
        };
        checklist.AddRange(RequiredDocs.Select(k => ($"doc:{k}", $"Upload {k.Replace('_', ' ')}", kinds.Contains(k))));
        return new Dictionary<string, object?>
        {
            ["id"] = s.Id.ToString(), ["status"] = s.Status, ["display_name"] = s.DisplayName, ["slug"] = s.Slug, ["description"] = s.Description,
            ["legal_name"] = s.LegalName, ["business_type"] = s.BusinessType, ["gstin"] = s.Gstin, ["pan"] = crypto.Decrypt(s.PanEnc),
            ["contact_email"] = s.ContactEmail, ["contact_phone"] = s.ContactPhone,
            ["pickup"] = new Dictionary<string, object?>
            {
                ["line1"] = s.PickupLine1, ["line2"] = s.PickupLine2, ["city"] = s.PickupCity, ["state_code"] = s.PickupStateCode,
                ["state"] = IndianFormats.States.GetValueOrDefault(s.PickupStateCode, ""), ["pincode"] = s.PickupPincode,
            },
            ["bank"] = new Dictionary<string, object?> { ["holder_name"] = s.BankHolderName, ["account_number"] = crypto.Decrypt(s.BankAccountEnc), ["ifsc"] = s.BankIfsc },
            ["grievance"] = new Dictionary<string, object?> { ["name"] = s.GrievanceName, ["email"] = s.GrievanceEmail, ["phone"] = s.GrievancePhone },
            ["documents"] = docs.Select(d => new Dictionary<string, object?>
            {
                ["kind"] = d.Kind, ["filename"] = d.Filename, ["content_type"] = d.ContentType, ["size_bytes"] = d.SizeBytes, ["uploaded_at"] = DateTimeFunctions.Iso(d.UploadedAt),
            }).ToList(),
            ["checklist"] = checklist.Select(c => new Dictionary<string, object?> { ["key"] = c.Key, ["label"] = c.Label, ["done"] = c.Done }).ToList(),
            ["rejection_reason"] = s.RejectionReason, ["submitted_at"] = DateTimeFunctions.Iso(s.SubmittedAt), ["approved_at"] = DateTimeFunctions.Iso(s.ApprovedAt),
            ["commission_bps_override"] = s.CommissionBpsOverride,
        };
    }

    private async Task<SellerModel> SellerForEditAsync(Guid id, IUnitOfWork uow) => await sellers.GetForUpdateAsync(id, uow.Transaction) ?? throw new NotFoundException("Seller");

    private static string TupleText(params string?[] xs) => "(" + string.Join(", ", xs.Select(x => x is null ? "None" : $"'{x}'")) + ")";

    /// <summary>Corrects business, GSTIN and PAN details, also while under review or approved (the seller cannot then).</summary>
    public async Task<Dictionary<string, object?>> SellerBusinessAsync(UserModel admin, Guid sellerId, SellerProfileIn body)
    {
        var gstin = IndianFormats.ValidateGstin(body.Gstin);
        var pan = IndianFormats.ValidatePan(body.Pan);
        SellerModel s;
        await using (var uow = await db.BeginAsync())
        {
            s = await SellerForEditAsync(sellerId, uow);
            var before = TupleText(s.LegalName, s.Gstin, s.DisplayName);
            if (gstin[2..12] != pan)
                throw new AppException("The PAN inside your GSTIN (characters 3 to 12) must match the PAN you entered", "pan_gstin_mismatch",
                    fields: new Dictionary<string, string> { ["pan"] = "Does not match GSTIN" });
            if (await sellers.GstinTakenAsync(gstin, s.Id, uow.Transaction)) throw new ConflictException("This GSTIN is already registered with another seller account", "gstin_taken");
            s.DisplayName = body.DisplayName!.Trim();
            s.Description = body.Description.Trim();
            s.LegalName = body.LegalName!.Trim();
            s.BusinessType = body.BusinessType!;
            s.Gstin = gstin;
            s.PanEnc = crypto.Encrypt(pan);
            s.PanLast4 = pan[^4..];
            s.ContactEmail = body.ContactEmail!.ToLowerInvariant();
            s.ContactPhone = IndianFormats.NormalizeMobile(body.ContactPhone);
            s.UpdatedAt = DateTimeFunctions.UtcNow();
            await sellers.UpdateKycAsync(s, uow.Transaction);
            await audit.AuditAsync(admin, "seller.edit_business", "seller", s.Id, $"{before} → {TupleText(s.LegalName, s.Gstin, s.DisplayName)}", uow);
            await uow.CommitAsync();
        }
        return await SellerProfileAsync(s);
    }

    public async Task<Dictionary<string, object?>> SellerPickupAsync(UserModel admin, Guid sellerId, SellerPickupIn body)
    {
        SellerModel s;
        await using (var uow = await db.BeginAsync())
        {
            s = await SellerForEditAsync(sellerId, uow);
            var now = DateTimeFunctions.UtcNow();
            s.PickupLine1 = body.Line1!.Trim();
            s.PickupLine2 = body.Line2.Trim();
            s.PickupCity = body.City!.Trim();
            s.PickupStateCode = IndianFormats.ValidateStateCode(body.StateCode);
            s.PickupPincode = IndianFormats.ValidatePincode(body.Pincode);
            s.UpdatedAt = now;
            await sellers.UpdateKycAsync(s, uow.Transaction);
            // the default warehouse keeps the KYC pickup address (inventory.sync_default_warehouse)
            var wh = await sellers.DefaultWarehouseAsync(s.Id, uow.Transaction);
            if (wh is null && s.PickupLine1.Length > 0)
                await sellers.InsertWarehouseAsync(new WarehouseModel
                {
                    Id = Guid.NewGuid(), SellerId = s.Id, Code = "MAIN", Name = "Main warehouse", Line1 = s.PickupLine1, Line2 = s.PickupLine2, City = s.PickupCity,
                    StateCode = s.PickupStateCode, Pincode = s.PickupPincode, ContactName = s.DisplayName, ContactPhone = s.ContactPhone, IsDefault = true, IsActive = true,
                    CreatedAt = now, UpdatedAt = now,
                }, uow.Transaction);
            else if (wh is not null)
            {
                wh.Line1 = s.PickupLine1;
                wh.Line2 = s.PickupLine2;
                wh.City = s.PickupCity;
                wh.StateCode = s.PickupStateCode;
                wh.Pincode = s.PickupPincode;
                wh.UpdatedAt = now;
                await sellers.UpdateWarehouseAddressAsync(wh, uow.Transaction);
            }
            await audit.AuditAsync(admin, "seller.edit_pickup", "seller", s.Id, $"{body.City} {s.PickupPincode}", uow);
            await uow.CommitAsync();
        }
        return await SellerProfileAsync(s);
    }

    /// <summary>
    /// Changes where payouts go. The staff member confirms it is them; the seller is told at once, so a change they did not
    /// ask for is noticed; payouts already created keep the old account until Finance confirms the new one.
    /// </summary>
    public async Task<Dictionary<string, object?>> SellerBankAsync(UserModel admin, Guid sellerId, SellerBankIn body)
    {
        await stepUp.ConfirmIdentityAsync(admin, body.Password, body.Totp, "seller-bank");
        var account = IndianFormats.ValidateAccountNumber(body.AccountNumber);
        var confirm = IndianFormats.ValidateAccountNumber(body.ConfirmAccountNumber);
        SellerModel s;
        await using (var uow = await db.BeginAsync())
        {
            s = await SellerForEditAsync(sellerId, uow);
            var old = s.BankAccountLast4;
            if (account != confirm)
                throw new AppException("Account numbers do not match", "account_mismatch", fields: new Dictionary<string, string> { ["confirm_account_number"] = "Does not match" });
            s.BankHolderName = body.HolderName!.Trim();
            s.BankAccountEnc = crypto.Encrypt(account);
            s.BankAccountLast4 = account[^4..];
            s.BankIfsc = IndianFormats.ValidateIfsc(body.Ifsc);
            // payout routing (RazorpayX contact / fund account) must be set up again for the new account
            s.PayoutFundAccountId = "";
            s.UpdatedAt = DateTimeFunctions.UtcNow();
            await sellers.UpdateKycAsync(s, uow.Transaction);
            await audit.AuditAsync(admin, "seller.edit_bank", "seller", s.Id, $"account …{(old.Length > 0 ? old : "-")} → …{s.BankAccountLast4}, IFSC {s.BankIfsc}", uow);
            await notify.NotifySellerAsync(s.Id, "seller_kyc_update", new Dictionary<string, object?>
            {
                ["status"] = "bank account changed",
                ["message"] = $"Your payout bank account was changed by our team to the account ending {s.BankAccountLast4} (IFSC {s.BankIfsc}). " +
                              "If you did not ask for this, contact seller support at once.",
            }, "/seller/settings", uow);
            await uow.CommitAsync();
        }
        return await SellerProfileAsync(s);
    }

    public async Task<Dictionary<string, object?>> SellerGrievanceAsync(UserModel admin, Guid sellerId, SellerGrievanceIn body)
    {
        SellerModel s;
        await using (var uow = await db.BeginAsync())
        {
            s = await SellerForEditAsync(sellerId, uow);
            s.GrievanceName = body.Name!.Trim();
            s.GrievanceEmail = body.Email!.ToLowerInvariant();
            s.GrievancePhone = IndianFormats.NormalizeMobile(body.Phone);
            s.UpdatedAt = DateTimeFunctions.UtcNow();
            await sellers.UpdateKycAsync(s, uow.Transaction);
            await audit.AuditAsync(admin, "seller.edit_grievance", "seller", s.Id, body.Name, uow);
            await uow.CommitAsync();
        }
        return await SellerProfileAsync(s);
    }
}
