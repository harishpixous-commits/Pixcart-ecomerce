using System.Text.Json;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// The own delivery fleet pipeline (reference: services/fleet.py route/ready_for_pickup/use_courier/offer/
/// auto_assign/sweep/accept/reject/advance/deliver/fail/trip_view plus routers/delivery.py location/feed/offers/
/// trips). Every step writes order_status_logs. Return pickups (kind 'pickup'), payouts, the stuck-check job and
/// the admin queue are later slices; customer tracking comes with the order-view slice.

/// <summary>
/// Staff delivery-fleet operations (reference: routers/delivery_admin.py queue/candidates/assign/auto-assign/
/// cancel/resolve/to_courier/trips/overview/settings). Every endpoint needs the "delivery" permission. KYC review,
/// zones CRUD, the live map, cash/payouts, reports and feedback are the next admin slices; the returns tab of the
/// queue arrives with the returns module.
/// </summary>
public class DeliveryAdminBAL(
    DeliveryFleetDAL fleet,
    ReturnsDAL returnsDal,
    DeliveryDAL delivery,
    OrdersDAL orders,
    AccountDAL accounts,
    IDeliveryFleetBAL fleetBal,
    IDeliveryBAL deliveryBal,
    IDeliverySettingsBAL deliverySettings,
    IAccessBAL access,
    IOrdersBAL ordersBal,
    ICatalogNotifyBAL notify,
    EncryptDecrypt crypto,
    IImageUpload images,
    IMySqlDapperHelper db)
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    private async Task<UserModel> StaffAsync(UserModel user)
    {
        await access.RequireAsync(user, "delivery");
        return user;
    }

    private async Task<JsonObject> PackageAsync(SubOrderModel sub, IUnitOfWork uow)
    {
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var place = await fleetBal.PickupPlaceForAsync(sub);
        var st = DeliveryFleetBAL.ShipToOf(order);
        var zone = sub.DeliveryZoneId is not null ? await delivery.ZoneAsync(sub.DeliveryZoneId.Value) : null;
        var tries = await fleet.TriesForSubAsync(sub.Id);
        string S(string k) => st[k]?.GetValue<string>() ?? "";
        return new JsonObject
        {
            ["sub_order_id"] = sub.Id.ToString(), ["order_id"] = order.Id.ToString(), ["order_number"] = sub.Number,
            ["status"] = sub.Status,
            ["ready_since"] = sub.ReadyForPickupAt?.ToString("o"),
            ["pickup"] = new JsonObject
            {
                ["name"] = place["name"]?.DeepClone(), ["address"] = place["address"]?.DeepClone(),
                ["city"] = place["city"]?.DeepClone(), ["pincode"] = place["pincode"]?.DeepClone(),
                ["phone"] = place["phone"]?.DeepClone(), ["lat"] = place["lat"]?.DeepClone(),
                ["lng"] = place["lng"]?.DeepClone(),
            },
            ["drop"] = new JsonObject
            {
                ["name"] = S("full_name"), ["city"] = S("city"), ["pincode"] = S("pincode"),
                ["lat"] = st["lat"]?.DeepClone(), ["lng"] = st["lng"]?.DeepClone(),
            },
            ["zone"] = zone is not null
                ? new JsonObject { ["id"] = zone.Id.ToString(), ["name"] = zone.Name }
                : null,
            ["payment"] = order.PaymentMethod,
            ["cod_amount"] = await ordersBal.CollectAmountAsync(sub, order, uow),
            ["pickup_code"] = sub.PickupCode,
            ["tries"] = new JsonArray((await fleet.TriesForSubAsync(sub.Id)).Select(t => (JsonNode?)new JsonObject
            {
                ["status"] = t.Status, ["reason"] = t.FailReason.Length > 0 ? t.FailReason : t.RejectReason,
                ["partner"] = t.Partner,
            }).ToArray()),
        };
    }

    /// <summary>Reference: GET /api/admin/delivery/queue.</summary>
    public async Task<JsonObject> QueueAsync(UserModel user, string tab)
    {
        await StaffAsync(user);
        await fleetBal.SweepExpiredAsync();
        var waiting = (await fleet.WaitingSubsAsync()).ToList();
        var offered = (await fleet.OfferedAsync()).ToList();
        var failed = (await fleet.FailedListAsync()).GroupBy(a => a.SubOrderId).Select(g => g.First()).ToList();
        var items = new List<JsonObject>();
        await using var uow = await db.BeginAsync();
        var pickups = (await returnsDal.PickupsWaitingAsync(uow)).ToList();
        if (tab == "waiting")
        {
            foreach (var s in waiting) items.Add(await PackageAsync(s, uow));
        }
        else if (tab == "offered")
        {
            var now = DateTimeFunctions.UtcNow();
            foreach (var a in offered)
            {
                var sub = await orders.GetSubAsync(a.SubOrderId);
                if (sub is null) continue;
                var item = await PackageAsync(sub, uow);
                var boy = await delivery.PartnerByIdAsync(a.DeliveryBoyId);
                var brief = DeliveryFleetBAL.BriefOf(a);
                brief["partner"] = boy?.Name ?? "";
                brief["partner_phone"] = boy?.Phone ?? "";
                brief["seconds_left"] = a.ExpiresAt is not null
                    ? Math.Max(0, (int)(a.ExpiresAt.Value - now).TotalSeconds)
                    : null;
                item["assignment"] = brief;
                items.Add(item);
            }
        }
        else if (tab == "failed")
        {
            foreach (var a in failed)
            {
                var sub = await orders.GetSubAsync(a.SubOrderId);
                if (sub is null) continue;
                var item = await PackageAsync(sub, uow);
                var boy = await delivery.PartnerByIdAsync(a.DeliveryBoyId);
                var brief = DeliveryFleetBAL.BriefOf(a);
                brief["partner"] = boy?.Name ?? "";
                brief["partner_phone"] = boy?.Phone ?? "";
                item["assignment"] = brief;
                items.Add(item);
            }
        }
        else if (tab == "returns")
        {
            foreach (var r in pickups) items.Add(await PickupItemAsync(r, uow));
        }
        await uow.CommitAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)i).ToArray()),
            ["counts"] = new JsonObject
            {
                ["waiting"] = waiting.Count, ["offered"] = offered.Count, ["failed"] = failed.Count,
                ["returns"] = pickups.Count,
            },
        };
    }

    /// <summary>A return waiting for a partner to collect it, as a queue row (reference: delivery_admin._pickup_item).</summary>
    private async Task<JsonObject> PickupItemAsync(ReturnRequestModel ret, IUnitOfWork uow)
    {
        var sub = await orders.GetSubAsync(ret.SubOrderId) ?? throw new NotFoundException("Order");
        var item = await PackageAsync(sub, uow);
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var st = DeliveryFleetBAL.ShipToOf(order);
        DeliveryZoneModel? zone = null;
        var pin = st["pincode"]?.GetValue<string>() ?? "";
        if (pin.Length > 0)
            foreach (var z in await delivery.ActiveZonesAsync())
            {
                var pins = JsonSerializer.Deserialize<List<string>>(z.Pincodes) ?? [];
                if (pins.Contains(pin)) { zone = z; break; }
            }
        var tries = (await fleet.TriesForReturnAsync(ret.Id)).ToList();
        var titles = (await returnsDal.ItemTitlesAsync(ret.Id, uow))
            .Select(t => $"{t.Title} × {t.Qty}").ToList();
        item["return_id"] = ret.Id.ToString();
        item["return_number"] = ret.Number;
        item["ready_since"] = ret.FleetRequestedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.ffffff+00:00");
        item["zone"] = zone is not null
            ? new JsonObject { ["id"] = zone.Id.ToString(), ["name"] = zone.Name }
            : null;
        item["payment"] = "online";
        item["cod_amount"] = 0;
        item["return_items"] = new JsonArray(titles.Select(t => (JsonNode?)t).ToArray());
        item["tries"] = new JsonArray(tries.Select(t => (JsonNode?)new JsonObject
        {
            ["status"] = t.Status, ["reason"] = t.FailReason.Length > 0 ? t.FailReason : t.RejectReason,
            ["partner"] = t.Partner,
        }).ToArray());
        return item;
    }

    /// <summary>Reference: GET /api/admin/delivery/packages/{sub_id}/candidates.</summary>
    public async Task<JsonArray> CandidatesAsync(UserModel user, Guid subOrderId)
    {
        await StaffAsync(user);
        var sub = await orders.GetSubAsync(subOrderId);
        if (sub is null || sub.ShippingProvider != "fleet") throw new NotFoundException("Package");
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var cfg = await deliverySettings.GetAsync();
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id, z => z.Name);
        await using var uow = await db.BeginAsync();
        var cands = await fleetBal.CandidatesAsync(sub, order, cfg, uow, onlineOnly: false);
        await uow.CommitAsync();
        var outList = new List<JsonObject>();
        foreach (var c in cands)
        {
            var boy = await delivery.PartnerByIdAsync(Guid.Parse(c["boy_id"]!.GetValue<string>()));
            if (boy is null) continue;
            outList.Add(new JsonObject
            {
                ["id"] = boy.Id.ToString(), ["name"] = boy.Name, ["phone"] = boy.Phone, ["photo"] = boy.Photo,
                ["vehicle"] = DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(boy.VehicleType, ""),
                ["zone"] = boy.ZoneId is not null ? zones.GetValueOrDefault(boy.ZoneId.Value, "") : "",
                ["online"] = boy.IsOnline, ["distance_km"] = c["distance_km"]?.DeepClone(),
                ["load"] = c["load"]!.GetValue<int>(), ["cash"] = c["cash"]!.GetValue<long>(),
                ["location_fresh"] = c["fresh"]!.GetValue<bool>(), ["ok"] = c["ok"]!.GetValue<bool>(),
                ["reasons"] = c["reasons"]!.DeepClone(),
                ["rating_avg"] = Math.Round(boy.RatingAvg, 1),
            });
        }
        return new JsonArray(outList.Select(i => (JsonNode?)i).ToArray());
    }

    /// <summary>Reference: GET /api/admin/delivery/trips.</summary>
    public async Task<JsonObject> TripsAsync(UserModel user, string status, string q, Guid? partnerId, int page)
    {
        await StaffAsync(user);
        var like = q.Trim().Length > 0 ? $"%{q.Trim()}%" : "";
        var rows = (await fleet.TripsPageAsync(status, like, partnerId, (page - 1) * 30)).ToList();
        var total = await fleet.TripsCountAsync(status, like, partnerId);
        var items = new List<JsonObject>();
        foreach (var a in rows) items.Add(await fleetBal.TripViewStaffAsync(a.Id));
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)i).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
        };
    }

    /// <summary>Reference: GET /api/admin/delivery/trips/{assignment_id}.</summary>
    public async Task<JsonObject> TripDetailAsync(UserModel user, Guid assignmentId)
    {
        await StaffAsync(user);
        var view = await fleetBal.TripViewStaffAsync(assignmentId);
        var logs = await fleet.StatusLogsAsync(Guid.Parse(view["sub_order_id"]!.GetValue<string>()));
        view["log"] = new JsonArray(logs.Select(x => (JsonNode?)new JsonObject
        {
            ["status"] = x.Status, ["actor"] = x.Actor, ["note"] = x.Note,
            ["lat"] = x.Lat, ["lng"] = x.Lng, ["at"] = x.CreatedAt.ToString("o"),
        }).ToArray());
        return view;
    }

    /// <summary>Reference: GET /api/admin/delivery/overview.</summary>
    public async Task<JsonObject> OverviewAsync(UserModel user)
    {
        await StaffAsync(user);
        await fleetBal.SweepExpiredAsync();
        var kyc = (await delivery.KycCountsAsync()).ToDictionary(r => r.KycStatus, r => r.Count);
        var online = await delivery.OnlineApprovedCountAsync();
        var zones = await delivery.ActiveZoneCountAsync();
        var cfg = await deliverySettings.GetAsync();
        var trips = (await fleet.ActiveStatusCountsAsync()).ToDictionary(r => r.Status, r => r.Count);
        var istNow = DateTimeFunctions.UtcNow() + Ist;
        var day = istNow.Date - Ist;
        var deliveredToday = await fleet.DeliveredSinceAsync(day);
        var failedToday = await fleet.FailedSinceAsync(day);
        var stuckLimit = DateTimeFunctions.UtcNow() - TimeSpan.FromMinutes(cfg.Int("stuck_minutes"));
        var stuck = await fleet.StuckCountAsync(stuckLimit);
        var waiting = (await fleet.WaitingSubsAsync()).Count();
        long OnTrip() => new[] { "accepted", "at_store", "picked", "on_the_way", "reached" }.Sum(s => trips.GetValueOrDefault(s));
        return new JsonObject
        {
            ["partners"] = new JsonObject(kyc.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
            ["online"] = online, ["zones"] = zones,
            ["fleet_mode"] = cfg.Str("fleet_mode"), ["auto_assign"] = cfg.Bool("auto_assign"),
            ["enabled"] = cfg.Bool("enabled"), ["queue"] = waiting,
            ["offered"] = trips.GetValueOrDefault("offered"), ["on_trip"] = OnTrip(),
            ["delivered_today"] = deliveredToday, ["failed_today"] = failedToday,
            ["stuck"] = stuck, ["stuck_minutes"] = cfg.Int("stuck_minutes"),
        };
    }

    /// <summary>Reference: GET + PUT /api/admin/delivery/settings.</summary>
    public async Task<JsonObject> SettingsAsync(UserModel user)
    {
        await StaffAsync(user);
        return new JsonObject
        {
            ["values"] = (await deliverySettings.GetAsync()).DeepClone(),
            ["fleet_modes"] = new JsonArray(DeliverySettingsBAL.FleetModes.Select(m => (JsonNode?)m).ToArray()),
            ["fee_modes"] = new JsonArray(DeliverySettingsBAL.FeeModes.Select(m => (JsonNode?)m).ToArray()),
        };
    }

    public async Task<JsonObject> UpdateSettingsAsync(UserModel user, JsonObject body)
    {
        await StaffAsync(user);
        var values = await deliverySettings.UpdateAsync(body);
        return new JsonObject
        {
            ["values"] = values.DeepClone(),
            ["fleet_modes"] = new JsonArray(DeliverySettingsBAL.FleetModes.Select(m => (JsonNode?)m).ToArray()),
            ["fee_modes"] = new JsonArray(DeliverySettingsBAL.FeeModes.Select(m => (JsonNode?)m).ToArray()),
        };
    }

    // ------------------------------------------------------------------ partner documents + app upload (reference: delivery_admin.py)

    /// <summary>Staff read a partner's KYC document, written to the audit log (reference: GET .../partners/{id}/docs/{kind}).
    /// The photo lives at a public URL, so only the private documents are served here.</summary>
    public async Task<(byte[] Data, string Media, string FileName)> PartnerDocAsync(UserModel user, Guid partnerId, string kind)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        var key = kind switch
        {
            "license" => b.LicenseDoc, "id_proof" => b.IdProofDoc, "vehicle_rc" => b.VehicleDoc, _ => "",
        };
        if (key.Length == 0) throw new NotFoundException("Document");
        await AuditSimpleAsync(user, "delivery.kyc_view", "delivery_boy", b.Id, kind);
        var data = await images.ReadPrivateAsync(key);
        var ext = key[(key.LastIndexOf('.') + 1)..];
        var media = ext switch { "pdf" => "application/pdf", "png" => "image/png", "webp" => "image/webp", _ => "image/jpeg" };
        return (data, media, $"{kind}.{ext}");
    }

    /// <summary>Staff upload or replace a partner's document (reference: POST .../partners/{id}/docs/{kind}).</summary>
    public async Task<JsonObject> UploadPartnerDocAsync(UserModel user, Guid partnerId, string kind, byte[] data)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
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
        await AuditSimpleAsync(user, "delivery.kyc_upload", "delivery_boy", b.Id, kind);
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        return OutAdmin(b, zones, await deliverySettings.GetAsync());
    }

    private const long ApkMaxBytes = 120L * 1024 * 1024;
    private static readonly System.Text.RegularExpressions.Regex VersionPattern =
        new("^[0-9A-Za-z.\\-+ ]{0,20}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>Publish the partner Android app (reference: POST .../app). The checked APK is stored publicly and the
    /// download link and version shown in the partner app are updated.</summary>
    public async Task<JsonObject> UploadAppAsync(UserModel user, byte[] data, string version)
    {
        await StaffAsync(user);
        version = version.Trim();
        if (!VersionPattern.IsMatch(version))
            throw new AppException("Use a version like 1.0.3", "invalid_version");
        var name = "pixcart-partner" + (version.Length > 0
            ? $"-{System.Text.RegularExpressions.Regex.Replace(version, "[^0-9A-Za-z.]+", "-")}" : "");
        var url = await images.SaveAppPackageAsync(data, ApkMaxBytes, name);
        var updates = new JsonObject { ["android_apk_url"] = url };
        if (version.Length > 0) updates["app_version"] = version;
        var values = await deliverySettings.UpdateAsync(updates);
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, 'delivery.app_upload', 'settings', 'delivery', @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, detail = $"{(version.Length > 0 ? version : "no version")} {data.Length / 1024} KB", id = Guid.NewGuid() });
        await uow.CommitAsync();
        return new JsonObject { ["values"] = values, ["size"] = data.Length };
    }

    // ------------------------------------------------------------------ partners (reference: delivery_admin.py partners)

    private JsonObject OutAdmin(DeliveryBoyModel b, IReadOnlyDictionary<Guid, DeliveryZoneModel> zones, JsonObject cfg)
    {
        var o = deliveryBal.PartnerOut(b, b.ZoneId is not null && zones.TryGetValue(b.ZoneId.Value, out var z) ? z : null, cfg);
        o["user_id"] = b.UserId.ToString();
        return o;
    }

    /// <summary>Reference: GET /api/admin/delivery/partners.</summary>
    public async Task<JsonObject> PartnersAsync(UserModel user, string status, string q, Guid? zoneId, bool? online, int page)
    {
        await StaffAsync(user);
        var like = q.Trim().Length > 0 ? $"%{q.Trim()}%" : "";
        var rows = (await delivery.PartnersPageAsync(status, like, zoneId, online, (page - 1) * 30)).ToList();
        var total = await delivery.PartnersCountAsync(status, like, zoneId, online);
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        var cfg = await deliverySettings.GetAsync();
        var counts = (await delivery.KycCountsAsync()).ToDictionary(r => r.KycStatus, r => (JsonNode?)r.Count);
        counts["inactive"] = await delivery.InactivePartnerCountAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(rows.Select(b => (JsonNode?)OutAdmin(b, zones, cfg)).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 30,
            ["counts"] = new JsonObject(counts.Select(kv => new KeyValuePair<string, JsonNode?>(kv.Key, kv.Value)).ToArray()),
        };
    }

    private async Task<DeliveryBoyModel> RequireBoyAsync(Guid partnerId) =>
        await delivery.PartnerByIdAsync(partnerId) ?? throw new NotFoundException("Delivery partner");

    /// <summary>Reference: GET /api/admin/delivery/partners/{partner_id}.</summary>
    public async Task<JsonObject> PartnerDetailAsync(UserModel user, Guid partnerId)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        var o = OutAdmin(b, zones, await deliverySettings.GetAsync());
        // The verification team compares the number with the document photo (Aadhaar numbers are never stored).
        o["id_proof_no"] = b.IdProofEnc.Length > 0 ? crypto.Decrypt(b.IdProofEnc) : "";
        var u = await accounts.GetUserAsync(b.UserId);
        o["account"] = new JsonObject
        {
            ["name"] = u?.Name ?? "", ["last_login_at"] = u?.LastLoginAt?.ToString("o"),
        };
        return o;
    }

    /// <summary>Reference: POST /api/admin/delivery/partners (walk-in hiring by mobile number).</summary>
    public async Task<JsonObject> PartnerCreateAsync(UserModel user, string phone, string name, DeliveryProfile profile)
    {
        await StaffAsync(user);
        string normalized;
        try { normalized = NormalizeMobile(phone); }
        catch (ArgumentException exc)
        {
            throw new AppException(exc.Message, "invalid_phone", 400, new Dictionary<string, string> { ["phone"] = "Invalid" });
        }
        var u = await accounts.GetUserByPhoneAsync(normalized, null);
        if (u is null)
        {
            u = new UserModel { Id = Guid.NewGuid(), Phone = normalized, Name = name.Trim() };
            await accounts.InsertUserAsync(u, null);
        }
        else if (u.IsAdmin)
        {
            throw new AppException("This number belongs to a staff account", "staff_account");
        }
        if (await delivery.PartnerForUserAsync(u.Id) is not null)
            throw new AppException("This number is already a delivery partner", "already_registered", 409);
        var b = new DeliveryBoyModel
        {
            Id = Guid.NewGuid(), UserId = u.Id, Name = name.Trim(), Phone = normalized,
            KycStatus = "draft", BankDetails = "{}",
        };
        await deliveryBal.ApplyProfileAsync(b, profile);
        await delivery.InsertPartnerAsync(b);
        await AuditSimpleAsync(user, "delivery.partner_add", "delivery_boy", b.Id, normalized);
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        return OutAdmin(b, zones, await deliverySettings.GetAsync());
    }

    /// <summary>Reference: PUT /api/admin/delivery/partners/{partner_id}.</summary>
    public async Task<JsonObject> PartnerUpdateAsync(UserModel user, Guid partnerId, DeliveryProfile profile)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        await deliveryBal.ApplyProfileAsync(b, profile);
        await delivery.UpdatePartnerAsync(b);
        await AuditSimpleAsync(user, "delivery.partner_edit", "delivery_boy", b.Id);
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        return OutAdmin(b, zones, await deliverySettings.GetAsync());
    }

    /// <summary>Reference: GET /api/admin/delivery/partners/{partner_id}/bank (needs the payouts permission).</summary>
    public async Task<JsonObject> PartnerBankAsync(UserModel user, Guid partnerId)
    {
        await access.RequireAsync(user, "payouts");
        var b = await RequireBoyAsync(partnerId);
        await AuditSimpleAsync(user, "delivery.bank_view", "delivery_boy", b.Id);
        var bank = JsonNode.Parse(b.BankDetails)?.AsObject() ?? new JsonObject();
        var enc = bank["account_enc"]?.GetValue<string>() ?? "";
        return new JsonObject
        {
            ["holder"] = bank["holder"]?.GetValue<string>() ?? "",
            ["account_number"] = enc.Length > 0 ? crypto.Decrypt(enc) : "",
            ["ifsc"] = bank["ifsc"]?.GetValue<string>() ?? "",
            ["upi"] = bank["upi"]?.GetValue<string>() ?? "",
        };
    }

    /// <summary>Reference: POST /api/admin/delivery/partners/{partner_id}/kyc.</summary>
    public async Task<JsonObject> KycReviewAsync(UserModel user, Guid partnerId, string action, string note, Guid? zoneId)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        var cfg = await deliverySettings.GetAsync();
        if (zoneId is not null)
        {
            var zone = await delivery.ZoneAsync(zoneId.Value)
                       ?? throw new AppException("Choose a delivery zone", "invalid_zone");
            b.ZoneId = zone.Id;
        }
        string message;
        if (action == "approve")
        {
            var missing = DeliveryBAL.Checklist(b, cfg).Where(i => !i.Done).Select(i => i.Label).ToList();
            if (missing.Count > 0)
                throw new AppException($"Missing before approval: {string.Join(", ", missing)}", "incomplete");
            if (b.ZoneId is null)
                throw new AppException("Choose the zone this partner delivers in", "zone_required", 400,
                    new Dictionary<string, string> { ["zone_id"] = "Required" });
            b.KycStatus = "approved";
            b.KycNote = note.Trim();
            b.ApprovedAt ??= DateTimeFunctions.UtcNow();
            message = "You are approved. Open the partner app, go online and start delivering.";
        }
        else
        {
            if (note.Trim().Length < 5)
                throw new AppException("Tell the partner what to fix (at least 5 characters)", "note_required", 400,
                    new Dictionary<string, string> { ["note"] = "Required" });
            b.KycStatus = "rejected";
            b.KycNote = note.Trim();
            b.IsOnline = false;
            message = $"Please fix your registration: {b.KycNote}";
        }
        await delivery.UpdatePartnerAsync(b);
        await AuditSimpleAsync(user, $"delivery.kyc_{action}", "delivery_boy", b.Id, note[..Math.Min(200, note.Length)]);
        await notify.NotifyUserAsync(b.UserId, "delivery_kyc_update",
            new Dictionary<string, string> { ["status"] = action == "approve" ? "approved" : "needs changes", ["message"] = message },
            action == "approve" ? "/delivery" : "/delivery/register");
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        return OutAdmin(b, zones, cfg);
    }

    /// <summary>Reference: POST /api/admin/delivery/partners/{partner_id}/active.</summary>
    public async Task<JsonObject> SetActiveAsync(UserModel user, Guid partnerId, bool active, string reason)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        if (!active && reason.Trim().Length < 5)
            throw new AppException("Give a reason (at least 5 characters)", "reason_required", 400,
                new Dictionary<string, string> { ["reason"] = "Required" });
        b.IsActive = active;
        var inHand = 0;
        if (!active)
        {
            b.IsOnline = false;
            // Requests and trips not yet picked up go to other partners; packages already in hand stay with the
            // partner, who can still deliver them or bring them back to the store.
            var actives = (await fleet.ActiveForPartnerAsync(b.Id)).ToList();
            foreach (var a in actives)
            {
                if (a.Status is "offered" or "accepted" or "at_store")
                {
                    await fleetBal.CancelByStaffAsync(user, a.Id, $"Partner switched off: {reason.Trim()}");
                    await fleetBal.ReleaseAsync(a.SubOrderId, "the partner was switched off");
                }
                else
                {
                    inHand++;
                }
            }
        }
        await delivery.UpdatePartnerAsync(b);
        await AuditSimpleAsync(user, active ? "delivery.partner_on" : "delivery.partner_off", "delivery_boy", b.Id,
            reason[..Math.Min(200, reason.Length)]);
        await notify.NotifyUserAsync(b.UserId, "delivery_kyc_update",
            new Dictionary<string, string>
            {
                ["status"] = active ? "switched on" : "switched off",
                ["message"] = active ? "You can take deliveries again." : reason.Trim(),
            }, "/delivery");
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        var o = OutAdmin(b, zones, await deliverySettings.GetAsync());
        o["trips_in_hand"] = inHand;
        return o;
    }

    // ------------------------------------------------------------------ zones (reference: delivery_admin.py zones)

    private static readonly System.Text.RegularExpressions.Regex PinRe = new(@"^[1-9]\d{5}$");

    private static List<string> Pins(JsonNode? raw)
    {
        IEnumerable<string> items = raw is JsonArray arr
            ? arr.Select(x => x?.ToString() ?? "")
            : System.Text.RegularExpressions.Regex.Split(raw?.GetValue<string>() ?? "", "[\\s,;]+").AsEnumerable();
        var outList = new List<string>();
        foreach (var x in items.Select(s => s.Trim()))
        {
            if (x.Length == 0) continue;
            if (!PinRe.IsMatch(x))
                throw new AppException($"{x} is not a 6-digit PIN code", "invalid_pin", 400,
                    new Dictionary<string, string> { ["pincodes"] = x });
            if (!outList.Contains(x)) outList.Add(x);
        }
        if (outList.Count == 0)
            throw new AppException("Add at least one PIN code", "pins_required", 400,
                new Dictionary<string, string> { ["pincodes"] = "Required" });
        if (outList.Count > 500)
            throw new AppException("A zone can have at most 500 PIN codes", "too_many_pins");
        return outList;
    }

    private async Task<List<JsonObject>> ZoneOutAsync(List<DeliveryZoneModel> zones)
    {
        var stats = (await delivery.ZoneStatsAsync(zones.Select(z => z.Id).ToList())).ToList();
        return zones.Select(z =>
        {
            var mine = stats.Where(s => s.ZoneId == z.Id).ToList();
            return new JsonObject
            {
                ["id"] = z.Id.ToString(), ["name"] = z.Name, ["city"] = z.City,
                ["pincodes"] = JsonNode.Parse(z.Pincodes)?.DeepClone(),
                ["is_active"] = z.IsActive, ["center_lat"] = z.CenterLat, ["center_lng"] = z.CenterLng,
                ["partners"] = mine.Sum(s => s.Count),
                ["approved"] = mine.Where(s => s.KycStatus == "approved").Sum(s => s.Count),
                ["online"] = mine.Where(s => s is { KycStatus: "approved", Online: true }).Sum(s => s.Count),
            };
        }).ToList();
    }

    private async Task CheckOverlapAsync(List<string> pins, Guid? zoneId)
    {
        foreach (var z in (await delivery.AllZonesAsync()).Where(z => z.IsActive && z.Id != zoneId))
        {
            var existing = JsonNode.Parse(z.Pincodes)?.AsArray().Select(x => x?.GetValue<string>() ?? "").ToList() ?? [];
            var clash = pins.Intersect(existing).OrderBy(x => x).ToList();
            if (clash.Count > 0)
                throw new AppException(
                    $"{string.Join(", ", clash.Take(5))}{(clash.Count > 5 ? "…" : "")} already belong to the zone {z.Name}",
                    "pin_overlap", 409);
        }
    }

    /// <summary>Reference: GET /api/admin/delivery/zones.</summary>
    public async Task<JsonArray> ZonesAsync(UserModel user)
    {
        await StaffAsync(user);
        var rows = (await delivery.AllZonesAsync()).ToList();
        return new JsonArray((await ZoneOutAsync(rows)).Select(z => (JsonNode?)z).ToArray());
    }

    /// <summary>Reference: POST /api/admin/delivery/zones.</summary>
    public async Task<JsonObject> ZoneCreateAsync(UserModel user, string name, string city, JsonNode? pincodes,
        bool isActive, decimal? centerLat, decimal? centerLng)
    {
        await StaffAsync(user);
        var pins = Pins(pincodes);
        if (isActive) await CheckOverlapAsync(pins, null);
        if ((await delivery.AllZonesAsync()).Any(z => string.Equals(z.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new AppException("A zone with this name exists", "zone_exists", 409);
        var z = new DeliveryZoneModel
        {
            Id = Guid.NewGuid(), Name = name.Trim(), City = city.Trim(),
            Pincodes = JsonSerializer.Serialize(pins), IsActive = isActive, CenterLat = centerLat, CenterLng = centerLng,
        };
        await delivery.InsertZoneAsync(z);
        await AuditSimpleAsync(user, "delivery.zone_create", "delivery_zone", z.Id, z.Name);
        return (await ZoneOutAsync([z]))[0];
    }

    /// <summary>Reference: PUT /api/admin/delivery/zones/{zone_id}.</summary>
    public async Task<JsonObject> ZoneUpdateAsync(UserModel user, Guid zoneId, string name, string city,
        JsonNode? pincodes, bool isActive, decimal? centerLat, decimal? centerLng)
    {
        await StaffAsync(user);
        var z = await delivery.ZoneAsync(zoneId) ?? throw new NotFoundException("Zone");
        var pins = Pins(pincodes);
        if (isActive) await CheckOverlapAsync(pins, z.Id);
        if ((await delivery.AllZonesAsync()).Any(x => x.Id != z.Id && string.Equals(x.Name, name.Trim(), StringComparison.OrdinalIgnoreCase)))
            throw new AppException("A zone with this name exists", "zone_exists", 409);
        z.Name = name.Trim();
        z.City = city.Trim();
        z.Pincodes = JsonSerializer.Serialize(pins);
        z.IsActive = isActive;
        z.CenterLat = centerLat;
        z.CenterLng = centerLng;
        // Partners of a switched-off zone stop getting requests.
        if (!isActive) await delivery.SetOfflineInZoneAsync(z.Id);
        await delivery.UpdateZoneAsync(z);
        await AuditSimpleAsync(user, "delivery.zone_update", "delivery_zone", z.Id, z.Name);
        return (await ZoneOutAsync([z]))[0];
    }

    /// <summary>Reference: DELETE /api/admin/delivery/zones/{zone_id}.</summary>
    public async Task<JsonObject> ZoneDeleteAsync(UserModel user, Guid zoneId)
    {
        await StaffAsync(user);
        var z = await delivery.ZoneAsync(zoneId) ?? throw new NotFoundException("Zone");
        if (await delivery.PartnersInZoneCountAsync(z.Id) > 0)
            throw new AppException("Move this zone's partners to another zone first, or switch the zone off",
                "zone_in_use", 409);
        await AuditSimpleAsync(user, "delivery.zone_delete", "delivery_zone", z.Id, z.Name);
        await delivery.DeleteZoneAsync(z.Id);
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Reference: POST /api/admin/delivery/zones/{zone_id}/partners.</summary>
    public async Task<JsonObject> ZoneAssignAsync(UserModel user, Guid zoneId, IReadOnlyCollection<Guid> partnerIds)
    {
        await StaffAsync(user);
        _ = await delivery.ZoneAsync(zoneId) ?? throw new NotFoundException("Zone");
        var moved = await delivery.MovePartnersToZoneAsync(partnerIds, zoneId);
        await AuditSimpleAsync(user, "delivery.zone_assign", "delivery_zone", zoneId, $"{moved} partners");
        return new JsonObject { ["moved"] = moved };
    }

    // ------------------------------------------------------------------ shared

    /// <summary>Reference: core.validators.normalize_mobile (10 digits or an error).</summary>
    private static string NormalizeMobile(string value)
    {
        var digits = new string((value ?? "").Where(char.IsDigit).ToArray());
        if (digits.Length == 12 && digits.StartsWith("91")) digits = digits[2..];
        else if (digits.Length == 11 && digits.StartsWith("0")) digits = digits[1..];
        if (!System.Text.RegularExpressions.Regex.IsMatch(digits, "^[6-9]\\d{9}$"))
            throw new ArgumentException("Enter a valid 10-digit Indian mobile number");
        return digits;
    }

    private async Task AuditSimpleAsync(UserModel user, string action, string entityType, Guid entityId, string detail = "")
    {
        await using var uow = await db.BeginAsync();
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, @etype, @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, etype = entityType, eid = entityId.ToString(), detail, id = Guid.NewGuid() });
        await uow.CommitAsync();
    }

    // ------------------------------------------------------------------ cash and payouts (reference: delivery_admin.py)

    private async Task<long> CashInHandAsync(Guid boyId)
    {
        await using var uow = await db.BeginAsync();
        var cash = await fleet.CashByPartnerAsync([boyId], uow);
        await uow.CommitAsync();
        return cash.GetValueOrDefault(boyId);
    }

    /// <summary>Reference: GET /api/admin/delivery/cash.</summary>
    public async Task<JsonObject> CashAsync(UserModel user)
    {
        await StaffAsync(user);
        var boys = (await delivery.ApprovedPartnersAsync(false)).ToList();
        await using var uow = await db.BeginAsync();
        var held = await fleet.CashByPartnerAsync(boys.Select(b => b.Id).ToList(), uow);
        await uow.CommitAsync();
        var cfg = await deliverySettings.GetAsync();
        var rows = boys.Where(b => held.GetValueOrDefault(b.Id) > 0)
            .Select(b => new JsonObject
            {
                ["id"] = b.Id.ToString(), ["name"] = b.Name, ["phone"] = b.Phone, ["photo"] = b.Photo,
                ["cash_in_hand"] = held[b.Id], ["over_limit"] = held[b.Id] > cfg.Long("cod_limit_paise"),
            })
            .OrderByDescending(r => r["cash_in_hand"]!.GetValue<long>()).ToList();
        var recent = await fleet.DepositsRecentAsync();
        return new JsonObject
        {
            ["partners"] = new JsonArray(rows.Select(r => (JsonNode?)r).ToArray()),
            ["total"] = rows.Sum(r => r["cash_in_hand"]!.GetValue<long>()),
            ["limit"] = cfg.Long("cod_limit_paise"),
            ["recent"] = new JsonArray(recent.Select(d => (JsonNode?)new JsonObject
            {
                ["partner"] = d.Partner, ["amount"] = d.Amount, ["method"] = d.Method,
                ["reference"] = d.Reference, ["note"] = d.Note, ["at"] = d.CreatedAt.ToString("o"),
            }).ToArray()),
        };
    }

    /// <summary>Reference: POST /api/admin/delivery/partners/{partner_id}/deposits.</summary>
    public async Task<JsonObject> AddDepositAsync(UserModel user, Guid partnerId, long amountPaise, string method,
        string reference, string note)
    {
        await StaffAsync(user);
        var b = await RequireBoyAsync(partnerId);
        var held = await CashInHandAsync(b.Id);
        if (amountPaise > held)
            throw new AppException($"{b.Name} holds {Money.Rupees(held)}; the deposit cannot be more", "deposit_too_big");
        await fleet.InsertDepositAsync(new DeliveryCashDepositModel
        {
            Id = Guid.NewGuid(), DeliveryBoyId = b.Id, Amount = amountPaise, Method = method,
            Reference = reference.Trim(), Note = note.Trim(), RecordedBy = user.Id,
            CreatedAt = DateTimeFunctions.UtcNow(),
        });
        await AuditSimpleAsync(user, "delivery.cash_deposit", "delivery_boy", b.Id, $"{amountPaise} {method}");
        return new JsonObject { ["cash_in_hand"] = await CashInHandAsync(b.Id) };
    }

    /// <summary>Reference: GET /api/admin/delivery/payouts.</summary>
    public async Task<JsonObject> PayoutsAsync(UserModel user, string status, int page)
    {
        await StaffAsync(user);
        var rows = (await fleet.PayoutsPageAsync(status, (page - 1) * 50)).ToList();
        var total = await fleet.PayoutsCountAsync(status);
        var pending = await fleet.PendingPayoutTotalAsync();
        var unbilled = await fleet.UnbilledTotalAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(rows.Select(p =>
            {
                var bank = JsonNode.Parse(p.PartnerBank)?.AsObject() ?? new JsonObject();
                bank.Remove("account_enc");
                return (JsonNode?)new JsonObject
                {
                    ["id"] = p.Id.ToString(),
                    ["partner"] = new JsonObject
                    {
                        ["id"] = p.DeliveryBoyId.ToString(), ["name"] = p.PartnerName, ["phone"] = p.PartnerPhone,
                        ["bank"] = bank,
                    },
                    ["period_start"] = p.PeriodStart.ToString("o"), ["period_end"] = p.PeriodEnd.ToString("o"),
                    ["deliveries"] = p.Deliveries, ["amount"] = p.Amount, ["cod_deducted"] = p.CodDeducted,
                    ["net_amount"] = p.NetAmount, ["status"] = p.Status, ["paid_at"] = p.PaidAt?.ToString("o"),
                    ["reference"] = p.Reference,
                };
            }).ToArray()),
            ["total"] = total, ["page"] = page, ["page_size"] = 50,
            ["pending_total"] = pending, ["not_in_payout"] = unbilled,
        };
    }

    /// <summary>Reference: fleet.week_of (Monday to Sunday).</summary>
    private static (DateOnly Start, DateOnly End) WeekOfIst(DateTime dayIst)
    {
        var d = DateOnly.FromDateTime(dayIst);
        var start = d.AddDays(-(((int)d.DayOfWeek + 6) % 7));
        return (start, start.AddDays(6));
    }

    /// <summary>Reference: POST /api/admin/delivery/payouts/generate + fleet.generate_payouts (payouts permission).</summary>
    public async Task<JsonObject> GeneratePayoutsAsync(UserModel user, DateOnly? weekStart)
    {
        await access.RequireAsync(user, "payouts");
        var day = weekStart ?? DateOnly.FromDateTime(DateTimeFunctions.UtcNow() + Ist - TimeSpan.FromDays(7));
        var (start, end) = WeekOfIst(day.ToDateTime(TimeOnly.MinValue));
        var until = (end.ToDateTime(TimeOnly.MinValue) + TimeSpan.FromDays(1)) - Ist; // IST day start of day after end, in UTC
        var cfg = await deliverySettings.GetAsync();
        var made = 0;
        await using var uow = await db.BeginAsync();
        var rows = (await fleet.UnbilledByPartnerAsync(until, uow)).ToList();
        foreach (var r in rows)
        {
            var amount = r.Amount;
            var p = await fleet.PayoutForPeriodAsync(r.BoyId, start, uow);
            if (p is not null && p.Status == "paid") continue; // late trips go into the next week's payout
            var deduct = 0L;
            if (cfg.Bool("cod_deduct_from_payout"))
            {
                var cash = await fleet.CashByPartnerAsync([r.BoyId], uow);
                deduct = Math.Max(0, Math.Min(cash.GetValueOrDefault(r.BoyId), amount));
            }
            var now = DateTimeFunctions.UtcNow();
            if (p is null)
            {
                p = new DeliveryPayoutModel
                {
                    Id = Guid.NewGuid(), DeliveryBoyId = r.BoyId, PeriodStart = start, PeriodEnd = end,
                    Deliveries = 0, Amount = 0, CodDeducted = 0, NetAmount = 0, Status = "pending",
                    Reference = "", CreatedAt = now,
                };
                await fleet.InsertPayoutAsync(p, uow);
                made++;
            }
            p.Deliveries += (int)r.Deliveries;
            p.Amount += amount;
            p.CodDeducted += deduct;
            p.NetAmount = p.Amount - p.CodDeducted;
            await fleet.UpdatePayoutAsync(p, uow);
            if (deduct > 0)
            {
                await fleet.InsertDepositAsync(new DeliveryCashDepositModel
                {
                    Id = Guid.NewGuid(), DeliveryBoyId = r.BoyId, Amount = deduct, Method = "payout",
                    Reference = $"Payout {start:yyyy-MM-dd}", Note = "Cash in hand taken from the weekly payout",
                    CreatedAt = now,
                }, uow);
            }
            await fleet.AssignPayoutAsync(r.BoyId, until, p.Id, uow);
        }
        await AuditSimpleAsync(user, "delivery.payouts_generate", "delivery_payout",
            Guid.Empty, $"{start:yyyy-MM-dd} {made}");
        await uow.CommitAsync();
        return new JsonObject { ["created"] = made, ["week_start"] = start.ToString("o") };
    }

    /// <summary>Reference: POST /api/admin/delivery/payouts/{payout_id}/paid (payouts permission).</summary>
    public async Task<JsonObject> MarkPayoutPaidAsync(UserModel user, Guid payoutId, string reference)
    {
        await access.RequireAsync(user, "payouts");
        await using var uow = await db.BeginAsync();
        var p = await fleet.PayoutForUpdateAsync(payoutId, uow) ?? throw new NotFoundException("Payout");
        if (p.Status == "paid") throw new AppException("Already marked paid", "already_paid", 409);
        p.Status = "paid";
        p.PaidAt = DateTimeFunctions.UtcNow();
        p.PaidBy = user.Id;
        p.Reference = reference.Trim();
        await fleet.UpdatePayoutAsync(p, uow);
        await uow.CommitAsync();
        var b = await delivery.PartnerByIdAsync(p.DeliveryBoyId);
        await AuditSimpleAsync(user, "delivery.payout_paid", "delivery_payout", p.Id, reference[..Math.Min(60, reference.Length)]);
        if (b is not null)
        {
            await notify.NotifyUserAsync(b.UserId, "delivery_payout_paid", new Dictionary<string, string>
            {
                ["amount"] = Money.Rupees(p.NetAmount),
                ["period"] = $"{p.PeriodStart:dd MMM} to {p.PeriodEnd:dd MMM}", ["reference"] = p.Reference,
            }, "/delivery/earnings");
        }
        return new JsonObject { ["ok"] = true, ["status"] = p.Status };
    }

    // ------------------------------------------------------------------ reports and feedback (reference: delivery_admin.py)

    /// <summary>Reference: GET /api/admin/delivery/reports.</summary>
    public async Task<JsonObject> ReportsAsync(UserModel user, int days)
    {
        await StaffAsync(user);
        var istToday = (DateTimeFunctions.UtcNow() + Ist).Date;
        var sinceDay = istToday.AddDays(-(days - 1));
        var since = sinceDay - Ist;
        var dayRows = (await fleet.ReportDaysAsync(since)).ToList();
        var perDay = new Dictionary<string, JsonObject>();
        for (var k = 0; k < days; k++)
        {
            var d = DateOnly.FromDateTime(sinceDay.AddDays(k)).ToString("yyyy-MM-dd");
            perDay[d] = new JsonObject { ["date"] = d, ["delivered"] = 0L, ["failed"] = 0L, ["cod"] = 0L };
        }
        foreach (var r in dayRows)
        {
            var d = DateOnly.FromDateTime(r.Day).ToString("yyyy-MM-dd");
            if (!perDay.TryGetValue(d, out var rec)) continue;
            rec[r.Status] = r.Count;
            rec["cod"] = rec["cod"]!.GetValue<long>() + r.Cod;
        }
        long delivered = perDay.Values.Sum(r => r["delivered"]!.GetValue<long>());
        long failed = perDay.Values.Sum(r => r["failed"]!.GetValue<long>());
        var perf = (await fleet.ReportPartnersAsync(since)).ToList();
        return new JsonObject
        {
            ["days"] = new JsonArray(perDay.Values.Select(v => (JsonNode?)v).ToArray()),
            ["delivered"] = delivered, ["failed"] = failed,
            ["success_rate"] = delivered + failed > 0
                ? Math.Round(100.0 * delivered / (delivered + failed), 1)
                : null,
            ["cod_collected"] = perDay.Values.Sum(r => r["cod"]!.GetValue<long>()),
            ["partners"] = new JsonArray(perf.Select(i => (JsonNode?)new JsonObject
            {
                ["id"] = i.BoyId.ToString(), ["name"] = i.Name, ["rating_avg"] = Math.Round(i.RatingAvg, 1),
                ["rating_count"] = i.RatingCount, ["delivered"] = i.Delivered, ["failed"] = i.Failed,
                ["declined"] = i.Declined, ["earned"] = i.Earned, ["cod"] = i.Cod,
                ["avg_minutes"] = i.AvgMinutes is not null ? Math.Round(i.AvgMinutes.Value, 1) : null,
                ["success_rate"] = i.Delivered + i.Failed > 0
                    ? Math.Round(100.0 * i.Delivered / (i.Delivered + i.Failed), 1)
                    : null,
            }).OrderByDescending(x => x!["delivered"]!.GetValue<long>()).ToArray()),
        };
    }

    /// <summary>Reference: GET /api/admin/delivery/feedback.</summary>
    public async Task<JsonObject> FeedbackAsync(UserModel user, string kind, string status, int page)
    {
        await StaffAsync(user);
        if (kind == "ratings")
        {
            var rows = (await fleet.RatingsPageAsync((page - 1) * 30)).ToList();
            var total = await fleet.RatingsCountAsync();
            return new JsonObject
            {
                ["items"] = new JsonArray(rows.Select(a => (JsonNode?)new JsonObject
                {
                    ["assignment_id"] = a.AssignmentId.ToString(), ["partner"] = a.Partner,
                    ["order_number"] = a.OrderNumber, ["rating"] = a.Rating, ["comment"] = a.Comment,
                    ["at"] = a.At?.ToString("o"),
                }).ToArray()),
                ["total"] = total, ["page"] = page, ["page_size"] = 30,
            };
        }
        var crows = (await fleet.ComplaintsPageAsync(status, (page - 1) * 30)).ToList();
        var ctotal = await fleet.ComplaintsCountAsync(status);
        var open = await fleet.OpenComplaintsCountAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(crows.Select(c => (JsonNode?)new JsonObject
            {
                ["id"] = c.Id.ToString(), ["assignment_id"] = c.AssignmentId.ToString(), ["partner"] = c.Partner,
                ["order_number"] = c.OrderNumber, ["category"] = c.Category,
                ["category_label"] = DeliverySettingsBAL.Complaints.GetValueOrDefault(c.Category, c.Category),
                ["text"] = c.Text, ["status"] = c.Status, ["admin_note"] = c.AdminNote, ["at"] = c.At.ToString("o"),
            }).ToArray()),
            ["total"] = ctotal, ["page"] = page, ["page_size"] = 30, ["open"] = open,
        };
    }

    /// <summary>Reference: POST /api/admin/delivery/complaints/{complaint_id}/resolve.</summary>
    public async Task<JsonObject> ResolveComplaintAsync(UserModel user, Guid complaintId, string note)
    {
        await StaffAsync(user);
        var c = await fleet.ComplaintAsync(complaintId) ?? throw new NotFoundException("Complaint");
        await fleet.ResolveComplaintAsync(c.Id, note.Trim(), DateTimeFunctions.UtcNow());
        await AuditSimpleAsync(user, "delivery.complaint_resolve", "delivery_complaint", c.Id,
            note[..Math.Min(200, note.Length)]);
        return new JsonObject { ["ok"] = true };
    }

    // ------------------------------------------------------------------ live map (reference: delivery_admin.live)

    /// <summary>Reference: GET /api/admin/delivery/live.</summary>
    public async Task<JsonObject> LiveAsync(UserModel user)
    {
        await StaffAsync(user);
        await fleetBal.SweepExpiredAsync();
        var now = DateTimeFunctions.UtcNow();
        var cfg = await deliverySettings.GetAsync();
        var boys = (await fleet.LiveBoysAsync()).ToList();
        var ids = boys.Select(b => b.Id).ToList();
        await using var uow = await db.BeginAsync();
        var cash = await fleet.CashByPartnerAsync(ids, uow);
        var load = await fleet.LoadsAsync(ids, uow);
        await uow.CommitAsync();
        var istToday = (now + Ist).Date;
        var day = istToday - Ist;
        var today = (await fleet.TodayStatsMultiAsync(ids.Count > 0 ? ids : [Guid.Empty], day))
            .ToDictionary(r => r.BoyId, r => (r.Trips, r.Earned));
        var zones = (await delivery.AllZonesAsync()).ToDictionary(z => z.Id);
        var trips = (await fleet.ActiveTripsAsync()).ToList();
        var stuckLimit = now - TimeSpan.FromMinutes(cfg.Int("stuck_minutes"));
        string[] onTrip = ["accepted", "at_store", "picked", "on_the_way", "reached"];
        var tripViews = new List<JsonObject>();
        foreach (var a in trips)
        {
            var v = await fleetBal.TripViewStaffAsync(a.Id);
            v["minutes_in_step"] = (int)(now - a.StatusAt).TotalMinutes;
            v["stuck"] = onTrip.Contains(a.Status) && a.StatusAt < stuckLimit;
            tripViews.Add(v);
        }
        var partners = new List<JsonObject>();
        foreach (var b in boys)
        {
            var mine = tripViews.Where(t => t["partner"]!["id"]!.GetValue<string>() == b.Id.ToString()).ToList();
            var age = b.LocationAt is not null ? (int?)(now - b.LocationAt.Value).TotalSeconds : null;
            partners.Add(new JsonObject
            {
                ["id"] = b.Id.ToString(), ["name"] = b.Name, ["phone"] = b.Phone, ["photo"] = b.Photo,
                ["vehicle"] = DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(b.VehicleType, ""),
                ["vehicle_no"] = b.VehicleNo,
                ["zone"] = b.ZoneId is not null && zones.TryGetValue(b.ZoneId.Value, out var z)
                    ? new JsonObject { ["id"] = z.Id.ToString(), ["name"] = z.Name, ["city"] = z.City }
                    : null,
                ["online"] = b.IsOnline,
                ["online_since"] = b.IsOnline && b.OnlineSince is not null ? b.OnlineSince.Value.ToString("o") : null,
                ["online_minutes"] = b.IsOnline && b.OnlineSince is not null
                    ? (int)(now - b.OnlineSince.Value).TotalMinutes
                    : null,
                ["lat"] = b.Lat, ["lng"] = b.Lng, ["location_age_seconds"] = age,
                ["location_state"] = age is null ? "unknown" : age <= 120 ? "live" : age <= 900 ? "stale" : "unknown",
                ["load"] = load.GetValueOrDefault(b.Id), ["max_active"] = cfg.Int("max_active"),
                ["state"] = mine.Count > 0 ? "on_trip" : "free",
                ["trips"] = new JsonArray(mine.Select(t => (JsonNode?)new JsonObject
                {
                    ["id"] = t["id"]!.GetValue<string>(), ["order_number"] = t["order_number"]!.GetValue<string>(),
                    ["status"] = t["status"]!.GetValue<string>(), ["status_label"] = t["status_label"]!.GetValue<string>(),
                    ["stuck"] = t["stuck"]!.GetValue<bool>(),
                }).ToArray()),
                ["today_trips"] = today.GetValueOrDefault(b.Id).Trips,
                ["today_earned"] = today.GetValueOrDefault(b.Id).Earned,
                ["cash_in_hand"] = cash.GetValueOrDefault(b.Id), ["cash_limit"] = cfg.Long("cod_limit_paise"),
                ["rating_avg"] = Math.Round(b.RatingAvg, 1), ["rating_count"] = b.RatingCount,
            });
        }
        partners = partners
            .OrderBy(p => !p["online"]!.GetValue<bool>())
            .ThenBy(p => p["state"]!.GetValue<string>() != "free")
            .ThenBy(p => p["name"]!.GetValue<string>()).ToList();
        var byZone = new Dictionary<string, JsonObject>();
        foreach (var p in partners)
        {
            var key = p["zone"] is JsonObject zo ? zo["name"]!.GetValue<string>() : "No zone";
            if (!byZone.TryGetValue(key, out var zr))
            {
                zr = new JsonObject { ["zone"] = key, ["online"] = 0, ["free"] = 0, ["on_trip"] = 0 };
                byZone[key] = zr;
            }
            var on = p["online"]!.GetValue<bool>();
            var onTripNow = p["state"]!.GetValue<string>() == "on_trip";
            zr["online"] = zr["online"]!.GetValue<int>() + (on ? 1 : 0);
            zr["free"] = zr["free"]!.GetValue<int>() + (on && !onTripNow ? 1 : 0);
            zr["on_trip"] = zr["on_trip"]!.GetValue<int>() + (onTripNow ? 1 : 0);
        }
        var waiting = (await fleet.WaitingSubsAsync()).Count();
        return new JsonObject
        {
            ["partners"] = new JsonArray(partners.Select(p => (JsonNode?)p).ToArray()),
            ["trips"] = new JsonArray(tripViews.Select(t => (JsonNode?)t).ToArray()),
            ["zones"] = new JsonArray(zones.Values.Where(z => z.IsActive).Select(z => (JsonNode?)new JsonObject
            {
                ["id"] = z.Id.ToString(), ["name"] = z.Name, ["city"] = z.City,
                ["lat"] = z.CenterLat, ["lng"] = z.CenterLng,
            }).ToArray()),
            ["summary"] = new JsonObject
            {
                ["online"] = partners.Count(p => p["online"]!.GetValue<bool>()),
                ["free"] = partners.Count(p => p["online"]!.GetValue<bool>() && p["state"]!.GetValue<string>() == "free"),
                ["on_trip"] = partners.Count(p => p["state"]!.GetValue<string>() == "on_trip"),
                ["stuck"] = tripViews.Count(t => t["stuck"]!.GetValue<bool>()),
                ["waiting"] = waiting,
                ["cash_in_hand"] = partners.Sum(p => p["cash_in_hand"]!.GetValue<long>()),
            },
            ["by_zone"] = new JsonArray(byZone.Values.OrderBy(z => z["zone"]!.GetValue<string>()).Select(z => (JsonNode?)z).ToArray()),
            ["map_tiles"] = cfg.Str("map_tiles"), ["map_attribution"] = cfg.Str("map_attribution"),
            ["server_time"] = now.ToString("o"),
        };
    }
}
