using System.Text.Json.Nodes;
using BAL.Interface;
using DAL;
using Model.DomainModel;
using Utils;
using Utils.Interface;

namespace BAL;

/// <summary>
/// The cart and "Saved for later" (reference: routers/cart.py plus the cart parts of services/orders.py). Same
/// limits, notes, problem texts and payload shape, so the live e2e suite and the Angular port see the same API.
/// </summary>
public class CartBAL(CartDAL cart, ICatalogBAL catalog, IPlatformSettingsBAL platform, IFeesBAL fees, IDealsBAL deals, IRazorpayBAL razorpay, IMySqlDapperHelper db) : ICartBAL
{
    public const int MaxLines = 50;
    public const int MaxSaved = 100;
    public const int MaxQty = 10; // most of one item a cart line can hold

    /// <summary>One cart line with what the view needs (reference: services/orders.py CartLine).</summary>
    public sealed record CartLine(CartItemModel Item, VariantModel Variant, ProductModel Product, SellerModel Seller, string Image)
    {
        public string Problem { get; set; } = ""; // why this line cannot be bought right now
        public string ShipsOn { get; set; } = "";  // pre-order: when this item starts shipping
        public int MinQty { get; set; } = 1;      // the seller's minimum order quantity for this item
        public int MaxQty { get; set; }           // the most this line can hold now
        public long LineTotal => Variant.PricePaise * Item.Qty;
    }

    /// <summary>The lines of one seller with their package's delivery fee (reference: SellerGroup).</summary>
    public sealed record SellerGroup(SellerModel Seller)
    {
        public List<CartLine> Lines { get; } = [];
        public long ShippingFee { get; set; }
        public long ItemsTotal => Lines.Where(l => l.Problem == "").Sum(l => l.LineTotal);
    }

    /// <summary>The cart lines with availability problems and buy limits filled in (reference: load_cart).</summary>
    public async Task<List<CartLine>> LoadCartAsync(Guid userId, IUnitOfWork? uow = null, bool forUpdate = false)
    {
        var rows = await cart.LoadAsync(userId, uow, forUpdate);
        var imgs = await catalog.ImagesForAsync(rows.Select(r => r.Product.Id).Distinct());
        var cfg = await platform.GetAsync();
        var perItem = cfg.Int("max_qty_per_item");
        var atDeal = await deals.UnitsLeftAsync(rows.Select(r => r.Variant.Id));
        var lines = new List<CartLine>();
        foreach (var (item, variant, product, seller) in rows)
        {
            var line = new CartLine(item, variant, product, seller, imgs.GetValueOrDefault(product.Id)?.FirstOrDefault() ?? "");
            var dealLeft = atDeal.GetValueOrDefault(variant.Id);
            line.MaxQty = Math.Max(0, Math.Min(Math.Min(variant.Stock, perItem), dealLeft > 0 ? dealLeft : perItem));
            var det = ProductInfo.DetailsOf(product.Details);
            line.MinQty = Math.Max(1, Math.Min(det.MinQty, perItem));
            line.ShipsOn = det.PreorderDate();
            if (product.Status != "approved" || seller.Status != "approved" || !variant.IsActive)
                line.Problem = "This item is no longer available";
            else if (seller.HolidayMode)
                line.Problem = "The seller is not taking orders right now";
            else if (variant.Stock <= 0)
                line.Problem = "Out of stock";
            else if (variant.Stock < item.Qty)
                line.Problem = $"Only {variant.Stock} left in stock";
            else if (item.Qty < line.MinQty)
                line.Problem = $"The minimum order for this item is {line.MinQty}";
            else if (item.Qty > perItem)
                line.Problem = $"You can buy at most {perItem} of this item in one order";
            else if (dealLeft > 0 && item.Qty > dealLeft)
                line.Problem = $"Only {dealLeft} left at the deal price";
            lines.Add(line);
        }
        return lines;
    }

    /// <summary>Lines grouped by seller with the delivery fee of each package (reference: group_by_seller).</summary>
    public static long FreeThreshold(SellerModel seller, JsonObject cfg, (long Min, long Max)? bounds) =>
        bounds is null || seller.FreeShippingThresholdPaise is null ? cfg.Int("free_shipping_threshold_paise") : Math.Min(Math.Max(seller.FreeShippingThresholdPaise.Value, bounds.Value.Min), bounds.Value.Max);

