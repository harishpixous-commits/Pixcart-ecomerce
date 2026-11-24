// The JSON the screens use (port of the shop parts of `frontend/src/lib/types.ts`). Every model keeps its `raw`
// map, so a screen can read a field this file does not name yet without a model change.

import 'json.dart';

export 'json.dart';

class SellerRef {
  SellerRef(this.raw)
      : id = raw.str('id'),
        status = raw.str('status'),
        displayName = raw.str('display_name');
  final Json raw;
  final String id;
  final String status;
  final String displayName;
}

class User {
  User(this.raw)
      : id = raw.str('id'),
        name = raw.str('name'),
        phone = raw.strOrNull('phone'),
        email = raw.strOrNull('email'),
        isAdmin = raw.flag('is_admin'),
        marketingOptIn = raw.flag('marketing_opt_in'),
        seller = raw.objOrNull('seller') == null ? null : SellerRef(raw.obj('seller')),
        delivery = raw.objOrNull('delivery');
  final Json raw;
  final String id;
  final String name;
  final String? phone;
  final String? email;
  final bool isAdmin;
  final bool marketingOptIn;
  final SellerRef? seller;
  final Json? delivery;

  String get firstName => name.trim().isEmpty ? '' : name.trim().split(' ').first;
}

class CategoryNode {
  CategoryNode(this.raw)
      : id = raw.str('id'),
        name = raw.str('name'),
        slug = raw.str('slug'),
        imageUrl = raw.str('image_url'),
        productCount = raw.integer('product_count'),
        children = raw.list('children', CategoryNode.new);
  final Json raw;
  final String id;
  final String name;
  final String slug;
  final String imageUrl;
  final int productCount;
  final List<CategoryNode> children;
}

class DealInfo {
  DealInfo(this.raw)
      : kind = raw.str('kind'),
        label = raw.str('label'),
        endsAt = raw.str('ends_at'),
        dealPrice = raw.integer('deal_price'),
        regularPrice = raw.intOrNull('regular_price'),
        claimedPct = raw.intOrNull('claimed_pct'),
        unitsLeft = raw.intOrNull('units_left'),
        variantId = raw.str('variant_id');
  final Json raw;

  /// lightning | deal_of_day | limited
  final String kind;
  final String label;
  final String endsAt;
  final int dealPrice;
  final int? regularPrice;
  final int? claimedPct;
  final int? unitsLeft;
  final String variantId;
}

class UnitPrice {
  UnitPrice(Json raw)
      : paise = raw.integer('paise'),
        per = raw.str('per');
  final int paise;
  final String per;
}

class ProductCard {
  ProductCard(this.raw)
      : id = raw.str('id'),
        slug = raw.str('slug'),
        title = raw.str('title'),
        brand = raw.str('brand'),
        image = raw.str('image'),
        price = raw.integer('price'),
        mrp = raw.integer('mrp'),
        discountPct = raw.integer('discount_pct'),
        ratingAvg = raw.dbl('rating_avg'),
        ratingCount = raw.integer('rating_count'),
        inStock = raw.flag('in_stock', true),
        sellerName = raw.str('seller_name'),
        deal = raw.objOrNull('deal') == null ? null : DealInfo(raw.obj('deal')),
        unitPrice = raw.objOrNull('unit_price') == null ? null : UnitPrice(raw.obj('unit_price')),
        bought = raw.strOrNull('bought'),
        variantCount = raw.integer('variant_count', 1),
        variantId = raw.strOrNull('variant_id'),
        sponsored = raw.flag('sponsored'),
        href = raw.strOrNull('href'),
        deliveryBy = raw.strOrNull('delivery_by'),
        startsAt = raw.strOrNull('starts_at');
  final Json raw;
  final String id;
  final String slug;
  final String title;
  final String brand;
  final String image;
  final int price;
  final int mrp;
  final int discountPct;
  final double ratingAvg;
  final int ratingCount;
  final bool inStock;
  final String sellerName;
  final DealInfo? deal;
  final UnitPrice? unitPrice;
  final String? bought;
  final int variantCount;
  final String? variantId;
  final bool sponsored;
  final String? href;
  final String? deliveryBy;
  final String? startsAt;
}

class Crumb {
  Crumb(Json raw)
      : name = raw.str('name'),
        slug = raw.str('slug');
  final String name;
  final String slug;
}

