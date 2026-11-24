using System.Globalization;
using System.Text.Json.Nodes;
using BAL.AI;
using Utils;

namespace BAL.Assistant;

/// <summary>
/// System prompt for the admin assistant, in three layers: fixed rules (cached), how this marketplace works (cached;
/// changes only with the brand or house rules), and this request's context (date and time in India, who is asking,
/// role and permissions, page, memory notes, voice mode, the decision layer's reading, files, earlier messages).
/// </summary>
public static class AssistantPrompts
{
    public static string Rules => J.S(RefData.Obj("assistant_prompts")["rules"]);

    public static string Knowledge(string brand, string extraInstructions)
    {
        var outp = $"The marketplace is called {brand}.\n\n{J.S(RefData.Obj("assistant_prompts")["knowledge"])}";
        if (extraInstructions.Length > 0)
            outp += $"\n\nHouse rules from the marketplace's admins (follow them unless they conflict with the rules above):\n{extraInstructions}";
        return outp;
    }

    public static string Context(string userName, string roleName, IEnumerable<string> permissions, JsonObject? page, List<string> memories, bool voice,
        JsonObject? decision, JsonArray files, string earlier)
    {
        var now = DateTimeFunctions.ToIst(DateTimeFunctions.UtcNow());
        var lines = new List<string>
        {
            $"Now: {now.ToString("dddd, dd MMMM yyyy, hh:mm tt", CultureInfo.InvariantCulture)} IST.",
            $"You are helping {(userName.Length > 0 ? userName : "a staff member")} (role: {roleName}). Their permissions: {string.Join(", ", permissions.OrderBy(p => p, StringComparer.Ordinal))}.",
        };
        if (page != null && J.S(page["path"]).Length > 0)
            lines.Add($"They opened you from the page {J.S(page["title"])} ({J.S(page["path"])})" + (J.S(page["filters"]).Length > 0 ? $" with filters {J.S(page["filters"])}" : "") +
                      ". 'This', 'these' or 'here' may refer to it.");
        if (memories.Count > 0) lines.Add("Things they asked you to remember:\n" + string.Join("\n", memories.Select((m, i) => $"{i + 1}. {m}")));
        if (files.Count > 0)
            lines.Add("Files attached to this message: " + string.Join("; ", files.OfType<JsonObject>().Select(f => $"{J.S(f["filename"])} (id {J.S(f["id"])}, {J.Long(f["rows"]) ?? 0} rows)")));
        if (earlier.Length > 0) lines.Add("Earlier in this chat (condensed):\n" + earlier);
        if (decision != null)
            lines.Add($"Quick reading of the latest message (may be wrong): intent {J.S(decision["intent"])}, areas [{string.Join(", ", (decision["areas"] as JsonArray ?? []).Select(a => $"'{J.S(a)}'"))}], " +
                      $"period {(decision["period"] is null ? "None" : J.S(decision["period"]))}.");
        if (voice)
            lines.Add("VOICE MODE: your reply is spoken aloud. Answer in 1–3 short, natural sentences that sound good when heard. " +
                      "Say amounts the way people speak (\"one lakh twenty thousand rupees\" style is fine), no markdown, no bullet lists, no tables, " +
                      "no URLs. The cards still appear on screen, so you can say \"details are on screen\".");
        return string.Join("\n", lines);
    }
}

/// <summary>
/// Sandbox answers when no language model is connected: the decision layer picks the lookup and the real tools run, so
/// the cards are exact; only the sentence around them is a fixed template, and every reply says it is sandbox mode.
/// </summary>
public static class AssistantSandbox
{
    public const string Note = "Sandbox mode: no AI model is connected, so I can only run common lookups. Connect a model in Admin → AI providers for full answers.";

    private static readonly Dictionary<string, string> ExportFor = new()
    {
        ["orders"] = "orders", ["sales"] = "orders", ["returns"] = "returns", ["payouts"] = "payouts", ["catalog"] = "products", ["sellers"] = "sellers",
        ["customers"] = "customers", ["support"] = "tickets", ["reports"] = "tcs",
    };

