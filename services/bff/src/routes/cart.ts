/**
 * Cart, checkout, order and return routes (FR-CUS-007, FR-CUS-014..018).
 *
 * Auth: every route here is customer-only via `customer(ctx)`, which resolves
 * the principal from the bearer token (identity-svc introspection). A vendor
 * or staff token is refused at the edge — these surfaces are personal.
 *
 * Checkout is two-phase: `POST /checkout/quote` is read-only (it prices the
 * cart and returns an immutable quote), `POST /checkout/orders` captures it.
 * The capture re-derives the quote server-side and refuses if the client's
 * asserted total does not match to the paisa (FR-CUS-014 acceptance).
 */
import { Router, notFound, unprocessable } from '../http.js';
import type { Ctx } from '../db.js';
import * as commerce from '../repos/commerce.js';
import { limitOf } from '../repos/util.js';
import { body, customer, int, oneOf, paiseField, str, ulidParam, PAYMENT_METHODS, RMA_REASONS } from './validate.js';

/** Register cart, checkout, order and return routes onto `router`. */
export function register(router: Router): void {
  /* ---------------------------------------------------------------- *
   * Cart (FR-CUS-007)
   * **************************************************************** */

  router.get('/api/v1/cart', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const cartId = await commerce.getOrCreateCart(auth.subject);
    return commerce.getCartView(cartId);
  });

  router.post('/api/v1/cart/lines', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const b = body<{ listingId?: unknown; qty?: unknown }>(ctx);
    const listingId = ulidParam(b.listingId, 'listingId');
    const qty = int(b.qty);
    if (qty === undefined || qty < 1) throw unprocessable('qty must be a positive integer', { qty: 'must be a positive integer' });
    return commerce.addCartLine(auth.subject, listingId, qty);
  });

  router.put('/api/v1/cart/lines/:listingId', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const listingId = ulidParam(ctx.params.listingId, 'listingId');
    const b = body<{ qty?: unknown }>(ctx);
    const qty = int(b.qty);
    if (qty === undefined || qty < 0) throw unprocessable('qty must be a non-negative integer', { qty: 'must be >= 0 (0 removes)' });
    return commerce.updateCartQty(auth.subject, listingId, qty);
  });

  router.delete('/api/v1/cart/lines/:listingId', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const listingId = ulidParam(ctx.params.listingId, 'listingId');
    return commerce.removeCartLine(auth.subject, listingId);
  });

  router.post('/api/v1/cart/lines/:listingId/save', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const listingId = ulidParam(ctx.params.listingId, 'listingId');
    return commerce.saveForLater(auth.subject, listingId);
  });

  router.post('/api/v1/cart/lines/:listingId/move-to-cart', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const listingId = ulidParam(ctx.params.listingId, 'listingId');
    return commerce.moveToCart(auth.subject, listingId);
  });

  /* ---------------------------------------------------------------- *
   * Checkout (FR-CUS-014)
   * **************************************************************** */

  router.post('/api/v1/checkout/quote', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const b = body<{ addressPin?: unknown; paymentMethod?: unknown; couponCodes?: unknown }>(ctx);
    const pinRaw = str(b.addressPin);
    if (!pinRaw || !/^\d{6}$/.test(pinRaw)) throw unprocessable('addressPin must be a 6-digit PIN', { addressPin: 'must be 6 digits' });
    const paymentMethod = oneOf(b.paymentMethod ?? 'PREPAID', 'paymentMethod', PAYMENT_METHODS);
    const couponCodes = Array.isArray(b.couponCodes)
      ? b.couponCodes.filter((c): c is string => typeof c === 'string').slice(0, 5)
      : [];

    // buildQuote throws 422 (with per-line fields) when the engine refuses any
    // line, so a quote that reaches here has no problems by construction; the
    // problems member of the DTO stays absent rather than an empty fake.
    const { quote } = await commerce.buildQuote({
      customerId: auth.subject, addressPin: pinRaw, paymentMethod, couponCodes,
    });
    return commerce.quoteToDto(quote);
  });