class SearchResult {
  SearchResult(this.raw)
      : items = raw.list('items', ProductCard.new),
        total = raw.integer('total'),
        page = raw.integer('page', 1),
        pageSize = raw.integer('page_size', 24),
        category = raw.objOrNull('category'),
        breadcrumbs = raw.list('breadcrumbs', Crumb.new),
        brands = [for (final b in raw.obj('facets').maps('brands')) (name: b.str('name'), count: b.integer('count'))],
        priceMin = raw.obj('facets').integer('price_min'),
        priceMax = raw.obj('facets').integer('price_max');
  final Json raw;
  final List<ProductCard> items;
  final int total;
  final int page;
  final int pageSize;
  final Json? category;
  final List<Crumb> breadcrumbs;
  final List<({String name, int count})> brands;
  final int priceMin;
  final int priceMax;
}

class PublicVariant {
  PublicVariant(this.raw)
      : id = raw.str('id'),
        options = raw.obj('options').map((k, v) => MapEntry(k, '$v')),
        label = raw.str('label'),
        price = raw.integer('price'),
        mrp = raw.integer('mrp'),
        discountPct = raw.integer('discount_pct'),
        inStock = raw.flag('in_stock', true),
        lowStock = raw.flag('low_stock'),
        stockLeft = raw.intOrNull('stock_left'),
        unitPrice = raw.objOrNull('unit_price') == null ? null : UnitPrice(raw.obj('unit_price'));
  final Json raw;
  final String id;
  final Map<String, String> options;
  final String label;
  final int price;
  final int mrp;
  final int discountPct;
  final bool inStock;
  final bool lowStock;
  final int? stockLeft;
  final UnitPrice? unitPrice;
}

class ProductPage {
  ProductPage(this.raw)
      : id = raw.str('id'),
        slug = raw.str('slug'),
        title = raw.str('title'),
        brand = raw.str('brand'),
        description = raw.str('description'),
        highlights = raw.strings('highlights'),
        specs = raw.obj('specs').map((k, v) => MapEntry(k, '$v')),
        images = raw.strings('images'),
        videos = raw.maps('videos'),
        countryOfOrigin = raw.str('country_of_origin'),
        returnWindowDays = raw.integer('return_window_days'),
        ratingAvg = raw.dbl('rating_avg'),
        ratingCount = raw.integer('rating_count'),
        price = raw.integer('price'),
        mrp = raw.integer('mrp'),
        discountPct = raw.integer('discount_pct'),
        inStock = raw.flag('in_stock', true),
        breadcrumbs = raw.list('breadcrumbs', Crumb.new),
        optionAxes = raw.obj('option_axes').map((k, v) => MapEntry(k, [for (final x in (v as List? ?? const [])) '$x'])),
        variants = raw.list('variants', PublicVariant.new),
        seller = raw.obj('seller'),
        similar = raw.list('similar', ProductCard.new),
        deal = raw.objOrNull('deal') == null ? null : DealInfo(raw.obj('deal')),
        keySpecs = [for (final k in raw.maps('key_specs')) (label: k.str('label'), value: k.str('value'))],
        info = [for (final k in raw.maps('info')) (label: k.str('label'), value: k.str('value'))],
        offers = raw.maps('offers'),
        boughtLastMonth = raw.strOrNull('bought_last_month'),
        bestseller = raw.objOrNull('bestseller'),
        sellerSnapshot = raw.objOrNull('seller_snapshot'),
        returnable = raw.flag('returnable', true);
  final Json raw;
  final String id;
  final String slug;
  final String title;
  final String brand;
  final String description;
  final List<String> highlights;
  final Map<String, String> specs;
  final List<String> images;
  final List<Json> videos;
  final String countryOfOrigin;
  final int returnWindowDays;
  final double ratingAvg;
  final int ratingCount;
  final int price;
  final int mrp;
  final int discountPct;
  final bool inStock;
  final List<Crumb> breadcrumbs;
  final Map<String, List<String>> optionAxes;
  final List<PublicVariant> variants;
  final Json seller;
  final List<ProductCard> similar;
  final DealInfo? deal;
  final List<({String label, String value})> keySpecs;
  final List<({String label, String value})> info;
  final List<Json> offers;
  final String? boughtLastMonth;
  final Json? bestseller;
  final Json? sellerSnapshot;
  final bool returnable;
}

