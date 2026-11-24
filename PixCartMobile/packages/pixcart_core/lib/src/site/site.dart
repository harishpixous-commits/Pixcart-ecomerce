// Site settings from GET /api/site (Admin → Storefront): brand, colours, theme, navigation, features, lists.

import '../format/format.dart' as fmt;
import '../models/json.dart';
import 'theme_tokens.dart';

class LinkItem {
  LinkItem(Json j)
      : label = j.str('label'),
        href = j.str('href');
  final String label;
  final String href;
}

/// Shown only while the API cannot be reached (lib/site-defaults.ts).
const Json fallbackSiteJson = {
  'brand_name': '',
  'tagline': 'Shop from verified sellers across India',
  'logo_url': '',
  'colors': {'primary': '#0B5563', 'primary_dark': '#073B45', 'accent': '#F5A524', 'buy': '#D7263D', 'success': '#1E8E3E', 'page': '#EEF2F4'},
  'radius': 'rounded',
  'theme': 'classic',
  'announcement': {'enabled': false, 'text': '', 'link': '', 'tone': 'accent'},
  'features': {'wishlist': true, 'reviews': true, 'returns': true, 'coupons': true, 'support': true, 'ai': false},
  'cod_enabled': true,
  'free_shipping_threshold_paise': 49900,
  'gallery': {'zoom': true, 'zoom_level': 2.5},
  'nav': {
    'all_menu': true,
    'search_categories': true,
    'show_categories': true,
    'links': [
      {'label': "Today's Deals", 'href': '/deals'},
      {'label': 'Bestsellers', 'href': '/bestsellers'},
      {'label': 'New Releases', 'href': '/new-releases'},
      {'label': 'Coupons', 'href': '/coupons'},
    ],
    'trending': <String>[],
  },
  'home_extras': {'back_to_top': true, 'signin_prompt': true},
};

/// How many results each list shows (lib/site.tsx LIST_DEFAULTS), overridden by the API's `lists`.
const Map<String, int> listDefaults = {
  'search_page_size': 24, 'search_suggestions': 8, 'similar_products': 12, 'sponsored_on_product': 10, 'reviews_page_size': 10,
  'questions_page_size': 10, 'customer_photos_shown': 6, 'highlights_shown': 5, 'compare_max': 4, 'bestseller_badge_top': 10,
  'recently_viewed_max': 12, 'recent_searches_max': 8, 'checkout_suggestions': 10, 'brand_filter_max': 30,
};

class Site {
  Site(this.raw) : tokens = resolveTokens(raw);

  factory Site.fallback() => Site(fallbackSiteJson);

  final Json raw;

  /// The theme's colours, radii and fonts (CSS variables on the website).
  final PcTokens tokens;

  String get brandName => raw.str('brand_name');
  String get tagline => raw.str('tagline');
  String get logoUrl => raw.str('logo_url');
  Json get announcement => raw.obj('announcement');
  List<LinkItem> get headerLinks => raw.list('header_links', LinkItem.new);
  Json get nav => raw.obj('nav');
  List<LinkItem> get navLinks => nav.list('links', LinkItem.new);
  List<LinkItem> get drawerLinks => nav.list('drawer_links', LinkItem.new);
  List<String> get trending => nav.strings('trending');
  Json get features => raw.obj('features');
  bool feature(String name) => features.flag(name, name != 'ai');
  bool get codEnabled => raw.flag('cod_enabled', true);
  bool get onlinePayments => raw.flag('online_payments', true);
  int get freeShippingThresholdPaise => raw.integer('free_shipping_threshold_paise', 49900);
  int get shippingFeePaise => raw.integer('shipping_fee_paise');
  int get maxQtyPerItem => raw.integer('max_qty_per_item', 10);
  Json get gallery => raw.obj('gallery');
  Json get pdp => raw.obj('pdp');
  bool pdpOn(String name) => pdp.flag(name, true);
  Json get reviews => raw.obj('reviews');
  Json get maintenance => raw.obj('maintenance');
  Json get homeExtras => raw.obj('home_extras');
  Json get business => raw.obj('business');
  Json get app => raw.obj('app');

  /// "return" (Razorpay comes back to the order page) or "window".
  String get paymentReturn => raw.str('payment_return', 'return');

  int list(String key) => raw.obj('lists').integer(key, listDefaults[key] ?? 0);

  /// Storefront text with {brand} and {free_delivery_amount} filled in.
  String fill(String text) => fmt.fillTokens(text, brand: brandName, freeShippingThresholdPaise: freeShippingThresholdPaise);
}