/* ------------------------------------------------------------------ *
 * Orders (FR-CUS-014/015/016)
 * ------------------------------------------------------------------ */

  router.post('/api/v1/checkout/orders', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const b = body<{ addressId?: unknown; paymentMethod?: unknown; grandTotalPaise?: unknown; paymentRef?: unknown }>(ctx);
  const addressId = ulidParam(b.addressId, 'addressId');
  const paymentMethod = oneOf(b.paymentMethod, 'paymentMethod', PAYMENT_METHODS);
  const grandTotalPaise = paiseField(b.grandTotalPaise, 'grandTotalPaise');
  const paymentRef = str(b.paymentRef);
  // COD: no gateway ever issues a reference, so the server mints `COD:<orderId>`
  // inside createOrder. Requiring the client to supply one would mean the browser
  // fabricates a provider id that lands in pay_payment.gateway_order_ref.
  if (paymentMethod === 'PREPAID' && !paymentRef) {
    throw unprocessable('paymentRef is required for PREPAID', { paymentRef: 'required' });
  }

  // The quote's PIN is re-derived from the address we will actually ship to.
  const addrPin = await resolveAddressPin(auth.subject, addressId);
  const idempotencyKey = headerIdempotencyKey(ctx);

  const result = await commerce.createOrder({
    customerId: auth.subject, addressId, paymentMethod, grandTotalPaise,
    paymentRef, idempotencyKey, addressPin: addrPin,
  });
  return result;
});

  router.get('/api/v1/orders', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const limit = limitOf(ctx.query.get('limit'), 20, 50);
    const page = await commerce.listOrders(auth.subject, limit, ctx.query.get('cursor'));
    return page;
  });

  router.get('/api/v1/orders/:id', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    return commerce.getOrderDetail(auth.subject, id);
  });

  router.post('/api/v1/orders/:id/cancel', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    await commerce.cancelOrder(auth.subject, id);
    return commerce.getOrderDetail(auth.subject, id);
  });

  /* ---------------------------------------------------------------- *
   * Returns (FR-CUS-017/018)
   * **************************************************************** */

  router.get('/api/v1/returns', async (ctx: Ctx) => {
    const auth = customer(ctx);
    return { items: await commerce.listReturns(auth.subject) };
  });

  router.post('/api/v1/returns', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const b = body<{ subOrderId?: unknown; listingId?: unknown; qty?: unknown; reasonCode?: unknown; reasonText?: unknown }>(ctx);
    const subOrderId = ulidParam(b.subOrderId, 'subOrderId');
    const listingId = ulidParam(b.listingId, 'listingId');
    const qty = int(b.qty);
    if (qty === undefined || qty < 1) throw unprocessable('qty must be a positive integer', { qty: 'must be a positive integer' });
    const reasonCode = oneOf(b.reasonCode, 'reasonCode', RMA_REASONS);
    return commerce.createReturn({
      customerId: auth.subject, subOrderId, listingId, qty, reasonCode, reasonText: str(b.reasonText),
    });
  });

  router.get('/api/v1/returns/:id', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    return commerce.getReturn(auth.subject, id);
  });

  /** Customer withdraws a return while it is still REQUESTED (FR-CUS-017). */
  router.post('/api/v1/returns/:id/cancel', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    await commerce.cancelReturn(auth.subject, id);
    return commerce.getReturn(auth.subject, id);
  });
}

async function resolveAddressPin(customerId: string, addressId: string): Promise<string> {
  const { queryOne } = await import('../db.js');
  const row = await queryOne<{ pincode: string }>(
    'SELECT pincode FROM id_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
  if (!row) throw notFound('Address not found');
  return row.pincode;
}

function headerIdempotencyKey(ctx: Ctx): string | null {
  const raw = ctx.req.headers['idempotency-key'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.length > 0 ? v.slice(0, 64) : null;
}
