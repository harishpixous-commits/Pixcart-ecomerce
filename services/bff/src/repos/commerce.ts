/**
 * Commerce data access: cart aggregate, server-authoritative quote (FR-CUS-014),
 * order creation (FR-CUS-014/015), order reads, and returns (FR-CUS-017/018).
 *
 * Money is integer paise everywhere (util.ts is the only DECIMAL conversion).
 * Pricing is NEVER computed here: `buildQuote` loads DB facts and hands them to
 * the ported quote engine (`quote.ts`), which is the single source of pricing
 * truth. This module only persists what the engine returns.
 *
 * Disclosed schema gaps (cannot be enforced, not simulated):
 *   - No order-line table (V001-V007): an order's line detail cannot be stored
 *     or read back, so `OrderDetail` carries no lines and `itemCount` is 0.
 *   - `ord_sub_order` has no delivered_at: BRU-7's return window is not
 *     enforceable from this schema; returns admission checks DELIVERED state
 *     only.
 *   - `rma_request` has no evidence/photo column: the DAMAGED/WRONG_ITEM
 *     photo-evidence rule has nowhere to persist evidence, so it is not
 *     enforced here (the domain rule remains in order-svc; this adapter simply
 *     cannot store the field).
 *   - Quote expiry is 10 minutes (engine) but no quote table exists, so
 *     capture cannot re-check age; the engine's amount-mismatch guard still
 *     holds.
 */