    public static (Decision Decision, List<(string Name, JsonObject Args)> Calls) Choose(string text, ISet<string> available, bool hasUpload)
    {
        var d = DecisionLayer.Plan(DecisionLayer.Rules(text, hasUpload), 0.0, true, available);
        var calls = d.Prefetch.ToList();
        var low = text.ToLowerInvariant();
        if (d.Intent == "file_analysis" && available.Contains("file_overview"))
        {
            calls = [("file_overview", new JsonObject())];
        }
        else if (d.Intent == "export_request" && available.Contains("prepare_export"))
        {
            var fmt = low.Contains("pdf") ? "pdf" : low.Contains("csv") ? "csv" : "xlsx";
            var name = ExportFor.GetValueOrDefault(d.Domains.Count > 0 ? d.Domains[0] : "orders", "orders");
            var args = J.O(("name", name), ("format", fmt));
            if (d.Period != null) args["period"] = d.Period;
            calls = [("prepare_export", args)];
        }
        else if (calls.Count == 0 && d.Intent == "data_question")
        {
            var top = d.Domains.Count > 0 ? d.Domains[0] : "overview";
            (string, JsonObject)? guess = top switch
            {
                "orders" => ("find_orders", J.O(("period", d.Period ?? "today"))), "customers" => ("find_customers", new JsonObject()),
                "catalog" => ("find_products", J.O(("status", "approved"), ("sort", "best_selling"))), "sellers" => ("find_sellers", J.O(("period", d.Period ?? "last_30_days"))),
                "marketing" => ("coupons", new JsonObject()), "settings" => ("marketplace_settings", new JsonObject()),
                "sales" => ("business_overview", J.O(("period", d.Period ?? "today"))), "overview" => ("work_queue", new JsonObject()), _ => null,
            };
            if (guess is { } g && available.Contains(g.Item1)) calls = [g];
            if (top == "sales" && new[] { "by day", "trend", "daily", "chart", "graph", "day wise", "day-wise" }.Any(low.Contains) && available.Contains("sales_breakdown"))
                calls = [("sales_breakdown", J.O(("by", "day"), ("period", d.Period ?? "last_7_days")))];
        }
        return (d, calls.Take(2).ToList());
    }

    private static string Inr(JsonNode? n) => AiShared.Inr(J.Double(n) ?? 0);

    public static string Reply(Decision d, List<(string Name, JsonNode? Data)> results)
    {
        if (d.Intent == "small_talk") return $"Hello! Ask me about sales, orders, stock, returns, payouts or anything in the admin panel.\n\n({Note})";
        if (results.Count == 0)
        {
            if (d.Intent == "change_request") return $"I can prepare changes like approvals, cancellations or coupons once an AI model is connected.\n\n({Note})";
            return $"I could not match that to a lookup. Try “sales today”, “orders this week”, “low stock”, “what needs attention”, or attach a file.\n\n({Note})";
        }
        var parts = new List<string>();
        foreach (var (name, data) in results)
        {
            if (data is JsonObject e && J.Truthy(e["error"])) { parts.Add(J.S(e["error"])); continue; }
            switch (name)
            {
                case "business_overview":
                {
                    var c = data!["current"]!;
                    parts.Add($"{J.S(c["period"]!["label"])}: **{Inr(c["sales"])}** in sales from **{J.Long(c["orders"])}** orders " +
                              $"(average {Inr(c["average_order_value"])}, {J.Long(c["cod_orders"])} COD / {J.Long(c["online_orders"])} online).");
                    break;
                }
                case "work_queue":
                {
                    var waiting = ((JsonObject)data!).Where(kv => (J.Long(kv.Value) ?? 0) != 0).Select(kv => $"{J.Long(kv.Value)} {kv.Key.Replace('_', ' ')}").ToList();
                    parts.Add("Waiting for attention: " + (waiting.Count > 0 ? string.Join(", ", waiting) : "nothing right now."));
                    break;
                }
                case "prepare_export":
                    parts.Add($"Your {(J.S(data!["export"]) is { Length: > 0 } ex ? ex : "export")} ({J.S(data!["format"]).ToUpperInvariant()}) is ready below. {J.S(data!["filters"])}");
                    break;
                case "stock_alerts":
                    parts.Add($"{J.Long(data!["total"])} live options have {J.Long(data!["threshold"])} or fewer units; {J.Long(data!["out_of_stock"])} of those shown are out of stock.");
                    break;
                case "order_details":
                    parts.Add($"Order {J.S(data!["number"])} is {J.S(data!["status"])}, total {Inr(data!["grand_total"])}, paid by {J.S(data!["payment_method"]).ToUpperInvariant()}.");
                    break;
                case "customer_profile":
                    parts.Add($"{(J.S(data!["name"]) is { Length: > 0 } n ? n : J.S(data!["phone"]))}: {J.Long(data!["orders"])} orders, net spend {Inr(data!["net_spend"])}, joined {J.S(data!["joined"])}.");
                    break;
                case "file_overview":
                    parts.Add($"I read {J.S(data!["filename"])}: {(J.Long(data!["rows"]) ?? 0).ToString("N0", CultureInfo.InvariantCulture)} rows. Column totals are below.");
                    break;
                case "sales_breakdown":
                    parts.Add($"Sales by {J.S(data!["by"])} for {J.S(data!["period"]!["label"])} are in the chart below.");
                    break;
                default:
                    parts.Add("Here is what I found.");
                    break;
            }
        }
        return string.Join(" ", parts) + $"\n\n({Note})";
    }
}
