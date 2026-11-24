using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.Constants;
using Model.DomainModel;
using MySqlConnector;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// Order placement and the shopper's order view (reference: services/orders.py place_order + order_detail and the
/// checkout parts of routers/orders.py). One order splits into one package ("sub-order") per (seller, warehouse);
/// every package gets its GST split, commission and settlement, and stock moves while the order commits, so a failed
/// payment gateway call leaves no trace.
/// </summary>
public class OrdersBAL(
    OrdersDAL orders,
    CartDAL cartDal,
    AddressDAL addresses,
    CatalogDAL catalog,
    ICartBAL cart,
    IPlatformSettingsBAL platform,
    IFeesBAL fees,
    ICouponsBAL coupons,
    IDealsBAL deals,
    IInventoryBAL inventory,
    IRegionalBAL regional,
    IRazorpayBAL razorpay,
    IIntegrationBAL integrations,
    ICatalogNotifyBAL notify,
    IRateLimitBAL rateLimit,
    ISiteBAL site,
    IRefundQueue refundQueue,
    AuditDAL audit,
    SettingsDAL settings,
    Utils.AppSettings app,
    IMySqlDapperHelper db) : IOrdersBAL
{
    private static readonly char[] NumberAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray(); // no O, I

    /// <summary>The package steps a customer can still cancel at, ever (reference: CUSTOMER_CANCELLABLE).</summary>
    public static readonly string[] CustomerCancellable = ["placed", "confirmed", "packed"];

    private static readonly TimeZoneInfo Ist = TimeZoneInfo.FindSystemTimeZoneById("Asia/Kolkata");

    /// <summary>PC + yymmdd + 6 letters/digits (reference: _order_number).</summary>
    public static string OrderNumber(DateTime now) =>
        $"PC{now:yyMMdd}" + new string(Enumerable.Range(0, 6).Select(_ => NumberAlphabet[RandomNumberGenerator.GetInt32(NumberAlphabet.Length)]).ToArray());

    /// <summary>The package steps a customer can still cancel at, up to the owner's choice (Admin → Marketplace
    /// settings) (reference: customer_cancellable).</summary>
    public static string[] CustomerCancellableAt(JsonObject cfg)
    {
        var until = cfg.Str("customer_cancel_until");
        var at = Array.IndexOf(CustomerCancellable, until);
        return at < 0 ? CustomerCancellable : CustomerCancellable[..(at + 1)];
    }

    /// <summary>What cancelling this package gives back to a customer who paid online (reference: refund_on_cancel).</summary>
    public static long RefundOnCancel(SubOrderModel sub, OrderModel order, long othersLive, bool feesBack)
    {
        var amount = sub.Total - sub.PlatformDiscount;
        if (othersLive == 0) amount += order.TipPaise + (feesBack ? order.FeesTotal : 0);
        return amount;
    }

    // ------------------------------------------------------------------ placement

    public async Task<(OrderModel Order, PaymentModel? Payment)> PlaceOrderAsync(
        UserModel user, Guid addressId, string paymentMethod, string idempotencyKey, long? expectedTotal,
        string? couponCode = null, int tipPaise = 0, string buyerGstin = "", string buyerBusiness = "",
        string? instructions = null, bool noBag = false, string? currency = null)
    {
        var existing = await orders.FindByIdempotencyAsync(user.Id, idempotencyKey);
        if (existing is not null)
            return (existing, await orders.LatestPaymentAsync(existing.Id));

        var cfg = await platform.GetAsync();
        var ck = await fees.GetAsync();
        var address = await addresses.GetAsync(addressId);
        if (address is null || address.UserId != user.Id || address.IsDeleted)
            throw new AppException("Choose a delivery address", "invalid_address");

        // A deal that just started or ended changes the price paid (its own unit of work, as the reference's session).
        await deals.SyncAsync(force: true);

        await using var uow = await db.BeginAsync();
        var lines = await cart.LoadCartAsync(user.Id, uow, forUpdate: true);
        if (lines.Count == 0) throw new AppException("Your cart is empty", "cart_empty");
        var bad = lines.FirstOrDefault(l => l.Problem.Length > 0);
        if (bad is not null)
            throw new ConflictException($"'{bad.Product.Title}': {bad.Problem}. Update your cart and try again.", "cart_changed");
        var maxQty = cfg.Int("max_qty_per_item");
        if (lines.Any(l => l.Item.Qty > maxQty))
            throw new AppException($"You can buy at most {maxQty} of an item per order", "qty_limit");

        CouponsBAL.Result? coupon = null;
        if (!string.IsNullOrWhiteSpace(couponCode))
        {
            if (!cfg.Bool("feature_coupons")) throw new AppException("Coupons are not available right now", "coupons_off");
            coupon = await coupons.EvaluateAsync(couponCode, user.Id, lines);
            var locked = await orders.CouponForUpdateAsync(coupon.Coupon.Id, uow);
            if (locked is not null && locked.UsageLimit is not null && locked.UsedCount >= locked.UsageLimit)
                throw new AppException("This coupon has been fully used", "coupon_exhausted");
        }

        var groups = CartBAL.GroupBySeller(lines, cfg);
        var now = DateTime.UtcNow;
        var isOnline = paymentMethod == "online";
        var categories = new Dictionary<Guid, CategoryModel>();
        foreach (var catId in lines.Select(l => l.Product.CategoryId).Distinct())
            if (await catalog.GetCategoryAsync(catId) is { } cat) categories[catId] = cat;

        // Plan packages: one per (seller, warehouse) the stock is allocated from. A line no single warehouse can
        // fill is split across warehouses; each part ships in that warehouse's package.
        var plans = new List<(SellerModel Seller, WarehouseModel Warehouse, List<(CartBAL.CartLine Line, int Qty)> Pieces, long Shipping)>();
        foreach (var g in groups)
        {
            Dictionary<Guid, List<(WarehouseModel Warehouse, int Qty)>> alloc;
            try
            {
                alloc = await inventory.AllocateAsync(g.Seller, g.Lines.Select(l => (l.Variant, l.Item.Qty)).ToList(), address.StateCode, uow);
            }
            catch (InventoryBAL.InsufficientStockException exc)
            {
                var shortLine = g.Lines.First(l => l.Variant.Id == exc.VariantId);
                var left = exc.Available > 0 ? $"only {exc.Available} left in stock" : "it just sold out";
                throw new ConflictException($"'{shortLine.Product.Title}': {left}. Update your cart and try again.", "cart_changed");
            }
            var byWh = new Dictionary<Guid, (WarehouseModel Warehouse, List<(CartBAL.CartLine Line, int Qty)> Pieces)>();
            foreach (var ln in g.Lines)
                foreach (var (wh, qty) in alloc[ln.Variant.Id])
                {
                    if (!byWh.TryGetValue(wh.Id, out var entry)) byWh[wh.Id] = entry = (wh, []);
                    entry.Pieces.Add((ln, qty));
                }
            var n = 0;
            foreach (var entry in byWh.Values)
                plans.Add((g.Seller, entry.Warehouse, entry.Pieces, n++ == 0 ? g.ShippingFee : 0));
        }

        // A line's coupon discount is shared by its parts in proportion to their quantity (the last part takes the rest).
        var pieceDisc = new Dictionary<(Guid VariantId, Guid WarehouseId), long>();
        foreach (var ln in lines)
        {
            var whole = coupon is not null ? coupon.PerLine.GetValueOrDefault(ln.Variant.Id) : 0;
            var parts = plans.SelectMany(p => p.Pieces.Where(pc => ReferenceEquals(pc.Line, ln)).Select(pc => (p.Warehouse.Id, pc.Qty))).ToList();
            long given = 0;
            for (var i = 0; i < parts.Count; i++)
            {
                var share = i == parts.Count - 1 ? whole - given : whole * parts[i].Qty / ln.Item.Qty;
                pieceDisc[(ln.Variant.Id, parts[i].Id)] = share;
                given += share;
            }
        }

        var itemsTotal = lines.Sum(l => l.LineTotal);
        var shippingTotal = plans.Sum(p => p.Shipping);
        var codFee = paymentMethod == "cod" ? (long)cfg.Int("cod_fee_paise") : 0;
        var discountTotal = coupon?.Discount ?? 0;
        var feeLines = BAL.FeesBAL.OrderFees(ck, itemsTotal);
        var feesTotal = feeLines.OfType<JsonObject>().Sum(f => f["amount"]!.GetValue<long>());
        long tip;
        try { tip = BAL.FeesBAL.TipAmount(ck, tipPaise); }
        catch (AppException exc) { throw new AppException(exc.Message, "invalid_tip"); }
        var gstin = "";
        var business = "";
        if (buyerGstin.Trim().Length > 0)
        {
            if (!ck.Bool("gstin_enabled")) throw new AppException("Business invoices are not available right now", "gstin_off");
            try
            {
                gstin = IndianStates.ValidateGstin(buyerGstin);
                business = BAL.FeesBAL.CheckBusiness(buyerBusiness);
            }
            catch (AppException exc)
            {
                throw new AppException(exc.Message, "invalid_gstin", 400, new Dictionary<string, string> { ["buyer_gstin"] = "Invalid" });
            }
        }
        var rawNote = string.Join(' ', (instructions ?? address.Instructions ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var note = ck.Bool("instructions_enabled") ? (rawNote.Length > 300 ? rawNote[..300] : rawNote) : "";
        var grandTotal = itemsTotal + shippingTotal + codFee + feesTotal + tip - discountTotal;

        if (paymentMethod == "cod")
        {
            if (!cfg.Bool("cod_enabled")) throw new AppException("Cash on delivery is not available", "cod_unavailable");
            if (grandTotal > cfg.Int("cod_max_order_paise"))
                throw new AppException("Cash on delivery is not available for this order value. Please pay online.", "cod_limit");
        }
        else if (!await razorpay.OnlinePaymentsAsync())
        {
            throw new AppException("Online payment is not available right now. Please choose cash on delivery.", "online_unavailable");
        }
        if (expectedTotal is not null && expectedTotal != grandTotal)
            throw new ConflictException("Prices in your cart changed. Please review the new total.", "total_changed");

        var shipTo = new JsonObject
        {
            ["full_name"] = address.FullName, ["phone"] = address.Phone, ["line1"] = address.Line1, ["line2"] = address.Line2,
            ["landmark"] = address.Landmark, ["city"] = address.City, ["state_code"] = address.StateCode,
            ["state"] = IndianStates.Name(address.StateCode), ["pincode"] = address.Pincode, ["label"] = address.Label, ["kind"] = address.Kind,
            ["lat"] = address.Lat is { } la ? (double)la : null, ["lng"] = address.Lng is { } ln2 ? (double)ln2 : null,
            ["instructions"] = note, ["no_bag"] = noBag && ck.Bool("no_bag_enabled"),
        };

        var order = new OrderModel
        {
            Id = Guid.NewGuid(),
            Number = OrderNumber(now),
            UserId = user.Id,
            Status = isOnline ? "pending_payment" : "placed",
            PaymentMethod = paymentMethod,
            PaymentStatus = isOnline ? "pending" : "cod",
            ShipTo = shipTo.ToJsonString(),
            ItemsTotal = itemsTotal,
            ShippingTotal = shippingTotal,
            CodFee = codFee,
            DiscountTotal = discountTotal,
            CouponCode = coupon?.Coupon.Code ?? "",
            Fees = feeLines.ToJsonString(),
            FeesTotal = feesTotal,
            TipPaise = tip,
            BuyerGstin = gstin,
            BuyerBusiness = business,
            GrandTotal = grandTotal,
            Currency = "",
            FxRate = 0,
            RefundedTotal = 0,
            IdempotencyKey = idempotencyKey,
            PaymentExpiresAt = isOnline ? now.AddMinutes(cfg.Int("payment_window_minutes")) : null,
            PlacedAt = isOnline ? null : now,
            CreatedAt = now,
            UpdatedAt = now,
        };

        // The shopper's currency (Admin → Languages and currencies): kept on the order with today's rate.
        var reg = await regional.GetRegionalAsync();
        var shown = (currency ?? RegionalBAL.Base).ToUpperInvariant();
        var shownRate = regional.CurrencyRate(reg, shown);
        if (shownRate is not null)
        {
            order.Currency = shown;
            order.FxRate = shownRate.Value;
        }
        var (chargeCurrency, _, charge) = isOnline ? regional.ChargePlan(reg, currency, grandTotal) : (RegionalBAL.Base, 1m, (int?)null);

        await orders.InsertOrderAsync(order, uow);

        var sellerFunded = coupon is not null && coupon.Coupon.FundedBy == "seller";
        var subStatus = isOnline ? "pending_payment" : "placed";
        var counted = new HashSet<Guid>(); // a split line counts as one order of the product in the stats
        var subs = new List<SubOrderModel>();
        var idx = 0;
        foreach (var plan in plans)
        {
            idx++;
            var (seller, wh, pieces, shipping) = plan;
            var interstate = wh.StateCode != address.StateCode;
            var subCod = idx == 1 ? codFee : 0;
            var subItems = pieces.Sum(pc => pc.Line.LineTotal * pc.Qty / pc.Line.Item.Qty);
            var lineDisc = pieces.ToDictionary(pc => pc.Line.Variant.Id, pc => pieceDisc[(pc.Line.Variant.Id, wh.Id)]);
            var subSellerDisc = sellerFunded ? lineDisc.Values.Sum() : 0;
            var subPlatformDisc = sellerFunded ? 0 : lineDisc.Values.Sum();
            var estimate = DeliveryEstimate.Estimate(cfg, seller.DispatchDays, wh.Pincode, wh.StateCode, address.Pincode, cutoff: seller.DispatchCutoff);
            var maxDate = estimate["max_date"]!.GetValue<string>();
            var sub = new SubOrderModel
            {
                Id = Guid.NewGuid(),
                OrderId = order.Id,
                SellerId = seller.Id,
                Number = $"{order.Number}-{idx}",
                Status = subStatus,
                ItemsTotal = subItems,
                ShippingFee = shipping,
                CodFee = subCod,
                SellerDiscount = subSellerDisc,
                PlatformDiscount = subPlatformDisc,
                Total = subItems + shipping + subCod - subSellerDisc,
                TaxableTotal = 0,
                IsInterstate = interstate,
                SettlementStatus = "not_due",
                WarehouseId = wh.Id,
                ExpectedDeliveryAt = DateTime.SpecifyKind(DateTime.Parse(maxDate), DateTimeKind.Utc),
                CreatedAt = now,
                UpdatedAt = now,
            };
            await orders.InsertSubOrderAsync(sub, uow);
            subs.Add(sub);

            long taxable = 0, commission = 0;
            var maxRate = 0;
            foreach (var (ln, qty) in pieces)
            {
                var (v, p) = (ln.Variant, ln.Product);
                await inventory.ChangeAsync(v, wh.Id, -qty, "sale", reference: sub.Number, uow: uow);
                await orders.AddSoldCountAsync(p.Id, qty, uow);
                var itemSellerDisc = sellerFunded ? lineDisc[v.Id] : 0;
                var itemPlatformDisc = sellerFunded ? 0 : lineDisc[v.Id];
                var value = ln.LineTotal * qty / ln.Item.Qty - itemSellerDisc;
                var split = Money.SplitInclusiveGst(value, p.GstBps, interstate);
                categories.TryGetValue(p.CategoryId, out var cat);
                var bps = seller.CommissionBpsOverride ?? cat?.CommissionBps ?? 0;
                var lineCommission = Money.ApplyBps(value, bps);
                commission += lineCommission;
                taxable += split.Taxable;
                maxRate = Math.Max(maxRate, p.GstBps);
                await orders.InsertOrderItemAsync(new OrderItemModel
                {
                    Id = Guid.NewGuid(),
                    SubOrderId = sub.Id,
                    ProductId = p.Id,
                    VariantId = v.Id,
                    Title = p.Title,
                    VariantLabel = ProductInfo.VariantLabel(v.Options),
                    ImageUrl = ln.Image,
                    Sku = v.Sku,
                    HsnCode = p.HsnCode,
                    Qty = qty,
                    UnitPrice = v.PricePaise,
                    UnitMrp = v.MrpPaise,
                    LineTotal = ln.LineTotal * qty / ln.Item.Qty,
                    GstBps = p.GstBps,
                    TaxableValue = split.Taxable,
                    Cgst = split.Cgst,
                    Sgst = split.Sgst,
                    Igst = split.Igst,
                    CommissionBps = bps,
                    CommissionPaise = lineCommission,
                    SellerDiscount = itemSellerDisc,
                    PlatformDiscount = itemPlatformDisc,
                    ReturnWindowDays = p.ReturnWindowDays,
                }, uow);
                var day = TimeZoneInfo.ConvertTimeFromUtc(now, Ist).Date;
                await orders.BumpDailyStatsAsync(p.Id, day, counted.Contains(v.Id) ? 0 : 1, qty, value, uow);
                counted.Add(v.Id);
                // After the item is recorded at the deal price: may end a lightning deal whose units are now gone.
                await deals.RecordSaleAsync(v.Id, qty, uow);
            }
            var extra = sub.ShippingFee + sub.CodFee;
            if (extra > 0) taxable += Money.SplitInclusiveGst(extra, maxRate, interstate).Taxable;
            sub.ShippingGstBps = maxRate;
            sub.TaxableTotal = taxable;
            var st = Money.ComputeSettlement(gross: sub.Total, taxable: taxable, commission: commission,
                commissionGstBps: cfg.Int("commission_gst_bps"), tcsBps: cfg.Int("tcs_bps"), tdsBps: cfg.Int("tds_bps"));
            sub.CommissionPaise = st.Commission;
            sub.CommissionGstPaise = st.CommissionGst;
            sub.TcsPaise = st.Tcs;
            sub.TdsPaise = st.Tds;
            sub.SellerPayoutPaise = st.Payout;
            await UpdateSubSettlementAsync(sub, uow);
            await AddEventAsync(order.Id, sub.Id, "", subStatus, "customer", uow: uow);
        }
        foreach (var productId in lines.Select(l => l.Product.Id).Distinct())
            await catalog.RefreshAggregatesAsync(productId, uow);
        await orders.ClearCartAsync(user.Id, uow);

        if (coupon is not null)
        {
            await orders.IncrementCouponUsageAsync(coupon.Coupon.Id, uow);
            await orders.InsertRedemptionAsync(new CouponRedemptionModel
            {
                Id = Guid.NewGuid(), CouponId = coupon.Coupon.Id, UserId = user.Id, OrderId = order.Id,
                DiscountPaise = coupon.Discount, CreatedAt = now,
            }, uow);
        }

        PaymentModel? payment = null;
        if (isOnline)
        {
            // Created inside the transaction: if the gateway call fails, nothing above is committed.
            JsonObject rp;
            try
            {
                rp = await razorpay.CreateOrderAsync(charge ?? grandTotal, order.Number,
                    new Dictionary<string, string> { ["order_number"] = order.Number }, chargeCurrency);
            }
            catch (RazorpayBAL.GatewayException exc)
            {
                if (chargeCurrency != RegionalBAL.Base)
                    throw new AppException(
                        $"Paying in {chargeCurrency} is not available right now ({exc.Message}). Switch the currency to ₹ (INR) and try again.",
                        "currency_unavailable", 502);
                throw new AppException($"Could not start the payment: {exc.Message}", "gateway_error", 502);
            }
            payment = new PaymentModel
            {
                Id = Guid.NewGuid(),
                OrderId = order.Id,
                Provider = "razorpay",
                ProviderOrderId = rp["id"]?.GetValue<string>() ?? "",
                AmountPaise = grandTotal,
                Currency = chargeCurrency,
                ChargeAmount = charge,
                Status = "created",
                CreatedAt = now,
                UpdatedAt = now,
            };
            await orders.InsertPaymentAsync(payment, uow);
        }

        try
        {
            await uow.CommitAsync();
        }
        catch (MySqlException exc) when (exc.Number == 1062)
        {
            // The same idempotency key submitted twice at the same moment: return the winner.
            var winner = await orders.FindByIdempotencyAsync(user.Id, idempotencyKey)
                ?? throw new InvalidOperationException("idempotency winner missing after duplicate key");
            return (winner, await orders.LatestPaymentAsync(winner.Id));
        }

        if (!isOnline) await AnnouncePlacedAsync(order, user, subs);
        return (order, payment);
    }

    /// <summary>Reference: _announce_placed. In-app notifications now; the notifications module adds the other
    /// channels through the same templates.</summary>
    private async Task AnnouncePlacedAsync(OrderModel order, UserModel user, IReadOnlyList<SubOrderModel> subs)
    {
        await notify.NotifyUserAsync(user.Id, "order_placed",
            new Dictionary<string, string> { ["order_number"] = order.Number, ["amount"] = Money.Rupees(order.GrandTotal) },
            $"/orders/{order.Id}");
        foreach (var sub in subs)
        {
            var seller = await catalog.GetSellerAsync(sub.SellerId);
            var items = await orders.ItemsAsync([sub.Id]);
            var titles = string.Join(", ", items.Select(i => i.Title));
            await notify.NotifySellerAsync(sub.SellerId, "seller_new_order",
                new Dictionary<string, string>
                {
                    ["order_number"] = sub.Number,
                    ["items"] = titles.Length > 150 ? titles[..150] : titles,
                    ["amount"] = Money.Rupees(sub.Total),
                    ["dispatch_days"] = (seller?.DispatchDays ?? 2).ToString(),
                },
                $"/seller/orders/{sub.Id}");
        }
    }

    private Task<int> UpdateSubSettlementAsync(SubOrderModel s, IUnitOfWork uow) =>
        uow.ExecuteAsync(
            """
            UPDATE sub_orders SET taxable_total = @TaxableTotal, shipping_gst_bps = @ShippingGstBps,
                commission_paise = @CommissionPaise, commission_gst_paise = @CommissionGstPaise, tcs_paise = @TcsPaise,
                tds_paise = @TdsPaise, seller_payout_paise = @SellerPayoutPaise, updated_at = UTC_TIMESTAMP()
            WHERE id = @Id
            """, s);

    /// <summary>Reference: add_event.</summary>
    public Task<int> AddEventAsync(Guid orderId, Guid? subOrderId, string from, string to, string actor, string note = "", IUnitOfWork? uow = null)
    {
        var e = new OrderEventModel
        {
            Id = Guid.NewGuid(), OrderId = orderId, SubOrderId = subOrderId, FromStatus = from, ToStatus = to,
            Actor = actor, Note = note.Length > 1000 ? note[..1000] : note, CreatedAt = DateTime.UtcNow,
        };
        return uow is not null ? orders.InsertEventAsync(e, uow) : db.ExecuteAsync(
            """
            INSERT INTO order_events (id, order_id, sub_order_id, from_status, to_status, actor, note, created_at)
            VALUES (@Id, @OrderId, @SubOrderId, @FromStatus, @ToStatus, @Actor, @Note, @CreatedAt)
            """, e);
    }

    // ------------------------------------------------------------------ detail

    public async Task<JsonObject> DetailAsync(OrderModel o, bool forAdmin = false)
    {
        var subs = await orders.SubOrdersAsync(o.Id);
        var items = await orders.ItemsAsync(subs.Select(s => s.Id).ToList());
        var sellers = (await orders.SellersAsync(subs.Select(s => s.SellerId).Distinct().ToList())).ToDictionary(s => s.Id);
        var events = await orders.EventsAsync(o.Id);
        var refunds = await orders.RefundsAsync(o.Id);
        var slugs = await orders.ProductSlugsAsync(items.Select(i => i.ProductId).Distinct().ToList());
        var bySub = items.GroupBy(i => i.SubOrderId).ToDictionary(g => g.Key, g => g.ToList());
        var cfg = await platform.GetAsync();

        // What cancelling each package would refund now (the same rule cancel_sub_order applies), for the cancel dialog.
        var prepaid = o.PaymentMethod == "online" && o.PaymentStatus is "paid" or "partially_refunded";
        var feesBack = prepaid && (await fees.GetAsync()).Bool("fees_refund_on_cancel");
        var live = subs.Count(s => s.Status != "cancelled");
        var canCancelAt = CustomerCancellableAt(cfg);

        var captured = o.PaymentMethod == "online" ? await orders.CapturedPaymentAsync(o.Id) : null;
        var outp = new JsonObject
        {
            ["id"] = o.Id.ToString(),
            ["number"] = o.Number,
            ["status"] = o.Status,
            ["payment_method"] = o.PaymentMethod,
            ["payment_status"] = o.PaymentStatus,
            ["currency"] = o.Currency.Length > 0 ? o.Currency : "INR",
            ["fx_rate"] = o.FxRate != 0 ? (double)o.FxRate : 1.0,
            ["paid"] = captured is not null
                ? new JsonObject
                {
                    ["amount"] = captured.AmountPaise, ["method"] = captured.Method,
                    ["reference"] = captured.ProviderPaymentId ?? "", ["currency"] = captured.Currency.Length > 0 ? captured.Currency : "INR",
                    ["charge_amount"] = captured.ChargeAmount, ["at"] = captured.UpdatedAt.ToString("o"),
                }
                : null,
            ["ship_to"] = JsonNode.Parse(o.ShipTo),
            ["items_total"] = o.ItemsTotal,
            ["shipping_total"] = o.ShippingTotal,
            ["cod_fee"] = o.CodFee,
            ["fees"] = JsonNode.Parse(o.Fees),
            ["fees_total"] = o.FeesTotal,
            ["tip"] = o.TipPaise,
            ["buyer_gstin"] = o.BuyerGstin,
            ["buyer_business"] = o.BuyerBusiness,
            ["fee_invoice_number"] = o.FeeInvoiceNumber.Length > 0 ? o.FeeInvoiceNumber : null,
            ["grand_total"] = o.GrandTotal,
            ["refunded_total"] = o.RefundedTotal,
            ["discount_total"] = o.DiscountTotal,
            ["coupon_code"] = o.CouponCode,
            ["created_at"] = o.CreatedAt.ToString("o"),
            ["placed_at"] = o.PlacedAt?.ToString("o"),
            ["payment_expires_at"] = o.PaymentExpiresAt?.ToString("o"),
        };
        var subArr = new JsonArray();
        foreach (var s in subs)
        {
            var sj = new JsonObject
            {
                ["id"] = s.Id.ToString(),
                ["number"] = s.Number,
                ["status"] = s.Status,
                ["invoice_number"] = s.InvoiceNumber.Length > 0 ? s.InvoiceNumber : null,
                ["expected_delivery_at"] = s.ExpectedDeliveryAt?.ToString("o"),
                ["platform_discount"] = s.PlatformDiscount,
                ["seller_discount"] = s.SellerDiscount,
                ["seller"] = sellers.TryGetValue(s.SellerId, out var sl)
                    ? new JsonObject { ["name"] = sl.DisplayName, ["slug"] = sl.Slug }
                    : null,
                ["items_total"] = s.ItemsTotal,
                ["shipping_fee"] = s.ShippingFee,
                ["total"] = s.Total,
                ["courier_name"] = s.CourierName,
                ["tracking_number"] = s.TrackingNumber,
                ["tracking_url"] = s.TrackingUrl,
                ["shipped_at"] = s.ShippedAt?.ToString("o"),
                ["delivered_at"] = s.DeliveredAt?.ToString("o"),
                ["cancelled_at"] = s.CancelledAt?.ToString("o"),
                ["cancel_reason"] = s.CancelReason,
                ["cancelled_by"] = s.CancelledBy,
                ["can_cancel"] = canCancelAt.Contains(s.Status),
                ["refund_if_cancelled"] = prepaid && canCancelAt.Contains(s.Status)
                    ? RefundOnCancel(s, o, live - 1, feesBack)
                    : 0,
            };
            var itemArr = new JsonArray();
            foreach (var i in bySub.GetValueOrDefault(s.Id) ?? [])
                itemArr.Add(new JsonObject
                {
                    ["title"] = i.Title,
                    ["product_slug"] = slugs.GetValueOrDefault(i.ProductId, ""),
                    ["variant_label"] = i.VariantLabel,
                    ["image"] = i.ImageUrl,
                    ["qty"] = i.Qty,
                    ["unit_price"] = i.UnitPrice,
                    ["unit_mrp"] = i.UnitMrp,
                    ["line_total"] = i.LineTotal,
                    ["sku"] = i.Sku,
                    ["hsn_code"] = i.HsnCode,
                    ["gst_bps"] = i.GstBps,
                    ["taxable_value"] = i.TaxableValue,
                    ["cgst"] = i.Cgst,
                    ["sgst"] = i.Sgst,
                    ["igst"] = i.Igst,
                });
            sj["items"] = itemArr;
            if (forAdmin)
            {
                sj["commission"] = s.CommissionPaise;
                sj["commission_gst"] = s.CommissionGstPaise;
                sj["tcs"] = s.TcsPaise;
                sj["tds"] = s.TdsPaise;
                sj["seller_payout"] = s.SellerPayoutPaise;
                sj["settlement_status"] = s.SettlementStatus;
            }
            subArr.Add(sj);
        }
        outp["sub_orders"] = subArr;
        var timeline = new JsonArray();
        foreach (var e in events)
            timeline.Add(new JsonObject
            {
                ["sub_order_id"] = e.SubOrderId?.ToString(), ["from"] = e.FromStatus, ["to"] = e.ToStatus,
                ["actor"] = e.Actor, ["note"] = e.Note, ["at"] = e.CreatedAt.ToString("o"),
            });
        outp["timeline"] = timeline;
        var refundArr = new JsonArray();
        foreach (var r in refunds)
            refundArr.Add(new JsonObject
            {
                ["amount"] = r.AmountPaise, ["status"] = r.Status, ["reason"] = r.Reason, ["created_at"] = r.CreatedAt.ToString("o"),
            });
        outp["refunds"] = refundArr;
        // Packages carried by the own delivery fleet arrive with the delivery module; no fleet package means {}.
        outp["fleet"] = new JsonObject();
        return outp;
    }

    // ------------------------------------------------------------------ checkout payload

    public async Task<JsonObject?> ShopperCheckoutAsync(OrderModel order, PaymentModel? payment, UserModel user)
    {
        if (payment is null || order.Status != "pending_payment") return null;
        var integ = await integrations.GetAsync();
        var brand = await SiteSettingsReader.BrandNameAsync(settings, app);
        var data = new JsonObject
        {
            ["provider"] = "razorpay",
            ["key_id"] = integ.RazorpayKeyId,
            ["checkout_url"] = integ.RazorpayCheckoutUrl,
            ["razorpay_order_id"] = payment.ProviderOrderId,
            ["amount"] = payment.ChargeAmount ?? payment.AmountPaise,
            ["currency"] = payment.Currency.Length > 0 ? payment.Currency : "INR",
            ["name"] = brand,
            ["description"] = $"Order {order.Number}",
            ["prefill"] = new JsonObject
            {
                ["name"] = user.Name,
                ["contact"] = user.Phone.Length > 0 ? $"+91{user.Phone}" : "",
                ["email"] = user.Email ?? "",
            },
            ["expires_at"] = order.PaymentExpiresAt?.ToString("o"),
        };
        var reg = await regional.GetRegionalAsync();
        data["methods"] = reg["pay_methods"]?.DeepClone();
        data["card_networks"] = reg["card_networks"]?.DeepClone();
        if (reg["save_cards"]?.GetValue<bool>() == true && (user.Phone.Length > 0 || (user.Email ?? "").Length > 0))
        {
            if (user.RazorpayCustomerId is null)
            {
                try
                {
                    var cust = await razorpay.CreateCustomerAsync(user.Name, user.Phone.Length > 0 ? $"+91{user.Phone}" : "", user.Email ?? "");
                    var cid = cust["id"]?.GetValue<string>() ?? "";
                    if (cid.Length > 0)
                    {
                        user.RazorpayCustomerId = cid.Length > 40 ? cid[..40] : cid;
                        await orders.SetRazorpayCustomerAsync(user.Id, user.RazorpayCustomerId);
                    }
                }
                catch (RazorpayBAL.GatewayException)
                {
                    // Saved cards are a convenience: the payment window still works without a customer.
                }
            }
            data["customer_id"] = user.RazorpayCustomerId ?? "";
        }
        return data;
    }

    // ------------------------------------------------------------------ payment

    public long RefundCharge(PaymentModel payment, long paise)
    {
        if (payment.ChargeAmount is null || payment.Currency is "" or "INR" || payment.AmountPaise == 0) return paise;
        if (paise >= payment.AmountPaise) return payment.ChargeAmount.Value;
        return Math.Max(1, (paise * payment.ChargeAmount.Value + payment.AmountPaise / 2) / payment.AmountPaise);
    }

    public async Task<string> MarkPaidAsync(PaymentModel payment, string providerPaymentId, string method, long amount, IUnitOfWork uow)
    {
        var order = await orders.OrderForUpdateAsync(payment.OrderId, uow)
            ?? throw new NotFoundException("Order");
        payment = await orders.PaymentForUpdateAsync(payment.Id, uow) ?? payment;
        if (payment.Status == "captured" && payment.ProviderPaymentId == providerPaymentId) return "already";
        if (await orders.RefundExistsForProviderPaymentAsync(providerPaymentId, uow))
            return "already"; // a duplicate payment already being refunded
        if (amount != (payment.ChargeAmount ?? payment.AmountPaise))
            throw new AppException("Payment amount does not match the order", "amount_mismatch");
        var now = DateTime.UtcNow;
        if (payment.Status == "captured")
        {
            // A second successful payment for the same order (two tabs, a retried UPI request): refund it in full.
            await orders.InsertRefundAsync(new RefundModel
            {
                Id = Guid.NewGuid(), OrderId = order.Id, PaymentId = payment.Id, ProviderPaymentId = providerPaymentId,
                AmountPaise = payment.AmountPaise, Status = "pending", Reason = "Duplicate payment",
                CreatedAt = now, UpdatedAt = now,
            }, uow);
            return "refund";
        }
        payment.Status = "captured";
        payment.ProviderPaymentId = providerPaymentId;
        payment.Method = method.Length > 20 ? method[..20] : method;
        await orders.UpdatePaymentAsync(payment, uow);
        if (order.Status == "pending_payment")
        {
            order.Status = "placed";
            order.PaymentStatus = "paid";
            order.PlacedAt = now;
            await orders.UpdateOrderPaymentStateAsync(order, uow);
            foreach (var sub in await orders.SubOrdersForUpdateAsync(order.Id, uow))
            {
                if (sub.Status != "pending_payment") continue;
                await orders.SetSubStatusAsync(sub.Id, "placed", uow);
                await AddEventAsync(order.Id, sub.Id, "pending_payment", "placed", "payment", $"paid via {method}", uow);
            }
            return "paid";
        }
        // Paid after the order was cancelled (payment window expired): refund in full.
        order.PaymentStatus = "refunded";
        order.RefundedTotal += payment.AmountPaise;
        await orders.UpdateOrderPaymentStateAsync(order, uow);
        await orders.InsertRefundAsync(new RefundModel
        {
            Id = Guid.NewGuid(), OrderId = order.Id, PaymentId = payment.Id, ProviderPaymentId = providerPaymentId,
            AmountPaise = payment.AmountPaise, Status = "pending", Reason = "Payment received after order was cancelled",
            CreatedAt = now, UpdatedAt = now,
        }, uow);
        return "refund";
    }

    /// <summary>Asks Razorpay for the payment's real state (never trust the browser) and records it (reference:
    /// confirm_with_gateway).</summary>
    public async Task<string> ConfirmWithGatewayAsync(PaymentModel payment, string providerPaymentId, IUnitOfWork uow)
    {
        var data = await razorpay.FetchPaymentAsync(providerPaymentId);
        if (data["order_id"]?.GetValue<string>() != payment.ProviderOrderId)
            throw new AppException("Payment does not belong to this order", "payment_mismatch");
        var status = data["status"]?.GetValue<string>();
        if (status == "authorized")
        {
            data = await razorpay.CapturePaymentAsync(providerPaymentId, payment.ChargeAmount ?? payment.AmountPaise,
                payment.Currency.Length > 0 ? payment.Currency : "INR");
            status = data["status"]?.GetValue<string>();
        }
        if (status != "captured")
        {
            if (status == "failed") payment.Status = "failed";
            var errText = data["error_description"]?.GetValue<string>() ?? status ?? "";
            payment.Error = errText.Length > 500 ? errText[..500] : errText;
            await orders.UpdatePaymentAsync(payment, uow);
            return "not_captured";
        }
        return await MarkPaidAsync(payment, providerPaymentId, data["method"]?.GetValue<string>() ?? "",
            data["amount"]?.GetValue<long>() ?? 0, uow);
    }

    /// <summary>Asks Razorpay whether this order was paid, from Razorpay's own records (reference:
    /// check_with_gateway).</summary>
    public async Task<JsonObject> CheckWithGatewayAsync(PaymentModel payment, IUnitOfWork uow)
    {
        if (payment.Status == "captured")
            return new JsonObject
            {
                ["result"] = "already_paid", ["attempts"] = new JsonArray(),
                ["payment"] = new JsonObject { ["id"] = payment.ProviderPaymentId, ["method"] = payment.Method, ["status"] = "captured" },
                ["waiting"] = false, ["reason"] = "",
            };
        var attempts = (await razorpay.OrderPaymentsAsync(payment.ProviderOrderId))
            .OrderByDescending(a => a["created_at"]?.GetValue<long>() ?? 0).ToList();
        var seen = new JsonArray(attempts.Select(a => (JsonNode?)new JsonObject
        {
            ["id"] = a["id"]?.GetValue<string>(), ["status"] = a["status"]?.GetValue<string>(),
            ["method"] = a["method"]?.GetValue<string>() ?? "", ["error"] = a["error_description"]?.GetValue<string>() ?? "",
        }).ToArray());
        var done = attempts.FirstOrDefault(a => a["status"]?.GetValue<string>() is "captured" or "authorized");
        if (done is null)
        {
            var failed = attempts.FirstOrDefault(a => a["status"]?.GetValue<string>() == "failed");
            var reason = failed is not null
                ? (failed["error_description"]?.GetValue<string>() is { } f && f.Length > 0 ? f : "The payment did not go through")
                : "";
            if (failed is not null && payment.Status != "captured")
            {
                payment.Error = reason.Length > 500 ? reason[..500] : reason;
                await orders.UpdatePaymentAsync(payment, uow);
            }
            return new JsonObject
            {
                ["result"] = "not_paid", ["attempts"] = seen,
                ["waiting"] = attempts.Any(a => a["status"]?.GetValue<string>() == "created"), ["reason"] = reason,
            };
        }
        var result = await ConfirmWithGatewayAsync(payment, done["id"]!.GetValue<string>(), uow);
        return new JsonObject
        {
            ["result"] = result, ["attempts"] = seen,
            ["payment"] = new JsonObject { ["id"] = done["id"]?.GetValue<string>(), ["method"] = done["method"]?.GetValue<string>() ?? "", ["status"] = "captured" },
            ["waiting"] = false, ["reason"] = "",
        };
    }

    public async Task<(string Result, OrderModel Order)> VerifyPaymentAsync(
        UserModel user, string razorpayOrderId, string razorpayPaymentId, string razorpaySignature)
    {
        await using var uow = await db.BeginAsync();
        var payment = await orders.PaymentByProviderOrderForUpdateAsync(razorpayOrderId, uow)
            ?? throw new NotFoundException("Payment");
        var order = await orders.GetOrderAsync(payment.OrderId, uow) ?? throw new NotFoundException("Order");
        if (order.UserId != user.Id) throw new NotFoundException("Order");
        if (!await razorpay.VerifyPaymentSignatureAsync(razorpayOrderId, razorpayPaymentId, razorpaySignature))
            throw new AppException("Payment verification failed", "bad_signature");
        string result;
        try
        {
            result = await ConfirmWithGatewayAsync(payment, razorpayPaymentId, uow);
        }
        catch (RazorpayBAL.GatewayException exc)
        {
            // The webhook (or the expiry job's gateway check) will still record the payment.
            throw new AppException($"We could not confirm the payment yet: {exc.Message}", "gateway_error", 502);
        }
        await uow.CommitAsync();
        if (result == "refund")
        {
            // The duplicate-payment refunds go to the gateway from the background refund worker (reference:
            // background.add_task(run_refunds, ...)).
            refundQueue.Enqueue(await orders.PendingRefundIdsAsync(payment.Id));
        }
        if (result == "not_captured")
            throw new AppException("The payment was not completed. You can try again.", "payment_not_captured");
        if (result == "paid")
            await AnnouncePlacedAsync(order, user, await orders.SubOrdersAsync(order.Id));
        return (result, (await orders.GetOrderAsync(order.Id))!);
    }

    public async Task<JsonObject> PaymentStatusAsync(UserModel user, Guid orderId)
    {
        var outp = new JsonObject { ["status"] = "not_paid", ["reason"] = "" };
        var committed = false;
        await using (var uow = await db.BeginAsync())
        {
            var o = await orders.GetOrderAsync(orderId, uow) ?? throw new NotFoundException("Order");
            if (o.UserId != user.Id) throw new NotFoundException("Order");
            var payment = await orders.LatestPaymentForUpdateAsync(o.Id, uow);
            if (o.PaymentStatus is "paid" or "partially_refunded" or "refunded" || payment?.Status == "captured")
            {
                outp["status"] = "paid";
            }
            else if (payment is null || o.Status != "pending_payment")
            {
                outp["status"] = "not_paid";
            }
            else
            {
                await rateLimit.RateLimitAsync($"paycheck:{o.Id}", 80, 600, uow); // protects the Razorpay API quota
                try
                {
                    var res = await CheckWithGatewayAsync(payment, uow);
                    var result = res["result"]!.GetValue<string>();
                    if (result is "paid" or "already" or "already_paid" or "refund")
                    {
                        outp["status"] = "paid";
                        if (result == "refund") refundQueue.Enqueue(await orders.PendingRefundIdsAsync(payment.Id));
                    }
                    else if (res["waiting"]!.GetValue<bool>()) outp["status"] = "waiting";
                    else if (res["reason"]!.GetValue<string>() is { Length: > 0 } r)
                    {
                        outp["status"] = "failed";
                        outp["reason"] = r;
                    }
                }
                catch (RazorpayBAL.GatewayException) { outp["status"] = "unknown"; }
                catch (AppException) { outp["status"] = "unknown"; }
            }
            await uow.CommitAsync();
            committed = true;
        }
        _ = committed;
        var fresh = (await orders.GetOrderAsync(orderId))!;
        var detail = await DetailAsync(fresh);
        detail["payment"] = await ShopperCheckoutAsync(fresh, await orders.LatestPaymentAsync(fresh.Id), user);
        outp["order"] = detail;
        return outp;
    }

    // ------------------------------------------------------------------------- list / detail / cancel / refunds

    /// <summary>Every legal package move (reference: TRANSITIONS). A move not listed here is refused in one place.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Transitions = new Dictionary<string, string[]>
    {
        ["pending_payment"] = ["placed", "cancelled"],
        ["placed"] = ["confirmed", "cancelled"],
        ["confirmed"] = ["packed", "cancelled"],
        ["packed"] = ["shipped", "cancelled"],
        ["shipped"] = ["delivered", "cancelled"], // cancelled after shipping = returned to origin (RTO)
        ["delivered"] = [],
        ["cancelled"] = [],
    };

    public static bool CanTransition(string src, string dst) =>
        Transitions.TryGetValue(src, out var dsts) && dsts.Contains(dst);

    /// <summary>The shopper's orders page (reference: GET /api/orders my_orders + order_summary).</summary>
    public async Task<JsonObject> MyOrdersAsync(UserModel user, int page, int pageSize)
    {
        var total = await orders.CountOrdersByUserAsync(user.Id);
        var list = await orders.OrdersByUserAsync(user.Id, (page - 1) * pageSize, pageSize);
        var subs = await orders.SubOrdersForOrdersAsync(list.Select(o => o.Id).ToList());
        var items = await orders.ItemsAsync(subs.Select(s => s.Id).ToList());
        var byOrder = subs.GroupBy(s => s.OrderId).ToDictionary(g => g.Key, g => g.ToList());
        var bySub = items.GroupBy(i => i.SubOrderId).ToDictionary(g => g.Key, g => g.ToList());
        var arr = new JsonArray();
        foreach (var o in list)
        {
            var oSubs = byOrder.GetValueOrDefault(o.Id) ?? [];
            var oItems = oSubs.SelectMany(s => bySub.GetValueOrDefault(s.Id) ?? []).ToList();
            arr.Add(new JsonObject
            {
                ["id"] = o.Id.ToString(),
                ["number"] = o.Number,
                ["status"] = o.Status,
                ["payment_method"] = o.PaymentMethod,
                ["payment_status"] = o.PaymentStatus,
                ["grand_total"] = o.GrandTotal,
                ["created_at"] = o.CreatedAt.ToString("o"),
                ["item_count"] = oItems.Sum(i => i.Qty),
                ["items"] = new JsonArray(oItems.Take(4).Select(i => (JsonNode)new JsonObject
                {
                    ["title"] = i.Title, ["image"] = i.ImageUrl, ["qty"] = i.Qty,
                }).ToArray()),
                ["sub_statuses"] = new JsonArray(oSubs.Select(s => (JsonNode)JsonValue.Create(s.Status)!).ToArray()),
            });
        }
        return new JsonObject { ["items"] = arr, ["total"] = total, ["page"] = page, ["page_size"] = pageSize };
    }

    /// <summary>The order as its shopper sees it (reference: GET /api/orders/{order_id} → _shopper_order).</summary>
    public async Task<JsonObject> GetShopperOrderAsync(UserModel user, Guid orderId)
    {
        var o = await orders.GetOrderAsync(orderId);
        if (o is null || o.UserId != user.Id) throw new NotFoundException("Order");
        var data = await DetailAsync(o);
        data["payment"] = await ShopperCheckoutAsync(o, await orders.LatestPaymentAsync(o.Id), user);
        return data;
    }

    /// <summary>POST /api/orders/{order_id}/cancel (reference: cancel + customer_cancel). Cancels the customer's
    /// cancellable packages (all, or one) in one transaction and answers with the order detail; any refunds go to the
    /// gateway from the background refund worker after the response (reference: a FastAPI background task), with the
    /// retry job covering a crash in between.</summary>
    public async Task<JsonObject> CancelAsync(UserModel user, Guid orderId, string reason, Guid? subOrderId)
    {
        var own = await orders.GetOrderAsync(orderId);
        if (own is null || own.UserId != user.Id) throw new NotFoundException("Order");
        List<Guid> refundIds;
        await using (var uow = await db.BeginAsync())
        {
            refundIds = await CustomerCancelAsync(orderId, subOrderId, reason, uow);
            await uow.CommitAsync();
        }
        var detail = await DetailAsync((await orders.GetOrderAsync(orderId))!);
        refundQueue.Enqueue(refundIds);
        return detail;
    }

    /// <summary>Reference: customer_cancel. Ownership is the caller's check. Returns the refund ids to send after commit.</summary>
    private async Task<List<Guid>> CustomerCancelAsync(Guid orderId, Guid? subOrderId, string reason, IUnitOfWork uow)
    {
        var subs = await orders.SubOrdersForUpdateAsync(orderId, uow);
        var targets = subs.Where(s => subOrderId is null || s.Id == subOrderId).ToList();
        if (subOrderId is not null && targets.Count == 0) throw new NotFoundException("Order part");
        var allowed = CustomerCancellableAt(await platform.GetAsync());
        var cancellable = targets.Where(s => allowed.Contains(s.Status) || s.Status == "pending_payment").ToList();
        if (cancellable.Count == 0)
            throw new AppException("This order can no longer be cancelled. You can return it after delivery.", "not_cancellable", 409);
        var refundIds = new List<Guid>();
        foreach (var s in cancellable)
        {
            var refund = await CancelSubOrderAsync(s, "customer", reason, uow);
            if (refund is not null) refundIds.Add(refund.Id);
        }
        return refundIds;
    }

    /// <summary>Reference: cancel_sub_order. Every cancellation of paid money creates a refund record; stock, deals
    /// and sold counts go back; the last package standing takes the coupon back and closes the order.</summary>
    /// <summary>Cancels one package with stock release and online refund row (reference: orders.cancel_sub_order).
    /// Internal callers (fleet return-to-store) use it inside their own transaction.</summary>
    public async Task<RefundModel?> CancelSubOrderAsync(SubOrderModel sub, string actor, string reason, IUnitOfWork uow)
    {
        if (!CanTransition(sub.Status, "cancelled"))
            throw new AppException("This order can no longer be cancelled", "not_cancellable", 409);
        var order = await orders.OrderForUpdateAsync(sub.OrderId, uow) ?? throw new NotFoundException("Order");
        var src = sub.Status;
        var now = DateTimeFunctions.UtcNow();
        sub.Status = "cancelled";
        sub.CancelledAt = now;
        sub.CancelledBy = actor;
        sub.CancelReason = reason.Length > 300 ? reason[..300] : reason;
        await orders.UpdateSubCancelledAsync(sub, uow);
        await orders.InsertEventAsync(new OrderEventModel
        {
            Id = Guid.NewGuid(), OrderId = order.Id, SubOrderId = sub.Id,
            FromStatus = src, ToStatus = "cancelled", Actor = actor, Note = sub.CancelReason, CreatedAt = now,
        }, uow);
        await ReleaseStockAsync(sub, uow);
        // reference: fleet.on_cancelled when the own fleet carries the package — the delivery module owns that hook.

        var othersLive = await orders.CountLiveOtherSubsAsync(order.Id, sub.Id, uow);
        var feesBack = (await fees.GetAsync()).Bool("fees_refund_on_cancel");
        var paidShare = RefundOnCancel(sub, order, othersLive, feesBack);
        if (othersLive == 0 && !feesBack && order.PaymentMethod == "online" && order.PaymentStatus is "paid" or "partially_refunded")
            await IssueFeeInvoiceAsync(order, uow); // the marketplace keeps its fees: they are invoiced

        RefundModel? refund = null;
        if (order.PaymentMethod == "online" && order.PaymentStatus is "paid" or "partially_refunded")
        {
            var payment = await orders.CapturedPaymentAsync(order.Id);
            if (payment is not null)
            {
                refund = new RefundModel
                {
                    Id = Guid.NewGuid(), OrderId = order.Id, PaymentId = payment.Id, SubOrderId = sub.Id,
                    AmountPaise = paidShare, Status = "pending", Reason = sub.CancelReason,
                    Attempts = 0, LastError = "", CreatedAt = now, UpdatedAt = now,
                };
                await orders.InsertRefundAsync(refund, uow);
                order.RefundedTotal += paidShare;
                order.PaymentStatus = order.RefundedTotal >= order.GrandTotal ? "refunded" : "partially_refunded";
                await orders.UpdateOrderPaymentStateAsync(order, uow);
            }
        }

        await SyncCodStatusAsync(order, uow);
        if (othersLive == 0)
        {
            await orders.MarkOrderCancelledAsync(order.Id, uow);
            var couponId = await orders.UnreleasedRedemptionCouponAsync(order.Id, uow);
            if (couponId is Guid cid)
            {
                await orders.ReleaseRedemptionAsync(order.Id, uow);
                await orders.DecrementCouponUsageAsync(cid, uow);
            }
        }

        if (src != "pending_payment")
        {
            var item = await FirstTitleAsync(sub, uow);
            var refundText = refund is not null ? $"A refund of {Money.Rupees(paidShare)} has been started."
                : order.PaymentMethod == "cod" ? "Nothing was charged for it." : "";
            await notify.NotifyUserAsync(order.UserId, "order_cancelled",
                new Dictionary<string, string>
                {
                    ["order_number"] = order.Number, ["item"] = item, ["reason"] = sub.CancelReason, ["refund_text"] = refundText,
                },
                $"/orders/{order.Id}");
            if (actor != "seller")
                await notify.NotifySellerAsync(sub.SellerId, "seller_order_cancelled",
                    new Dictionary<string, string> { ["order_number"] = sub.Number, ["reason"] = sub.CancelReason },
                    $"/seller/orders/{sub.Id}");
        }
        return refund;
    }

    /// <summary>Reference: _release_stock(kind="release"): units back on the shelf, deal units back on offer,
    /// sold_count floored at 0, aggregates refreshed.</summary>
    private async Task ReleaseStockAsync(SubOrderModel sub, IUnitOfWork uow)
    {
        var items = await orders.ItemsAsync([sub.Id], uow);
        foreach (var it in items.OrderBy(i => i.VariantId))
        {
            var qty = it.Qty - it.ReturnedQty;
            if (qty <= 0) continue;
            var variant = await deals.VariantForUpdateAsync(it.VariantId, uow);
            if (variant is null) continue;
            if (sub.WarehouseId is Guid wh)
                await inventory.ChangeAsync(variant, wh, qty, "release", sub.Number, uow: uow);
            else
            {
                variant.Stock += qty;
                await inventory.SetVariantStockAsync(variant.Id, variant.Stock, uow);
            }
            await deals.ReleaseSaleAsync(it.VariantId, qty, it.UnitPrice, uow);
            await orders.ReleaseSoldCountAsync(it.ProductId, qty, uow);
        }
        foreach (var pid in items.Select(i => i.ProductId).Distinct())
            await catalog.RefreshAggregatesAsync(pid, uow);
    }

    /// <summary>A COD order counts as paid once every part that was not cancelled has been delivered (reference:
    /// _sync_cod_status).</summary>
    private async Task SyncCodStatusAsync(OrderModel order, IUnitOfWork uow)
    {
        if (order.PaymentMethod != "cod") return;
        var statuses = (await orders.SubOrdersForUpdateAsync(order.Id, uow)).Select(s => s.Status).ToList();
        var live = statuses.Where(st => st != "cancelled").ToList();
        if (live.Count > 0 && live.All(st => st == "delivered"))
        {
            order.PaymentStatus = "paid";
            await orders.UpdateOrderPaymentStateAsync(order, uow);
        }
    }

    /// <summary>Reference: _first_title.</summary>
    private async Task<string> FirstTitleAsync(SubOrderModel sub, IUnitOfWork uow)
    {
        var titles = (await orders.ItemsAsync([sub.Id], uow)).Select(i => i.Title).ToList();
        return titles.Count > 0 ? titles[0] + (titles.Count > 1 ? $" and {titles.Count - 1} more" : "") : sub.Number;
    }

    /// <summary>Gives the order its marketplace fee invoice number, once (reference: fee_invoices.issue). No-op
    /// without fees or without the operator's GSTIN.</summary>
    private async Task IssueFeeInvoiceAsync(OrderModel order, IUnitOfWork uow)
    {
        if (order.FeeInvoiceNumber.Length > 0 || order.FeesTotal == 0 || order.Fees is "" or "[]" or "null") return;
        var business = site.PublicBusiness(await site.GetSiteAsync());
        if (CatalogText.AsString(business["gstin"]) is not { Length: > 0 }) return;
        var now = DateTimeFunctions.UtcNow();
        var fy = FiscalYear(now);
        var prefix = (await fees.GetAsync()).Str("fee_invoice_prefix");
        var n = await orders.NextInvoiceNumberAsync(fy, uow);
        var number = $"{prefix}/{fy}/{n:000000}";
        await orders.SetFeeInvoiceAsync(order.Id, number.Length > 16 ? number[..16] : number, now, uow);
    }

    /// <summary>Indian fiscal year "26-27" (reference: invoices.fiscal_year, in IST).</summary>
    private static string FiscalYear(DateTime utc)
    {
        var d = utc.AddMinutes(330); // IST
        var start = d.Month >= 4 ? d.Year : d.Year - 1;
        return $"{start % 100:00}-{(start + 1) % 100:00}";
    }

    /// <summary>Sends queued refunds to the gateway, one by one (reference: run_refunds). A failure is recorded on
    /// the row; the retry job picks it up.</summary>
    public async Task ProcessRefundsAsync(IReadOnlyList<Guid> refundIds)
    {
        foreach (var id in refundIds)
        {
            try { await ProcessRefundAsync(id); }
            catch (Exception) { /* the retry job picks it up */ }
        }
    }

    /// <summary>Sends one pending refund to Razorpay. Safe to call repeatedly (receipt = our refund id)
    /// (reference: process_refund; attempts ≥ 8 → failed, needs manual attention in the admin panel).</summary>
    public async Task ProcessRefundAsync(Guid refundId)
    {
        await using var uow = await db.BeginAsync();
        var refund = await orders.RefundForUpdateAsync(refundId, uow);
        if (refund is null || refund.Status != "pending") return;
        var payment = await orders.PaymentForUpdateAsync(refund.PaymentId, uow) ?? throw new NotFoundException("Payment");
        refund.Attempts += 1;
        try
        {
            var data = await razorpay.RefundPaymentAsync(
                refund.ProviderPaymentId ?? payment.ProviderPaymentId ?? "",
                RefundCharge(payment, refund.AmountPaise),
                refund.Id.ToString(),
                new Dictionary<string, string> { ["refund_id"] = refund.Id.ToString() });
            refund.ProviderRefundId = data["id"]?.GetValue<string>();
            refund.Status = data["status"]?.GetValue<string>() == "processed" ? "processed" : "pending";
            if (refund.Status == "pending") refund.LastError = "";
            await orders.UpdateRefundAsync(refund, uow);
            await uow.CommitAsync();
            if (refund.Status == "processed") await NotifyRefundAsync(refund);
        }
        catch (RazorpayBAL.GatewayException ex)
        {
            refund.LastError = ex.Message.Length > 500 ? ex.Message[..500] : ex.Message;
            if (refund.Attempts >= 8) refund.Status = "failed";
            await orders.UpdateRefundAsync(refund, uow);
            await uow.CommitAsync();
        }
    }

    /// <summary>Tells the customer a refund has gone through (reference: notify_refund; call once, when it becomes
    /// processed).</summary>
    private async Task NotifyRefundAsync(RefundModel refund)
    {
        var order = await orders.GetOrderAsync(refund.OrderId);
        if (order is null) return;
        await notify.NotifyUserAsync(order.UserId, "refund_processed",
            new Dictionary<string, string> { ["amount"] = Money.Rupees(refund.AmountPaise), ["order_number"] = order.Number },
            $"/orders/{order.Id}");
    }

    // ------------------------------------------------------------------------- seller

    /// <summary>The caller's seller account (reference: deps.seller_account / approved_seller).</summary>
    public async Task<SellerModel> RequireSellerAsync(UserModel user, bool approved)
    {
        var seller = await catalog.GetSellerByUserAsync(user.Id)
            ?? throw new ForbiddenException("Register as a seller first");
        if (approved && seller.Status != "approved")
            throw new ForbiddenException("Your seller account is not approved yet");
        return seller;
    }

    /// <summary>One package as the seller sees it (reference: sub_out).</summary>
    public JsonObject SellerSubJson(SubOrderModel s, OrderModel o, IReadOnlyList<OrderItemModel> items, bool full)
    {
        var data = new JsonObject
        {
            ["id"] = s.Id.ToString(),
            ["number"] = s.Number,
            ["order_number"] = o.Number,
            ["status"] = s.Status,
            ["payment_method"] = o.PaymentMethod,
            ["created_at"] = s.CreatedAt.ToString("o"),
            ["items_total"] = s.ItemsTotal,
            ["shipping_fee"] = s.ShippingFee,
            ["total"] = s.Total,
            ["shipping_provider"] = s.ShippingProvider, // manual (the seller's own courier), shiprocket or fleet
            ["seller_payout"] = s.SellerPayoutPaise,
            ["item_count"] = items.Sum(i => i.Qty),
            ["items"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject
            {
                ["id"] = i.Id.ToString(), ["title"] = i.Title, ["variant_label"] = i.VariantLabel, ["sku"] = i.Sku,
                ["image"] = i.ImageUrl, ["qty"] = i.Qty, ["unit_price"] = i.UnitPrice, ["line_total"] = i.LineTotal,
            }).ToArray()),
            ["ship_to_city"] = JsonNode.Parse(o.ShipTo)?["city"]?.GetValue<string>(),
            ["ship_to_pincode"] = JsonNode.Parse(o.ShipTo)?["pincode"]?.GetValue<string>(),
            ["courier_name"] = s.CourierName,
            ["tracking_number"] = s.TrackingNumber,
            ["tracking_url"] = s.TrackingUrl,
            ["invoice_number"] = s.InvoiceNumber,
            ["label_url"] = s.LabelUrl,
            ["expected_delivery_at"] = s.ExpectedDeliveryAt?.ToString("o"),
        };
        if (full)
        {
            // Full address only once the order is the seller's to fulfil (not while unpaid).
            data["ship_to"] = s.Status != "pending_payment" ? JsonNode.Parse(o.ShipTo) : null;
            data["breakdown"] = new JsonObject
            {
                ["gross"] = s.Total,
                ["commission"] = s.CommissionPaise,
                ["commission_gst"] = s.CommissionGstPaise,
                ["tcs"] = s.TcsPaise,
                ["tds"] = s.TdsPaise,
                ["payout"] = s.SellerPayoutPaise,
                ["taxable_total"] = s.TaxableTotal,
                ["is_interstate"] = s.IsInterstate,
            };
            data["items_tax"] = new JsonArray(items.Select(i => (JsonNode)new JsonObject
            {
                ["title"] = i.Title, ["hsn_code"] = i.HsnCode, ["gst_bps"] = i.GstBps,
                ["taxable_value"] = i.TaxableValue, ["cgst"] = i.Cgst, ["sgst"] = i.Sgst, ["igst"] = i.Igst,
            }).ToArray());
            data["confirmed_at"] = s.ConfirmedAt?.ToString("o");
            data["packed_at"] = s.PackedAt?.ToString("o");
            data["shipped_at"] = s.ShippedAt?.ToString("o");
            data["delivered_at"] = s.DeliveredAt?.ToString("o");
            data["cancel_reason"] = s.CancelReason;
            data["settlement_status"] = s.SettlementStatus;
            data["settlement_due_at"] = s.SettlementDueAt?.ToString("o");
        }
        return data;
    }

    /// <summary>The seller's order queues (reference: GET /api/seller/orders list_orders).</summary>
    public async Task<JsonObject> SellerListAsync(SellerModel seller, string? status, string q, int page, int pageSize)
    {
        var total = await orders.CountSellerSubsAsync(seller.Id, status, q);
        var subs = await orders.SellerSubsAsync(seller.Id, status, q, (page - 1) * pageSize, pageSize);
        var byId = (await orders.OrdersByIdsAsync(subs.Select(s => s.OrderId).Distinct().ToList())).ToDictionary(o => o.Id);
        var items = await orders.ItemsAsync(subs.Select(s => s.Id).ToList());
        var bySub = items.GroupBy(i => i.SubOrderId).ToDictionary(g => g.Key, g => (IReadOnlyList<OrderItemModel>)g.ToList());
        return new JsonObject
        {
            ["items"] = new JsonArray(subs.Select(s => (JsonNode)SellerSubJson(
                s, byId[s.OrderId], bySub.GetValueOrDefault(s.Id) ?? [], full: false)).ToArray()),
            ["total"] = total,
            ["page"] = page,
            ["page_size"] = pageSize,
            ["status_counts"] = new JsonObject((await orders.SellerStatusCountsAsync(seller.Id)).Select(
                kv => new KeyValuePair<string, JsonNode?>(kv.Key, JsonValue.Create(kv.Value))).ToArray()),
        };
    }

    /// <summary>One package, owned by the seller and never the unpaid kind (reference: _own_sub).</summary>
    private async Task<(SubOrderModel Sub, OrderModel Order)> OwnSubAsync(Guid sellerId, Guid subId, IUnitOfWork? uow)
    {
        var s = uow is not null ? await orders.SubForUpdateAsync(subId, uow) : await orders.GetSubAsync(subId);
        if (s is null || s.SellerId != sellerId || s.Status == "pending_payment") throw new NotFoundException("Order");
        var o = await orders.GetOrderAsync(s.OrderId) ?? throw new NotFoundException("Order");
        return (s, o);
    }

    /// <summary>One package as the seller sees it (reference: GET /api/seller/orders/{sub_id}).</summary>
    public async Task<JsonObject> SellerGetAsync(SellerModel seller, Guid subId)
    {
        var (s, o) = await OwnSubAsync(seller.Id, subId, null);
        var data = SellerSubJson(s, o, await orders.ItemsAsync([s.Id]), full: true);
        data["timeline"] = new JsonArray((await orders.EventsForSubAsync(s.Id)).Select(e => (JsonNode)new JsonObject
        {
            ["from"] = e.FromStatus, ["to"] = e.ToStatus, ["actor"] = e.Actor, ["note"] = e.Note,
            ["at"] = e.CreatedAt.ToString("o"),
        }).ToArray());
        data["cod_to_collect"] = await CodToCollectAsync(s, o);
        return data;
    }

    /// <summary>The package's next step (reference: transition()). Shipped assigns the seller's invoice number and
    /// tells the customer; delivered opens the settlement window, posts the ledger and issues the marketplace's fee
    /// invoice. The fleet checks come with the delivery module.</summary>
    public async Task TransitionAsync(SubOrderModel sub, string dst, string actor, string note, IUnitOfWork uow,
        bool announce = true)
    {
        if (!CanTransition(sub.Status, dst))
            throw new AppException($"Cannot move this order from '{sub.Status}' to '{dst}'", "illegal_transition", 409);
        var src = sub.Status;
        var now = DateTimeFunctions.UtcNow();
        sub.Status = dst;
        if (dst == "confirmed") sub.ConfirmedAt = now;
        else if (dst == "packed") sub.PackedAt = now;
        else if (dst == "shipped")
        {
            sub.ShippedAt = now;
            await AssignInvoiceAsync(sub, now, uow);
            var shippedOrder = await orders.GetOrderAsync(sub.OrderId, uow) ?? throw new NotFoundException("Order");
            var shipper = await catalog.GetSellerAsync(sub.SellerId);
            // the fleet's pickup step announces with delivery_out_for_delivery instead (reference: transition announce=False)
            if (announce)
            await notify.NotifyUserAsync(shippedOrder.UserId, "order_shipped",
                new Dictionary<string, string>
                {
                    ["order_number"] = shippedOrder.Number, ["item"] = await FirstTitleAsync(sub, uow),
                    ["courier"] = sub.CourierName.Length > 0 ? sub.CourierName : "courier",
                    ["awb"] = sub.TrackingNumber, ["seller"] = shipper?.DisplayName ?? "",
                },
                $"/orders/{shippedOrder.Id}");
        }
        else if (dst == "delivered")
        {
            sub.DeliveredAt = now;
            // the return windows saved on the items when the order was placed (a later edit to the listing changes
            // nothing), and the period in which damaged, defective or wrong items are taken back whatever it says
            var window = Math.Max(await orders.MaxReturnWindowAsync(sub.Id, uow),
                (await platform.GetAsync()).Int("defect_return_days"));
            sub.SettlementDueAt = now.AddDays(window);
            sub.SettlementStatus = "pending";
            await orders.UpdateSubTransitionAsync(sub, uow);
            var deliveredOrder = await orders.GetOrderAsync(sub.OrderId, uow) ?? throw new NotFoundException("Order");
            await SyncCodStatusAsync(deliveredOrder, uow);
            // cash on delivery taken by the seller's own courier is already with the seller: it comes off the payout
            var held = deliveredOrder.PaymentMethod == "cod" && sub.ShippingProvider == "manual"
                ? await CollectAmountAsync(sub, deliveredOrder, uow) : 0;
            await PostDeliveryAsync(sub, held, uow);
            await IssueFeeInvoiceAsync(deliveredOrder, uow);
            await notify.NotifyUserAsync(deliveredOrder.UserId, "order_delivered",
                new Dictionary<string, string>
                {
                    ["order_number"] = deliveredOrder.Number, ["item"] = await FirstTitleAsync(sub, uow),
                    ["return_by"] = sub.SettlementDueAt.Value.AddMinutes(330).ToString("dd MMM yyyy", CultureInfo.InvariantCulture),
                },
                $"/orders/{deliveredOrder.Id}");
        }
        await orders.UpdateSubTransitionAsync(sub, uow);
        await orders.InsertEventAsync(new OrderEventModel
        {
            Id = Guid.NewGuid(), OrderId = sub.OrderId, SubOrderId = sub.Id,
            FromStatus = src, ToStatus = dst, Actor = actor, Note = note, CreatedAt = now,
        }, uow);
    }

    /// <summary>What the customer pays when this package is handed over, 0 for prepaid (reference: collect_amount).
    /// The seller's part is the package total less the discount the marketplace funded; the marketplace's fees and
    /// the tip ride with the first live package (lowest number), so they are collected once.</summary>
    public async Task<long> CollectAmountAsync(SubOrderModel sub, OrderModel order, IUnitOfWork uow)
    {
        if (order.PaymentMethod != "cod") return 0;
        var amount = sub.Total - sub.PlatformDiscount;
        if (order.FeesTotal != 0 || order.TipPaise != 0)
        {
            var first = await orders.FirstLiveSubIdAsync(order.Id, uow);
            if (first == sub.Id) amount += order.FeesTotal + order.TipPaise;
        }
        return amount;
    }

    /// <summary>The courier-facing collection figure for the detail payload (reference: get_order cod_to_collect).</summary>
    private async Task<long> CodToCollectAsync(SubOrderModel s, OrderModel o)
    {
        if (s.Status is "cancelled" or "pending_payment") return 0;
        if (o.PaymentMethod != "cod") return 0;
        var amount = s.Total - s.PlatformDiscount;
        if ((o.FeesTotal != 0 || o.TipPaise != 0) && await orders.FirstLiveSubIdAsync(o.Id) == s.Id)
            amount += o.FeesTotal + o.TipPaise;
        return amount;
    }

    /// <summary>Gives the package its seller invoice number, once (reference: invoices.assign_invoice).</summary>
    private async Task AssignInvoiceAsync(SubOrderModel sub, DateTime now, IUnitOfWork uow)
    {
        if (sub.InvoiceNumber.Length > 0) return;
        var fy = FiscalYear(now);
        var n = await orders.DocCounterForUpdateAsync(sub.SellerId, "INV", fy, uow);
        if (n is null) { await orders.InsertDocCounterAsync(sub.SellerId, "INV", fy, uow); n = 1; }
        else { await orders.BumpDocCounterAsync(sub.SellerId, "INV", fy, uow); n += 1; }
        var seller = await catalog.GetSellerAsync(sub.SellerId);
        var prefix = seller is not null && seller.InvoicePrefix.Length > 0 ? seller.InvoicePrefix : DefaultPrefix(seller?.DisplayName ?? "");
        if (prefix.Length > 4) prefix = prefix[..4];
        sub.InvoiceNumber = $"{prefix}/{fy}/{n.Value:D6}";
        if (sub.InvoiceNumber.Length > 16) sub.InvoiceNumber = sub.InvoiceNumber[..16];
        sub.InvoiceDate = now;
        await orders.SetSubInvoiceAsync(sub.Id, sub.InvoiceNumber, now, uow);
    }

    private static string DefaultPrefix(string displayName)
    {
        var letters = new string(displayName.ToUpperInvariant().Where(c => c is >= 'A' and <= 'Z').ToArray());
        var p = letters.Length >= 3 ? letters[..3] : letters.Length > 0 ? letters.PadRight(3, 'X') : "INV";
        return p;
    }

    /// <summary>Posts the sale and its deductions, available after the return window; a no-op when already posted
    /// (reference: ledger.post_delivery). cod_held_by_seller: cash the seller's own courier collected.</summary>
    private async Task PostDeliveryAsync(SubOrderModel sub, long codHeldBySeller, IUnitOfWork uow)
    {
        if (await orders.LedgerHasAsync(sub.Id, "sale", uow)) return;
        var due = sub.SettlementDueAt ?? DateTimeFunctions.UtcNow();
        foreach (var (kind, amount) in new (string Kind, long Amount)[]
        {
            ("sale", sub.Total), ("commission", -sub.CommissionPaise), ("commission_gst", -sub.CommissionGstPaise),
            ("tcs", -sub.TcsPaise), ("tds", -sub.TdsPaise),
        })
            if (amount != 0)
                await orders.InsertLedgerAsync(sub.SellerId, sub.Id, kind, amount,
                    string.Join(' ', kind.Split('_').Select(w => char.ToUpperInvariant(w[0]) + w[1..])) + " " + sub.Number, due, uow);
        if (codHeldBySeller > 0)
            await orders.InsertLedgerAsync(sub.SellerId, sub.Id, "cod_collected", -codHeldBySeller,
                $"Cash collected by your courier {sub.Number}", due, uow);
    }

    /// <summary>The seller's dashboard numbers (reference: dashboard). Earnings come from the ledger, like the
    /// Payouts page: returns, ad spend and cash the courier holds are already netted.</summary>
    public async Task<JsonObject> SellerDashboardAsync(SellerModel seller)
    {
        var since = DateTimeFunctions.UtcNow().AddDays(-30);
        var counts = await orders.SellerStatusCountsAsync(seller.Id);
        var sales = await orders.SalesSinceAsync(seller.Id, since);
        var daily = await orders.DailySalesSinceAsync(seller.Id, since);
        var bal = await orders.LedgerBalancesAsync(seller.Id);
        var products = await catalog.ProductStatusCountsAsync(seller.Id);
        var threshold = (await platform.GetAsync()).Int("low_stock_threshold");
        var lowStock = await catalog.LowStockCountAsync(seller.Id, threshold);
        long Count(string s) => counts.TryGetValue(s, out var n) ? n : 0;
        return new JsonObject
        {
            ["seller_status"] = seller.Status,
            ["orders"] = new JsonObject
            {
                ["to_confirm"] = Count("placed"), ["to_pack"] = Count("confirmed"), ["to_ship"] = Count("packed"),
                ["in_transit"] = Count("shipped"), ["delivered"] = Count("delivered"), ["cancelled"] = Count("cancelled"),
            },
            ["sales_30d"] = new JsonObject { ["amount"] = sales.Amount, ["orders"] = sales.Orders },
            ["daily_sales"] = new JsonArray(daily.Select(d => (JsonNode)new JsonObject
            {
                ["date"] = d.Date, ["amount"] = d.Amount, ["orders"] = d.Orders,
            }).ToArray()),
            ["earnings"] = new JsonObject { ["in_return_window"] = bal.Upcoming, ["ready_for_payout"] = bal.Available },
            ["products"] = new JsonObject(products.Select(
                kv => new KeyValuePair<string, JsonNode?>(kv.Key, JsonValue.Create(kv.Value))).ToArray()),
            ["low_stock_variants"] = lowStock,
            ["low_stock_threshold"] = threshold,
        };
    }

    /// <summary>Delivered packages and their settlement, page by page (reference: earnings).</summary>
    public async Task<JsonObject> SellerEarningsAsync(SellerModel seller, int page, int pageSize)
    {
        var now = DateTimeFunctions.UtcNow();
        var total = await orders.CountDeliveredSubsAsync(seller.Id);
        var rows = await orders.DeliveredSubsAsync(seller.Id, (page - 1) * pageSize, pageSize);
        var sums = await orders.DeliveredSumsAsync(seller.Id);
        return new JsonObject
        {
            ["totals"] = new JsonObject
            {
                ["gross"] = sums.Gross, ["commission"] = sums.Commission, ["commission_gst"] = sums.CommissionGst,
                ["tcs"] = sums.Tcs, ["tds"] = sums.Tds, ["payout"] = sums.Payout,
            },
            ["items"] = new JsonArray(rows.Select(s => (JsonNode)new JsonObject
            {
                ["sub_order_id"] = s.Id.ToString(), ["number"] = s.Number,
                ["delivered_at"] = s.DeliveredAt?.ToString("o"),
                ["gross"] = s.Total, ["commission"] = s.CommissionPaise, ["commission_gst"] = s.CommissionGstPaise,
                ["tcs"] = s.TcsPaise, ["tds"] = s.TdsPaise, ["payout"] = s.SellerPayoutPaise,
                ["settlement_status"] = s.SettlementStatus,
                ["eligible"] = s.SettlementStatus == "pending" && s.SettlementDueAt is not null && s.SettlementDueAt <= now,
                ["settlement_due_at"] = s.SettlementDueAt?.ToString("o"),
            }).ToArray()),
            ["total"] = total,
            ["page"] = page,
            ["page_size"] = pageSize,
        };
    }

    private static readonly IReadOnlyDictionary<string, string> SellerCancelReasons = new Dictionary<string, string>
    {
        ["out_of_stock"] = "Seller is out of stock",
        ["cannot_ship_to_pincode"] = "Seller cannot deliver to this PIN code",
        ["pricing_error"] = "Listing had a pricing error",
        ["other"] = "Cancelled by seller",
    };

    private const string RtoReasonText = "Returned to the seller by the courier (RTO)";

    /// <summary>The seller cancels a package not yet shipped (reference: reject). Out of stock zeroes the lines' stock
    /// in this package's warehouse through recorded movements, so they stop selling and do not come back.</summary>
    public async Task<JsonObject> SellerRejectAsync(UserModel user, SellerModel seller, Guid subId,
        string reasonKey, string note, IReadOnlyList<Guid> outOfStockItems)
    {
        await using var uow = await db.BeginAsync();
        var (s, o) = await OwnSubAsync(seller.Id, subId, uow);
        if (s.Status is not ("placed" or "confirmed" or "packed"))
            throw new AppException("Only orders that are not yet shipped can be cancelled", "not_cancellable", 400);
        var items = await orders.ItemsAsync([s.Id], uow);
        var gone = reasonKey == "out_of_stock"
            ? items.Where(i => outOfStockItems.Count == 0 || outOfStockItems.Contains(i.Id)).Select(i => i.VariantId).ToHashSet()
            : [];
        if (reasonKey == "out_of_stock" && outOfStockItems.Count > 0 && gone.Count == 0)
            throw new AppException("Choose the items that are out of stock in this order", "invalid_items", 400);
        var reason = SellerCancelReasons[reasonKey] + (note.Trim().Length > 0 ? $": {note.Trim()}" : "");
        var refund = await CancelSubOrderAsync(s, "seller", reason, uow);
        if (gone.Count > 0)
        {
            foreach (var vid in gone.OrderBy(x => x))
            {
                var v = await deals.VariantForUpdateAsync(vid, uow);
                if (v is null) continue;
                if (s.WarehouseId is Guid wh)
                    await inventory.SetQuantityAsync(v, wh, 0, user.Id, $"Out of stock: seller cancelled {s.Number}", uow);
                else
                    await inventory.SetVariantStockAsync(v.Id, 0, uow);
            }
            foreach (var pid in items.Where(i => gone.Contains(i.VariantId)).Select(i => i.ProductId).Distinct())
                await catalog.RefreshAggregatesAsync(pid, uow);
        }
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = user.Id, Action = "suborder.seller_cancel",
            EntityType = "sub_order", EntityId = s.Id.ToString(),
            Detail = reason + (gone.Count > 0 ? $" ({gone.Count} item(s) set to 0 in stock)" : ""), CreatedAt = DateTimeFunctions.UtcNow(),
        }, uow.Transaction);
        var data = SellerSubJson(s, o, await orders.ItemsAsync([s.Id], uow), full: true);
        await uow.CommitAsync();
        if (refund is not null) refundQueue.Enqueue([refund.Id]);
        return data;
    }

    /// <summary>The seller's own courier brought a shipped package back (reference: returned_to_origin): cancelled,
    /// stock back, a prepaid customer refunded; no sale is ever posted.</summary>
    public async Task<JsonObject> SellerRtoAsync(UserModel user, SellerModel seller, Guid subId, string note)
    {
        await using var uow = await db.BeginAsync();
        var (s, o) = await OwnSubAsync(seller.Id, subId, uow);
        if (s.Status != "shipped")
            throw new AppException("Only a package that has shipped and not been delivered can come back to you", "not_shipped", 400);
        if (s.ShippingProvider != "manual")
            throw new AppException($"This package travels with {(s.ShippingProvider == "fleet" ? "our delivery partners" : "Shiprocket")}; it comes back to you through them", "not_own_courier", 400);
        var reason = RtoReasonText + (note.Trim().Length > 0 ? $": {note.Trim()}" : "");
        var refund = await CancelSubOrderAsync(s, "seller", reason, uow);
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = user.Id, Action = "suborder.rto",
            EntityType = "sub_order", EntityId = s.Id.ToString(), Detail = reason, CreatedAt = DateTimeFunctions.UtcNow(),
        }, uow.Transaction);
        var data = SellerSubJson(s, o, await orders.ItemsAsync([s.Id], uow), full: true);
        await uow.CommitAsync();
        if (refund is not null) refundQueue.Enqueue([refund.Id]);
        return data;
    }

    /// <summary>confirm / pack / ship / deliver (reference: _act). Ship first records the courier on the package.</summary>
    public async Task<JsonObject> SellerActAsync(UserModel user, SellerModel seller, Guid subId, string dst, string note = "",
        string? courierName = null, string? trackingNumber = null, string? trackingUrl = null)
    {
        await using var uow = await db.BeginAsync();
        var (s, o) = await OwnSubAsync(seller.Id, subId, uow);
        if (dst == "shipped")
        {
            s.CourierName = courierName ?? "";
            s.TrackingNumber = trackingNumber ?? "";
            s.TrackingUrl = trackingUrl ?? "";
        }
        await TransitionAsync(s, dst, "seller", note, uow);
        await audit.InsertAsync(new AuditLogModel
        {
            Id = Guid.NewGuid(), ActorUserId = user.Id, Action = $"suborder.{dst}",
            EntityType = "sub_order", EntityId = s.Id.ToString(), Detail = note, CreatedAt = DateTimeFunctions.UtcNow(),
        }, uow.Transaction);
        await uow.CommitAsync();
        return SellerSubJson(s, o, await orders.ItemsAsync([s.Id]), full: true);
    }

    /// <summary>
    /// Reference: jobs.expire_unpaid_orders. An order whose payment window closed is cancelled unless the gateway
    /// shows a captured/authorized attempt (then it is confirmed instead); a gateway error skips the order rather
    /// than cancelling it.
    /// </summary>
    public async Task<int> ExpireUnpaidOrdersAsync()
    {
        var expired = await orders.PendingPaymentExpiredAsync(DateTimeFunctions.UtcNow());
        var cancelled = 0;
        foreach (var order in expired)
        {
            var paid = false;
            PaymentModel? confirmPay = null;
            string? confirmId = null;
            foreach (var pay in await orders.PaymentsForOrderAsync(order.Id))
            {
                IReadOnlyList<System.Text.Json.Nodes.JsonObject>? attempts;
                try
                {
                    attempts = await razorpay.OrderPaymentsAsync(pay.ProviderOrderId);
                }
                catch (Exception e) when (e is RazorpayBAL.GatewayException or HttpRequestException)
                {
                    attempts = null; // cannot verify right now: leave the order alone
                }
                if (attempts is null) { paid = true; break; }
                foreach (var a in attempts)
                {
                    var st = a["status"]?.GetValue<string>();
                    if (st is "captured" or "authorized") { confirmPay = pay; confirmId = a["id"]!.GetValue<string>(); break; }
                }
                if (confirmId is not null) break;
            }
            if (confirmPay is not null && confirmId is not null)
            {
                try
                {
                    await using var cuow = await db.BeginAsync();
                    var r = await ConfirmWithGatewayAsync(confirmPay, confirmId, cuow);
                    await cuow.CommitAsync();
                    if (r is "paid" or "already") paid = true;
                }
                catch (Exception e) when (e is AppException or RazorpayBAL.GatewayException or HttpRequestException)
                {
                    paid = true; // gateway rejected the confirm: leave the order alone
                }
            }
            if (paid) continue;
            await using var uow = await db.BeginAsync();
            var subs = await orders.SubOrdersForUpdateAsync(order.Id, uow);
            foreach (var sub in subs.Where(s => s.Status == "pending_payment"))
                await CancelSubOrderAsync(sub, "system", "Payment not completed in time", uow);
            await uow.CommitAsync();
            cancelled++;
        }
        return cancelled;
    }

    /// <summary>Reference: jobs.pending_refund_ids — pending refunds the provider never confirmed, requeued.</summary>
    public async Task<IReadOnlyList<Guid>> PendingRefundIdsAsync() =>
        (await orders.PendingRefundIdsAsync()).ToList();

    /// <summary>Reference: jobs.cancel_unconfirmed_orders.</summary>
    public async Task<int> CancelUnconfirmedAsync()
    {
        var hours = (await platform.GetAsync()).Long("auto_cancel_unconfirmed_hours");
        if (hours == 0) return 0;
        var cutoff = DateTimeFunctions.UtcNow() - TimeSpan.FromHours(hours);
        await using var uow = await db.BeginAsync();
        var n = 0;
        foreach (var sub in await orders.UnconfirmedForUpdateAsync(cutoff, uow))
        {
            await CancelSubOrderAsync(sub, "system", "The seller did not confirm the order in time", uow);
            n++;
        }
        await uow.CommitAsync();
        return n;
    }
}
