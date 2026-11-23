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
            // Sending the duplicate-payment refunds to the gateway lands with the refunds runner; the rows are queued.
            _ = await orders.PendingRefundIdsAsync(payment.Id);
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
                        if (result == "refund") _ = await orders.PendingRefundIdsAsync(payment.Id);
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
}
