/**
 * Shared wire contract between the BFF (`services/bff`) and the web client
 * (`services/web`).
 *
 * Why a single file: the two packages are compiled by different toolchains, so a
 * type in one cannot be imported by the other without a workspace build. Keeping the
 * DTOs here, under `contracts/`, makes the document Vol. 7 §7.4 describes — the API
 * surface — a real artifact both sides typecheck against instead of a convention.
 *
 * Conventions encoded in these types (CLAUDE.md §6):
 *   - money is integer paise; `*Paise` columns never carry a fractional value
 *   - rates and shares are integer basis points; they sum to exactly 10,000
 *   - ids are ULID strings, 26 characters, Crockford base32
 *   - every list response is a cursor page, never an offset page (Vol. 7 §7.3)
 */

export type Ulid = string;
export type Paise = number;
export type Bps = number;

/* ---------------------------------------------------------------- *
 * Errors — Vol. 7 §7.2 RFC 7807 problem+json
 * ---------------------------------------------------------------- */

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  /** Always present so the UI can show it in its error state (§8.3). */
  traceId: string;
  /** Present on 422 — mapped onto fields by the form (§8.3). */
  fields?: Record<string, string>;
}

/* ---------------------------------------------------------------- *
 * Pagination — Vol. 7 §7.3 keyset
 * ---------------------------------------------------------------- */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/* ---------------------------------------------------------------- *
 * Identity & access
 * ---------------------------------------------------------------- */

export type Role =
  | 'CUSTOMER'
  | 'VENDOR'
  | 'ADMIN'
  | 'SUPER_ADMIN'
  | 'FINANCE'
  | 'MARKETING'
  | 'WAREHOUSE'
  | 'DELIVERY'
  | 'SUPPORT';

export interface SessionUser {
  id: Ulid;
  displayName: string;
  role: Role;
  email?: string;
  mobile?: string;
  /** Step-up (MFA) grant covering a sensitive action, per Vol. 10 §10.3. */
  stepUpValidUntilMs?: number;
  locale: string;
}

export interface Address {
  id: Ulid;
  label: 'HOME' | 'WORK' | 'OTHER';
  line1: string;
  line2?: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  mobile: string;
  isDefault: boolean;
}

/* ---------------------------------------------------------------- *
 * Catalogue
 * ---------------------------------------------------------------- */

export interface Category {
  id: Ulid;
  parentId: Ulid | null;
  name: string;
  slug: string;
  /** Filled on parents when the tree is fetched. */
  children?: Category[];
  productCount?: number;
}

export interface ListingSummary {
  id: Ulid;
  productId: Ulid;
  vendorId: Ulid;
  vendorName: string;
  title: string;
  mrpPaise: Paise;
  pricePaise: Paise;
  state: string;
  ratingAvg: number;
  ratingCount: number;
  imageUrl?: string;
  inStock: boolean;
  categorySlug: string;
}

export interface ListingDetail extends ListingSummary {
  description: string;
  attributes: Record<string, string>;
  brand?: string;
  hsnCode: string;
  variants: { id: Ulid; sku: string; optionMap: Record<string, string>; inStock: boolean }[];
  images: string[];
  /** Ranked alternatives for the out-of-stock rail (SCR-006). */
  similar: ListingSummary[];
}

/* ---------------------------------------------------------------- *
 * Search & discovery (FR-CUS-009..013)
 * ---------------------------------------------------------------- */

export interface SearchResponse {
  items: ListingSummary[];
  total: number;
  /** Zero-results always offers relaxations (§8.3). */
  relaxations: string[];
  facets: {
    category: { slug: string; name: string; count: number }[];
    brand: { name: string; count: number }[];
    priceBand: { minPaise: Paise; maxPaise: Paise; count: number }[];
  };
  /** Query echo for the "did you mean" and the search box. */
  query: string;
}

/* ---------------------------------------------------------------- *
 * Cart & checkout (FR-CUS-007, FR-CUS-014)
 * ---------------------------------------------------------------- */

export interface CartLine {
  id: Ulid;
  listingId: Ulid;
  variantSku?: string;
  vendorId: Ulid;
  vendorName: string;
  title: string;
  mrpPaise: Paise;
  pricePaise: Paise;
  qty: number;
  savedForLater: boolean;
  inStock: boolean;
  maxQty: number;
}

export interface CartView {
  id: Ulid;
  lines: CartLine[];
  /** Grouped per vendor — BRU-03 splits the order at checkout. */
  byVendor: { vendorId: Ulid; vendorName: string; lines: CartLine[]; subtotalPaise: Paise }[];
  itemTotalPaise: Paise;
  savingsPaise: Paise;
  itemCount: number;
}

