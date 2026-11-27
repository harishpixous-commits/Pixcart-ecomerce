namespace BAL;

using System.Text.Json.Nodes;
using DAL;

/// <summary>
/// Sandbox answers when no language model is connected (reference: app/assistant/sandbox.py).
/// The decision layer picks the lookup and the real tools run, so the cards are exact; only the
/// sentence around them is a fixed template. Every reply says it is sandbox mode.
/// </summary>
public static class AssistantSandbox
{
    public const string Note =
        "Sandbox mode: no AI model is connected, so I can only run common lookups. Connect a model in Admin → AI providers for full answers.";

    private static readonly IReadOnlyDictionary<string, string> ExportFor = new Dictionary<string, string>
    {
        ["orders"] = "orders", ["sales"] = "orders", ["returns"] = "returns", ["payouts"] = "payouts",
        ["catalog"] = "products", ["sellers"] = "sellers", ["customers"] = "customers", ["support"] = "tickets",
        ["reports"] = "tcs",
    };

    /// <summary>Reference: sandbox.choose — picks up to two tool calls from the decision layer's prefetch plan.</summary>
    public static (AssistantDecision.Decision Decision, List<(string Name, JsonObject Args)> Calls) Choose(
        string text, HashSet<string> available, bool hasUpload)
    {
        var d = AssistantDecision.Plan(AssistantDecision.Rules(text, hasUpload), minConfidence: 0.0, prefetch: true, available: available);
        var calls = d.Prefetch.ToList();
        var low = text.ToLowerInvariant();
        if (d.Intent == "file_analysis" && available.Contains("file_overview"))
        {
            calls = [("file_overview", new JsonObject())];
        }
        else if (d.Intent == "export_request" && available.Contains("prepare_export"))
        {
            var fmt = low.Contains("pdf") ? "pdf" : low.Contains("csv") ? "csv" : "xlsx";
            var name = ExportFor.GetValueOrDefault(d.DomainList.Count > 0 ? d.DomainList[0] : "orders", "orders");
            var args = new JsonObject { ["name"] = name, ["format"] = fmt };
            if (d.Period is not null) args["period"] = d.Period;
            calls = [("prepare_export", args)];
        }
        else if (calls.Count == 0 && d.Intent == "data_question")
        {
            var top = d.DomainList.Count > 0 ? d.DomainList[0] : "overview";
            (string, JsonObject)? guess = top switch
            {
                "orders" => ("find_orders", new JsonObject { ["period"] = d.Period ?? "today" }),
                "customers" => ("find_customers", new JsonObject()),
                "catalog" => ("find_products", new JsonObject { ["status"] = "approved", ["sort"] = "best_selling" }),
                "sellers" => ("find_sellers", new JsonObject { ["period"] = d.Period ?? "last_30_days" }),
                "marketing" => ("coupons", new JsonObject()),
                "settings" => ("marketplace_settings", new JsonObject()),
                "sales" => ("business_overview", new JsonObject { ["period"] = d.Period ?? "today" }),
                _ => ("work_queue", new JsonObject()),
            };
            if (guess is { } g && available.Contains(g.Item1)) calls = [g];
            if (top == "sales" && new[] { "by day", "trend", "daily", "chart", "graph", "day wise", "day-wise" }.Any(low.Contains)
                && available.Contains("sales_breakdown"))
                calls = [("sales_breakdown", new JsonObject { ["by"] = "day", ["period"] = d.Period ?? "last_7_days" })];
        }
        return (d, calls.Take(2).ToList());
    }

    /// <summary>Reference: sandbox.reply — the fixed template sentence around the exact cards.</summary>
    public static string Reply(AssistantDecision.Decision d, List<(string Name, JsonNode? Data)> results)
    {
        if (d.Intent == "small_talk")
            return $"Hello! Ask me about sales, orders, stock, returns, payouts or anything in the admin panel.\n\n({Note})";
        if (results.Count == 0)
        {
            if (d.Intent == "change_request")
                return $"I can prepare changes like approvals, cancellations or coupons once an AI model is connected.\n\n({Note})";
            return $"I could not match that to a lookup. Try “sales today”, “orders this week”, “low stock”, “what needs attention”, or attach a file.\n\n({Note})";
        }
        var parts = new List<string>();
        foreach (var (name, data) in results)
        {
            if (data is JsonObject err && err["error"] is not null)
            {
                parts.Add(err["error"]!.GetValue<string>());
            }
            else if (data is not JsonObject o)
            {
                parts.Add("Here is what I found.");
            }
            else
            {
                switch (name)
                {
                    case "business_overview":
                    {
                        var c = o["current"]!.AsObject();
                        parts.Add($"{c["period"]!["label"]!.GetValue<string>()}: **{AssistantQueriesDAL.Inr(AssistantToolsBAL.Lng(c, "sales"))}** in sales from " +
                                  $"**{AssistantToolsBAL.Lng(c, "orders")}** orders (average {AssistantQueriesDAL.Inr(AssistantToolsBAL.Lng(c, "average_order_value"))}, " +
                                  $"{AssistantToolsBAL.Lng(c, "cod_orders")} COD / {AssistantToolsBAL.Lng(c, "online_orders")} online).");
                        break;
                    }
                    case "work_queue":
                    {
                        var waiting = o.Select(kv => (kv.Key, Value: AssistantToolsBAL.Lng(o, kv.Key)))
                            .Where(kv => kv.Value != 0)
                            .Select(kv => $"{kv.Value} {kv.Key.Replace('_', ' ')}").ToList();
                        parts.Add("Waiting for attention: " + (waiting.Count > 0 ? string.Join(", ", waiting) : "nothing right now."));
                        break;
                    }
                    case "prepare_export":
                        parts.Add($"Your {o["export"]?.GetValue<string>() ?? "export"} ({(o["format"]?.GetValue<string>() ?? "").ToUpperInvariant()}) is ready below. {o["filters"]?.GetValue<string>() ?? ""}");
                        break;
                    case "stock_alerts":
                        parts.Add($"{AssistantToolsBAL.Lng(o, "total")} live options have {AssistantToolsBAL.Lng(o, "threshold")} or fewer units; {AssistantToolsBAL.Lng(o, "out_of_stock")} of those shown are out of stock.");
                        break;
                    case "order_details":
                        parts.Add($"Order {o["number"]!.GetValue<string>()} is {o["status"]!.GetValue<string>()}, total {AssistantQueriesDAL.Inr(AssistantToolsBAL.Lng(o, "grand_total"))}, paid by {o["payment_method"]!.GetValue<string>().ToUpperInvariant()}.");
                        break;
                    case "customer_profile":
                        parts.Add($"{(o["name"]?.GetValue<string>() is { Length: > 0 } n ? n : o["phone"]?.GetValue<string>())}: {AssistantToolsBAL.Lng(o, "orders")} orders, net spend {AssistantQueriesDAL.Inr(AssistantToolsBAL.Lng(o, "net_spend"))}, joined {o["joined"]?.GetValue<string>()}.");
                        break;
                    case "file_overview":
                        parts.Add(FormattableString.Invariant($"I read {o["filename"]?.GetValue<string>()}: {AssistantToolsBAL.Lng(o, "rows"):N0} rows. Column totals are below."));
                        break;
                    case "sales_breakdown":
                        parts.Add($"Sales by {o["by"]!.GetValue<string>()} for {o["period"]!["label"]!.GetValue<string>()} are in the chart below.");
                        break;
                    default:
                        parts.Add("Here is what I found.");
                        break;
                }
            }
        }
        return string.Join(" ", parts) + $"\n\n({Note})";
    }
}
