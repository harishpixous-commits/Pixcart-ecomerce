using System.Globalization;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <inheritdoc cref="IInvoicesBAL"/>
public class InvoicesBAL(OrdersDAL orders, SellerAccountDAL sellers, ReturnsDAL returns, ISiteBAL site,
    IFeesBAL fees, IMySqlDapperHelper db) : IInvoicesBAL
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    private static string MoneyFmt(long paise) => (paise / 100m).ToString("N2", Inv); // reference: _money
    private static string GstPct(int bps) => (bps / 100m).ToString(Inv); // reference: f"{bps / 100:g}"
    private static string IstDate(DateTime utc) => utc.AddMinutes(330).ToString("dd MMM yyyy", Inv); // reference: strftime("%d %b %Y") IST

    private static JsonObject ShipTo(OrderModel o) =>
        JsonNode.Parse(o.ShipTo) as JsonObject ?? [];

    private static string St(JsonObject o, string key) => o[key]?.GetValue<string>() ?? "";

    // ------------------------------------------------------------------------- amount in words (Indian system)

    private static readonly string[] Ones =
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen"
            .Split(' ');
    private static readonly string[] Tens = "twenty thirty forty fifty sixty seventy eighty ninety".Split(' ');

    private static string Two(long n) => n < 20 ? Ones[n] : Tens[n / 10 - 2] + (n % 10 == 0 ? "" : "-" + Ones[n % 10]);

    private static string Three(long n)
    {
        var (h, r) = Math.DivRem(n, 100);
        var parts = new List<string>();
        if (h > 0) parts.Add($"{Ones[h]} hundred");
        if (r > 0) parts.Add(Two(r));
        return string.Join(' ', parts);
    }

    /// <summary>Reference: rupees_in_words.</summary>
    public static string RupeesInWords(long paise)
    {
        var rupees = paise / 100;
        var p = (int)(paise % 100);
        var parts = new List<string>();
        foreach (var (div, name) in new (long, string)[] { (10_000_000, "crore"), (100_000, "lakh"), (1000, "thousand") })
        {
            var q = Math.DivRem(rupees, div, out rupees);
            if (q > 0) parts.Add($"{(q < 1000 ? Three(q) : RupeesInWords(q * 100).Replace("Rupees ", "").Replace(" only", ""))} {name}");
        }
        if (rupees > 0) parts.Add(Three(rupees));
        var words = parts.Count > 0 ? string.Join(' ', parts) : "zero";
        var outp = $"Rupees {words}";
        if (p > 0) outp += $" and {Two(p)} paise";
        outp = (outp + " only").Replace("  ", " ");
        return char.ToUpper(outp[0]) + outp[1..];
    }

    private async Task<JsonObject> OperatorAsync() => site.PublicBusiness(await site.GetSiteAsync());

    // ------------------------------------------------------------------------- seller tax invoice

    /// <summary>Reference: invoice + services/invoices.py invoice_pdf.</summary>
    public async Task<(byte[] Pdf, string Filename)> InvoicePdfAsync(Guid userId, Guid subId)
    {
        var sub = await orders.GetSubAsync(subId) ?? throw new NotFoundException("Invoice");
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Invoice");
        if (order.UserId != userId) throw new NotFoundException("Invoice");
        if (sub.InvoiceNumber.Length == 0)
            throw new AppException("The invoice is issued when the package ships", "invoice_not_ready");
        var seller = await sellers.GetAsync(sub.SellerId) ?? throw new NotFoundException("Invoice");
        var wh = sub.WarehouseId is null
            ? null
            : await db.QueryFirstOrDefaultAsync<WarehouseModel>("SELECT * FROM warehouses WHERE id = @wid", new { wid = sub.WarehouseId });
        var items = (await db.QueryAsync<OrderItemModel>("SELECT * FROM order_items WHERE sub_order_id = @subId", new { subId })).ToList();
        var op = await OperatorAsync();
        var st = ShipTo(order);
        var originState = wh?.StateCode ?? seller.PickupStateCode;
        var gstin = wh is not null && wh.Gstin.Length > 0 ? wh.Gstin : seller.Gstin;

        var rows = new List<string[]>();
        var i = 0;
        foreach (var it in items)
        {
            i++;
            rows.Add(
            [
                i.ToString(), $"{it.Title}{(it.VariantLabel.Length > 0 ? $" ({it.VariantLabel})" : "")}", it.HsnCode,
                it.Qty.ToString(), MoneyFmt(it.UnitPrice), MoneyFmt(it.SellerDiscount), MoneyFmt(it.TaxableValue), GstPct(it.GstBps),
                MoneyFmt(it.Cgst), MoneyFmt(it.Sgst), MoneyFmt(it.Igst), MoneyFmt(it.LineTotal - it.SellerDiscount),
            ]);
        }
        var extra = sub.ShippingFee + sub.CodFee;
        if (extra > 0)
        {
            var sp = Money.SplitInclusiveGst(extra, sub.ShippingGstBps, sub.IsInterstate);
            rows.Add(
            [
                (i + 1).ToString(), "Delivery charges" + (sub.CodFee > 0 ? " and COD fee" : ""), "996812", "1", MoneyFmt(extra), "0.00",
                MoneyFmt(sp.Taxable), GstPct(sub.ShippingGstBps), MoneyFmt(sp.Cgst), MoneyFmt(sp.Sgst), MoneyFmt(sp.Igst), MoneyFmt(extra),
            ]);
        }

        var header = new (string, string)[]
        {
            ("Invoice number", sub.InvoiceNumber),
            ("Invoice date", IstDate(sub.InvoiceDate ?? sub.CreatedAt)),
            ("Order", $"{order.Number} / {sub.Number}"),
            ("Place of supply", $"{IndianStates.Name(St(st, "state_code"))} ({St(st, "state_code")})"),
            ("Reverse charge", "No"),
        };
        var opGstin = op["gstin"]?.GetValue<string>() ?? "";
        var opLegal = op["legal_name"]?.GetValue<string>() ?? "";
        var soldBy = new InvoicePdf.PartyCell("Sold by",
        [
            seller.LegalName,
            wh?.Line1 ?? seller.PickupLine1,
            $"{wh?.City ?? seller.PickupCity}, {IndianStates.Name(originState)} {wh?.Pincode ?? seller.PickupPincode}".Trim(),
            $"GSTIN: {gstin}",
        ]);
        var buyerLines = order.BuyerGstin.Length > 0
            ? new List<string> { order.BuyerBusiness, $"GSTIN: {order.BuyerGstin}", "Ship to" }
            : new List<string>();
        buyerLines.AddRange(
        [
            St(st, "full_name"), St(st, "line1"), St(st, "line2"),
            $"{St(st, "city")}, {St(st, "state")} {St(st, "pincode")}".Trim(),
            $"Phone: {St(st, "phone")}",
        ]);
        var billTo = new InvoicePdf.PartyCell(order.BuyerGstin.Length > 0 ? "Bill to" : "Bill to / Ship to", buyerLines.ToArray());

        var totals = new (string, string)[]
        {
            ("Total (inclusive of GST)", MoneyFmt(sub.Total)),
            ("Amount in words", ""),
            (RupeesInWords(sub.Total), ""),
        };
        var note = $"This is a computer-generated invoice issued by the seller, {seller.LegalName}, and does not need a signature. " +
                   $"Sold through {opLegal}{(opGstin.Length > 0 ? ", GSTIN " + opGstin : "")} " +
                   "(e-commerce operator; TCS collected under section 52 of the CGST Act).";
        return (InvoicePdf.Build("Tax invoice", header, [soldBy, billTo], rows, totals, note), $"invoice-{sub.Number}.pdf");
    }

    // ------------------------------------------------------------------------- marketplace fee invoice

    /// <summary>Reference: fee_invoice + services/fee_invoices.py pdf.</summary>
    public async Task<(byte[] Pdf, string Filename)> FeeInvoicePdfAsync(Guid userId, Guid orderId)
    {
        var order = await orders.GetOrderAsync(orderId) ?? throw new NotFoundException("Invoice");
        if (order.UserId != userId || order.FeesTotal == 0) throw new NotFoundException("Invoice");
        if (order.FeeInvoiceNumber.Length == 0)
            throw new AppException("The invoice for the marketplace fees is issued when your first package is delivered", "invoice_not_ready");
        var op = await OperatorAsync();
        var ck = await fees.GetAsync();
        var st = ShipTo(order);
        var opGstin = op["gstin"]?.GetValue<string>() ?? "";
        var buyerState = order.BuyerGstin.Length >= 2 ? order.BuyerGstin[..2] : St(st, "state_code");
        var intra = opGstin.Length > 0 && opGstin[..2] == buyerState;
        var feeRows = JsonNode.Parse(order.Fees) as JsonArray ?? [];

        var rows = new List<string[]>();
        var i = 0;
        foreach (var f in feeRows.OfType<JsonObject>())
        {
            i++;
            var amount = f["amount"]?.GetValue<long>() ?? 0;
            var gst = f["gst"]?.GetValue<long>() ?? 0;
            var taxable = f["taxable"]?.GetValue<long>() ?? amount;
            var cgst = intra ? gst / 2 : 0;
            rows.Add(
            [
                i.ToString(), f["label"]?.GetValue<string>() ?? "", ck["fees_sac_code"]?.GetValue<string>() ?? "", "1",
                MoneyFmt(amount), "0.00", MoneyFmt(taxable), GstPct((int)(f["gst_bps"]?.GetValue<long>() ?? 0)),
                MoneyFmt(cgst), MoneyFmt(intra ? gst - cgst : 0), MoneyFmt(intra ? 0 : gst), MoneyFmt(amount),
            ]);
        }

        var header = new (string, string)[]
        {
            ("Invoice number", order.FeeInvoiceNumber),
            ("Invoice date", IstDate(order.FeeInvoiceDate ?? order.CreatedAt)),
            ("Order", order.Number),
            ("Place of supply", $"{IndianStates.Name(buyerState)} ({buyerState})"),
            ("Reverse charge", "No"),
        };
        var issuer = new InvoicePdf.PartyCell("Issued by",
        [
            op["legal_name"]?.GetValue<string>() ?? "", op["registered_address"]?.GetValue<string>() ?? "", $"GSTIN: {opGstin}",
        ]);
        var buyerLines = order.BuyerGstin.Length > 0 ? new List<string> { order.BuyerBusiness, $"GSTIN: {order.BuyerGstin}" } : new List<string>();
        buyerLines.AddRange(
        [
            St(st, "full_name"), St(st, "line1"), St(st, "line2"),
            $"{St(st, "city")}, {St(st, "state")} {St(st, "pincode")}".Trim(),
        ]);
        var buyer = new InvoicePdf.PartyCell("Bill to", buyerLines.ToArray());

        var totals = new (string, string)[]
        {
            ("Total (inclusive of GST)", MoneyFmt(order.FeesTotal)),
            ("Amount in words", ""),
            (RupeesInWords(order.FeesTotal), ""),
        };
        var note = $"Tax invoice for {op["legal_name"]?.GetValue<string>() ?? ""}'s own service fees on order {order.Number}. " +
                   "The goods, delivery and cash on delivery are invoiced separately by each seller. " +
                   "This is a computer-generated invoice and does not need a signature.";
        return (InvoicePdf.Build("Tax invoice: marketplace fees", header, [issuer, buyer], rows, totals, note),
            $"fee-invoice-{order.Number}.pdf");
    }

    // ------------------------------------------------------------------------- credit note

    /// <summary>Reference: credit_note + services/invoices.py credit_note_pdf.</summary>
    public async Task<(byte[] Pdf, string Filename)> CreditNotePdfAsync(Guid userId, Guid returnId)
    {
        var ret = await returns.ReturnAsync(returnId) ?? throw new NotFoundException("Credit note");
        if (ret.UserId != userId || ret.CreditNoteNumber.Length == 0) throw new NotFoundException("Credit note");
        var sub = await orders.GetSubAsync(ret.SubOrderId) ?? throw new NotFoundException("Credit note");
        var order = await orders.GetOrderAsync(sub.OrderId) ?? throw new NotFoundException("Credit note");
        var seller = await sellers.GetAsync(sub.SellerId) ?? throw new NotFoundException("Credit note");
        var items = (await db.QueryAsync<CreditNoteRow>(
                "SELECT ri.qty AS ReturnQty, oi.* FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.return_id = @returnId",
                new { returnId }))
            .ToList();

        var rows = new List<string[]>();
        long total = 0;
        var i = 0;
        foreach (var r in items)
        {
            i++;
            var value = (r.LineTotal - r.SellerDiscount) * r.ReturnQty / r.Qty; // reference: integer division
            var sp = Money.SplitInclusiveGst(value, r.GstBps, sub.IsInterstate);
            rows.Add(
            [
                i.ToString(), r.Title, r.HsnCode, r.ReturnQty.ToString(), MoneyFmt(r.UnitPrice), "", MoneyFmt(sp.Taxable), GstPct(r.GstBps),
                MoneyFmt(sp.Cgst), MoneyFmt(sp.Sgst), MoneyFmt(sp.Igst), MoneyFmt(value),
            ]);
            total += value;
        }

        var st = ShipTo(order);
        var header = new (string, string)[]
        {
            ("Credit note number", ret.CreditNoteNumber),
            ("Date", IstDate(ret.RefundedAt ?? ret.UpdatedAt)),
            ("Against invoice", sub.InvoiceNumber.Length > 0 ? sub.InvoiceNumber : sub.Number),
            ("Return", ret.Number),
        };
        var sellerCell = new InvoicePdf.PartyCell("Seller", [seller.LegalName, $"GSTIN: {seller.Gstin}"]);
        var customer = new InvoicePdf.PartyCell("Customer",
            [St(st, "full_name"), $"{St(st, "city")}, {St(st, "state")}".Trim().TrimEnd(',')]);
        var totals = new (string, string)[] { ("Total credit", MoneyFmt(total)), (RupeesInWords(total), "") };
        return (InvoicePdf.Build("Credit note", header, [sellerCell, customer], rows, totals, "Issued for goods returned by the customer."),
            $"credit-note-{ret.Number}.pdf");
    }

    /// <summary>A return item joined to its order item (reference: credit_note_pdf's ReturnItem/OrderItem join).</summary>
    public sealed class CreditNoteRow : OrderItemModel
    {
        public int ReturnQty { get; set; }
    }
}
