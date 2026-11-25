using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Utils;

namespace BAL;

/// <summary>
/// Product information beyond title and specifications (reference: services/product_info.py): the Legal Metrology
/// declarations for packaged goods (generic name, net quantity, unit sale price, manufacturer / packer / importer,
/// consumer care, country of origin), food details and the "important information" customers look for. Admins choose
/// per category which of these a listing must have (<c>categories.required_details</c>, inherited by sub-categories).
/// </summary>
public static partial class ProductInfo
{
    public static readonly IReadOnlyDictionary<string, string> NetUnits = new Dictionary<string, string>
    {
        ["g"] = "g", ["kg"] = "kg", ["ml"] = "ml", ["l"] = "l", ["m"] = "m", ["pcs"] = "pcs", ["pair"] = "pair",
    };

    /// <summary>What a category can make compulsory, in the admin and seller screens' order.</summary>
    public static readonly IReadOnlyList<KeyValuePair<string, string>> Requirable =
    [
        new("brand", "Brand"),
        new("net_quantity", "Net quantity (for the unit price)"),
        new("generic_name", "Generic name of the product"),
        new("manufacturer", "Manufacturer name and address"),
        new("packer", "Packer name and address"),
        new("importer", "Importer name and address (imported goods only)"),
        new("customer_care", "Consumer care details"),
        new("fssai_license", "FSSAI licence number"),
        new("ingredients", "Ingredients"),
        new("directions", "Directions for use"),
        new("safety_info", "Safety information"),
        new("shelf_life", "Best before / shelf life"),
        new("warranty", "Warranty"),
        new("dimensions", "Product dimensions"),
        new("in_the_box", "What's in the box"),
    ];

    [GeneratedRegex(@"[\x00-\x08\x0b\x0c\x0e-\x1f]")]
    private static partial Regex ControlRx();

    [GeneratedRegex(@"^\d{14}$")]
    private static partial Regex FssaiRx();

    private static string Clean(string? v) => ControlRx().Replace(v ?? "", "").Trim();

    /// <summary>Stored in <c>products.details</c>. Every field is optional unless the category requires it.</summary>
    public sealed class Details
    {
        public string NetUnit { get; init; } = "";
        public string GenericName { get; init; } = "";
        public string ModelNumber { get; init; } = "";
        public string Manufacturer { get; init; } = "";
        public string Packer { get; init; } = "";
        public string Importer { get; init; } = "";
        public string CustomerCare { get; init; } = "";
        public string FssaiLicense { get; init; } = "";
        public string Ingredients { get; init; } = "";
        public string Directions { get; init; } = "";
        public string SafetyInfo { get; init; } = "";
        public string LegalDisclaimer { get; init; } = "";
        public string ShelfLife { get; init; } = "";
        public string Warranty { get; init; } = "";
        public List<string> InTheBox { get; init; } = [];
        public double? LengthCm { get; init; }
        public double? WidthCm { get; init; }
        public double? HeightCm { get; init; }
        public List<string> KeySpecs { get; init; } = [];

        public string Field(string key) => key switch
        {
            "generic_name" => GenericName, "model_number" => ModelNumber, "manufacturer" => Manufacturer, "packer" => Packer,
            "importer" => Importer, "customer_care" => CustomerCare, "fssai_license" => FssaiLicense, "ingredients" => Ingredients,
            "directions" => Directions, "safety_info" => SafetyInfo, "legal_disclaimer" => LegalDisclaimer, "shelf_life" => ShelfLife,
            "warranty" => Warranty, "net_unit" => NetUnit, _ => "",
        };
    }

    private sealed class Invalid : Exception;