import { query, queryOne, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../http.js';
import type { CartView, OrderDetail, OrderSummary, Quote, QuoteLineProblem, RmaRequest } from '../dto.js';
import { createQuote, CheckoutLine, CheckoutRequest, isExpired, QUOTE_VALIDITY_MS, Quote as EngineQuote } from './quote.js';
import { Coupon } from './promotions-core.js';
import { groupByVendor, Cart as DomainCart, CartLine as DomainCartLine } from './cart-domain.js';
import { dec, decodeCursor, encodeCursor, iso, isoOrNull, jsonCol, num, paise } from './util.js';
import { ulid } from '../seed/ulid.js';

/** FR-FIN-002 has no per-category GST table in V001-V007; 1800 bps is the documented flat rate. */
const FLAT_TAX_BPS = 1800;

/* ------------------------------------------------------------------ *
 * Cart aggregate (FR-CUS-007)
 * ------------------------------------------------------------------ */

interface CartRow {
  id: string; customer_id: string | null; guest_token: string | null; status: string; expires_at: Date;
}
interface CartLineRow {
  id: string; cart_id: string; listing_id: string; variant_sku: string | null; vendor_id: string;
  qty: number; unit_mrppaise: unknown; unit_salepaise: unknown; saved_for_later: number;
}

/** Load the ACTIVE cart for a customer, creating one if absent. */
export async function getOrCreateCart(customerId: string): Promise<string> {
  const existing = await queryOne<CartRow>(
    "SELECT id, customer_id, guest_token, status, expires_at FROM cart WHERE customer_id = ? AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
    [customerId]);
  if (existing) return existing.id;
  const id = ulid();
  // expires_at = CART_TTL_DAYS (90) from now (cart-domain CART_TTL_DAYS).
  await query(
    'INSERT INTO cart (id, customer_id, guest_token, status, expires_at) VALUES (?, ?, NULL, \'ACTIVE\', DATE_ADD(NOW(3), INTERVAL 90 DAY))',
    [id, customerId]);
  return id;
}

/** Guest carts are device-bound via guest_token (FR-CUS-007 merge-on-login). */
export async function getOrCreateGuestCart(guestToken: string): Promise<string> {
  if (!guestToken || guestToken.length > 64) throw badRequest('guest token must be 1-64 chars', 'BAD_GUEST_TOKEN');
  const existing = await queryOne<CartRow>(
    "SELECT id, customer_id, guest_token, status, expires_at FROM cart WHERE guest_token = ? AND status = 'ACTIVE' LIMIT 1",
    [guestToken]);
  if (existing) return existing.id;
  const id = ulid();
  await query(
    "INSERT INTO cart (id, customer_id, guest_token, status, expires_at) VALUES (?, NULL, ?, 'ACTIVE', DATE_ADD(NOW(3), INTERVAL 90 DAY))",
    [id, guestToken]);
  return id;
}

/** Hydrate the pure domain cart (lines with paise prices) from the DB. */
async function loadDomainCart(cartId: string): Promise<DomainCart> {
  const row = await queryOne<CartRow>(
    'SELECT id, customer_id, guest_token, status, expires_at FROM cart WHERE id = ?', [cartId]);
  if (!row) throw notFound('Cart not found');
  const lines = await query<CartLineRow>(
    'SELECT id, cart_id, listing_id, variant_sku, vendor_id, qty, unit_mrppaise, unit_salepaise, saved_for_later FROM cart_line WHERE cart_id = ? ORDER BY added_at',
    [cartId]);
  const toDomain = (r: CartLineRow, saved: boolean): DomainCartLine => ({
    listingId: r.listing_id,
    vendorId: r.vendor_id,
    categoryId: '', // filled below from listing join; domain never branches on it
    qty: num(r.qty),
    unitPriceAtAddPaise: paise(r.unit_salepaise),
    ...(saved ? {} : {}),
  });
  const active: DomainCartLine[] = [];
  const savedForLater: DomainCartLine[] = [];
  for (const r of lines) {
    const cat = await queryOne<{ category_id: string }>(
      'SELECT p.category_id FROM cat_listing l JOIN cat_product p ON p.id = l.product_id WHERE l.id = ?', [r.listing_id]);
    const line = { ...toDomain(r, false), categoryId: cat?.category_id ?? '' };
    if (num(r.saved_for_later) === 1) savedForLater.push(line); else active.push(line);
  }
  return { cartId, ownerId: row.customer_id, active, savedForLater, updatedAtMs: row.expires_at.getTime() };
}

/** Persist a domain cart back: replace its lines in one transaction. */
async function saveDomainCart(cart: DomainCart): Promise<void> {
  await tx(async (conn) => {
    await conn.query('DELETE FROM cart_line WHERE cart_id = ?', [cart.cartId]);
    for (const l of [...cart.active, ...cart.savedForLater]) {
      const saved = cart.savedForLater.includes(l) ? 1 : 0;
      // unit_mrppaise/unit_salepaise are BIGINT paise; snapshot = current unit price.
      await conn.query(
        'INSERT INTO cart_line (id, cart_id, listing_id, variant_sku, vendor_id, qty, unit_mrppaise, unit_salepaise, saved_for_later) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)',
        [ulid(), cart.cartId, l.listingId, l.vendorId, l.qty, l.unitPriceAtAddPaise, l.unitPriceAtAddPaise, saved]);
    }
  });
}

/** CartView DTO: loads facts for display (vendor names, current prices, stock). */
export async function getCartView(cartId: string): Promise<CartView> {
  const cart = await loadDomainCart(cartId);
  const allLines = [...cart.active, ...cart.savedForLater];
  const facts = await loadLineFacts(allLines.map((l) => l.listingId));
  const savedSet = new Set(cart.savedForLater.map((l) => l.listingId));
  const views = allLines.map((l) => {
    const f = facts.get(l.listingId);
    return {
      id: `${cart.cartId}:${l.listingId}`,
      listingId: l.listingId,
      vendorId: l.vendorId,
      vendorName: f?.vendorName ?? '',
      title: f?.title ?? '',
      mrpPaise: f?.mrpPaise ?? l.unitPriceAtAddPaise,
      pricePaise: f?.pricePaise ?? l.unitPriceAtAddPaise,
      qty: l.qty,
      savedForLater: savedSet.has(l.listingId),
      inStock: (f?.availableStock ?? 0) > 0,
      maxQty: 10,
    };
  });
  const activeViews = views.filter((v) => !v.savedForLater);
  const byVendor = groupByVendor(cart).map((g) => ({
    vendorId: g.vendorId,
    vendorName: facts.get(g.lines[0]!.listingId)?.vendorName ?? '',
    lines: activeViews.filter((v) => g.lines.some((gl) => gl.listingId === v.listingId)),
    subtotalPaise: g.lines.reduce((a, l) => {
      const f = facts.get(l.listingId);
      return a + (f?.pricePaise ?? l.unitPriceAtAddPaise) * l.qty;
    }, 0),
  }));
  const itemTotalPaise = activeViews.reduce((a, v) => a + v.pricePaise * v.qty, 0);
  const savingsPaise = activeViews.reduce((a, v) => a + (v.mrpPaise - v.pricePaise) * v.qty, 0);
  return {
    id: cart.cartId,
    lines: views,
    byVendor,
    itemTotalPaise,
    savingsPaise,
    itemCount: activeViews.reduce((a, v) => a + v.qty, 0),
  };
}

interface LineFacts {
  vendorName: string; title: string; mrpPaise: number; pricePaise: number; availableStock: number;
  categoryId: string; vendorId: string; vendorSuspended: boolean;
}

/** Current DB facts for a set of listing ids (price, stock, vendor state). */
async function loadLineFacts(listingIds: string[]): Promise<Map<string, LineFacts>> {
  const out = new Map<string, LineFacts>();
  if (listingIds.length === 0) return out;
  const placeholders = listingIds.map(() => '?').join(',');
  const rows = await query<{
    id: string; vendor_id: string; title: string; mrp: string; price: string; category_id: string;
    vendor_name: string; vendor_status: string; avail: number | string;
  }>(`
    SELECT l.id, l.vendor_id, l.title, l.mrp, l.price, p.category_id,
           vs.display_name AS vendor_name, vs.status AS vendor_status,
           IFNULL((SELECT SUM(i.on_hand - i.reserved) FROM inv_item i
                    JOIN cat_variant v ON v.sku = i.variant_sku
                   WHERE v.listing_id = l.id), 0) AS avail
    FROM cat_listing l
    JOIN cat_product p ON p.id = l.product_id
    JOIN ven_store vs ON vs.id = l.vendor_id
    WHERE l.id IN (${placeholders})`, listingIds);
  for (const r of rows) {
    out.set(r.id, {
      vendorName: r.vendor_name,
      title: r.title,
      mrpPaise: paise(r.mrp),
      pricePaise: paise(r.price),
      availableStock: num(r.avail),
      categoryId: r.category_id,
      vendorId: r.vendor_id,
      vendorSuspended: r.vendor_status !== 'APPROVED',
    });
  }
  return out;
}

/** Mutations: thin wrappers over the ported pure cart functions + save. */

export async function addCartLine(customerId: string, listingId: string, qty: number): Promise<CartView> {
  if (!Number.isInteger(qty) || qty < 1) throw unprocessable('qty must be a positive integer', { qty: 'must be a positive integer' });
  const cartId = await getOrCreateCart(customerId);
  const cart = await loadDomainCart(cartId);
  const facts = await loadLineFacts([listingId]);
  const f = facts.get(listingId);
  if (!f) throw notFound('Listing not found');
  if (f.vendorSuspended) throw unprocessable('Vendor is suspended', { listingId: 'vendor suspended' });
  const { addItem } = await import('./cart-domain.js');
  const res = addItem(cart, {
    listingId, vendorId: f.vendorId, categoryId: f.categoryId,
    qty, unitPriceAtAddPaise: f.pricePaise,
  }, Date.now());
  if (!res.ok) throw unprocessable(res.reason, { qty: res.reason });
  await saveDomainCart(res.cart);
  return getCartView(cartId);
}

export async function updateCartQty(customerId: string, listingId: string, qty: number): Promise<CartView> {
  const cartId = await getOrCreateCart(customerId);
  const cart = await loadDomainCart(cartId);
  const { updateQty } = await import('./cart-domain.js');
  const res = updateQty(cart, listingId, qty, Date.now());
  if (!res.ok) throw unprocessable(res.reason, { qty: res.reason });
  await saveDomainCart(res.cart);
  return getCartView(cartId);
}

export async function removeCartLine(customerId: string, listingId: string): Promise<CartView> {
  const cartId = await getOrCreateCart(customerId);
  const cart = await loadDomainCart(cartId);
  const { removeItem } = await import('./cart-domain.js');
  await saveDomainCart(removeItem(cart, listingId, Date.now()));
  return getCartView(cartId);
}

export async function saveForLater(customerId: string, listingId: string): Promise<CartView> {
  const cartId = await getOrCreateCart(customerId);
  const cart = await loadDomainCart(cartId);
  const res = (await import('./cart-domain.js')).saveForLater(cart, listingId, Date.now());
  if (!res.ok) throw notFound(res.reason);
  await saveDomainCart(res.cart);
  return getCartView(cartId);
}

export async function moveToCart(customerId: string, listingId: string): Promise<CartView> {
  const cartId = await getOrCreateCart(customerId);
  const cart = await loadDomainCart(cartId);
  const res = (await import('./cart-domain.js')).moveToCart(cart, listingId, Date.now());
  if (!res.ok) throw notFound(res.reason);
  await saveDomainCart(res.cart);
  return getCartView(cartId);
}

/* ------------------------------------------------------------------ *
 * Quote (FR-CUS-014) — facts in, ported engine, DTO out
 * ------------------------------------------------------------------ */

/** Serviceability fact: vendor has an inv_location whose pincode matches. */
async function pinServiceable(vendorIds: string[], pin: string): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (vendorIds.length === 0) return out;
  const placeholders = vendorIds.map(() => '?').join(',');
  const rows = await query<{ vendor_id: string }>(
    `SELECT DISTINCT vendor_id FROM inv_location WHERE vendor_id IN (${placeholders}) AND pincode = ?`,
    [...vendorIds, pin]);
  const ok = new Set(rows.map((r) => r.vendor_id));
  for (const v of vendorIds) out.set(v, ok.has(v));
  return out;
}

