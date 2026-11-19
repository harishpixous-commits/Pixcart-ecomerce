export type Paise = number;

export interface SellerRef {
  id: string;
  status: SellerStatus;
  display_name: string;
}

export type SellerStatus = "draft" | "submitted" | "approved" | "rejected" | "suspended";

export interface User {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  is_admin: boolean;
  admin_role?: string | null;
  marketing_opt_in?: boolean;
  totp_enabled?: boolean;
  seller: SellerRef | null;
  /** Set when this account is a delivery partner (the /delivery app). */
  delivery?: { id: string; kyc_status: "draft" | "submitted" | "approved" | "rejected"; is_active: boolean } | null;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  image_url: string;
  product_count: number;
  children: CategoryNode[];
}

export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string;
  image: string;
  price: Paise;
  mrp: Paise;
  discount_pct: number;
  rating_avg: number;
  rating_count: number;
  in_stock: boolean;
  seller_name: string;
  deal?: DealInfo | null;
  unit_price?: { paise: Paise; per: string } | null;
  bought?: string | null;
  variant_count?: number;
  variant_id?: string | null;
  sponsored?: boolean;
  href?: string;
  delivery_by?: string | null;
  starts_at?: string;
}

export interface DealInfo {
  kind: "lightning" | "deal_of_day" | "limited";
  label: string;
  ends_at: string;
  deal_price: Paise;
  regular_price: Paise | null;
  claimed_pct: number | null;
  variant_id: string;
}

export interface NavSettings {
  all_menu: boolean;
  search_categories: boolean;
  show_categories: boolean;
  links: LinkItem[];
  promo: { enabled: boolean; text: string; link: string; tone: "accent" | "buy" | "primary" | "dark" };
  drawer_links: LinkItem[];
  trending: string[];
}

export interface HomeData {
  categories: CategoryNode[];
  deals: ProductCard[];
  new_arrivals: ProductCard[];
  top_rated: ProductCard[];
  bestsellers: ProductCard[];
}

export interface SearchResult {
  items: ProductCard[];
  total: number;
  page: number;
  page_size: number;
  category: { id: string; name: string; slug: string } | null;
  breadcrumbs: { name: string; slug: string }[];
  facets: { brands: { name: string; count: number }[]; price_min: Paise; price_max: Paise };
}

export interface PublicVariant {
  id: string;
  options: Record<string, string>;
  label: string;
  price: Paise;
  mrp: Paise;
  discount_pct: number;
  in_stock: boolean;
  low_stock: boolean;
  stock_left: number | null;
  net_quantity?: string;
  unit_price?: { paise: Paise; per: string } | null;
}

export interface ProductOffer {
  code: string;
  title: string;
  terms: string;
  description: string;
  kind: "percent" | "flat";
  value: number;
  max_discount_paise: Paise | null;
  min_order_paise: Paise;
  first_order_only: boolean;
  ends_at: string | null;
  source: "platform" | "seller";
  source_name: string;
}

export interface SellerSnapshot {
  rating_avg: number;
  rating_count: number;
  positive_pct: number | null;
  orders_90d: string | null;
  on_time_pct: number | null;
  since: string;
  years: number;
  months: number;
  top_seller: boolean;
  dispatch_days: number;
}

export interface ReviewMedia {
  kind: "image" | "video";
  url: string;
  poster_url: string;
}

export interface CustomerMediaItem extends ReviewMedia {
  review_id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  verified: boolean;
  created_at: string;
}

export interface ProductDetails {
  net_unit: "" | "g" | "kg" | "ml" | "l" | "m" | "pcs" | "pair";
  generic_name: string;
  model_number: string;
  manufacturer: string;
  packer: string;
  importer: string;
  customer_care: string;
  fssai_license: string;
  ingredients: string;
  directions: string;
  safety_info: string;
  legal_disclaimer: string;
  shelf_life: string;
  warranty: string;
  in_the_box: string[];
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  key_specs: string[];
}

export interface ProductVideo {
  url: string;
  poster_url: string;
  title: string;
  duration_s: number;
}