    /// <summary>Stored details (possibly from an older version); anything invalid gives empty details (a product page never breaks over one bad value).</summary>
    public static Details DetailsOf(string? json, bool strict = false)
    {
        try
        {
            var o = JsonHelper.Node(json) as JsonObject ?? [];
            string Text(string key, int max, bool strip = true)
            {
                if (!o.TryGetPropertyValue(key, out var v) || v is null) return "";
                if (v.GetValueKind() != JsonValueKind.String) throw new Invalid();
                var s = v.GetValue<string>();
                if (s.Length > max) throw new Invalid();
                return strip ? Clean(s) : s;
            }
            double? Dim(string key)
            {
                if (!o.TryGetPropertyValue(key, out var v) || v is null || v.GetValueKind() == JsonValueKind.Null) return null;
                if (v.GetValueKind() != JsonValueKind.Number) throw new Invalid();
                var d = double.Parse(v.ToJsonString(), CultureInfo.InvariantCulture);
                if (d <= 0 || d > 10_000) throw new Invalid();
                return d;
            }
            List<string> Items(string key, int maxItems)
            {
                if (!o.TryGetPropertyValue(key, out var v) || v is null) return [];
                if (v is not JsonArray arr || arr.Count > maxItems) throw new Invalid();
                var outp = new List<string>();
                foreach (var x in arr)
                {
                    if (strict && (x is not JsonValue j || !j.TryGetValue<string>(out _))) throw new Invalid();
                    var s = Clean(CatalogText.Str(x));
                    s = s.Length > 120 ? s[..120] : s;
                    if (s.Length > 0 && !outp.Contains(s)) outp.Add(s);
                }
                return outp;
            }
            var unit = Text("net_unit", 10, strip: false);
            if (unit.Length > 0 && !NetUnits.ContainsKey(unit)) throw new Invalid();
            var fssai = Regex.Replace(Text("fssai_license", 14, strip: false), @"\s+", "");
            if (fssai.Length > 0 && !FssaiRx().IsMatch(fssai)) throw new Invalid();
            return new Details
            {
                NetUnit = unit,
                GenericName = Text("generic_name", 120), ModelNumber = Text("model_number", 60), Manufacturer = Text("manufacturer", 400),
                Packer = Text("packer", 400), Importer = Text("importer", 400), CustomerCare = Text("customer_care", 300), FssaiLicense = fssai,
                Ingredients = Text("ingredients", 2000), Directions = Text("directions", 2000), SafetyInfo = Text("safety_info", 2000),
                LegalDisclaimer = Text("legal_disclaimer", 1000), ShelfLife = Text("shelf_life", 80), Warranty = Text("warranty", 300),
                InTheBox = Items("in_the_box", 20), LengthCm = Dim("length_cm"), WidthCm = Dim("width_cm"), HeightCm = Dim("height_cm"),
                KeySpecs = Items("key_specs", 6),
            };
        }
        catch (Exception e) when (e is Invalid or JsonException or FormatException or InvalidOperationException)
        {
            if (strict) throw new AppException("Invalid product details", "validation", 422);
            return new Details();
        }
    }

    /// <summary>"250 g", "1.5 kg"; "" without a quantity or unit.</summary>
    public static string FmtQty(decimal? qty, string unit)
    {
        if (qty is null || string.IsNullOrEmpty(unit)) return "";
        return $"{qty.Value.ToString("0.############################", CultureInfo.InvariantCulture)} {(NetUnits.TryGetValue(unit, out var u) ? u : unit)}";
    }

    /// <summary>
    /// Unit sale price, e.g. ₹420 per 100 g for ₹210 / 50 g. Small packs are priced per 100 g / 100 ml, a kilogram or
    /// litre and above per kg / l, countable goods per piece or pair. Null when it does not apply.
    /// </summary>
    public static JsonObject? UnitPrice(long pricePaise, decimal? qty, string unit)
    {
        if (qty is null || qty == 0 || string.IsNullOrEmpty(unit) || pricePaise <= 0) return null;
        var q = qty.Value;
        if (q <= 0) return null;
        decimal baseQty;
        string per;
        switch (unit)
        {
            case "g": (baseQty, per) = q >= 1000 ? (1000m, "kg") : (100m, "100 g"); break;
            case "ml": (baseQty, per) = q >= 1000 ? (1000m, "l") : (100m, "100 ml"); break;
            case "kg" or "l" or "m": (baseQty, per) = (1m, unit); break;
            case "pcs" or "pair": (baseQty, per) = (1m, unit == "pcs" ? "piece" : "pair"); break;
            default: return null;
        }
        return new JsonObject { ["paise"] = (long)Math.Round(pricePaise * baseQty / q, MidpointRounding.ToEven), ["per"] = per };
    }