async function loadCouponsByCodes(codes: string[]): Promise<Coupon[]> {
  if (codes.length === 0) return [];
  const placeholders = codes.map(() => '?').join(',');
  const rows = await query<{
    id: string; code: string; kind: string; value_bps: number; value_paise: unknown;
    min_cart_paise: unknown; per_user_limit: number; starts_at: Date; ends_at: Date; status: string;
  }>(`
    SELECT id, code, kind, value_bps, value_paise, min_cart_paise, per_user_limit, starts_at, ends_at, status
    FROM mkt_coupon WHERE code IN (${placeholders})`, codes);
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    level: 'PLATFORM' as const,
    kind: r.kind === 'PERCENT' ? 'PERCENT' as const : 'FLAT' as const,
    value: r.kind === 'PERCENT' ? num(r.value_bps) : paise(r.value_paise),
    minOrderPaise: paise(r.min_cart_paise),
    startsAtMs: r.starts_at.getTime(),
    endsAtMs: r.ends_at.getTime(),
    firstOrderOnly: false,
    perUserRemaining: num(r.per_user_limit),
    autoApply: false,
    stackWithVendorCoupon: true,
  }));
}

/**
 * Build a server-authoritative quote for a customer's cart. Loads every fact,
 * then delegates pricing entirely to the ported `createQuote`. Returns the
 * engine's `Quote` (not the DTO) so the route layer can adapt it; problems are
 * thrown as 422 with per-line reasons.
 */
