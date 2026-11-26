using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;

namespace BAL;

/// <summary>
/// Customer-facing delivery tracking (read only). It lives apart from <see cref="DeliveryFleetBAL"/>, which drives the
/// trips and itself uses the orders service, so the order page can read the tracking without a dependency cycle.
/// </summary>
public class DeliveryTrackingBAL(DeliveryFleetDAL fleet, DeliveryDAL partners) : IDeliveryTrackingBAL
{
    /// <summary>Trip states in which the partner is carrying out the trip (their phone number is shown only then).</summary>
    private static readonly HashSet<string> OnTrip = [.. DeliveryFleetDAL.OnTrip];

    /// <summary>States in which the package is with the partner: the customer sees the delivery code and the position.</summary>
    private static readonly HashSet<string> WithPartner = ["picked", "on_the_way", "reached"];

    /// <summary>A position older than this is not shown as live.</summary>
    private static readonly TimeSpan LivePositionAge = TimeSpan.FromMinutes(15);

    /// <summary>Trip fields that are between the partner and the marketplace (pay, cash handling, why they declined).</summary>
    private static readonly string[] PartnerOnlyFields = ["fee", "tip", "cod_collected", "cod_method", "reject_reason"];

    public async Task<JsonObject> CustomerTrackingAsync(OrderModel order, IEnumerable<SubOrderModel> packages)
    {
        var drop = DropPoint(order.ShipTo);
        var tracking = new JsonObject();
        foreach (var package in packages.Where(p => p.ShippingProvider == "fleet"))
        {
            var view = new JsonObject
            {
                ["ready_for_pickup_at"] = DateTimeFunctions.Iso(package.ReadyForPickupAt),
                ["assignment"] = null,
                ["partner"] = null,
                ["otp"] = null,
                ["location"] = null,
                ["drop"] = drop.DeepClone(),
            };
            var trip = await fleet.LatestDeliveryTripAsync(package.Id);
            if (trip is not null)
            {
                var brief = DeliveryFleetBAL.BriefOf(trip);
                foreach (var field in PartnerOnlyFields) brief.Remove(field);
                view["assignment"] = brief;
                if (await partners.PartnerByIdAsync(trip.DeliveryBoyId) is { } partner)
                {
                    view["partner"] = PartnerView(partner, OnTrip.Contains(trip.Status));
                    if (WithPartner.Contains(trip.Status))
                    {
                        view["otp"] = package.DeliveryOtp;
                        view["location"] = LivePosition(partner);
                    }
                }
                view["can_rate"] = trip.Status == "delivered" && trip.Rating is null;
            }
            tracking[package.Id.ToString()] = view;
        }
        return tracking;
    }

    /// <summary>The partner as the customer sees them; the phone number only while they are on this trip (privacy both ways).</summary>
    private static JsonObject PartnerView(DeliveryBoyModel partner, bool onTrip) => new()
    {
        ["name"] = partner.Name,
        ["photo"] = partner.Photo,
        ["phone"] = onTrip ? partner.Phone : "",
        ["vehicle"] = DeliverySettingsBAL.VehicleLabels.GetValueOrDefault(partner.VehicleType, ""),
        ["vehicle_no"] = partner.VehicleNo,
        ["rating_avg"] = Math.Round(partner.RatingAvg, 1),
        ["rating_count"] = partner.RatingCount,
    };

    /// <summary>The partner's last position when it is recent enough to call live, else null.</summary>
    private static JsonObject? LivePosition(DeliveryBoyModel partner)
    {
        if (partner.Lat is null || partner.Lng is null || partner.LocationAt is not { } at) return null;
        if (DateTimeFunctions.UtcNow() - at >= LivePositionAge) return null;
        return new JsonObject { ["lat"] = (double)partner.Lat.Value, ["lng"] = (double)partner.Lng.Value, ["at"] = DateTimeFunctions.Iso(at) };
    }

    /// <summary>The delivery address's map point as stored on the order (either value may be null).</summary>
    private static JsonObject DropPoint(string shipTo)
    {
        var address = JsonNode.Parse(string.IsNullOrEmpty(shipTo) ? "null" : shipTo) as JsonObject;
        return new JsonObject { ["lat"] = address?["lat"]?.DeepClone(), ["lng"] = address?["lng"]?.DeepClone() };
    }
}