class CartLine {
  CartLine(this.raw)
      : id = raw.str('id'),
        variantId = raw.str('variant_id'),
        productSlug = raw.str('product_slug'),
        title = raw.str('title'),
        variantLabel = raw.str('variant_label'),
        image = raw.str('image'),
        qty = raw.integer('qty'),
        price = raw.integer('price'),
        mrp = raw.integer('mrp'),
        lineTotal = raw.integer('line_total'),
        stockLeft = raw.integer('stock_left'),
        maxQty = raw.intOrNull('max_qty'),
        problem = raw.str('problem');
  final Json raw;
  final String id;
  final String variantId;
  final String productSlug;
  final String title;
  final String variantLabel;
  final String image;
  final int qty;
  final int price;
  final int mrp;
  final int lineTotal;
  final int stockLeft;
  final int? maxQty;
  final String problem;
}

class CartGroup {
  CartGroup(this.raw)
      : seller = raw.obj('seller'),
        itemsTotal = raw.integer('items_total'),
        shippingFee = raw.integer('shipping_fee'),
        freeShippingGap = raw.integer('free_shipping_gap'),
        lines = raw.list('lines', CartLine.new);
  final Json raw;
  final Json seller;
  final int itemsTotal;
  final int shippingFee;
  final int freeShippingGap;
  final List<CartLine> lines;
}

class FeeLine {
  FeeLine(this.raw)
      : code = raw.str('code'),
        label = raw.str('label'),
        info = raw.str('info'),
        amount = raw.integer('amount'),
        listAmount = raw.integer('list_amount'),
        hint = raw.str('hint');
  final Json raw;
  final String code;
  final String label;
  final String info;
  final int amount;
  final int listAmount;
  final String hint;
}

class CartSummary {
  CartSummary(this.raw)
      : mrpTotal = raw.integer('mrp_total'),
        discount = raw.integer('discount'),
        itemsTotal = raw.integer('items_total'),
        shippingTotal = raw.integer('shipping_total'),
        grandTotal = raw.integer('grand_total'),
        itemCount = raw.integer('item_count'),
        hasProblems = raw.flag('has_problems'),
        codFee = raw.integer('cod_fee'),
        fees = raw.list('fees', FeeLine.new),
        feesTotal = raw.integer('fees_total'),
        feeSavings = raw.integer('fee_savings'),
        tip = raw.integer('tip'),
        couponDiscount = raw.integer('coupon_discount');
  final Json raw;
  final int mrpTotal;
  final int discount;
  final int itemsTotal;
  final int shippingTotal;
  final int grandTotal;
  final int itemCount;
  final bool hasProblems;
  final int codFee;
  final List<FeeLine> fees;
  final int feesTotal;
  final int feeSavings;
  final int tip;
  final int couponDiscount;
}

class CartView {
  CartView(this.raw)
      : groups = raw.list('groups', CartGroup.new),
        summary = CartSummary(raw.obj('summary')),
        codAvailable = raw.flag('cod_available'),
        codMaxOrderPaise = raw.integer('cod_max_order_paise'),
        onlineAvailable = raw.flag('online_available', true),
        notice = raw.strOrNull('notice'),
        codAllowed = raw['cod_allowed'] is bool ? raw['cod_allowed'] as bool : null,
        hints = raw.strings('hints'),
        checkout = raw.objOrNull('checkout');
  final Json raw;
  final List<CartGroup> groups;
  final CartSummary summary;
  final bool codAvailable;
  final int codMaxOrderPaise;
  final bool onlineAvailable;
  final String? notice;
  final bool? codAllowed;
  final List<String> hints;
  final Json? checkout;

  List<CartLine> get lines => [for (final g in groups) ...g.lines];
}

class Address {
  Address(this.raw)
      : id = raw.str('id'),
        fullName = raw.str('full_name'),
        phone = raw.str('phone'),
        line1 = raw.str('line1'),
        line2 = raw.str('line2'),
        landmark = raw.str('landmark'),
        city = raw.str('city'),
        stateCode = raw.str('state_code'),
        state = raw.str('state'),
        pincode = raw.str('pincode'),
        kind = raw.str('kind', 'home'),
        isDefault = raw.flag('is_default'),
        label = raw.str('label'),
        instructions = raw.str('instructions'),
        lat = raw.dblOrNull('lat'),
        lng = raw.dblOrNull('lng');
  final Json raw;
  final String id;
  final String fullName;
  final String phone;
  final String line1;
  final String line2;
  final String landmark;
  final String city;
  final String stateCode;
  final String state;
  final String pincode;
  final String kind;
  final bool isDefault;
  final String label;
  final String instructions;
  final double? lat;
  final double? lng;