export async function buildQuote(input: {
  customerId: string; addressPin: string; paymentMethod: 'PREPAID' | 'COD'; couponCodes: string[];
}): Promise<{ quote: EngineQuote; lines: CheckoutLine[] }> {
  const cartId = await getOrCreateCart(input.customerId);
  const cart = await loadDomainCart(cartId);
  if (cart.active.length === 0) throw unprocessable('Cart has no active lines', { cart: 'empty' });

  const facts = await loadLineFacts(cart.active.map((l) => l.listingId));
  const vendorIds = [...new Set(cart.active.map((l) => l.vendorId))];
  const serviceable = await pinServiceable(vendorIds, input.addressPin);

  const lines: CheckoutLine[] = cart.active.map((l, i) => {
    const f = facts.get(l.listingId);
    if (!f) throw unprocessable(`Listing ${l.listingId} no longer exists`, { [`lines[${i}]`]: 'unknown listing' });
    return {
      lineId: `CL${i + 1}`,
      listingId: l.listingId,
      vendorId: l.vendorId,
      categoryId: f.categoryId,
      qty: l.qty,
      unitListPaise: f.pricePaise,
      availableStock: f.availableStock,
      serviceablePin: serviceable.get(l.vendorId) ?? false,
      taxBps: FLAT_TAX_BPS,
    };
  });

  const coupons = await loadCouponsByCodes(input.couponCodes);
  const req: CheckoutRequest = {
    cartId, customerId: input.customerId, addressPin: input.addressPin, lines, coupons,
    requestedPaymentMethod: input.paymentMethod, fraudScore: 0, codFraudThreshold: 0.7, nowMs: Date.now(),
  };
  const mintQuoteId = (seed: string): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'Q' + (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
  };
  const result = createQuote(req, mintQuoteId);
  if (!result.ok) {
    const fields: Record<string, string> = {};
    for (const p of result.problems) fields[`lines.${p.lineId}`] = p.reason;
    throw unprocessable('Quote failed revalidation', fields);
  }
  return { quote: result.quote, lines };
}