export interface QuoteLineProblem {
  lineId: Ulid;
  reason: 'OUT_OF_STOCK' | 'QTY_OVER_CATEGORY_CAP' | 'PIN_NOT_SERVICEABLE';
}

export interface Quote {
  quoteId: string;
  grandTotalPaise: Paise;
  itemTotalPaise: Paise;
  discountTotalPaise: Paise;
  taxTotalPaise: Paise;
  shippingTotalPaise: Paise;
  expiresAtMs: number;
  paymentMethod: 'PREPAID' | 'COD';
  codEligible: boolean;
  codReasons: string[];
  subOrders: { vendorId: Ulid; lineIds: Ulid[]; grandPaise: Paise }[];
  problems?: QuoteLineProblem[];
}

export interface CreateOrderRequest {
  quoteId: string;
  paymentRef: string;
  grandTotalPaise: Paise;
  addressId: Ulid;
  paymentMethod: 'PREPAID' | 'COD';
}

/* ---------------------------------------------------------------- *
 * Orders (FR-CUS-016)
 * ---------------------------------------------------------------- */

export type SubOrderState =
  | 'CONFIRMED' | 'ACCEPTED' | 'PACKED' | 'SHIPPED' | 'OUT_FOR_DELIVERY'
  | 'DELIVERED' | 'NDR' | 'RTO_INITIATED' | 'RTO_RECEIVED' | 'RETURN_REQUESTED'
  | 'RETURN_PICKED_UP' | 'QC' | 'REFUNDED' | 'RETURN_REJECTED' | 'CANCELLED' | 'CLOSED';

export interface OrderSummary {
  id: Ulid;
  placedAt: string;
  status: string;
  grandTotalPaise: Paise;
  itemCount: number;
  vendorNames: string[];
  thumbnailUrl?: string;
  etaText?: string;
}

export interface OrderDetail extends OrderSummary {
  quoteId: string;
  paymentRef: string;
  itemTotalPaise: Paise;
  taxTotalPaise: Paise;
  shippingTotalPaise: Paise;
  discountTotalPaise: Paise;
  address: Address;
  paymentMethod: string;
  paymentStatus: string;
  subOrders: {
    id: Ulid;
    vendorId: Ulid;
    vendorName: string;
    amountPaise: Paise;
    state: SubOrderState;
    slaAcceptBy: string;
    slaShipBy: string;
    tracking?: { carrier: string; awb: string; events: TrackingEvent[] };
  }[];
  timeline: { at: string; label: string; state: string }[];
}

export interface TrackingEvent {
  at: string;
  label: string;
  location?: string;
}

/* ---------------------------------------------------------------- *
 * Returns (FR-CUS-017, FR-CUS-018)
 * ---------------------------------------------------------------- */

export type RmaState =
  | 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'PICKUP_SCHEDULED' | 'PICKED_UP'
  | 'IN_TRANSIT' | 'QC_PASSED' | 'QC_FAILED' | 'REFUND_INITIATED' | 'REFUNDED' | 'CLOSED';

export interface RmaRequest {
  id: Ulid;
  orderId: Ulid;
  subOrderId: Ulid;
  listingId: Ulid;
  listingTitle: string;
  qty: number;
  reasonCode: string;
  reasonText?: string;
  state: RmaState;
  refundPaise?: Paise;
  refundMethod?: 'ORIGINAL' | 'WALLET';
  requestedAt: string;
  decidedAt?: string;
  events: { at: string; toState: RmaState; note?: string; actorType: string }[];
}

/* ---------------------------------------------------------------- *
 * Reviews (FR-CUS-023, FR-CUS-024)
 * ---------------------------------------------------------------- */

export interface Review {
  id: Ulid;
  listingId: Ulid;
  customerId: Ulid;
  customerName: string;
  rating: number;
  title?: string;
  body?: string;
  createdAt: string;
  verifiedPurchase: boolean;
  helpfulUp: number;
  status: 'PENDING' | 'PUBLISHED' | 'REJECTED' | 'FLAGGED';
}