    public static List<SellerGroup> GroupBySeller(IEnumerable<CartLine> lines, JsonObject cfg, (long Amount, bool Waive) remote = default, (long Min, long Max)? bounds = null, long? stateFee = null, bool memberFree = false)
    {
        var groups = new Dictionary<Guid, SellerGroup>();
        foreach (var line in lines)
        {
            if (!groups.TryGetValue(line.Seller.Id, out var g)) groups[line.Seller.Id] = g = new SellerGroup(line.Seller);
            g.Lines.Add(line);
        }
        foreach (var g in groups.Values)
        {
            var hasItems = g.ItemsTotal > 0;
            g.ShippingFee = !hasItems || memberFree || g.ItemsTotal >= FreeThreshold(g.Seller, cfg, bounds) ? 0 : stateFee ?? cfg.Int("shipping_fee_paise");
            // Remote-area surcharge (Admin → Growth → Shipping zones): once per seller package.
            if (hasItems && remote.Amount > 0 && !memberFree && !(remote.Waive && g.ShippingFee == 0)) g.ShippingFee += remote.Amount;
        }
        return groups.Values.ToList();
    }

    /// <summary>The cart and its bill; with the checkout settings the marketplace's fees and the nudges are included
    /// (reference: cart_payload — identical keys and maths).</summary>
    public static JsonObject CartPayload(List<SellerGroup> groups, JsonObject cfg, bool onlineAvailable, JsonObject? ck, (long Min, long Max)? bounds = null)
    {
        var itemsTotal = groups.Sum(g => g.ItemsTotal);
        var shipping = groups.Sum(g => g.ShippingFee);
        var mrpTotal = groups.SelectMany(g => g.Lines).Where(l => l.Problem == "").Sum(l => l.Variant.MrpPaise * l.Item.Qty);
        var feeLines = ck is not null ? FeesBAL.OrderFees(ck, itemsTotal) : [];
        var feesTotal = feeLines.OfType<JsonObject>().Sum(f => f["amount"]!.GetValue<long>());
        var groupViews = new JsonArray(groups.Select(g => (JsonNode?)new JsonObject
        {
            ["seller"] = new JsonObject { ["id"] = g.Seller.Id.ToString(), ["name"] = g.Seller.DisplayName, ["slug"] = g.Seller.Slug },
            ["items_total"] = g.ItemsTotal,
            ["shipping_fee"] = g.ShippingFee,
            ["free_shipping_gap"] = g.ItemsTotal > 0 && g.ItemsTotal < FreeThreshold(g.Seller, cfg, bounds) ? Math.Max(0, FreeThreshold(g.Seller, cfg, bounds) - g.ItemsTotal) : 0,
            ["lines"] = new JsonArray(g.Lines.Select(line => (JsonNode?)new JsonObject
            {
                ["id"] = line.Item.Id.ToString(),
                ["variant_id"] = line.Variant.Id.ToString(),
                ["product_id"] = line.Product.Id.ToString(),
                ["product_slug"] = line.Product.Slug,
                ["title"] = line.Product.Title,
                ["variant_label"] = ProductInfo.VariantLabel(line.Variant.Options),
                ["image"] = line.Image,
                ["qty"] = line.Item.Qty,
                ["price"] = line.Variant.PricePaise,
                ["mrp"] = line.Variant.MrpPaise,
                ["line_total"] = line.LineTotal,
                ["stock_left"] = line.Variant.Stock,
                ["max_qty"] = line.MaxQty,
                ["min_qty"] = line.MinQty,
                ["ships_on"] = line.ShipsOn,
                ["problem"] = line.Problem,
            }).ToArray()),
        }).ToArray());
        var view = new JsonObject
        {
            ["groups"] = groupViews,
            ["summary"] = new JsonObject
            {
                ["mrp_total"] = mrpTotal,
                ["discount"] = mrpTotal - itemsTotal,
                ["items_total"] = itemsTotal,
                ["shipping_total"] = shipping,
                ["fees"] = feeLines,
                ["fees_total"] = feesTotal,
                ["fee_savings"] = feeLines.OfType<JsonObject>().Sum(f => (f["list_amount"]?.GetValue<long>() ?? 0) is var la && la > 0 ? la - f["amount"]!.GetValue<long>() : 0),
                ["grand_total"] = itemsTotal + shipping + feesTotal,
                ["item_count"] = groups.SelectMany(g => g.Lines).Where(l => l.Problem == "").Sum(l => l.Item.Qty),
                ["has_problems"] = groups.SelectMany(g => g.Lines).Any(l => l.Problem != ""),
            },
            ["cod_available"] = cfg.Bool("cod_enabled"),
            ["cod_max_order_paise"] = cfg.Int("cod_max_order_paise"),
            ["online_available"] = onlineAvailable,
        };
        if (ck is not null)
        {
            view["hints"] = FeesBAL.Hints(ck, cfg, itemsTotal, groupViews);
            view["checkout"] = FeesBAL.Public(ck);
        }
        return view;
    }

