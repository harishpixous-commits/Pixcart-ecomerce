using System.Globalization;
using System.Text.Json.Nodes;
using BAL.Interface;
using Utils;

namespace BAL;

/// <summary>
/// Delivery estimates without a courier API (reference: services/delivery.py): seller dispatch days + transit days by
/// zone. Same first three PIN digits is "city", same state is "state", otherwise "national". The PIN → state table
/// follows the India Post circles and is used only for estimates, never for tax.
/// </summary>
public static class DeliveryEstimate
{
    private static readonly Dictionary<string, string> Pin2 = new()
    {
        ["11"] = "07", ["12"] = "06", ["13"] = "06", ["14"] = "03", ["15"] = "03", ["16"] = "03", ["17"] = "02", ["18"] = "01", ["19"] = "01",
        ["20"] = "09", ["21"] = "09", ["22"] = "09", ["23"] = "09", ["24"] = "09", ["25"] = "09", ["26"] = "09", ["27"] = "09", ["28"] = "09",
        ["30"] = "08", ["31"] = "08", ["32"] = "08", ["33"] = "08", ["34"] = "08", ["36"] = "24", ["37"] = "24", ["38"] = "24", ["39"] = "24",
        ["40"] = "27", ["41"] = "27", ["42"] = "27", ["43"] = "27", ["44"] = "27", ["45"] = "23", ["46"] = "23", ["47"] = "23", ["48"] = "23", ["49"] = "22",
        ["50"] = "36", ["51"] = "37", ["52"] = "37", ["53"] = "37", ["56"] = "29", ["57"] = "29", ["58"] = "29", ["59"] = "29",
        ["60"] = "33", ["61"] = "33", ["62"] = "33", ["63"] = "33", ["64"] = "33", ["67"] = "32", ["68"] = "32", ["69"] = "32",
        ["70"] = "19", ["71"] = "19", ["72"] = "19", ["73"] = "19", ["74"] = "19", ["75"] = "21", ["76"] = "21", ["77"] = "21", ["78"] = "18", ["79"] = "18",
        ["80"] = "10", ["81"] = "10", ["82"] = "10", ["83"] = "20", ["84"] = "10", ["85"] = "10",
    };

    private static readonly Dictionary<string, string> Pin3 = new()
    {
        ["160"] = "04", ["194"] = "38", ["246"] = "05", ["247"] = "05", ["248"] = "05", ["249"] = "05", ["262"] = "05", ["263"] = "05",
        ["396"] = "26", ["403"] = "30", ["605"] = "34", ["607"] = "34", ["609"] = "34", ["673"] = "32", ["682"] = "32", ["737"] = "11", ["744"] = "35",
        ["790"] = "12", ["791"] = "12", ["792"] = "12", ["793"] = "17", ["794"] = "17", ["795"] = "14", ["796"] = "15", ["797"] = "13", ["798"] = "13", ["799"] = "16",
        ["813"] = "20", ["814"] = "20", ["815"] = "20", ["816"] = "20", ["820"] = "20", ["821"] = "20", ["822"] = "20", ["825"] = "20", ["826"] = "20",
        ["827"] = "20", ["828"] = "20", ["829"] = "20", ["831"] = "20", ["832"] = "20", ["833"] = "20", ["834"] = "20", ["835"] = "20", ["490"] = "22", ["491"] = "22",
        ["492"] = "22", ["493"] = "22", ["494"] = "22", ["495"] = "22", ["496"] = "22", ["497"] = "22",
    };

    /// <summary>The GST state code of a PIN code (estimates only), or null.</summary>
    public static string? StateForPin(string pin)
    {
        if (pin.Length != 6 || !pin.All(char.IsAsciiDigit)) return null;
        return Pin3.TryGetValue(pin[..3], out var s) ? s : Pin2.GetValueOrDefault(pin[..2]);
    }

    public static string Zone(string originPin, string destPin, string originState)
    {
        if (originPin.Length >= 3 && destPin.Length >= 3 && originPin[..3] == destPin[..3]) return "city";
        var destState = StateForPin(destPin);
        return destState != null && destState == originState ? "state" : "national";
    }

    private static DateTime AddWorkingDays(DateTime start, int days)
    {
        var d = start;
        var added = 0;
        while (added < days)
        {
            d = d.AddDays(1);
            if (d.DayOfWeek != DayOfWeek.Sunday) added++; // couriers do not deliver on Sundays
        }
        return d;
    }

    /// <summary>Minutes until the seller's daily dispatch cut-off ("HH:MM" IST); null when passed, on Sunday or not set.</summary>
    public static int? CutoffMinutesLeft(string cutoff, DateTime istNow)
    {
        if (string.IsNullOrEmpty(cutoff)) return null;
        var parts = cutoff.Split(':');
        if (parts.Length != 2 || !int.TryParse(parts[0], out var hh) || !int.TryParse(parts[1], out var mm)) return null;
        if (istNow.DayOfWeek == DayOfWeek.Sunday) return null;
        var left = hh * 60 + mm - (istNow.Hour * 60 + istNow.Minute);
        return left > 0 ? left : null;
    }

    /// <summary>
    /// Expected delivery window: {"zone", "min_date", "max_date", "days_min", "order_within_min"}. With a dispatch
    /// cut-off, an order placed after it (or on a Sunday) is packed a day later; before it the customer sees how long
    /// is left. <paramref name="istNow"/> is the time in India (default: now).
    /// </summary>
    public static JsonObject Estimate(JsonObject cfg, int dispatchDays, string originPin, string originState, string destPin, DateTime? istNow = null, string cutoff = "")
    {
        var z = Zone(originPin, destPin, originState);
        var transit = cfg.Int(z switch { "city" => "transit_days_same_city", "state" => "transit_days_same_state", _ => "transit_days_national" });
        var start = istNow ?? DateTimeFunctions.ToIst(DateTime.UtcNow);
        var left = CutoffMinutesLeft(cutoff, start);
        var days = dispatchDays + transit + (!string.IsNullOrEmpty(cutoff) && left == null ? 1 : 0);
        var earliest = AddWorkingDays(start, days);
        var latest = AddWorkingDays(start, days + (z == "city" ? 1 : 2));
        return new JsonObject
        {
            ["zone"] = z,
            ["min_date"] = earliest.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["max_date"] = latest.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            ["days_min"] = days,
            ["order_within_min"] = left,
        };
    }
}