/** Adapt the engine Quote to the wire DTO (paise only; no re-derivation). */
export function quoteToDto(q: EngineQuote, problems?: QuoteLineProblem[]): Quote {
  return {
    quoteId: q.quoteId,
    grandTotalPaise: q.grandTotalPaise,
    itemTotalPaise: q.itemTotalPaise,
    discountTotalPaise: q.discountTotalPaise,
    taxTotalPaise: q.taxTotalPaise,
    shippingTotalPaise: 0,
    expiresAtMs: q.expiresAtMs,
    paymentMethod: q.paymentMethod,
    codEligible: q.codEligible,
    codReasons: q.codReasons,
    subOrders: q.subOrders.map((s) => ({ vendorId: s.vendorId, lineIds: s.lineIds, grandPaise: s.grandPaise })),
    ...(problems && problems.length > 0 ? { problems } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Order creation (FR-CUS-014/015) — idempotent transaction
 * ------------------------------------------------------------------ */

/**
 * Create the order from a freshly rebuilt quote. The quote is re-derived inside
 * the transaction and the captured amount must match its grand total to the
 * paisa (FR-CUS-014 acceptance). Idempotency: `pay_payment.idempotency_key` is
 * UNIQUE; a replay with the same key returns the existing order (200).
 */
export async function createOrder(input: {
  customerId: string; addressId: string; paymentMethod: 'PREPAID' | 'COD';
  grandTotalPaise: number; paymentRef?: string; idempotencyKey: string | null; addressPin: string;
}): Promise<{ orderId: string; replay: boolean }> {
  // `pay_payment.gateway_order_ref` is NOT NULL and is part of the UNIQUE
  // (gateway, gateway_order_ref) key, so COD still needs a value — but no gateway
  // ever issues one for cash on delivery. The server therefore mints `COD:<orderId>`
  // rather than asking the client to invent a reference, which would put a fabricated
  // provider id in the ledger. For PREPAID the ref is the provider's own order ref,
  // so the client must supply it.
  const orderId = ulid();
  const gatewayOrderRef =
    input.paymentMethod === 'COD' ? `COD:${orderId}` : (input.paymentRef ?? '');
  if (input.paymentMethod === 'PREPAID' && !gatewayOrderRef) {
    throw unprocessable('paymentRef is required for PREPAID', { paymentRef: 'required' });
  }

  const idem = input.idempotencyKey
    ?? (input.paymentMethod === 'PREPAID' ? `auto:${gatewayOrderRef}` : `auto:${orderId}`);
  if (idem.length > 64) throw badRequest('Idempotency-Key must be at most 64 chars', 'BAD_IDEMPOTENCY_KEY');

  // Replay check before building anything (cheap unique-key lookup).
  const replay = await queryOne<{ order_id: string }>(
    'SELECT order_id FROM pay_payment WHERE idempotency_key = ?', [idem]);
  if (replay) return { orderId: replay.order_id, replay: true };

  const addr = await queryOne<{
    id: string; customer_id: string; line1: string; line2: string | null; landmark: string | null;
    city: string; state: string; pincode: string; country: string; mobile: string;
  }>(`
    SELECT id, customer_id, line1, line2, landmark, city, state, pincode, country, mobile
    FROM id_address WHERE id = ? AND customer_id = ?`, [input.addressId, input.customerId]);
  if (!addr) throw notFound('Address not found');
  if (addr.pincode !== input.addressPin) throw unprocessable('Address PIN does not match quote PIN', { addressId: 'pin mismatch' });

  const { quote, lines: checkoutLines } = await buildQuote({
    customerId: input.customerId, addressPin: input.addressPin,
    paymentMethod: input.paymentMethod, couponCodes: [],
  });
  if (isExpired(quote, Date.now())) throw conflict('Quote expired; request a new quote', 'QUOTE_EXPIRED');
  if (quote.grandTotalPaise !== input.grandTotalPaise) {
    throw unprocessable('Captured amount does not match quote', { grandTotalPaise: 'amount mismatch' });
  }

  const placedAt = new Date();

  await tx(async (conn) => {
    // 1. reserve stock for every line (guard-clause: refuse rather than oversell)
    for (const l of checkoutLines) {
      const res = await conn.query(
        `UPDATE inv_item i JOIN cat_variant v ON v.sku = i.variant_sku
         SET i.reserved = i.reserved + ?
         WHERE v.listing_id = ? AND (i.on_hand - i.reserved) >= ?`,
        [l.qty, l.listingId, l.qty]) as { affectedRows?: number };
      if ((res?.affectedRows ?? 0) === 0) {
        throw unprocessable(`Insufficient stock for ${l.listingId}`, { [`lines.${l.listingId}`]: 'OUT_OF_STOCK' });
      }
    }

    // 2. order header (money as DECIMAL strings via dec())
    await conn.query(
      `INSERT INTO ord_order (id, customer_id, quote_id, status, item_total, discount_total, shipping_total, tax_total, grand_total, promo_allocation, ship_address, placed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, input.customerId, quote.quoteId, 'CONFIRMED',
        dec(quote.itemTotalPaise), dec(quote.discountTotalPaise), dec(0), dec(quote.taxTotalPaise),
        dec(quote.grandTotalPaise),
        JSON.stringify(quote.subOrders.map((s) => ({ vendorId: s.vendorId, grandPaise: s.grandPaise }))),
        JSON.stringify({ line1: addr.line1, line2: addr.line2, landmark: addr.landmark, city: addr.city, state: addr.state, pincode: addr.pincode, country: addr.country, mobile: addr.mobile }),
        placedAt]);

    // 3. one sub-order per vendor (BRU-03)
    for (const s of quote.subOrders) {
      const subId = ulid();
      const acceptBy = new Date(placedAt.getTime() + 12 * 3600 * 1000);
      const shipBy = new Date(placedAt.getTime() + 48 * 3600 * 1000);
      await conn.query(
        `INSERT INTO ord_sub_order (id, order_id, vendor_id, state, sla_accept_by, sla_ship_by, created_at)
         VALUES (?, ?, ?, 'CONFIRMED', ?, ?, ?)`,
        [subId, orderId, s.vendorId, acceptBy, shipBy, placedAt]);
    }

    // 4. payment row (no provider: COD records method COD/AUTHORISED; PREPAID
    //    records UPI/INITIATED with gateway BFF_UNVERIFIED — no fake capture).
    const method = quote.paymentMethod === 'COD' ? 'COD' : 'UPI';
    const status = quote.paymentMethod === 'COD' ? 'AUTHORISED' : 'INITIATED';
    const gateway = quote.paymentMethod === 'COD' ? 'COD' : 'BFF_UNVERIFIED';
    try {
      await conn.query(
        `INSERT INTO pay_payment (id, order_id, method, status, amount, gateway, gateway_order_ref, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ulid(), orderId, method, status, dec(quote.grandTotalPaise), gateway, gatewayOrderRef, idem]);
    } catch (err) {
      const e = err as { code?: string; errno?: number };
      if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
        throw conflict('Idempotency key already used by another order', 'IDEMPOTENCY_CONFLICT');
      }
      throw err;
    }

    // 5. clear the cart -> CHECKED_OUT
    await conn.query("UPDATE cart SET status = 'CHECKED_OUT' WHERE customer_id = ? AND status = 'ACTIVE'", [input.customerId]);
  });

  return { orderId, replay: false };
}

/* ------------------------------------------------------------------ *
 * Order reads (FR-CUS-016)
 * ------------------------------------------------------------------ */

interface OrderRow {
  id: string; customer_id: string; quote_id: string; status: string; item_total: string;
  discount_total: string; shipping_total: string; tax_total: string; grand_total: string;
  ship_address: Record<string, unknown>; placed_at: Date;
}

export async function listOrders(customerId: string, limit: number, cursorRaw: string | null): Promise<{ items: OrderSummary[]; nextCursor: string | null }> {
  const cursor = decodeCursor(cursorRaw);
  const params: unknown[] = [customerId];
  let cursorSql = '';
  if (cursor) {
    cursorSql = ' AND (o.placed_at < ? OR (o.placed_at = ? AND o.id < ?))';
    const d = new Date(String(cursor.k));
    params.push(d, d, cursor.id);
  }
  const rows = await query<OrderRow & { vendor_names: string | null; sub_count: number | string }>(`
    SELECT o.id, o.customer_id, o.quote_id, o.status, o.item_total, o.discount_total, o.shipping_total,
           o.tax_total, o.grand_total, o.ship_address, o.placed_at,
           (SELECT GROUP_CONCAT(DISTINCT vs.display_name ORDER BY vs.display_name SEPARATOR ',')
              FROM ord_sub_order so JOIN ven_store vs ON vs.id = so.vendor_id
             WHERE so.order_id = o.id) AS vendor_names,
           (SELECT COUNT(*) FROM ord_sub_order so WHERE so.order_id = o.id) AS sub_count
    FROM ord_order o WHERE o.customer_id = ?${cursorSql}
    ORDER BY o.placed_at DESC, o.id DESC LIMIT ?`, [...params, limit + 1]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      placedAt: iso(r.placed_at),
      status: r.status,
      grandTotalPaise: paise(r.grand_total),
      // No order-line table: itemCount cannot be derived; reported as 0 (documented).
      itemCount: 0,
      vendorNames: r.vendor_names ? r.vendor_names.split(',') : [],
    })),
    nextCursor: hasMore && last ? encodeCursor({ k: iso(last.placed_at), id: last.id }) : null,
  };
}