    /// <summary>The full cart view (reference: routers/cart.py _view).</summary>
    public async Task<JsonObject> ViewAsync(Guid userId, string? pincode = null, string? stateCode = null, bool freeShipping = false)
    {
        var cfg = await platform.GetAsync();
        var ck = await fees.GetAsync();
        if (stateCode is not null) cfg = await ShippingZones.WithStateThresholdAsync(db, cfg, stateCode);
        return CartPayload(GroupBySeller(await LoadCartAsync(userId), cfg, pincode is null ? default : await ShippingZones.SurchargeAsync(db, pincode), await ShippingZones.SellerFreeBoundsAsync(db), stateCode is null ? null : await ShippingZones.StateFeeAsync(db, stateCode), freeShipping || await LoyaltyPoints.FreeDeliveryAsync(db, userId)), cfg, await razorpay.OnlinePaymentsAsync(), ck, await ShippingZones.SellerFreeBoundsAsync(db));
    }

    /// <summary>
    /// Puts the quantity in the cart, lowered to what can be bought (stock, the per-item limit in Admin → Marketplace
    /// settings, units left at a deal price). Returns a note for the shopper when it had to be lowered (reference: _set).
    /// </summary>
    public async Task<string> SetAsync(Guid userId, Guid variantId, int qty, bool add = false)
    {
        var item = await cart.GetItemAsync(userId, variantId);
        if (qty <= 0 && !add)
        {
            if (item is not null) await cart.DeleteItemAsync(userId, variantId);
            return "";
        }
        var variant = await cart.PurchasableAsync(variantId) ?? throw new NotFoundException("Product");
        var cfg = await platform.GetAsync();
        if (variant.Stock <= 0) throw new AppException("This item is out of stock", "out_of_stock");
        var wanted = (add && item is not null ? item.Qty : 0) + qty;
        var newQty = wanted;
        var note = "";
        var dealLeft = (await deals.UnitsLeftAsync([variant.Id])).GetValueOrDefault(variant.Id);
        foreach (var (cap, why) in new (long Cap, string Why)[]
        {
            (cfg.Int("max_qty_per_item"), $"You can buy at most {cfg.Int("max_qty_per_item")} of this item in one order"),
            (variant.Stock, $"Only {variant.Stock} left in stock"),
            (dealLeft, $"Only {dealLeft} left at the deal price"),
        })
        {
            if (cap > 0 && cap < newQty) { newQty = (int)cap; note = why; }
        }
        var prod = await catalog.GetProductAsync(variant.ProductId);
        var minQty = Math.Max(1, Math.Min(prod is null ? 1 : ProductInfo.DetailsOf(prod.Details).MinQty, cfg.Int("max_qty_per_item")));
        if (newQty < minQty)
        {
            if (minQty > variant.Stock) throw new AppException($"The minimum order for this item is {minQty}, but only {variant.Stock} are in stock", "below_minimum");
            newQty = minQty; note = $"The minimum order for this item is {minQty}";
        }
        if (note.Length > 0) note = $"{note}, so your cart has {newQty}.";
        if (item is null)
        {
            if (await cart.CountItemsAsync(userId) >= MaxLines)
                throw new AppException($"Your cart can hold up to {MaxLines} different items", "cart_full");
            var now = DateTime.UtcNow;
            await cart.InsertItemAsync(new CartItemModel { Id = Guid.NewGuid(), UserId = userId, VariantId = variantId, Qty = newQty, CreatedAt = now, UpdatedAt = now });
        }
        else
        {
            await cart.UpdateQtyAsync(userId, variantId, newQty);
        }
        return note;
    }

    // ---------------------------------------------------------------- saved for later