export interface ProductPage {
  id: string;
  slug: string;
  title: string;
  brand: string;
  description: string;
  highlights: string[];
  specs: Record<string, string>;
  images: string[];
  videos?: ProductVideo[];
  country_of_origin: string;
  return_window_days: number;
  rating_avg: number;
  rating_count: number;
  price: Paise;
  mrp: Paise;
  discount_pct: number;
  in_stock: boolean;
  breadcrumbs: { name: string; slug: string }[];
  option_axes: Record<string, string[]>;
  variants: PublicVariant[];
  seller: {
    name: string;
    slug: string;
    legal_name: string;
    gstin: string | null;
    city: string;
    state: string;
    grievance_officer: { name: string; email: string };
    dispatch_days?: number;
  };
  similar: ProductCard[];
  deal?: DealInfo | null;
  key_specs?: { label: string; value: string }[];
  info?: { label: string; value: string }[];
  important?: { title: string; text: string }[];
  first_available?: string | null;
  bought_last_month?: string | null;
  bestseller?: { rank: number; category: string; slug: string } | null;
  offers?: ProductOffer[];
  seller_snapshot?: SellerSnapshot | null;
  returnable?: boolean;
}

export interface CartLine {
  id: string;
  variant_id: string;
  product_slug: string;
  title: string;
  variant_label: string;
  image: string;
  qty: number;
  price: Paise;
  mrp: Paise;
  line_total: Paise;
  stock_left: number;
  problem: string;
}

export interface CartGroup {
  seller: { id: string; name: string; slug: string };
  items_total: Paise;
  shipping_fee: Paise;
  free_shipping_gap: Paise;
  lines: CartLine[];
}

export interface CartView {
  groups: CartGroup[];
  summary: {
    mrp_total: Paise;
    discount: Paise;
    items_total: Paise;
    shipping_total: Paise;
    grand_total: Paise;
    item_count: number;
    has_problems: boolean;
    cod_fee?: Paise;
  };
  cod_available: boolean;
  cod_max_order_paise: Paise;
  online_available: boolean;
  cod_allowed?: boolean;
}

export interface Address {
  id: string;
  full_name: string;
  phone: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state_code: string;
  state: string;
  pincode: string;
  kind: "home" | "work" | "other";
  is_default: boolean;
}

export type SubStatus = "pending_payment" | "placed" | "confirmed" | "packed" | "shipped" | "delivered" | "cancelled";

export interface OrderItem {
  title: string;
  product_slug?: string;
  variant_label: string;
  image: string;
  qty: number;
  unit_price: Paise;
  unit_mrp: Paise;
  line_total: Paise;
  sku: string;
  hsn_code: string;
  gst_bps: number;
  taxable_value: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
}

export interface SubOrderView {
  id: string;
  number: string;
  status: SubStatus;
  invoice_number?: string;
  expected_delivery_at?: string | null;
  platform_discount?: Paise;
  seller_discount?: Paise;
  seller: { name: string; slug: string } | null;
  items_total: Paise;
  shipping_fee: Paise;
  total: Paise;
  courier_name: string;
  tracking_number: string;
  tracking_url: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  cancelled_by: string;
  can_cancel: boolean;
  items: OrderItem[];
  commission?: Paise;
  commission_gst?: Paise;
  tcs?: Paise;
  tds?: Paise;
  seller_payout?: Paise;
  settlement_status?: string;
}

export interface CheckoutPayload {
  provider: "razorpay";
  key_id: string;
  checkout_url?: string;
  razorpay_order_id: string;
  amount: Paise;
  currency: "INR";
  name: string;
  description: string;
  prefill: { name: string; contact: string; email: string };
  expires_at: string | null;
}

export interface OrderDetail {
  id: string;
  number: string;
  status: "pending_payment" | "placed" | "cancelled";
  payment_method: "cod" | "online";
  payment_status: string;
  ship_to: Record<string, string>;
  items_total: Paise;
  shipping_total: Paise;
  cod_fee: Paise;
  grand_total: Paise;
  refunded_total: Paise;
  discount_total?: Paise;
  coupon_code?: string;
  created_at: string;
  placed_at: string | null;
  payment_expires_at: string | null;
  sub_orders: SubOrderView[];
  timeline: { sub_order_id: string | null; from: string; to: string; actor: string; note: string; at: string }[];
  refunds: { id?: string; amount: Paise; status: string; reason: string; created_at?: string; attempts?: number; last_error?: string }[];
  payment?: CheckoutPayload | null;
  customer?: { id: string; name: string; phone: string | null; email: string | null };
}