export async function getOrderDetail(customerId: string, orderId: string): Promise<OrderDetail> {
  const r = await queryOne<OrderRow>(`
    SELECT id, customer_id, quote_id, status, item_total, discount_total, shipping_total, tax_total, grand_total, ship_address, placed_at
    FROM ord_order WHERE id = ? AND customer_id = ?`, [orderId, customerId]);
  if (!r) throw notFound('Order not found');

  const subs = await query<{
    id: string; vendor_id: string; vendor_name: string; state: string; sla_accept_by: Date; sla_ship_by: Date;
  }>(`
    SELECT so.id, so.vendor_id, vs.display_name AS vendor_name, so.state, so.sla_accept_by, so.sla_ship_by
    FROM ord_sub_order so JOIN ven_store vs ON vs.id = so.vendor_id
    WHERE so.order_id = ? ORDER BY so.created_at`, [orderId]);

  const pay = await queryOne<{ method: string; status: string }>(
    'SELECT method, status FROM pay_payment WHERE order_id = ? ORDER BY created_at LIMIT 1', [orderId]);

  const timeline = await query<{ created_at: Date; state: string }>(
    'SELECT created_at, state FROM ord_sub_order WHERE order_id = ? ORDER BY created_at', [orderId]);

  const addr = jsonCol<Record<string, string>>(r.ship_address, {});
  return {
    id: r.id,
    placedAt: iso(r.placed_at),
    status: r.status,
    grandTotalPaise: paise(r.grand_total),
    itemCount: 0,
    vendorNames: subs.map((s) => s.vendor_name),
    quoteId: r.quote_id,
    paymentRef: '',
    itemTotalPaise: paise(r.item_total),
    taxTotalPaise: paise(r.tax_total),
    shippingTotalPaise: paise(r.shipping_total),
    discountTotalPaise: paise(r.discount_total),
    address: {
      id: r.id, label: 'OTHER', line1: addr.line1 ?? '', line2: addr.line2, landmark: addr.landmark,
      city: addr.city ?? '', state: addr.state ?? '', pincode: addr.pincode ?? '', country: addr.country ?? 'IN',
      mobile: addr.mobile ?? '', isDefault: false,
    },
    paymentMethod: pay?.method ?? '',
    paymentStatus: pay?.status ?? '',
    subOrders: subs.map((s) => ({
      id: s.id, vendorId: s.vendor_id, vendorName: s.vendor_name,
      amountPaise: 0, // no line/sub-order amount column; grand is order-level only
      state: s.state as OrderDetail['subOrders'][number]['state'],
      slaAcceptBy: iso(s.sla_accept_by), slaShipBy: iso(s.sla_ship_by),
    })),
    timeline: timeline.map((t) => ({ at: iso(t.created_at), label: t.state, state: t.state })),
  };
}