    /// <summary>The saved lines for the view (reference: _saved_view).</summary>
    public async Task<JsonObject> SavedViewAsync(Guid userId)
    {
        var rows = await cart.SavedAsync(userId);
        var imgs = await catalog.ImagesForAsync(rows.Select(r => r.Product.Id).Distinct());
        return new JsonObject
        {
            ["items"] = new JsonArray(rows.Select(r => (JsonNode?)new JsonObject
            {
                ["variant_id"] = r.Variant.Id.ToString(),
                ["product_id"] = r.Product.Id.ToString(),
                ["slug"] = r.Product.Slug,
                ["title"] = r.Product.Title,
                ["variant_label"] = ProductInfo.VariantLabel(r.Variant.Options),
                ["image"] = imgs.GetValueOrDefault(r.Product.Id)?.FirstOrDefault() ?? "",
                ["price"] = r.Variant.PricePaise,
                ["mrp"] = r.Variant.MrpPaise,
                ["in_stock"] = r.Product.Status == "approved" && r.Variant.IsActive && r.Variant.Stock > 0,
                ["available"] = r.Product.Status == "approved" && r.Variant.IsActive,
                ["saved_at"] = new DateTimeOffset(DateTime.SpecifyKind(r.Saved.CreatedAt, DateTimeKind.Utc)).ToString("yyyy-MM-ddTHH:mm:ss.ffffffzzz"),
            }).ToArray()),
        };
    }

    /// <summary>Moves a cart line to "Saved for later" (it keeps its place even when out of stock).</summary>
    public async Task<JsonObject> SaveForLaterAsync(Guid userId, Guid variantId)
    {
        _ = await cart.GetItemAsync(userId, variantId) ?? throw new NotFoundException("Cart item");
        if (await cart.GetSavedAsync(userId, variantId) is null)
        {
            if (await cart.CountSavedAsync(userId) >= MaxSaved)
                throw new AppException($"You can save up to {MaxSaved} items for later", "saved_full");  // the cart line stays
            await cart.InsertSavedAsync(new SavedItemModel { UserId = userId, VariantId = variantId, CreatedAt = DateTime.UtcNow });
        }
        await cart.DeleteItemAsync(userId, variantId);
        return new JsonObject { ["cart"] = await ViewAsync(userId), ["saved"] = await SavedViewAsync(userId) };
    }

    /// <summary>Moves a saved line back into the cart.</summary>
    public async Task<JsonObject> MoveToCartAsync(Guid userId, Guid variantId)
    {
        var saved = await cart.GetSavedAsync(userId, variantId) ?? throw new NotFoundException("Saved item");
        await SetAsync(userId, variantId, 1, add: true);
        await cart.DeleteSavedAsync(userId, variantId);
        return new JsonObject { ["cart"] = await ViewAsync(userId), ["saved"] = await SavedViewAsync(userId) };
    }

    /// <summary>Forgets a saved line.</summary>
    public async Task<JsonObject> DeleteSavedAsync(Guid userId, Guid variantId)
    {
        await cart.DeleteSavedAsync(userId, variantId);
        return await SavedViewAsync(userId);
    }

    public async Task<JsonObject> ReorderAsync(Guid userId, Guid orderId)
    {
        var owned = await db.QueryFirstOrDefaultAsync<int>("SELECT COUNT(*) FROM orders WHERE id = @orderId AND user_id = @userId", new { orderId, userId });
        if (owned == 0) throw new NotFoundException("Order");
        var lines = (await db.QueryAsync<(Guid VariantId, int Qty, string Title)>(
            "SELECT i.variant_id AS VariantId, i.qty AS Qty, i.title AS Title FROM order_items i JOIN sub_orders s ON s.id = i.sub_order_id WHERE s.order_id = @orderId ORDER BY i.title", new { orderId })).ToList();
        int added = 0; var skipped = new JsonArray(); var notices = new JsonArray();
        foreach (var (variantId, qty, title) in lines)
        {
            string note;
            try { note = await SetAsync(userId, variantId, Math.Max(1, Math.Min(qty, 10)), add: true); }
            catch (AppException e) { skipped.Add(new JsonObject { ["title"] = title, ["reason"] = e.Message }); continue; }
            added++;
            if (!string.IsNullOrEmpty(note)) notices.Add($"{title}: {note}");
        }
        var view = await ViewAsync(userId);
        view["added"] = added; view["skipped"] = skipped; view["notices"] = notices;
        return view;
    }

    /// <summary>Moves a signed-out (browser) cart into the account after login; unavailable items are skipped.</summary>
    public async Task<JsonObject> MergeAsync(Guid userId, IReadOnlyList<(Guid VariantId, int Qty)> items)
    {
        foreach (var (variantId, qty) in items)
        {
            if (qty < 1) continue;
            try { await SetAsync(userId, variantId, qty, add: true); }
            catch (AppException) { /* unavailable items are skipped */ }
        }
        return await ViewAsync(userId);
    }
}
