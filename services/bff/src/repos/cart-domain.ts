/**
 * PORT of `services/cart-checkout-svc/src/domain/cart/cart.ts`
 * (FR-CUS-007 shopping cart aggregate).
 *
 * Why a port instead of an import: see `promotions-core.ts` in this directory
 * (TS6059 rootDir + unbuilt sibling package + Node 18). The BFF persists the
 * aggregate through `commerce.ts` (load -> domain function -> save), exactly
 * the adapter split the source prescribes. Everything below is verbatim
 * except mechanical non-null assertions for `noUncheckedIndexedAccess`. If
 * cart.ts changes, change this copy in the same commit.
 *
 * ---- original header ----
 * DESC:       "persistent multi-vendor cart (guest carts device-bound, merged on login)
 *              with quantity edits, saved-for-later, per-vendor grouping, live
 *              price/stock revalidation and offer application preview."
 * RULES:      "Cart TTL 90 days; price at checkout = current approved price (cart shows
 *              deltas since add, BRU-04); items from suspended vendors auto-moved to
 *              saved-for-later with notice."
 * VALIDATION: "Qty <= stock and per-order category cap; price re-quoted server-side on
 *              every mutation."  (Qty 1-10 per line, FR-CUS-007 / the quote engine.)
 *
 * Pure and immutable: every mutation returns a NEW cart, so persistence is a
 * plain save and there is no shared mutable state. Prices are stored as a
 * snapshot at add-time (paise) so the cart can show deltas vs the current
 * approved price (BRU-04); the authoritative re-price happens in the FR-CUS-014
 * quote engine, which this cart feeds. Money is integer paise.
 */

/** Integer paise. */
export type Paise = number;

export const MAX_QTY_PER_LINE = 10;   // FR-CUS-007 per-line cap (matches the quote engine)
export const CART_TTL_DAYS = 90;      // RULES: cart TTL 90 days

export interface CartLine {
  listingId: string;
  vendorId: string;
  categoryId: string;
  qty: number;
  /** Unit price snapshot at the moment the line was added/last set (paise). BRU-04 delta base. */
  unitPriceAtAddPaise: Paise;
}

export interface Cart {
  cartId: string;
  ownerId: string | null;   // null => guest (device-bound)
  active: CartLine[];
  savedForLater: CartLine[];
  updatedAtMs: number;
}

export function emptyCart(cartId: string, ownerId: string | null, nowMs: number): Cart {
  return { cartId, ownerId, active: [], savedForLater: [], updatedAtMs: nowMs };
}

const touch = (c: Cart, nowMs: number): Cart => ({ ...c, updatedAtMs: nowMs });

function upsertLine(lines: CartLine[], line: CartLine): CartLine[] {
  const i = lines.findIndex((l) => l.listingId === line.listingId);
  if (i === -1) return [...lines, line];
  const existing = lines[i]!;
  const merged = { ...existing, qty: Math.min(MAX_QTY_PER_LINE, existing.qty + line.qty), unitPriceAtAddPaise: line.unitPriceAtAddPaise };
  return lines.map((l, idx) => (idx === i ? merged : l));
}

export type CartResult =
  | { ok: true; cart: Cart }
  | { ok: false; reason: string };

/**
 * Add an item. If the listing is already active, quantities combine, capped at
 * MAX_QTY_PER_LINE (excess is clamped, not rejected - the cart is forgiving; the quote
 * engine enforces the hard cap at checkout). qty must be >= 1.
 */
export function addItem(cart: Cart, item: Omit<CartLine, 'qty'> & { qty: number }, nowMs: number): CartResult {
  if (item.qty < 1) return { ok: false, reason: 'QTY_MUST_BE_POSITIVE' };
  const line: CartLine = {
    listingId: item.listingId, vendorId: item.vendorId, categoryId: item.categoryId,
    qty: Math.min(MAX_QTY_PER_LINE, item.qty), unitPriceAtAddPaise: item.unitPriceAtAddPaise,
  };
  return { ok: true, cart: touch({ ...cart, active: upsertLine(cart.active, line) }, nowMs) };
}