  /// "12 MG Road, Indiranagar, Bengaluru, Karnataka 560038"
  String get oneLine => [line1, line2, landmark, city, '$state $pincode'.trim()].where((s) => s.trim().isNotEmpty).join(', ');
}

class OrderItem {
  OrderItem(this.raw)
      : title = raw.str('title'),
        productSlug = raw.strOrNull('product_slug'),
        variantLabel = raw.str('variant_label'),
        image = raw.str('image'),
        qty = raw.integer('qty'),
        unitPrice = raw.integer('unit_price'),
        unitMrp = raw.integer('unit_mrp'),
        lineTotal = raw.integer('line_total');
  final Json raw;
  final String title;
  final String? productSlug;
  final String variantLabel;
  final String image;
  final int qty;
  final int unitPrice;
  final int unitMrp;
  final int lineTotal;
}

class SubOrderView {
  SubOrderView(this.raw)
      : id = raw.str('id'),
        number = raw.str('number'),
        status = raw.str('status'),
        expectedDeliveryAt = raw.strOrNull('expected_delivery_at'),
        seller = raw.objOrNull('seller'),
        itemsTotal = raw.integer('items_total'),
        shippingFee = raw.integer('shipping_fee'),
        total = raw.integer('total'),
        courierName = raw.str('courier_name'),
        trackingNumber = raw.str('tracking_number'),
        trackingUrl = raw.str('tracking_url'),
        shippedAt = raw.strOrNull('shipped_at'),
        deliveredAt = raw.strOrNull('delivered_at'),
        cancelledAt = raw.strOrNull('cancelled_at'),
        cancelReason = raw.str('cancel_reason'),
        cancelledBy = raw.str('cancelled_by'),
        canCancel = raw.flag('can_cancel'),
        refundIfCancelled = raw.integer('refund_if_cancelled'),
        items = raw.list('items', OrderItem.new);
  final Json raw;
  final String id;
  final String number;
  final String status;
  final String? expectedDeliveryAt;
  final Json? seller;
  final int itemsTotal;
  final int shippingFee;
  final int total;
  final String courierName;
  final String trackingNumber;
  final String trackingUrl;
  final String? shippedAt;
  final String? deliveredAt;
  final String? cancelledAt;
  final String cancelReason;
  final String cancelledBy;
  final bool canCancel;
  final int refundIfCancelled;
  final List<OrderItem> items;
}

class CheckoutPayload {
  CheckoutPayload(this.raw)
      : provider = raw.str('provider', 'razorpay'),
        keyId = raw.str('key_id'),
        checkoutUrl = raw.strOrNull('checkout_url'),
        razorpayOrderId = raw.str('razorpay_order_id'),
        amount = raw.integer('amount'),
        currency = raw.str('currency', 'INR'),
        name = raw.str('name'),
        description = raw.str('description'),
        prefill = raw.obj('prefill'),
        expiresAt = raw.strOrNull('expires_at'),
        methods = raw.obj('methods').map((k, v) => MapEntry(k, v == true)),
        cardNetworks = raw.strings('card_networks'),
        customerId = raw.strOrNull('customer_id');
  final Json raw;
  final String provider;
  final String keyId;
  final String? checkoutUrl;
  final String razorpayOrderId;
  final int amount;
  final String currency;
  final String name;
  final String description;
  final Json prefill;
  final String? expiresAt;
  final Map<String, bool> methods;
  final List<String> cardNetworks;
  final String? customerId;
}