/** Customer cancels an order: only while every sub-order is still CONFIRMED. */
export async function cancelOrder(customerId: string, orderId: string): Promise<void> {
  const r = await queryOne<{ status: string }>(
    'SELECT status FROM ord_order WHERE id = ? AND customer_id = ?', [orderId, customerId]);
  if (!r) throw notFound('Order not found');
  const active = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ord_sub_order WHERE order_id = ? AND state NOT IN ('CANCELLED','CLOSED')", [orderId]);
  if (num(active?.n ?? 0) > 0) {
    // Sub-orders exist and none are terminal: block cancellation (vendor workflow owns state).
    const anyConfirmed = await queryOne<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM ord_sub_order WHERE order_id = ? AND state = 'CONFIRMED'", [orderId]);
    if (num(anyConfirmed?.n ?? 0) > 0) throw forbidden('Order cannot be cancelled after vendor confirmation');
    throw conflict('Order is already in progress', 'ORDER_IN_PROGRESS');
  }
  await query("UPDATE ord_order SET status = 'CANCELLED' WHERE id = ? AND customer_id = ?", [orderId, customerId]);
}

/* ------------------------------------------------------------------ *
 * Returns (FR-CUS-017/018)
 * ------------------------------------------------------------------ */

const RMA_REASONS = new Set(['DAMAGED', 'WRONG_ITEM', 'MISSING_PARTS', 'NOT_AS_DESCRIBED', 'SIZE_ISSUE', 'CHANGED_MIND', 'LATE_DELIVERY', 'QUALITY_ISSUE']);