/** Set an exact quantity. 0 removes the line. Above the cap is rejected (explicit intent). */
export function updateQty(cart: Cart, listingId: string, qty: number, nowMs: number): CartResult {
  if (qty < 0) return { ok: false, reason: 'QTY_NEGATIVE' };
  if (qty > MAX_QTY_PER_LINE) return { ok: false, reason: `QTY_OVER_CAP (max ${MAX_QTY_PER_LINE})` };
  const exists = cart.active.some((l) => l.listingId === listingId);
  if (!exists) return { ok: false, reason: 'LINE_NOT_IN_CART' };
  const active = qty === 0
    ? cart.active.filter((l) => l.listingId !== listingId)
    : cart.active.map((l) => (l.listingId === listingId ? { ...l, qty } : l));
  return { ok: true, cart: touch({ ...cart, active }, nowMs) };
}

export function removeItem(cart: Cart, listingId: string, nowMs: number): Cart {
  return touch({ ...cart, active: cart.active.filter((l) => l.listingId !== listingId) }, nowMs);
}

function move(cart: Cart, listingId: string, from: 'active' | 'savedForLater', nowMs: number): CartResult {
  const src = cart[from];
  const line = src.find((l) => l.listingId === listingId);
  if (!line) return { ok: false, reason: 'LINE_NOT_FOUND' };
  const to = from === 'active' ? 'savedForLater' : 'active';
  const next: Cart = {
    ...cart,
    [from]: src.filter((l) => l.listingId !== listingId),
    [to]: upsertLine(cart[to], line),
  } as Cart;
  return { ok: true, cart: touch(next, nowMs) };
}

export const saveForLater = (cart: Cart, listingId: string, nowMs: number) => move(cart, listingId, 'active', nowMs);
export const moveToCart = (cart: Cart, listingId: string, nowMs: number) => move(cart, listingId, 'savedForLater', nowMs);

/**
 * RULES: items from suspended vendors are auto-moved to saved-for-later with a notice.
 * Returns the updated cart plus the listing ids that were moved (for the notice).
 */
export function quarantineSuspendedVendors(cart: Cart, suspendedVendorIds: Set<string>, nowMs: number):
  { cart: Cart; movedListingIds: string[] } {
  const moved = cart.active.filter((l) => suspendedVendorIds.has(l.vendorId));
  if (moved.length === 0) return { cart, movedListingIds: [] };
  let next = cart;
  for (const l of moved) next = (saveForLater(next, l.listingId, nowMs) as { ok: true; cart: Cart }).cart;
  return { cart: next, movedListingIds: moved.map((l) => l.listingId) };
}

/** Per-vendor grouping for the cart view (deterministic: first-seen vendor order). */
export function groupByVendor(cart: Cart): Array<{ vendorId: string; lines: CartLine[] }> {
  const order: string[] = [];
  const map = new Map<string, CartLine[]>();
  for (const l of cart.active) {
    if (!map.has(l.vendorId)) { map.set(l.vendorId, []); order.push(l.vendorId); }
    map.get(l.vendorId)!.push(l);
  }
  return order.map((vendorId) => ({ vendorId, lines: map.get(vendorId)! }));
}

/**
 * Merge a guest cart into the user's cart on login (RULES: merged on login). Active lines
 * union by listing with quantities summed and clamped to the cap; saved-for-later unions
 * too. The user cart wins its identity; the guest cart is consumed. Deterministic.
 */
export function mergeGuestInto(userCart: Cart, guestCart: Cart, nowMs: number): Cart {
  let active = userCart.active;
  for (const g of guestCart.active) active = upsertLine(active, g);
  let saved = userCart.savedForLater;
  for (const g of guestCart.savedForLater) {
    // do not duplicate into saved-for-later if it is already active in the merged cart
    if (!active.some((l) => l.listingId === g.listingId)) saved = upsertLine(saved, g);
  }
  return touch({ ...userCart, active, savedForLater: saved }, nowMs);
}