export interface OrderSummary {
  id: string;
  number: string;
  status: string;
  payment_method: string;
  payment_status: string;
  grand_total: Paise;
  created_at: string;
  item_count: number;
  items: { title: string; image: string; qty: number }[];
  sub_statuses: SubStatus[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  status_counts?: Record<string, number>;
}

export interface SellerProfile {
  id: string;
  status: SellerStatus;
  display_name: string;
  slug: string;
  description: string;
  legal_name: string;
  business_type: string;
  gstin: string | null;
  pan: string;
  contact_email: string;
  contact_phone: string;
  pickup: { line1: string; line2: string; city: string; state_code: string; state: string; pincode: string };
  bank: { holder_name: string; account_number: string; ifsc: string };
  grievance: { name: string; email: string; phone: string };
  documents: { kind: string; filename: string; content_type: string; size_bytes: number; uploaded_at: string }[];
  checklist: { key: string; label: string; done: boolean }[];
  rejection_reason: string;
  submitted_at: string | null;
  approved_at: string | null;
  commission_bps_override: number | null;
  owner?: { id: string; name: string; phone: string | null; email: string | null } | null;
  product_counts?: Record<string, number>;
}

export interface SellerVariant {
  id: string;
  sku: string;
  options: Record<string, string>;
  label: string;
  mrp_paise: Paise;
  price_paise: Paise;
  discount_pct: number;
  stock: number;
  weight_grams: number;
  net_qty?: number | null;
  is_active: boolean;
}

export type ProductStatus = "draft" | "pending" | "approved" | "rejected" | "archived";

export interface SellerProduct {
  id: string;
  slug: string;
  status: ProductStatus;
  rejection_reason: string;
  category_id: string;
  category_name: string;
  title: string;
  brand: string;
  description: string;
  highlights: string[];
  specs: Record<string, string>;
  hsn_code: string;
  gst_bps: number;
  country_of_origin: string;
  return_window_days: number;
  images: string[];
  videos?: ProductVideo[];
  variants: SellerVariant[];
  details?: ProductDetails;
  required_details?: string[];
  missing_details?: string[];
  price_from: Paise;
  mrp_from: Paise;
  in_stock: boolean;
  created_at: string;
  updated_at: string;
  seller?: { id: string; name: string; status: string };
}

export interface SellerCategory {
  id: string;
  name: string;
  path: string;
  commission_bps: number;
  default_gst_bps: number;
}

export interface SellerOrder {
  invoice_number?: string | null;
  label_url?: string | null;
  expected_delivery_at?: string | null;
  id: string;
  number: string;
  order_number: string;
  status: SubStatus;
  payment_method: string;
  created_at: string;
  items_total: Paise;
  shipping_fee: Paise;
  total: Paise;
  seller_payout: Paise;
  item_count: number;
  items: { title: string; variant_label: string; sku: string; image: string; qty: number; unit_price: Paise; line_total: Paise }[];
  ship_to_city: string;
  ship_to_pincode: string;
  courier_name: string;
  tracking_number: string;
  tracking_url: string;
  ship_to?: Record<string, string> | null;
  breakdown?: { gross: Paise; commission: Paise; commission_gst: Paise; tcs: Paise; tds: Paise; payout: Paise; taxable_total: Paise; is_interstate: boolean };
  items_tax?: { title: string; hsn_code: string; gst_bps: number; taxable_value: Paise; cgst: Paise; sgst: Paise; igst: Paise }[];
  confirmed_at?: string | null;
  packed_at?: string | null;
  shipped_at?: string | null;
  delivered_at?: string | null;
  cancel_reason?: string;
  settlement_status?: string;
  settlement_due_at?: string | null;
  timeline?: { from: string; to: string; actor: string; note: string; at: string }[];
}

export interface PlatformInfo {
  name: string;
  legal_name: string;
  gstin: string;
  registered_address: string;
  grievance_officer: Business["grievance"];
  free_shipping_threshold_paise: Paise;
  shipping_fee_paise: Paise;
  cod_enabled: boolean;
  online_payments: boolean;
}

export interface LinkItem {
  label: string;
  href: string;
}

export type SocialIcon = "instagram" | "facebook" | "x" | "youtube" | "linkedin" | "whatsapp" | "telegram" | "pinterest" | "threads" | "website" | "custom";
export interface SocialLink { id: string; label: string; url: string; icon: SocialIcon; icon_url: string; enabled: boolean }
export type ContactType = "email" | "phone" | "whatsapp" | "address" | "link" | "text";
export interface ContactItem { id: string; type: ContactType; label: string; value: string; enabled: boolean }
export interface Business {
  legal_name: string;
  registered_address: string;
  gstin: string;
  cin: string;
  grievance: { name: string; designation: string; email: string; phone: string; hours: string };
}

export interface Site {
  brand_name: string;
  tagline: string;
  logo_url: string;
  favicon_url: string;
  colors: { primary: string; primary_dark: string; accent: string; buy: string; success: string; page: string };
  radius: "rounded" | "soft" | "square";
  announcement: { enabled: boolean; text: string; link: string; tone: "accent" | "primary" | "dark" };
  header_links: LinkItem[];
  footer_columns: { title: string; links: LinkItem[] }[];
  business: Business;
  contact: { enabled: boolean; title: string; items: ContactItem[] };
  social: { enabled: boolean; title: string; links: SocialLink[] };
  footer: { show_business: boolean; show_contact: boolean; show_social: boolean; show_grievance: boolean; show_gstin: boolean; copyright: string };
  seo: { title: string; description: string };
  analytics: { google_analytics_id: string; meta_pixel_id: string };
  features: { wishlist: boolean; reviews: boolean; returns: boolean; coupons: boolean; support: boolean; ai: boolean; product_videos?: boolean;
    deals?: boolean; ads?: boolean; qa?: boolean; stock_alerts?: boolean; price_alerts?: boolean; compare?: boolean; bought_together?: boolean };
  cod_enabled: boolean;
  online_payments?: boolean;
  free_shipping_threshold_paise: number;
  gallery: { zoom: boolean; zoom_level: number; max_video_mb: number; max_videos: number };
  shipping_fee_paise?: number;
  pdp: PdpSettings;
  reviews: ReviewSettingsPublic;
  nav: NavSettings;
  home_extras: { back_to_top: boolean; signin_prompt: boolean };
}

export interface PdpSettings {
  unit_price: boolean;
  bought_count: boolean;
  bestseller_badge: boolean;
  offers: boolean;
  service_icons: boolean;
  key_specs: boolean;
  delivery_countdown: boolean;
  seller_snapshot: boolean;
  customer_media: boolean;
  share: boolean;
  report: boolean;
  ask_assistant: boolean;
  sticky_bar: boolean;
  similar: boolean;
  recently_viewed: boolean;
  header_pincode: boolean;
  page_loading_bar: boolean;
}

export interface ReviewSettingsPublic {
  buyers_only: boolean;
  photos: boolean;
  max_photos: number;
  videos: boolean;
  max_video_mb: number;
  media_public: boolean;
  min_body_chars: number;
  guidelines: string;
  report_reasons: Record<string, string>;
}

export interface HomeSectionData {
  id: string;
  kind: "hero" | "categories" | "products" | "banner" | "banner_grid" | "text" | "usp" | "recent" | "cards" | "deals" | "sponsored" | "countdown" | "signin" | "inspired" | "buy_again";
  title: string;
  device: "all" | "mobile" | "desktop";
  config: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  products?: ProductCard[];
  categories?: CategoryNode[];
}

export interface ReturnView {
  id: string;
  number: string;
  status: "requested" | "approved" | "picked_up" | "received" | "refunded" | "rejected" | "cancelled";
  reason: string;
  reason_label: string;
  comment: string;
  seller_note: string;
  refund_amount: Paise;
  refund_upi: string;
  pickup_courier: string;
  pickup_tracking: string;
  credit_note_number: string;
  sub_order_id: string;
  sub_order_number: string;
  order_id: string;
  created_at: string;
  received_at: string | null;
  refunded_at: string | null;
  items: { title: string; variant_label: string; image: string; qty: number; amount: Paise }[];
}

export interface ReturnableItem {
  order_item_id: string;
  title: string;
  variant_label: string;
  image: string;
  qty_left: number;
  return_by: string;
  eligible: boolean;
  unit_refund: Paise;
}