export async function createReturn(input: {
  customerId: string; subOrderId: string; listingId: string; qty: number; reasonCode: string; reasonText?: string;
}): Promise<RmaRequest> {
  if (!RMA_REASONS.has(input.reasonCode)) {
    throw unprocessable('Unknown reason code', { reasonCode: `must be one of ${[...RMA_REASONS].join(', ')}` });
  }
  if (!Number.isInteger(input.qty) || input.qty < 1) {
    throw unprocessable('qty must be a positive integer', { qty: 'must be a positive integer' });
  }
  const sub = await queryOne<{ order_id: string; vendor_id: string; state: string; customer_id: string }>(`
    SELECT so.order_id, so.vendor_id, so.state, o.customer_id
    FROM ord_sub_order so JOIN ord_order o ON o.id = so.order_id
    WHERE so.id = ? AND o.customer_id = ?`, [input.subOrderId, input.customerId]);
  if (!sub) throw notFound('Sub-order not found');
  if (sub.state !== 'DELIVERED') throw unprocessable('Only DELIVERED sub-orders can be returned', { subOrderId: 'not delivered' });

  // Listing must exist and belong to the sub-order's vendor. Without an
  // order-line table we cannot prove the listing was inside this order, but
  // vendor-match is the strongest genuine check available.
  const listing = await queryOne<{ vendor_id: string; title: string }>(
    'SELECT vendor_id, title FROM cat_listing WHERE id = ?', [input.listingId]);
  if (!listing) throw notFound('Listing not found');
  if (listing.vendor_id !== sub.vendor_id) {
    throw unprocessable('Listing does not belong to this sub-order vendor', { listingId: 'vendor mismatch' });
  }

  const rmaId = ulid();
  const now = new Date();
  await query(
    `INSERT INTO rma_request (id, order_id, sub_order_id, customer_id, vendor_id, listing_id, qty, reason_code, reason_text, state, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
    [rmaId, sub.order_id, input.subOrderId, input.customerId, sub.vendor_id, input.listingId, input.qty, input.reasonCode, input.reasonText ?? null, now]);
  await query(
    'INSERT INTO rma_event (id, rma_id, from_state, to_state, actor_type, actor_id, note) VALUES (?, ?, NULL, \'REQUESTED\', \'CUSTOMER\', ?, ?)',
    [ulid(), rmaId, input.customerId, input.reasonText ?? null]);
  return {
    id: rmaId, orderId: sub.order_id, subOrderId: input.subOrderId, listingId: input.listingId, listingTitle: listing.title,
    qty: input.qty, reasonCode: input.reasonCode, reasonText: input.reasonText, state: 'REQUESTED',
    requestedAt: now.toISOString(),
    events: [{ at: now.toISOString(), toState: 'REQUESTED', actorType: 'CUSTOMER' }],
  };
}

interface RmaRow {
  id: string; order_id: string; sub_order_id: string; listing_id: string; qty: number;
  reason_code: string; reason_text: string | null; state: string; refund_paise: unknown;
  refund_method: string | null; requested_at: Date; decided_at: Date | null;
}

/** Row → DTO, shared by the list and single reads so both carry identical fields. */
async function toRmaRequest(r: RmaRow): Promise<RmaRequest> {
  const events = await query<{ from_state: string | null; to_state: string; actor_type: string; note: string | null; created_at: Date }>(
    'SELECT from_state, to_state, actor_type, note, created_at FROM rma_event WHERE rma_id = ? ORDER BY created_at', [r.id]);
  return {
    id: r.id, orderId: r.order_id, subOrderId: r.sub_order_id, listingId: r.listing_id,
    listingTitle: '', qty: num(r.qty), reasonCode: r.reason_code, reasonText: r.reason_text ?? undefined,
    state: r.state as RmaRequest['state'],
    refundPaise: r.refund_paise === null || r.refund_paise === undefined ? undefined : paise(r.refund_paise),
    refundMethod: (r.refund_method as 'ORIGINAL' | 'WALLET' | null) ?? undefined,
    requestedAt: iso(r.requested_at), decidedAt: isoOrNull(r.decided_at) ?? undefined,
    events: events.map((e) => ({ at: iso(e.created_at), toState: e.to_state as RmaRequest['state'], note: e.note ?? undefined, actorType: e.actor_type })),
  };
}

export async function listReturns(customerId: string): Promise<RmaRequest[]> {
  const rows = await query<RmaRow>(`
    SELECT id, order_id, sub_order_id, listing_id, qty, reason_code, reason_text, state,
           refund_paise, refund_method, requested_at, decided_at
    FROM rma_request WHERE customer_id = ? ORDER BY requested_at DESC`, [customerId]);
  const out: RmaRequest[] = [];
  for (const r of rows) out.push(await toRmaRequest(r));
  return out;
}

/** One return with its event trail; 404 unless it belongs to this customer. */
export async function getReturn(customerId: string, rmaId: string): Promise<RmaRequest> {
  const r = await queryOne<RmaRow>(`
    SELECT id, order_id, sub_order_id, listing_id, qty, reason_code, reason_text, state,
           refund_paise, refund_method, requested_at, decided_at
    FROM rma_request WHERE id = ? AND customer_id = ?`, [rmaId, customerId]);
  if (!r) throw notFound('Return not found');
  return toRmaRequest(r);
}

/**
 * Customer withdraws a return (FR-CUS-017). Admitted only while the request is
 * still REQUESTED — once a vendor or the returns desk has acted (APPROVED,
 * PICKUP_SCHEDULED, …) the workflow owns it and a customer-side withdrawal is
 * refused by name with the current state. V006's `ck_rma_state` vocabulary has
 * no WITHDRAWN value, so the withdrawal is recorded as REJECTED (the request
 * will not be processed) with an rma_event note naming it as a customer
 * withdrawal, rather than inventing a state string the schema would refuse.
 */
export async function cancelReturn(customerId: string, rmaId: string): Promise<void> {
  const r = await queryOne<{ id: string; state: string }>(
    'SELECT id, state FROM rma_request WHERE id = ? AND customer_id = ?', [rmaId, customerId]);
  if (!r) throw notFound('Return not found');
  if (r.state !== 'REQUESTED') {
    throw conflict(`Return cannot be withdrawn from state ${r.state}`, 'NOT_WITHDRAWABLE');
  }
  await tx(async (conn) => {
    // Guard in the UPDATE itself: a concurrent decision between the read and
    // this write makes affectedRows 0, which is refused rather than double-applied.
    const res = await conn.query(
      "UPDATE rma_request SET state = 'REJECTED', decided_at = NOW(3) WHERE id = ? AND customer_id = ? AND state = 'REQUESTED'",
      [rmaId, customerId]) as { affectedRows?: number };
    if ((res?.affectedRows ?? 0) === 0) throw conflict('Return was decided concurrently', 'NOT_WITHDRAWABLE');
    await conn.query(
      `INSERT INTO rma_event (id, rma_id, from_state, to_state, actor_type, actor_id, note)
       VALUES (?, ?, 'REQUESTED', 'REJECTED', 'CUSTOMER', ?, 'withdrawn by customer')`,
      [ulid(), rmaId, customerId]);
  });
}

export { QUOTE_VALIDITY_MS };