// ------------------------------------------------------- revalidation preview

export interface LineFacts {
  listingId: string;
  currentPricePaise: Paise;
  availableStock: number;
  categoryQtyCap?: number;
  vendorSuspended?: boolean;
}

export type LinePreview =
  | { listingId: string; status: 'OK' }
  | { listingId: string; status: 'PRICE_CHANGED'; fromPaise: Paise; toPaise: Paise }
  | { listingId: string; status: 'OUT_OF_STOCK' }
  | { listingId: string; status: 'QTY_REDUCED_TO_STOCK'; available: number }
  | { listingId: string; status: 'QTY_OVER_CATEGORY_CAP'; cap: number }
  | { listingId: string; status: 'VENDOR_SUSPENDED' };

/**
 * Live revalidation preview (DESC / VALIDATION). Read-only: reports what WOULD change at
 * checkout without mutating the cart (BRU-04 delta display). One entry per active line.
 */
export function revalidate(cart: Cart, facts: Map<string, LineFacts>): LinePreview[] {
  return cart.active.map((l): LinePreview => {
    const f = facts.get(l.listingId);
    if (!f) return { listingId: l.listingId, status: 'OUT_OF_STOCK' }; // unknown => treat as unavailable
    if (f.vendorSuspended) return { listingId: l.listingId, status: 'VENDOR_SUSPENDED' };
    if (f.availableStock <= 0) return { listingId: l.listingId, status: 'OUT_OF_STOCK' };
    if (l.qty > f.availableStock) return { listingId: l.listingId, status: 'QTY_REDUCED_TO_STOCK', available: f.availableStock };
    if (f.categoryQtyCap !== undefined && l.qty > f.categoryQtyCap) return { listingId: l.listingId, status: 'QTY_OVER_CATEGORY_CAP', cap: f.categoryQtyCap };
    if (f.currentPricePaise !== l.unitPriceAtAddPaise) return { listingId: l.listingId, status: 'PRICE_CHANGED', fromPaise: l.unitPriceAtAddPaise, toPaise: f.currentPricePaise };
    return { listingId: l.listingId, status: 'OK' };
  });
}

export function isExpired(cart: Cart, nowMs: number): boolean {
  return nowMs - cart.updatedAtMs > CART_TTL_DAYS * 24 * 3600 * 1000;
}

/**
 * Emit checkout lines for the FR-CUS-014 quote engine, using CURRENT facts (price at
 * checkout = current approved price, RULES). Lines whose vendor is suspended or which are
 * out of stock are excluded; quantities are clamped to available stock. The quote engine
 * then does the authoritative revalidation + pricing.
 */
export interface CheckoutLineDraft {
  lineId: string;
  listingId: string;
  vendorId: string;
  categoryId: string;
  qty: number;
  unitListPaise: Paise;
  availableStock: number;
  serviceablePin: boolean;
  categoryQtyCap?: number;
  taxBps: number;
}

export function toCheckoutLines(
  cart: Cart,
  facts: Map<string, LineFacts>,
  opts: { serviceablePin: boolean; taxBpsFor: (listingId: string) => number },
): CheckoutLineDraft[] {
  const out: CheckoutLineDraft[] = [];
  let n = 0;
  for (const l of cart.active) {
    const f = facts.get(l.listingId);
    if (!f || f.vendorSuspended || f.availableStock <= 0) continue;
    out.push({
      lineId: `CL${++n}`,
      listingId: l.listingId,
      vendorId: l.vendorId,
      categoryId: l.categoryId,
      qty: Math.min(l.qty, f.availableStock, MAX_QTY_PER_LINE),
      unitListPaise: f.currentPricePaise,          // current approved price at checkout
      availableStock: f.availableStock,
      serviceablePin: opts.serviceablePin,
      categoryQtyCap: f.categoryQtyCap,
      taxBps: opts.taxBpsFor(l.listingId),
    });
  }
  return out;
}