class OrderDetail {
  OrderDetail(this.raw)
      : id = raw.str('id'),
        number = raw.str('number'),
        status = raw.str('status'),
        paymentMethod = raw.str('payment_method'),
        paymentStatus = raw.str('payment_status'),
        shipTo = raw.obj('ship_to').map((k, v) => MapEntry(k, v == null ? '' : '$v')),
        itemsTotal = raw.integer('items_total'),
        shippingTotal = raw.integer('shipping_total'),
        codFee = raw.integer('cod_fee'),
        fees = raw.list('fees', FeeLine.new),
        tip = raw.integer('tip'),
        grandTotal = raw.integer('grand_total'),
        refundedTotal = raw.integer('refunded_total'),
        discountTotal = raw.integer('discount_total'),
        couponCode = raw.str('coupon_code'),
        createdAt = raw.str('created_at'),
        placedAt = raw.strOrNull('placed_at'),
        paymentExpiresAt = raw.strOrNull('payment_expires_at'),
        subOrders = raw.list('sub_orders', SubOrderView.new),
        timeline = raw.maps('timeline'),
        refunds = raw.maps('refunds'),
        payment = raw.objOrNull('payment') == null ? null : CheckoutPayload(raw.obj('payment')),
        paid = raw.objOrNull('paid'),
        fleet = raw.obj('fleet');
  final Json raw;
  final String id;
  final String number;
  final String status;
  final String paymentMethod;
  final String paymentStatus;
  final Map<String, String> shipTo;
  final int itemsTotal;
  final int shippingTotal;
  final int codFee;
  final List<FeeLine> fees;
  final int tip;
  final int grandTotal;
  final int refundedTotal;
  final int discountTotal;
  final String couponCode;
  final String createdAt;
  final String? placedAt;
  final String? paymentExpiresAt;
  final List<SubOrderView> subOrders;
  final List<Json> timeline;
  final List<Json> refunds;
  final CheckoutPayload? payment;
  final Json? paid;
  final Json fleet;
}

class OrderSummary {
  OrderSummary(this.raw)
      : id = raw.str('id'),
        number = raw.str('number'),
        status = raw.str('status'),
        paymentMethod = raw.str('payment_method'),
        paymentStatus = raw.str('payment_status'),
        grandTotal = raw.integer('grand_total'),
        createdAt = raw.str('created_at'),
        itemCount = raw.integer('item_count'),
        items = raw.maps('items'),
        subStatuses = raw.strings('sub_statuses');
  final Json raw;
  final String id;
  final String number;
  final String status;
  final String paymentMethod;
  final String paymentStatus;
  final int grandTotal;
  final String createdAt;
  final int itemCount;
  final List<Json> items;
  final List<String> subStatuses;
}

class Paged<T> {
  Paged(Json raw, T Function(Json) parse)
      : items = raw.list('items', parse),
        total = raw.integer('total'),
        page = raw.integer('page', 1),
        pageSize = raw.integer('page_size', 20),
        statusCounts = raw.obj('status_counts').map((k, v) => MapEntry(k, v is num ? v.toInt() : 0));
  final List<T> items;
  final int total;
  final int page;
  final int pageSize;
  final Map<String, int> statusCounts;
}

class HomeSection {
  HomeSection(this.raw)
      : id = raw.str('id'),
        kind = raw.str('kind'),
        title = raw.str('title'),
        device = raw.str('device', 'all'),
        config = raw.obj('config'),
        products = raw.list('products', ProductCard.new),
        categories = raw.list('categories', CategoryNode.new);
  final Json raw;
  final String id;
  final String kind;
  final String title;
  final String device;
  final Json config;
  final List<ProductCard> products;
  final List<CategoryNode> categories;
}

/// A line of the cart kept on the phone while signed out (lib/session.tsx GuestLine).
class GuestLine {
  GuestLine({
    required this.variantId,
    required this.qty,
    required this.title,
    required this.image,
    required this.price,
    required this.mrp,
    required this.slug,
    this.variantLabel = '',
    this.sellerName = '',
    this.max,
  });

  factory GuestLine.fromJson(Json j) => GuestLine(
        variantId: j.str('variant_id'),
        qty: j.integer('qty', 1),
        title: j.str('title'),
        image: j.str('image'),
        price: j.integer('price'),
        mrp: j.integer('mrp'),
        slug: j.str('slug'),
        variantLabel: j.str('variant_label'),
        sellerName: j.str('seller_name'),
        max: j.intOrNull('max'),
      );

  final String variantId;
  int qty;
  final String title;
  final String image;
  final int price;
  final int mrp;
  final String slug;
  final String variantLabel;
  final String sellerName;
  int? max;

  Json toJson() => {
        'variant_id': variantId,
        'qty': qty,
        'title': title,
        'image': image,
        'price': price,
        'mrp': mrp,
        'slug': slug,
        'variant_label': variantLabel,
        'seller_name': sellerName,
        if (max != null) 'max': max,
      };
}