    /// <summary>The union of the required lists of a category and its parents, in the admin's order.</summary>
    public static List<string> EffectiveRequired(IEnumerable<IEnumerable<string>> lists)
    {
        var all = lists.SelectMany(x => x).ToHashSet();
        return Requirable.Select(r => r.Key).Where(all.Contains).ToList();
    }

    /// <summary>Labels of the required items this listing does not have yet.</summary>
    public static List<string> MissingRequired(IEnumerable<string> required, string brand, string countryOfOrigin, Details details, IReadOnlyCollection<decimal?> netQtys)
    {
        var labels = Requirable.ToDictionary(r => r.Key, r => r.Value);
        var missing = new List<string>();
        foreach (var key in required)
        {
            var ok = key switch
            {
                "brand" => brand.Trim().Length > 0,
                "net_quantity" => details.NetUnit.Length > 0 && netQtys.Count > 0 && netQtys.All(q => q is > 0),
                "importer" => countryOfOrigin.Trim().Equals("india", StringComparison.OrdinalIgnoreCase) || details.Importer.Length > 0,
                "dimensions" => details.LengthCm != null && details.WidthCm != null && details.HeightCm != null,
                "in_the_box" => details.InTheBox.Count > 0,
                _ => details.Field(key).Trim().Length > 0,
            };
            if (!ok && labels.TryGetValue(key, out var label)) missing.Add(label);
        }
        return missing;
    }

    private static string G(double x) => x.ToString("G6", CultureInfo.InvariantCulture);

    /// <summary>Rows for the product page's "Product information" table (net quantity is per variant).</summary>
    public static JsonArray InfoRows(Details d, string brand, string countryOfOrigin)
    {
        var rows = new List<(string, string)> { ("Brand", brand), ("Generic name", d.GenericName), ("Model number", d.ModelNumber) };
        if (d.LengthCm != null && d.WidthCm != null && d.HeightCm != null)
            rows.Add(("Dimensions (L × W × H)", $"{G(d.LengthCm.Value)} × {G(d.WidthCm.Value)} × {G(d.HeightCm.Value)} cm"));
        rows.AddRange([
            ("Country of origin", countryOfOrigin), ("Manufacturer", d.Manufacturer), ("Packer", d.Packer), ("Importer", d.Importer),
            ("Consumer care", d.CustomerCare), ("FSSAI licence", d.FssaiLicense), ("Best before", d.ShelfLife), ("Warranty", d.Warranty),
            ("In the box", string.Join(", ", d.InTheBox)),
        ]);
        return new JsonArray(rows.Where(r => r.Item2.Length > 0).Select(r => (JsonNode)new JsonObject { ["label"] = r.Item1, ["value"] = r.Item2 }).ToArray());
    }

    public static JsonArray ImportantInfo(Details d)
    {
        var items = new[] { ("Ingredients", d.Ingredients), ("Directions for use", d.Directions), ("Safety information", d.SafetyInfo), ("Legal disclaimer", d.LegalDisclaimer) };
        return new JsonArray(items.Where(i => i.Item2.Length > 0).Select(i => (JsonNode)new JsonObject { ["title"] = i.Item1, ["text"] = i.Item2 }).ToArray());
    }

    /// <summary>"Size: M / Colour: Red".</summary>
    public static string VariantLabel(string? optionsJson)
    {
        var o = JsonHelper.Node(optionsJson) as JsonObject;
        return o == null ? "" : string.Join(" / ", o.Select(kv => $"{kv.Key}: {CatalogText.Str(kv.Value)}"));
    }

    public static int DiscountPct(long price, long mrp) => mrp <= 0 || price >= mrp ? 0 : (int)((mrp - price) * 100 / mrp);
}