export interface ReviewSummary {
  average: number;
  count: number;
  histogram: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/* ---------------------------------------------------------------- *
 * Wallet / loyalty / notifications (FR-CUS-019..022)
 * ---------------------------------------------------------------- */

export interface WalletView {
  cashPaise: Paise;
  promoPaise: Paise;
  entries: { id: Ulid; bucket: 'CASH' | 'PROMO'; amountPaise: Paise; reason: string; at: string }[];
}

export interface LoyaltyView {
  points: number;
  tier: 'SILVER' | 'GOLD' | 'PLATINUM';
  entries: { id: Ulid; points: number; reason: string; at: string }[];
}

export interface NotificationItem {
  id: Ulid;
  category: 'ORDER' | 'PAYMENT' | 'PROMO' | 'SYSTEM' | 'RETURN';
  title: string;
  body: string;
  linkUrl?: string;
  severity: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  readAt: string | null;
  createdAt: string;
}

/* ---------------------------------------------------------------- *
 * Vendor portal
 * ---------------------------------------------------------------- */

export interface VendorDashboard {
  store: { id: Ulid; displayName: string; slug: string; status: string; kycState: string };
  openOrders: number;
  awaitingPickup: number;
  ndrCount: number;
  revenueTodayPaise: Paise;
  revenueMonthPaise: Paise;
  commissionMonthPaise: Paise;
  ratingAvg: number;
  onTimePct: number;
  lowStockCount: number;
  pendingActionCount: number;
  sparkline: { label: string; valuePaise: Paise }[];
}

export interface VendorOrderRow {
  id: Ulid;
  orderId: Ulid;
  customerCity: string;
  amountPaise: Paise;
  state: SubOrderState;
  placedAt: string;
  slaShipBy: string;
  breachRisk: boolean;
  itemCount: number;
}

export interface InventoryRow {
  variantSku: string;
  listingTitle: string;
  locationName: string;
  onHand: number;
  reserved: number;
  available: number;
  safetyStock: number;
  belowSafety: boolean;
}

export interface LedgerRow {
  id: Ulid;
  period: string;
  accountCode: string;
  debitPaise: Paise;
  creditPaise: Paise;
  refType: string;
  refId: string;
  memo?: string;
  createdAt: string;
}

export interface SettlementSummary {
  period: string;
  grossPaise: Paise;
  commissionPaise: Paise;
  tdsPaise: Paise;
  netPaise: Paise;
  status: 'PENDING' | 'IN_PROGRESS' | 'PAID';
  expectedAt?: string;
}

/* ---------------------------------------------------------------- *
 * Admin / operator consoles
 * ---------------------------------------------------------------- */

export interface Kpi {
  key: string;
  label: string;
  valueText: string;
  deltaBps?: number;
  /** Direction is never colour-only (§8.4) — the text carries it too. */
  trend: 'up' | 'down' | 'flat';
}

export interface AdminOverview {
  kpis: Kpi[];
  gmvPaise: Paise;
  ordersToday: number;
  pendingVendorApprovals: number;
  pendingProductApprovals: number;
  openRiskCases: number;
  ndrOpen: number;
  series: { label: string; gmvPaise: Paise; orders: number }[];
}

export interface ApprovalCase {
  id: Ulid;
  kind: 'VENDOR' | 'PRODUCT' | 'REVIEW';
  subjectId: Ulid;
  subjectLabel: string;
  submittedBy: string;
  submittedAt: string;
  state: 'OPEN' | 'APPROVED' | 'REJECTED' | 'ESCALATED';
  riskFlags: string[];
  aiQcScore?: number;
}

export interface AuditEvent {
  id: Ulid;
  actorType: string;
  actorId: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  justification?: string;
  createdAt: string;
  chainValid: boolean;
}

export interface StaffUser {
  id: Ulid;
  email: string;
  fullName: string;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  mfaEnforced: boolean;
  lastSeenAt?: string;
}

export interface CouponRow {
  id: Ulid;
  code: string;
  description: string;
  kind: 'PERCENT' | 'FLAT';
  valueBps: Bps;
  valuePaise: Paise;
  usedCount: number;
  maxRedemptions: number;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXHAUSTED' | 'EXPIRED';
  startsAt: string;
  endsAt: string;
}

export interface CmsRow {
  id: Ulid;
  kind: 'PAGE' | 'BANNER' | 'BLOCK';
  slug: string;
  title: string;
  locale: string;
  status: 'DRAFT' | 'SCHEDULED' | 'PUBLISHED' | 'UNPUBLISHED';
  publishAt?: string;
  updatedAt: string;
}

export interface FinanceOverview {
  gmvPaise: Paise;
  commissionPaise: Paise;
  refundsPaise: Paise;
  pendingPayoutsPaise: Paise;
  taxCollectedPaise: Paise;
  unsettledVendors: number;
  reconBreaks: number;
  periods: { period: string; gmvPaise: Paise; commissionPaise: Paise; closed: boolean }[];
}
