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
/// </summary>
public class DeliveryFleetBAL(
    DeliveryFleetDAL fleet,
    DeliveryDAL delivery,
    OrdersDAL orders,
    InventoryDAL inventory,
    CatalogDAL catalog,
    AccountDAL accounts,
    StaffDAL staff,
    IAccessBAL access,
    IDeliveryBAL partners,
    IDeliverySettingsBAL deliverySettings,
    IFeesBAL fees,
    IOrdersBAL ordersBal,
    ICatalogNotifyBAL notify,
    IRateLimitBAL rateLimit,
    IImageUpload images,
    IMySqlDapperHelper db) : IDeliveryFleetBAL
{
    private const double RoadFactor = 1.3; // roads are longer than the straight line between two points
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);

    private static readonly IReadOnlyDictionary<string, string> StepLabel = new Dictionary<string, string>
    {
        ["offered"] = "Waiting for the partner to accept", ["accepted"] = "Partner on the way to the store",
        ["at_store"] = "Partner at the store", ["picked"] = "Picked up", ["on_the_way"] = "On the way to you",
        ["reached"] = "Partner has arrived", ["delivered"] = "Delivered", ["rejected"] = "Declined by the partner",
        ["expired"] = "Not accepted in time", ["cancelled"] = "Cancelled", ["failed"] = "Delivery attempt failed",
    };

    /// <summary>Reference STEPS for a delivery trip (the return-pickup steps come with the returns slice).</summary>
    private static readonly IReadOnlyDictionary<string, string[]> Steps = new Dictionary<string, string[]>
    {
        ["at_store"] = ["accepted"], ["picked"] = ["accepted", "at_store"],
        ["on_the_way"] = ["picked"], ["reached"] = ["picked", "on_the_way"],
    };

    // ------------------------------------------------------------------------- small helpers (reference: fleet.py top)

    private static double HaversineKm(double lat1, double lng1, double lat2, double lng2)
    {
        const double r = 6371.0;
        double Rad(double d) => d * Math.PI / 180.0;
        var a = Math.Pow(Math.Sin(Rad(lat2 - lat1) / 2), 2) +
                Math.Cos(Rad(lat1)) * Math.Cos(Rad(lat2)) * Math.Pow(Math.Sin(Rad(lng2 - lng1) / 2), 2);
        return 2 * r * Math.Asin(Math.Sqrt(a));
    }

    private static string Code() => Random.Shared.Next(0, 10_000).ToString("D4");

    private static long Long(JsonObject o, string key)
    {
        if (o[key] is not JsonValue v) return 0;
        if (v.TryGetValue<long>(out var n)) return n;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<double>(out var d)) return (long)d;
        return 0;
    }

    private static double Dbl(JsonObject o, string key)
    {
        if (o[key] is not JsonValue v) return 0;
        if (v.TryGetValue<double>(out var d)) return d;
        if (v.TryGetValue<int>(out var i)) return i;
        if (v.TryGetValue<long>(out var n)) return n;
        return 0;
    }

    /// <summary>A geo coordinate from a JSON address blob (may be stored as double or decimal, or absent).</summary>
    private static decimal? JDec(JsonNode? n)
    {
        if (n is not JsonValue v) return null;
        if (v.TryGetValue<decimal>(out var d)) return d;
        if (v.TryGetValue<double>(out var db2)) return (decimal)db2;
        return null;
    }

    private static string Rupees(long paise) =>
        paise % 100 == 0 ? $"₹{paise / 100m:N0}" : $"₹{paise / 100m:N2}";

    /// <summary>What a partner earns for one delivery before the tip (reference: fee_for).</summary>
    private static long FeeFor(JsonObject cfg, double? distanceKm)
    {
        if (cfg.Str("fee_mode") == "distance")
        {
            var fee = Long(cfg, "fee_base_paise") +
                      (distanceKm is not null ? (long)Math.Round(Long(cfg, "fee_per_km_paise") * distanceKm.Value) : 0);
            return Math.Max(Long(cfg, "fee_min_paise"), Math.Min(fee, Long(cfg, "fee_max_paise")));
        }
        return Long(cfg, "fee_fixed_paise");
    }

    /// <summary>The bad-weather bonus a trip finishing now would earn (reference: weather_bonus via fees.surge_active).</summary>
    private async Task<long> WeatherBonusAsync(JsonObject cfg)
    {
        if (Long(cfg, "weather_bonus_paise") == 0) return 0;
        var ck = await fees.GetAsync();
        return FeesBAL.SurgeActive(ck) ? Long(cfg, "weather_bonus_paise") : 0;
    }

    private async Task<long> CashInHandAsync(Guid boyId, IUnitOfWork uow) =>
        (await fleet.CashByPartnerAsync([boyId], uow))[boyId];

    private async Task<DeliveryZoneModel?> ZoneForPinAsync(string pin)
    {
        if (pin.Length == 0) return null;
        foreach (var z in await delivery.ActiveZonesAsync())
        {
            var pins = JsonSerializer.Deserialize<List<string>>(z.Pincodes) ?? [];
            if (pins.Contains(pin)) return z;
        }
        return null;
    }

    private static JsonObject ShipTo(OrderModel order) =>
        JsonNode.Parse(order.ShipTo) as JsonObject ?? new JsonObject();

    private static string Area(JsonObject st) =>
        string.Join(", ", new[] { st?["city"]?.GetValue<string>() ?? "", st?["pincode"]?.GetValue<string>() ?? "" }
            .Where(x => x.Length > 0));

    /// <summary>Where the partner collects the package (reference: pickup_place).</summary>
    private async Task<JsonObject> PickupPlaceAsync(SubOrderModel sub)
    {
        var seller = await catalog.GetSellerAsync(sub.SellerId);
        var wh = sub.WarehouseId is not null ? await inventory.WarehouseByIdAsync(sub.WarehouseId.Value) : null;
        var owner = seller is not null ? await accounts.GetUserAsync(seller.UserId) : null;
        var phone = (wh is not null ? wh.ContactPhone : "").Length > 0 ? wh!.ContactPhone : owner?.Phone ?? "";
        if (wh is not null)
            return new JsonObject
            {
                ["name"] = seller?.DisplayName ?? wh.Name,
                ["address"] = string.Join(", ", new[] { wh.Line1, wh.Line2 }.Where(x => x.Length > 0)),
                ["pincode"] = wh.Pincode, ["city"] = wh.City, ["phone"] = phone,
                ["lat"] = wh.Lat, ["lng"] = wh.Lng, ["warehouse_id"] = wh.Id.ToString(),
            };
        return new JsonObject
        {
            ["name"] = seller?.DisplayName ?? "",
            ["address"] = string.Join(", ", new[] { seller?.PickupLine1 ?? "", seller?.PickupLine2 ?? "" }.Where(x => x.Length > 0)),
            ["pincode"] = seller?.PickupPincode ?? "", ["city"] = seller?.PickupCity ?? "", ["phone"] = phone,
            ["lat"] = null, ["lng"] = null, ["warehouse_id"] = null,
        };
    }

    /// <summary>The first live package of the order carries the marketplace fees and the tip (reference: is_fee_carrier).</summary>
    private async Task<bool> IsFeeCarrierAsync(SubOrderModel sub, IUnitOfWork uow)
    {
        var first = await uow.QueryFirstOrDefaultAsync<Guid?>(
            "SELECT id FROM sub_orders WHERE order_id = @OrderId AND status != 'cancelled' ORDER BY number LIMIT 1",
            new { sub.OrderId });
        return first == sub.Id;
    }

    private async Task LogStatusAsync(IUnitOfWork uow, Guid orderId, Guid? subOrderId, Guid? assignmentId, string status,
        string actor, Guid? userId = null, string note = "", decimal? lat = null, decimal? lng = null) =>
        await fleet.InsertLogAsync(new OrderStatusLogModel
        {
            Id = Guid.NewGuid(), OrderId = orderId, SubOrderId = subOrderId, AssignmentId = assignmentId,
            Status = status, UpdatedBy = userId, Actor = actor, Note = note, Lat = lat, Lng = lng,
            CreatedAt = DateTimeFunctions.UtcNow(),
        }, uow);

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

    // ------------------------------------------------------------------------- which packages the fleet carries (reference: route)

    /// <summary>Whether this package goes to the own delivery partners, and from which zone (reference: route).</summary>
    public async Task<JsonObject> RouteAsync(SubOrderModel sub, OrderModel order)
    {
        var cfg = await deliverySettings.GetAsync();
        JsonObject Off() => new()
        {
            ["eligible"] = false, ["choice"] = false, ["zone_id"] = null, ["in_zones"] = false,
            ["mode"] = cfg.Str("fleet_mode"),
        };
        if (!cfg.Bool("enabled") || cfg.Str("fleet_mode") == "off") return Off();
        var place = await PickupPlaceAsync(sub);
        var pz = await ZoneForPinAsync(place["pincode"]!.GetValue<string>());
        var dz = await ZoneForPinAsync(ShipTo(order)["pincode"]?.GetValue<string>() ?? "");
        var inZones = pz is not null && dz is not null &&
                      pz.City.Trim().Equals(dz.City.Trim(), StringComparison.OrdinalIgnoreCase);
        var zoneId = pz?.Id ?? dz?.Id;
        return cfg.Str("fleet_mode") switch
        {
            "all" => new JsonObject
            {
                ["eligible"] = true, ["choice"] = false, ["zone_id"] = zoneId?.ToString(),
                ["in_zones"] = inZones, ["mode"] = cfg.Str("fleet_mode"),
            },
            "zones" => new JsonObject
            {
                ["eligible"] = inZones, ["choice"] = false, ["zone_id"] = inZones ? pz!.Id.ToString() : null,
                ["in_zones"] = inZones, ["mode"] = cfg.Str("fleet_mode"),
            },
            _ => new JsonObject
            {
                ["eligible"] = inZones, ["choice"] = inZones, ["zone_id"] = inZones ? pz!.Id.ToString() : null,
                ["in_zones"] = inZones, ["mode"] = cfg.Str("fleet_mode"),
            },
        };
    }

    // ------------------------------------------------------------------------- seller: hand-off (reference: ready_for_pickup / use_courier)

    public async Task<JsonObject> ReadyForPickupAsync(UserModel user, SellerModel seller, Guid subOrderId)
    {
        await using var uow = await db.BeginAsync();
        var (sub, order) = await OwnSubAsync(seller.Id, subOrderId, uow);
        if (sub.Status == "confirmed")
            await ordersBal.TransitionAsync(sub, "packed", "seller", "Packed and ready for pickup", uow);
        if (sub.Status != "packed")
            throw new AppException("Confirm and pack the order before handing it to a delivery partner", "invalid_status", 409);
        var r = await RouteAsync(sub, order);
        if (!r["eligible"]!.GetValue<bool>())
            throw new AppException("Our delivery partners do not cover this order. Ship it by courier.", "not_fleet");
        if (await fleet.ActiveForSubAsync(sub.Id, uow) is not null)
            throw new AppException("A delivery partner is already assigned", "already_assigned", 409);
        var now = DateTimeFunctions.UtcNow();
        sub.ShippingProvider = "fleet";
        sub.ReadyForPickupAt ??= now;
        sub.PickupCode = sub.PickupCode.Length > 0 ? sub.PickupCode : Code();
        sub.DeliveryOtp = sub.DeliveryOtp.Length > 0 ? sub.DeliveryOtp : Code();
        sub.DeliveryZoneId = r["zone_id"] is JsonValue z ? Guid.Parse(z.GetValue<string>()) : null;
        sub.FleetAlertedAt = null;
        await orders.UpdateSubFleetAsync(sub, uow);
        await LogStatusAsync(uow, order.Id, sub.Id, null, "ready_for_pickup", "seller", user.Id);
        var cfg = await deliverySettings.GetAsync();
        if (cfg.Bool("auto_assign"))
            await AutoAssignAsync(sub, order, cfg, uow);
        else
        {
            var place = await PickupPlaceAsync(sub);
            await NotifyStaffAsync("delivery", "staff_delivery_ready", new Dictionary<string, string>
            {
                ["order_number"] = sub.Number, ["store"] = place["name"]!.GetValue<string>(),
                ["pickup_area"] = place["city"]!.GetValue<string>(), ["drop_area"] = Area(ShipTo(order)),
            }, "/admin/delivery/queue");
        }
        await AuditAsync(uow, user, "suborder.ready_for_pickup", sub.Id);
        await uow.CommitAsync();
        return await SellerViewAsync(seller, subOrderId);
    }

    public async Task<JsonObject> UseCourierAsync(UserModel user, SellerModel seller, Guid subOrderId)
    {
        var cfg = await deliverySettings.GetAsync();
        if (cfg.Str("fleet_mode") != "seller_choice")
            throw new AppException("Our delivery partners deliver this order; contact the marketplace team to change it", "fleet_order");
        await using var uow = await db.BeginAsync();
        var (sub, _) = await OwnSubAsync(seller.Id, subOrderId, uow);
        if (sub.ShippingProvider != "fleet")
            throw new AppException("This order is not with the delivery fleet", "not_fleet");
        await UseCourierCoreAsync(sub, user.Id, "seller", uow);
        await AuditAsync(uow, user, "suborder.use_courier", sub.Id);
        await uow.CommitAsync();
        return await SellerViewAsync(seller, subOrderId);
    }

    /// <summary>Reference: fleet.use_courier (seller and staff share it).</summary>
    private async Task UseCourierCoreAsync(SubOrderModel sub, Guid userId, string actor, IUnitOfWork uow)
    {
        var a = await fleet.ActiveForSubAsync(sub.Id, uow);
        if (a is not null && a.Status is not ("offered" or "accepted" or "at_store"))
            throw new AppException("The delivery partner already has the package", "already_picked", 409);
        if (a is not null)
            await EndAsync(a, "cancelled", $"Switched to courier by the {actor}", uow, userId: userId, actor: actor, tellPartner: true);
        sub.ShippingProvider = "manual";
        sub.ReadyForPickupAt = null;
        await orders.UpdateSubFleetAsync(sub, uow);
        await LogStatusAsync(uow, sub.OrderId, sub.Id, null, "courier", actor, userId, "Ships by courier");
    }

    /// <summary>Reference: seller_orders._act fleet guards.</summary>
    public async Task GuardSellerActAsync(SellerModel seller, Guid subOrderId, string dst)
    {
        if (dst is not ("shipped" or "delivered")) return;
        var (sub, order) = await OwnSubAsync(seller.Id, subOrderId, null);
        if (sub.ShippingProvider == "fleet")
            throw new AppException("Our delivery partner picks up and delivers this order; the steps update by themselves", "fleet_order");
        if (dst == "shipped")
        {
            var r = await RouteAsync(sub, order);
            if (r["eligible"]!.GetValue<bool>() && !r["choice"]!.GetValue<bool>())
                throw new AppException("Our delivery partners deliver this order. Mark it Ready for pickup instead of shipping by courier.", "fleet_order");
        }
    }

    // ------------------------------------------------------------------------- offering and assigning (reference: _end / offer / candidates / auto_assign)

    private async Task EndAsync(DeliveryAssignmentModel a, string status, string note, IUnitOfWork uow,
        Guid? userId = null, string actor = "system", bool tellPartner = false)
    {
        var now = DateTimeFunctions.UtcNow();
        a.Status = status; a.EndedAt = now; a.StatusAt = now;
        if (status is "rejected" or "expired" or "cancelled" && a.RejectReason.Length == 0)
            a.RejectReason = note[..Math.Min(200, note.Length)];
        await fleet.UpdateAsync(a, uow);
        await LogStatusAsync(uow, a.OrderId, a.SubOrderId, a.Id, status, actor, userId, note);
        if (tellPartner)
        {
            var boy = await delivery.PartnerByIdAsync(a.DeliveryBoyId);
            var sub = await orders.GetSubAsync(a.SubOrderId);
            if (boy is not null && sub is not null)
                await notify.NotifyUserAsync(boy.UserId, "delivery_trip_cancelled",
                    new Dictionary<string, string> { ["order_number"] = sub.Number, ["message"] = note }, "/delivery");
        }
    }

    /// <summary>Offers the package to a partner, or assigns it outright (reference: offer; the return-pickup branch
    /// comes with the returns slice).</summary>
    private async Task<DeliveryAssignmentModel> OfferAsync(SubOrderModel sub, OrderModel order, DeliveryBoyModel boy,
        string mode, JsonObject cfg, IUnitOfWork uow, UserModel? by = null, bool direct = false)
    {
        if (await fleet.ActiveForSubAsync(sub.Id, uow) is not null)
            throw new AppException("This package already has a delivery partner", "already_assigned", 409);
        var now = DateTimeFunctions.UtcNow();
        var a = new DeliveryAssignmentModel
        {
            Id = Guid.NewGuid(), OrderId = order.Id, SubOrderId = sub.Id, DeliveryBoyId = boy.Id,
            AssignedBy = by?.Id, Mode = mode, Kind = "delivery",
            Status = direct ? "accepted" : "offered", AssignedAt = now,
            ExpiresAt = direct ? null : now.AddSeconds(cfg.Int("offer_seconds")),
            AcceptedAt = direct ? now : null, StatusAt = now,
            CodAmount = await ordersBal.CollectAmountAsync(sub, order, uow), CreatedAt = now,
        };
        await fleet.InsertAsync(a, uow);
        await LogStatusAsync(uow, order.Id, sub.Id, a.Id, a.Status, by is not null ? "admin" : "system", by?.Id,
            $"{(direct ? "Assigned to" : "Offered to")} {boy.Name}");
        var vars = await OfferVarsAsync(a, sub, order, cfg, uow);
        await notify.NotifyUserAsync(boy.UserId, direct ? "delivery_assigned" : "delivery_new_offer", vars,
            direct ? $"/delivery/trips/{a.Id}" : "/delivery");
        if (direct)
            await AnnounceAcceptedAsync(a, sub, order, boy, uow);
        return a;
    }

    private async Task<Dictionary<string, string>> OfferVarsAsync(DeliveryAssignmentModel a, SubOrderModel sub,
        OrderModel order, JsonObject cfg, IUnitOfWork uow)
    {
        var place = await PickupPlaceAsync(sub);
        var fee = FeeFor(cfg, null) +
                  (a.Kind == "delivery" && await IsFeeCarrierAsync(sub, uow) ? order.TipPaise : 0) +
                  await WeatherBonusAsync(cfg);
        return new Dictionary<string, string>
        {
            ["order_number"] = sub.Number, ["store"] = place["name"]!.GetValue<string>(),
            ["pickup_area"] = place["city"]!.GetValue<string>().Length > 0 ? place["city"]!.GetValue<string>() : place["pincode"]!.GetValue<string>(),
            ["drop_area"] = Area(ShipTo(order)), ["fee"] = $"Earn {Rupees(fee)}",
            ["cod"] = a.CodAmount > 0 ? $", collect {Rupees(a.CodAmount)}" : "",
            ["seconds"] = cfg.Int("offer_seconds").ToString(),
        };
    }

    /// <summary>Reference: _announce_accepted (delivery branch; the return-pickup branch comes with returns).</summary>
    private async Task AnnounceAcceptedAsync(DeliveryAssignmentModel a, SubOrderModel sub, OrderModel order,
        DeliveryBoyModel boy, IUnitOfWork uow)
    {
        var item = await FirstTitleAsync(sub, uow) is { Length: > 0 } t ? t : "Your package";
        await notify.NotifyUserAsync(order.UserId, "delivery_partner_assigned",
            new Dictionary<string, string> { ["partner"] = boy.Name, ["item"] = item }, $"/orders/{order.Id}");
        await notify.NotifySellerAsync(sub.SellerId, "seller_pickup_assigned", new Dictionary<string, string>
        {
            ["order_number"] = sub.Number, ["partner"] = boy.Name,
            ["vehicle"] = $"{DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(boy.VehicleType, "")} {boy.VehicleNo}".Trim(),
            ["code"] = sub.PickupCode,
        }, $"/seller/orders/{sub.Id}");
    }

    private async Task<string> FirstTitleAsync(SubOrderModel sub, IUnitOfWork uow) =>
        (await orders.ItemsAsync([sub.Id], uow)).FirstOrDefault()?.Title ?? "";

    /// <summary>Partners who could take this package, best first, each with why they can or cannot
    /// (reference: candidates; the return-pickup branch comes with returns).</summary>
    public async Task<List<JsonObject>> CandidatesAsync(SubOrderModel sub, OrderModel order, JsonObject cfg,
        IUnitOfWork uow, bool onlineOnly = true)
    {
        var place = await PickupPlaceAsync(sub);
        var zoneId = sub.DeliveryZoneId;
        var boys = (await delivery.ApprovedPartnersAsync(onlineOnly)).ToList();
        var ids = boys.Select(b => b.Id).ToList();
        var load = await fleet.LoadsAsync(ids, uow);
        var cash = await fleet.CashByPartnerAsync(ids, uow);
        var tried = await fleet.TriedForSubAsync(sub.Id, uow);
        var cod = await ordersBal.CollectAmountAsync(sub, order, uow);
        var now = DateTimeFunctions.UtcNow();
        var outList = new List<(DeliveryBoyModel Boy, double? Dist, int Load, long Cash, bool Fresh, List<string> Reasons)>();
        foreach (var b in boys)
        {
            var plat = JDec(place["lat"]); var plng = JDec(place["lng"]);
            double? dist = plat is not null && plng is not null && b.Lat is not null && b.Lng is not null
                ? HaversineKm((double)plat.Value, (double)plng.Value, (double)b.Lat.Value, (double)b.Lng.Value)
                : null;
            var reasons = new List<string>();
            if (zoneId is not null && b.ZoneId != zoneId) reasons.Add("other zone");
            if (tried.Contains(b.Id)) reasons.Add("already asked");
            if (load[b.Id] >= cfg.Int("max_active")) reasons.Add("busy");
            if (cod > 0 && cash[b.Id] + cod > Long(cfg, "cod_limit_paise")) reasons.Add("cash limit");
            if (dist is not null && dist > Dbl(cfg, "radius_km")) reasons.Add("too far");
            if (!b.IsOnline) reasons.Add("offline");
            var fresh = b.LocationAt is not null && now - b.LocationAt.Value < TimeSpan.FromMinutes(10);
            outList.Add((b, dist is not null ? Math.Round(dist.Value, 2) : null, load[b.Id], cash[b.Id], fresh, reasons));
        }
        outList.Sort((x, y) =>
        {
            var kx = (x.Reasons.Count > 0, x.Dist is null, x.Dist ?? 0, x.Load, !x.Fresh);
            var ky = (y.Reasons.Count > 0, y.Dist is null, y.Dist ?? 0, y.Load, !y.Fresh);
            return kx.CompareTo(ky);
        });
        return outList.Select(c => new JsonObject
        {
            ["boy_id"] = c.Boy.Id.ToString(), ["distance_km"] = c.Dist, ["load"] = c.Load, ["cash"] = c.Cash,
            ["fresh"] = c.Fresh, ["ok"] = c.Reasons.Count == 0,
            ["reasons"] = new JsonArray(c.Reasons.Select(r => JsonValue.Create(r)).ToArray<JsonNode?>()),
        }).ToList();
    }

    private async Task AlertUnassignedAsync(SubOrderModel sub, string reason, IUnitOfWork uow)
    {
        if (sub.FleetAlertedAt is not null) return;
        sub.FleetAlertedAt = DateTimeFunctions.UtcNow();
        await orders.UpdateSubFleetAsync(sub, uow);
        await NotifyStaffAsync("delivery", "staff_delivery_unassigned",
            new Dictionary<string, string> { ["order_number"] = sub.Number, ["reason"] = reason }, "/admin/delivery/queue");
    }

    /// <summary>Offers the package to the nearest free partner of the store's zone (reference: auto_assign).</summary>
    private async Task<DeliveryAssignmentModel?> AutoAssignAsync(SubOrderModel sub, OrderModel order, JsonObject cfg, IUnitOfWork uow)
    {
        if (!cfg.Bool("enabled") || !cfg.Bool("auto_assign") || sub.Status != "packed" || sub.ShippingProvider != "fleet")
            return null;
        if (await fleet.ActiveForSubAsync(sub.Id, uow) is not null) return null;
        var triedCount = await fleet.AutoOffersForSubAsync(sub.Id, uow);
        if (triedCount >= cfg.Int("max_offers"))
        {
            await AlertUnassignedAsync(sub, $"{triedCount} partners were asked and none took it.", uow);
            return null;
        }
        if (sub.DeliveryZoneId is null)
        {
            await AlertUnassignedAsync(sub, "No delivery zone covers the store.", uow);
            return null;
        }
        var pool = (await CandidatesAsync(sub, order, cfg, uow)).Where(c => c["ok"]!.GetValue<bool>()).ToList();
        if (pool.Count == 0)
        {
            await AlertUnassignedAsync(sub, "No free partner is online near the store right now.", uow);
            return null;
        }
        var boy = await delivery.PartnerByIdAsync(Guid.Parse(pool[0]["boy_id"]!.GetValue<string>()))
                  ?? throw new NotFoundException("Delivery partner");
        return await OfferAsync(sub, order, boy, "auto", cfg, uow);
    }

    /// <summary>After a request ended without the work done: offer it again or tell staff (reference: _after_release).</summary>
    private async Task AfterReleaseAsync(SubOrderModel sub, string why, JsonObject cfg, IUnitOfWork uow)
    {
        if (sub.Status != "packed" || sub.ShippingProvider != "fleet") return;
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        if (cfg.Bool("auto_assign"))
        {
            if (await AutoAssignAsync(sub, order, cfg, uow) is null)
                await AlertUnassignedAsync(sub, why, uow);
        }
        else
        {
            sub.FleetAlertedAt = null;
            await orders.UpdateSubFleetAsync(sub, uow);
            await AlertUnassignedAsync(sub, why, uow);
        }
    }

    /// <summary>Ends offers whose time ran out and moves their packages on (reference: sweep; safe to call often).</summary>
    private async Task<int> SweepAsync(IUnitOfWork uow)
    {
        var now = DateTimeFunctions.UtcNow();
        var rows = (await fleet.ExpiredOffersAsync(now, uow)).ToList();
        if (rows.Count == 0) return 0;
        var cfg = await deliverySettings.GetAsync();
        foreach (var a in rows)
        {
            await EndAsync(a, "expired", "Not accepted in time", uow);
            var sub = await orders.GetSubAsync(a.SubOrderId);
            if (sub is not null) await AfterReleaseAsync(sub, "The partner did not answer in time.", cfg, uow);
        }
        return rows.Count;
    }

    // ------------------------------------------------------------------------- the partner's answer (reference: accept / reject)

    public async Task<JsonObject> AcceptAsync(UserModel user, Guid assignmentId)
    {
        var boy = await partners.RequireApprovedAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await OwnTripAsync(assignmentId, boy, uow, "Delivery request");
        var cfg = await deliverySettings.GetAsync();
        try
        {
            if (a.Status != "offered")
                throw new AppException("This request is no longer available", "offer_gone", 409);
            if (a.ExpiresAt is not null && a.ExpiresAt < DateTimeFunctions.UtcNow())
            {
                await EndAsync(a, "expired", "Not accepted in time", uow);
                var sub = await orders.GetSubAsync(a.SubOrderId);
                if (sub is not null) await AfterReleaseAsync(sub, "The partner answered too late.", cfg, uow);
                throw new AppException("Time is up for this request; it went to another partner", "offer_expired", 409);
            }
            var busy = await fleet.OnTripCountAsync(boy.Id, uow);
            if (busy >= cfg.Int("max_active"))
                throw new AppException($"You can carry at most {cfg.Int("max_active")} packages at once", "too_many_trips", 409);
            var now = DateTimeFunctions.UtcNow();
            a.Status = "accepted"; a.AcceptedAt = now; a.StatusAt = now;
            await fleet.UpdateAsync(a, uow);
            await LogStatusAsync(uow, a.OrderId, a.SubOrderId, a.Id, "accepted", "delivery", boy.UserId);
            var sub2 = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
            var order = await orders.GetOrderAsync(a.OrderId) ?? throw new NotFoundException("Order");
            await AnnounceAcceptedAsync(a, sub2, order, boy, uow);
        }
        catch (AppException ex) when (ex.Code == "offer_expired")
        {
            await uow.CommitAsync(); // an expired offer was moved on; keep that
            throw;
        }
        await uow.CommitAsync();
        return await TripViewAsync(a.Id, boy);
    }

    public async Task<JsonObject> RejectAsync(UserModel user, Guid assignmentId, string reason, string note)
    {
        var boy = await partners.RequireApprovedAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await OwnTripAsync(assignmentId, boy, uow, "Delivery request");
        if (a.Status is not ("offered" or "accepted"))
            throw new AppException("This request can no longer be declined; call the delivery team", "cannot_reject", 409);
        var text = DeliverySettingsBAL.RejectReasons.GetValueOrDefault(reason, "Other reason") +
                   (note.Trim().Length > 0 ? $": {note.Trim()}" : "");
        a.RejectReason = text[..Math.Min(200, text.Length)];
        await EndAsync(a, "rejected", text, uow, userId: boy.UserId, actor: "delivery");
        var sub = await orders.GetSubAsync(a.SubOrderId);
        var cfg = await deliverySettings.GetAsync();
        if (sub is not null) await AfterReleaseAsync(sub, $"{boy.Name} declined: {text}", cfg, uow);
        await uow.CommitAsync();
        return new JsonObject { ["ok"] = true };
    }

    // ------------------------------------------------------------------------- the trip (reference: advance / deliver / fail)

    public async Task<JsonObject> StepAsync(UserModel user, Guid assignmentId, string to, string code, decimal? lat, decimal? lng)
    {
        if (to is not ("at_store" or "picked" or "on_the_way" or "reached"))
            throw new AppException("to must be one of at_store, picked, on_the_way, reached", "validation", 422);
        if (code.Length > 8) throw new AppException("code must be at most 8 characters", "validation", 422);
        var boy = await partners.RequireApprovedAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await OwnTripAsync(assignmentId, boy, uow, "Delivery");
        if (!Steps.GetValueOrDefault(to, []).Contains(a.Status))
            throw new AppException($"You cannot mark this as {to.Replace('_', ' ')} now", "invalid_step", 409);
        var cfg = await deliverySettings.GetAsync();
        var sub = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
        var order = await orders.GetOrderAsync(a.OrderId) ?? throw new NotFoundException("Order");
        var now = DateTimeFunctions.UtcNow();
        if (to == "picked")
        {
            if (cfg.Bool("pickup_code_required"))
            {
                await rateLimit.RateLimitAsync($"dpick:{a.Id}", 8, 900);
                if (code.Trim() != sub.PickupCode)
                    throw new AppException("The pickup code does not match. Ask the seller for the code on their order screen.", "wrong_code");
            }
            sub.CourierName = "Own delivery partner";
            sub.TrackingNumber = "";
            await ordersBal.TransitionAsync(sub, "shipped", "delivery", $"Picked up by {boy.Name}", uow, announce: false);
            a.PickedLat = lat; a.PickedLng = lng;
        }
        if (to == "at_store" && lat is not null && lng is not null && sub.WarehouseId is not null)
            await inventory.SetWarehouseLocationAsync(sub.WarehouseId.Value,
                Math.Round(lat.Value, 6), Math.Round(lng.Value, 6), uow); // learns the store location once
        a.Status = to; a.StatusAt = now; a.StuckAlertedAt = null;
        switch (to)
        {
            case "at_store": a.AtStoreAt = now; break;
            case "picked": a.PickedAt = now; break;
            case "on_the_way": a.OnTheWayAt = now; break;
            case "reached": a.ReachedAt = now; break;
        }
        await fleet.UpdateAsync(a, uow);
        await LogStatusAsync(uow, a.OrderId, a.SubOrderId, a.Id, to, "delivery", boy.UserId, lat: lat, lng: lng);
        if (to is "picked" or "reached")
        {
            var item = await FirstTitleAsync(sub, uow) is { Length: > 0 } t ? t : "Your package";
            if (to == "picked")
                await notify.NotifyUserAsync(order.UserId, "delivery_out_for_delivery",
                    new Dictionary<string, string> { ["item"] = item, ["partner"] = boy.Name, ["otp"] = sub.DeliveryOtp },
                    $"/orders/{order.Id}");
            else
                await notify.NotifyUserAsync(order.UserId, "delivery_arriving",
                    new Dictionary<string, string> { ["item"] = item, ["partner"] = boy.Name, ["otp"] = sub.DeliveryOtp },
                    $"/orders/{order.Id}");
        }
        await uow.CommitAsync();
        return await TripViewAsync(a.Id, boy);
    }

    public async Task<JsonObject> DeliverAsync(UserModel user, Guid assignmentId, string otp, byte[]? proofPhoto,
        long codCollected, string codMethod, decimal? lat, decimal? lng)
    {
        if (otp.Length > 8) throw new AppException("otp must be at most 8 characters", "validation", 422);
        if (codCollected is < 0 or > 100_000_000)
            throw new AppException("cod_collected must be between 0 and 100000000", "validation", 422);
        var boy = await partners.RequireApprovedAsync(user);
        var key = "";
        if (proofPhoto is not null)
            key = (await images.SavePrivateAsync(proofPhoto, $"delivery-proof/{assignmentId}")).Key;
        await using var uow = await db.BeginAsync();
        var a = await OwnTripAsync(assignmentId, boy, uow, "Delivery");
        if (a.Kind != "delivery" || a.Status is not ("picked" or "on_the_way" or "reached"))
            throw new AppException("This package cannot be marked delivered now", "invalid_step", 409);
        var cfg = await deliverySettings.GetAsync();
        var sub = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
        var order = await orders.GetOrderAsync(a.OrderId) ?? throw new NotFoundException("Order");
        if (cfg.Bool("delivery_otp_required"))
        {
            await rateLimit.RateLimitAsync($"dotp:{a.Id}", 6, 900);
            if (otp.Trim() != sub.DeliveryOtp)
                throw new AppException("The OTP does not match. Ask the customer for the code in their SMS or order page.", "wrong_otp");
        }
        if (cfg.Bool("proof_photo_required") && key.Length == 0)
            throw new AppException("Take a photo of the delivered package", "proof_required");
        var due = await ordersBal.CollectAmountAsync(sub, order, uow);
        if (due > 0)
        {
            if (codCollected != due)
                throw new AppException($"Collect {Rupees(due)} from the customer and enter that amount", "cod_mismatch",
                    fields: new Dictionary<string, string> { ["cod_collected"] = Rupees(due) });
            if (codMethod is not ("cash" or "upi"))
                throw new AppException("Choose how the customer paid: cash or UPI", "cod_method");
        }
        var now = DateTimeFunctions.UtcNow();
        a.Status = "delivered"; a.DeliveredAt = now; a.StatusAt = now; a.EndedAt = now;
        a.DropLat = lat; a.DropLng = lng; a.ProofPhoto = key;
        a.CodCollected = due > 0 ? due : 0; a.CodMethod = due > 0 ? codMethod : "";
        if (a.PickedLat is not null && lat is not null)
            a.DistanceKm = (decimal)Math.Round(
                HaversineKm((double)a.PickedLat.Value, (double)a.PickedLng!.Value, (double)lat.Value, (double)lng!.Value) * RoadFactor, 2);
        a.FeePaise = FeeFor(cfg, a.DistanceKm is not null ? (double)a.DistanceKm.Value : null);
        a.TipPaise = await IsFeeCarrierAsync(sub, uow) ? order.TipPaise : 0;
        a.BonusPaise = await WeatherBonusAsync(cfg);
        await fleet.UpdateAsync(a, uow);
        await ordersBal.TransitionAsync(sub, "delivered", "delivery", $"Delivered by {boy.Name}", uow);
        await LogStatusAsync(uow, a.OrderId, a.SubOrderId, a.Id, "delivered", "delivery", boy.UserId, lat: lat, lng: lng);
        await notify.NotifySellerAsync(sub.SellerId, "seller_package_delivered",
            new Dictionary<string, string> { ["order_number"] = sub.Number, ["partner"] = boy.Name },
            $"/seller/orders/{sub.Id}");
        var item = await FirstTitleAsync(sub, uow) is { Length: > 0 } t ? t : "your package";
        await notify.NotifyUserAsync(order.UserId, "delivery_rate",
            new Dictionary<string, string> { ["partner"] = boy.Name, ["item"] = item }, $"/orders/{order.Id}#delivery");
        await uow.CommitAsync();
        return await TripViewAsync(a.Id, boy);
    }

    public async Task<JsonObject> FailAsync(UserModel user, Guid assignmentId, string reason, string note, decimal? lat, decimal? lng)
    {
        if (note.Length > 200) throw new AppException("note must be at most 200 characters", "validation", 422);
        var boy = await partners.RequireApprovedAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await OwnTripAsync(assignmentId, boy, uow, "Delivery");
        if (a.Kind != "delivery" || a.Status is not ("picked" or "on_the_way" or "reached"))
            throw new AppException("Only a package you are carrying can be marked as not delivered", "invalid_step", 409);
        var text = DeliverySettingsBAL.FailReasons.GetValueOrDefault(reason, "Other reason") +
                   (note.Trim().Length > 0 ? $": {note.Trim()}" : "");
        a.FailReason = text[..Math.Min(200, text.Length)];
        a.DropLat = lat; a.DropLng = lng;
        await EndAsync(a, "failed", text, uow, userId: boy.UserId, actor: "delivery");
        var sub = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
        var order = await orders.GetOrderAsync(a.OrderId) ?? throw new NotFoundException("Order");
        var item = await FirstTitleAsync(sub, uow) is { Length: > 0 } t ? t : "Your package";
        await notify.NotifyUserAsync(order.UserId, "delivery_failed",
            new Dictionary<string, string>
            {
                ["item"] = item, ["reason"] = DeliverySettingsBAL.FailReasons.GetValueOrDefault(reason, "Other reason"),
            }, $"/orders/{order.Id}");
        await NotifyStaffAsync("delivery", "staff_delivery_failed", new Dictionary<string, string>
        {
            ["order_number"] = sub.Number, ["partner"] = boy.Name, ["reason"] = text,
        }, "/admin/delivery/queue?tab=failed");
        await uow.CommitAsync();
        return await TripViewAsync(a.Id, boy);
    }

    // ------------------------------------------------------------------------- location, feed and views

    public async Task<JsonObject> SetLocationAsync(UserModel user, decimal lat, decimal lng)
    {
        if (lat is < -90 or > 90 || lng is < -180 or > 180)
            throw new AppException("lat must be between -90 and 90, lng between -180 and 180", "validation", 422);
        var boy = await partners.RequireApprovedAsync(user);
        await rateLimit.RateLimitAsync($"dloc:{boy.Id}", 40, 60);
        await fleet.UpdateLocationAsync(boy.Id, Math.Round(lat, 6), Math.Round(lng, 6), DateTimeFunctions.UtcNow());
        return new JsonObject { ["ok"] = true };
    }

    public async Task<JsonObject> FeedAsync(UserModel user)
    {
        var boy = await partners.RequireApprovedAsync(user);
        await using var uow = await db.BeginAsync();
        await SweepAsync(uow);
        var now = DateTimeFunctions.UtcNow();
        var cfg = await deliverySettings.GetAsync();
        var taking = boy.IsActive && cfg.Bool("enabled"); // paused: only trips already in hand, no new requests
        List<DeliveryAssignmentModel> offers = taking ? (await fleet.LiveOffersAsync(boy.Id, now, uow)).ToList() : [];
        var active = (await fleet.OnTripAsync(boy.Id, uow)).ToList();
        var istToday = DateOnly.FromDateTime(now + Ist);
        var dayStart = istToday.ToDateTime(TimeOnly.MinValue) - Ist;
        var (trips, earned) = await fleet.TodayStatsAsync(boy.Id, dayStart, uow);
        var outOffers = new List<JsonObject>();
        foreach (var a in offers)
        {
            var v = await TripViewCoreAsync(a, uow, forPartner: true);
            v["seconds_left"] = Math.Max(0, (int)(a.ExpiresAt!.Value - now).TotalSeconds);
            outOffers.Add(v);
        }
        var activeViews = new List<JsonObject>();
        foreach (var a in active) activeViews.Add(await TripViewCoreAsync(a, uow, forPartner: true));
        var cashInHand = await CashInHandAsync(boy.Id, uow);
        await uow.CommitAsync();
        return new JsonObject
        {
            ["offers"] = new JsonArray(outOffers.Cast<JsonNode?>().ToArray()),
            ["active"] = new JsonArray(activeViews.Cast<JsonNode?>().ToArray()),
            ["is_online"] = boy.IsOnline && taking, ["taking_requests"] = taking,
            ["today"] = new JsonObject { ["trips"] = trips, ["earned"] = earned },
            ["cash_in_hand"] = cashInHand,
            ["cash_limit"] = Long(cfg, "cod_limit_paise"), ["offer_seconds"] = cfg.Int("offer_seconds"),
            ["server_time"] = now.ToString("o"), ["bonus_now"] = await WeatherBonusAsync(cfg),
        };
    }

    public async Task<JsonObject> TripAsync(UserModel user, Guid assignmentId)
    {
        var boy = await partners.RequirePartnerAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await fleet.AssignmentForUpdateAsync(assignmentId, uow);
        if (a is null || a.DeliveryBoyId != boy.Id) throw new NotFoundException("Delivery");
        var view = await TripViewCoreAsync(a, uow, forPartner: true);
        var logs = await fleet.LogsForAssignmentAsync(a.Id, uow);
        view["log"] = new JsonArray(logs.Select(x => (JsonNode?)new JsonObject
        {
            ["status"] = x.Status, ["note"] = x.Note, ["at"] = x.CreatedAt.ToString("o"),
        }).ToArray());
        return view;
    }

    public async Task<(byte[] Data, string Media)> ProofAsync(UserModel user, Guid assignmentId)
    {
        var boy = await partners.RequirePartnerAsync(user);
        await using var uow = await db.BeginAsync();
        var a = await fleet.AssignmentForUpdateAsync(assignmentId, uow);
        if (a is null || a.DeliveryBoyId != boy.Id) throw new NotFoundException("Delivery");
        if (a.ProofPhoto.Length == 0) throw new NotFoundException("Delivery photo");
        var data = await images.ReadPrivateAsync(a.ProofPhoto);
        var ext = a.ProofPhoto.Split('.').Last();
        var media = ext switch
        {
            "png" => "image/png", "webp" => "image/webp", "pdf" => "application/pdf", _ => "image/jpeg",
        };
        return (data, media);
    }

    private async Task<JsonObject> TripViewAsync(Guid assignmentId, DeliveryBoyModel boy)
    {
        await using var uow = await db.BeginAsync();
        var a = await fleet.AssignmentForUpdateAsync(assignmentId, uow)
                ?? throw new NotFoundException("Delivery");
        return await TripViewCoreAsync(a, uow, forPartner: true);
    }

    /// <summary>Reference: assignment_brief.</summary>
    private static JsonObject AssignmentBrief(DeliveryAssignmentModel a) => new()
    {
        ["id"] = a.Id.ToString(), ["status"] = a.Status,
        ["status_label"] = StepLabel.GetValueOrDefault(a.Status, a.Status), ["kind"] = a.Kind, ["mode"] = a.Mode,
        ["assigned_at"] = a.AssignedAt.ToString("o"), ["expires_at"] = a.ExpiresAt?.ToString("o"),
        ["accepted_at"] = a.AcceptedAt?.ToString("o"), ["at_store_at"] = a.AtStoreAt?.ToString("o"),
        ["picked_at"] = a.PickedAt?.ToString("o"), ["on_the_way_at"] = a.OnTheWayAt?.ToString("o"),
        ["reached_at"] = a.ReachedAt?.ToString("o"), ["delivered_at"] = a.DeliveredAt?.ToString("o"),
        ["status_at"] = a.StatusAt.ToString("o"), ["reject_reason"] = a.RejectReason, ["fail_reason"] = a.FailReason,
        ["cod_amount"] = a.CodAmount, ["cod_collected"] = a.CodCollected, ["cod_method"] = a.CodMethod,
        ["fee"] = a.FeePaise, ["tip"] = a.TipPaise, ["bonus"] = a.BonusPaise,
        ["distance_km"] = a.DistanceKm is not null ? (double)a.DistanceKm.Value : null,
        ["rating"] = a.Rating, ["rating_comment"] = a.RatingComment, ["has_proof"] = a.ProofPhoto.Length > 0,
        ["return_id"] = a.ReturnId?.ToString(),
    };

    /// <summary>Everything a partner needs for one trip (reference: trip_view; customer details only while the trip
    /// is theirs, staff views come with the admin slice).</summary>
    private async Task<JsonObject> TripViewCoreAsync(DeliveryAssignmentModel a, IUnitOfWork uow, bool forPartner)
    {
        var sub = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
        var order = await orders.GetOrderAsync(a.OrderId) ?? throw new NotFoundException("Order");
        var place = await PickupPlaceAsync(sub);
        var st = ShipTo(order);
        var items = await orders.ItemsAsync([sub.Id], uow);
        var cfg = await deliverySettings.GetAsync();
        var boy = await delivery.PartnerByIdAsync(a.DeliveryBoyId) ?? throw new NotFoundException("Delivery partner");
        // Partners see the customer's name, phone, address and instructions only from accepting to handing over.
        var showCustomer = DeliveryFleetDAL.OnTrip.Contains(a.Status) || !forPartner;
        var bonusNow = DeliveryFleetDAL.Active.Contains(a.Status) ? await WeatherBonusAsync(cfg) : 0;
        string S(string k) => st[k]?.GetValue<string>() ?? "";
        var view = AssignmentBrief(a);
        foreach (var kv in new JsonObject
        {
            ["order_number"] = sub.Number, ["order_id"] = order.Id.ToString(), ["sub_order_id"] = sub.Id.ToString(),
            ["payment"] = order.PaymentMethod,
            ["pickup"] = new JsonObject
            {
                ["name"] = place["name"]!.GetValue<string>(), ["address"] = place["address"]!.GetValue<string>(),
                ["pincode"] = place["pincode"]!.GetValue<string>(), ["city"] = place["city"]!.GetValue<string>(),
                ["phone"] = place["phone"]!.GetValue<string>(), ["lat"] = JDec(place["lat"]), ["lng"] = JDec(place["lng"]),
            },
            ["drop"] = new JsonObject
            {
                ["name"] = showCustomer ? S("full_name") : "", ["phone"] = showCustomer ? S("phone") : "",
                ["address"] = showCustomer
                    ? string.Join(", ", new[] { S("line1"), S("line2"), S("landmark") }.Where(x => x.Length > 0)) : "",
                ["city"] = S("city"), ["pincode"] = S("pincode"),
                ["lat"] = JDec(st["lat"]), ["lng"] = JDec(st["lng"]),
                ["instructions"] = showCustomer ? S("instructions") : "", ["no_bag"] = st["no_bag"]?.GetValue<bool>() ?? false,
            },
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)new JsonObject
            {
                ["title"] = i.Title, ["variant"] = i.VariantLabel, ["qty"] = i.Qty, ["image"] = i.ImageUrl,
            }).ToArray()),
            ["fee_estimate"] = FeeFor(cfg, null) +
                               (a.Kind == "delivery" && await IsFeeCarrierAsync(sub, uow) ? order.TipPaise : 0) + bonusNow,
            ["bonus_now"] = bonusNow,
            ["needs"] = new JsonObject
            {
                ["pickup_code"] = cfg.Bool("pickup_code_required"), ["otp"] = cfg.Bool("delivery_otp_required"),
                ["photo"] = cfg.Bool("proof_photo_required"),
            },
            ["partner"] = new JsonObject
            {
                ["id"] = boy.Id.ToString(), ["name"] = boy.Name, ["phone"] = boy.Phone, ["photo"] = boy.Photo,
                ["vehicle"] = DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(boy.VehicleType, ""),
                ["vehicle_no"] = boy.VehicleNo, ["lat"] = boy.Lat, ["lng"] = boy.Lng,
                ["location_at"] = boy.LocationAt?.ToString("o"),
            },
            ["pickup_code"] = !forPartner ? sub.PickupCode : null,
        })
            view[kv.Key] = kv.Value?.DeepClone();
        return view;
    }

    // ------------------------------------------------------------------------- shared small pieces

    private async Task<(SubOrderModel Sub, OrderModel Order)> OwnSubAsync(Guid sellerId, Guid subId, IUnitOfWork? uow)
    {
        var s = uow is not null ? await orders.SubForUpdateAsync(subId, uow) : await orders.GetSubAsync(subId);
        if (s is null || s.SellerId != sellerId || s.Status == "pending_payment") throw new NotFoundException("Order");
        var o = await orders.GetOrderAsync(s.OrderId) ?? throw new NotFoundException("Order");
        return (s, o);
    }

    private async Task<DeliveryAssignmentModel> OwnTripAsync(Guid assignmentId, DeliveryBoyModel boy, IUnitOfWork uow, string what)
    {
        var a = await fleet.AssignmentForUpdateAsync(assignmentId, uow);
        if (a is null || a.DeliveryBoyId != boy.Id) throw new NotFoundException(what);
        return a;
    }

    private async Task<JsonObject> SellerViewAsync(SellerModel seller, Guid subOrderId)
    {
        var data = await ordersBal.SellerGetAsync(seller, subOrderId);
        data["fleet"] = await FleetInfoAsync(seller, subOrderId);
        return data;
    }

    public async Task<JsonObject> FleetInfoAsync(SellerModel seller, Guid subOrderId)
    {
        var (s, o) = await OwnSubAsync(seller.Id, subOrderId, null);
        if (s.Status is "pending_payment" or "cancelled" or "delivered" && s.ShippingProvider != "fleet")
            return new JsonObject { ["eligible"] = false, ["choice"] = false, ["active"] = false };
        var r = s.ShippingProvider != "fleet"
            ? await RouteAsync(s, o)
            : new JsonObject { ["eligible"] = true, ["choice"] = false };
        var outObj = new JsonObject
        {
            ["eligible"] = r["eligible"]!.GetValue<bool>(), ["choice"] = r["choice"]!.GetValue<bool>(),
            ["active"] = s.ShippingProvider == "fleet",
            ["ready_for_pickup_at"] = s.ReadyForPickupAt?.ToString("o"),
            ["pickup_code"] = s.ShippingProvider == "fleet" && s.Status == "packed" ? s.PickupCode : "",
            ["partner"] = null, ["step"] = null,
        };
        if (s.ShippingProvider == "fleet")
        {
            var cfg = await deliverySettings.GetAsync();
            outObj["choice"] = cfg.Str("fleet_mode") == "seller_choice";
            await using var uow = await db.BeginAsync();
            var a = await fleet.ActiveForSubAsync(s.Id, uow);
            if (a is not null && a.Status != "offered")
            {
                var boy = await delivery.PartnerByIdAsync(a.DeliveryBoyId);
                outObj["partner"] = new JsonObject
                {
                    ["name"] = boy?.Name ?? "", ["phone"] = boy?.Phone ?? "", ["photo"] = boy?.Photo ?? "",
                    ["vehicle"] = DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(boy?.VehicleType ?? "", ""),
                    ["vehicle_no"] = boy?.VehicleNo ?? "",
                };
                outObj["step"] = new JsonObject
                {
                    ["status"] = a.Status, ["label"] = StepLabel.GetValueOrDefault(a.Status, a.Status), ["kind"] = a.Kind,
                };
            }
            else if (a is not null)
                outObj["step"] = new JsonObject { ["status"] = "offered", ["label"] = "Finding a delivery partner", ["kind"] = a.Kind };
            else if (s.Status == "packed")
                outObj["step"] = new JsonObject { ["status"] = "waiting", ["label"] = "Waiting for a delivery partner", ["kind"] = "delivery" };
        }
        return outObj;
    }

    private async Task AuditAsync(IUnitOfWork uow, UserModel user, string action, Guid subId, string detail = "") =>
        await uow.ExecuteAsync(
            "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, detail, created_at, id) " +
            "VALUES (@actor, @action, 'sub_order', @eid, @detail, UTC_TIMESTAMP(6), @id)",
            new { actor = user.Id, action, eid = subId.ToString(), detail, id = Guid.NewGuid() });

    // ------------------------------------------------------------------ staff operations (reference: delivery_admin.py)

    /// <summary>Ends expired offers outside a partner poll (reference: sweep; admin screens call it first).</summary>
    public async Task SweepExpiredAsync()
    {
        await using var uow = await db.BeginAsync();
        await SweepAsync(uow);
        await uow.CommitAsync();
    }

    /// <summary>Reference: fleet.pickup_place, shared with the staff queue view.</summary>
    public Task<JsonObject> PickupPlaceForAsync(SubOrderModel sub) => PickupPlaceAsync(sub);

    public static JsonObject ShipToOf(OrderModel order) => ShipTo(order);

    public static string AreaOf(JsonObject st) => Area(st);

    public static JsonObject BriefOf(DeliveryAssignmentModel a) => AssignmentBrief(a);

    /// <summary>Reference: delivery_admin.assign.</summary>
    public async Task<JsonObject> AssignByStaffAsync(UserModel admin, Guid subOrderId, Guid partnerId, bool direct, bool force)
    {
        await using var uow = await db.BeginAsync();
        var sub = await orders.SubForUpdateAsync(subOrderId, uow);
        if (sub is null || sub.ShippingProvider != "fleet" || sub.Status != "packed")
            throw new AppException("Only packages ready for pickup can be assigned", "not_ready", 409);
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var boy = await delivery.PartnerByIdAsync(partnerId) ?? throw new NotFoundException("Delivery partner");
        if (boy.KycStatus != "approved" || !boy.IsActive)
            throw new AppException("This partner is not approved or is switched off", "partner_unavailable");
        var cfg = await deliverySettings.GetAsync();
        var match = (await CandidatesAsync(sub, order, cfg, uow, onlineOnly: false))
            .FirstOrDefault(c => c["boy_id"]!.GetValue<string>() == boy.Id.ToString());
        var reasons = match is null
            ? new List<string>()
            : match["reasons"]!.AsArray().Select(r => r!.GetValue<string>()).Where(r => r != "already asked").ToList();
        if (reasons.Count > 0 && !force)
            throw new AppException($"{boy.Name}: {string.Join(", ", reasons)}. Assign anyway to override.",
                "partner_not_free", 409);
        var a = await OfferAsync(sub, order, boy, "manual", cfg, uow, by: admin, direct: direct);
        await AuditAsync(uow, admin, "delivery.assign", sub.Id, $"{boy.Name}{(direct ? " (direct)" : "")}");
        await uow.CommitAsync();
        return AssignmentBrief(a);
    }

    /// <summary>Reference: delivery_admin.run_auto.</summary>
    public async Task<JsonObject> AutoAssignByStaffAsync(UserModel admin, Guid subOrderId)
    {
        await using var uow = await db.BeginAsync();
        var sub = await orders.SubForUpdateAsync(subOrderId, uow);
        if (sub is null || sub.ShippingProvider != "fleet") throw new NotFoundException("Package");
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var cfg = (JsonObject)(await deliverySettings.GetAsync()).DeepClone();
        cfg["auto_assign"] = true;
        sub.FleetAlertedAt = null;
        await orders.UpdateSubFleetAsync(sub, uow);
        var a = await AutoAssignAsync(sub, order, cfg, uow);
        await AuditAsync(uow, admin, "delivery.auto_assign", sub.Id);
        await uow.CommitAsync();
        if (a is null) throw new AppException("No free partner can take it right now", "no_partner", 409);
        return AssignmentBrief(a);
    }

    /// <summary>Reference: delivery_admin.cancel_assignment + fleet.cancel_by_staff.</summary>
    public async Task CancelByStaffAsync(UserModel admin, Guid assignmentId, string reason)
    {
        await using var uow = await db.BeginAsync();
        var a = await fleet.AssignmentForUpdateAsync(assignmentId, uow) ?? throw new NotFoundException("Delivery");
        if (a.Status is not ("offered" or "accepted" or "at_store"))
            throw new AppException("The partner already has the package; mark the delivery failed or return it instead",
                "already_picked", 409);
        await EndAsync(a, "cancelled", $"Taken off by the delivery team: {reason}", uow,
            userId: admin.Id, actor: "admin", tellPartner: true);
        var sub = await orders.GetSubAsync(a.SubOrderId) ?? throw new NotFoundException("Order");
        sub.FleetAlertedAt = null;
        await orders.UpdateSubFleetAsync(sub, uow);
        await AuditAsync(uow, admin, "delivery.unassign", sub.Id, reason[..Math.Min(200, reason.Length)]);
        await uow.CommitAsync();
    }

    /// <summary>Reference: delivery_admin.resolve + fleet.resolve_failed.</summary>
    public async Task<JsonObject> ResolveFailedAsync(UserModel admin, Guid assignmentId, string action)
    {
        await using var uow = await db.BeginAsync();
        var failed = await fleet.AssignmentForUpdateAsync(assignmentId, uow) ?? throw new NotFoundException("Delivery");
        if (failed.Status != "failed")
            throw new AppException("Only a failed delivery can be resolved", "invalid_status", 409);
        var sub = await orders.GetSubAsync(failed.SubOrderId) ?? throw new NotFoundException("Order");
        if (await fleet.ActiveForSubAsync(sub.Id, uow) is not null)
            throw new AppException("This package already has a trip in progress", "already_assigned", 409);
        if (sub.Status != "shipped")
            throw new AppException("This package is no longer with the delivery partner", "invalid_status", 409);
        var boy = await delivery.PartnerByIdAsync(failed.DeliveryBoyId) ?? throw new NotFoundException("Delivery partner");
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Order");
        var now = DateTimeFunctions.UtcNow();
        var kind = action == "return" ? "return" : "delivery";
        var a = new DeliveryAssignmentModel
        {
            Id = Guid.NewGuid(), OrderId = order.Id, SubOrderId = sub.Id, DeliveryBoyId = boy.Id, AssignedBy = admin.Id,
            Mode = "manual", Kind = kind, Status = "picked", AssignedAt = now, AcceptedAt = now, PickedAt = now,
            StatusAt = now, PickedLat = failed.PickedLat, PickedLng = failed.PickedLng,
            CodAmount = kind == "delivery" ? await ordersBal.CollectAmountAsync(sub, order, uow) : 0, CreatedAt = now,
        };
        await fleet.InsertAsync(a, uow);
        await LogStatusAsync(uow, order.Id, sub.Id, a.Id, $"{kind}_trip", "admin", admin.Id,
            kind == "delivery" ? "Try the delivery again" : "Bring the package back to the store");
        var vars = await OfferVarsAsync(a, sub, order, await deliverySettings.GetAsync(), uow);
        vars["drop_area"] = kind == "return" ? "the store" : Area(ShipTo(order));
        await notify.NotifyUserAsync(boy.UserId, "delivery_assigned", vars, $"/delivery/trips/{a.Id}");
        await AuditAsync(uow, admin, $"delivery.{action}", sub.Id);
        await uow.CommitAsync();
        return AssignmentBrief(a);
    }

    /// <summary>Reference: delivery_admin.to_courier.</summary>
    public async Task ToCourierByStaffAsync(UserModel admin, Guid subOrderId)
    {
        await using var uow = await db.BeginAsync();
        var sub = await orders.SubForUpdateAsync(subOrderId, uow);
        if (sub is null || sub.ShippingProvider != "fleet") throw new NotFoundException("Package");
        await UseCourierCoreAsync(sub, admin.Id, "admin", uow);
        await AuditAsync(uow, admin, "delivery.to_courier", sub.Id);
        await uow.CommitAsync();
    }

    /// <summary>The full trip view with customer details, for staff (reference: delivery_admin trips detail).</summary>
    public async Task<JsonObject> TripViewStaffAsync(Guid assignmentId)
    {
        var a = await fleet.AssignmentAsync(assignmentId) ?? throw new NotFoundException("Delivery");
        await using var uow = await db.BeginAsync();
        var view = await TripViewCoreAsync(a, uow, forPartner: false);
        await uow.CommitAsync();
        return view;
    }

    /// <summary>Reference: delivery_admin.trip_proof (no ownership check - staff).</summary>
    public async Task<(byte[] Data, string Media)> ProofStaffAsync(Guid assignmentId)
    {
        var a = await fleet.AssignmentAsync(assignmentId) ?? throw new NotFoundException("Delivery");
        if (a.ProofPhoto.Length == 0) throw new NotFoundException("Delivery photo");
        var data = await images.ReadPrivateAsync(a.ProofPhoto);
        var ext = a.ProofPhoto.Split('.').Last();
        var media = ext switch
        {
            "png" => "image/png", "webp" => "image/webp", "pdf" => "application/pdf", _ => "image/jpeg",
        };
        return (data, media);
    }
}
