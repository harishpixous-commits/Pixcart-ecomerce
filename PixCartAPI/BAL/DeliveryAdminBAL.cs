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
    DeliveryDAL delivery,
    OrdersDAL orders,
    IDeliveryFleetBAL fleetBal,
    IDeliverySettingsBAL deliverySettings,
    IAccessBAL access,
    IOrdersBAL ordersBal,
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
        // tab "returns": return pickups arrive with the returns module; counts report zero until then.
        await uow.CommitAsync();
        return new JsonObject
        {
            ["items"] = new JsonArray(items.Select(i => (JsonNode?)i).ToArray()),
            ["counts"] = new JsonObject
            {
                ["waiting"] = waiting.Count, ["offered"] = offered.Count, ["failed"] = failed.Count, ["returns"] = 0,
            },
        };
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
}
