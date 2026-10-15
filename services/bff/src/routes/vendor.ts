/**
 * Vendor portal routes (FR-VEN-*).
 *
 * RBAC: VENDOR (and ADMIN, which may operate on a vendor's behalf) via
 * requireRole. The vendorId is ALWAYS the authenticated principal's subject —
 * never a path or body parameter — so one vendor can never address another's
 * data even if a client forges an id.
 */
import { Router, unprocessable } from '../http.js';
import type { Ctx } from '../db.js';
import { requireRole } from '../auth.js';
import * as vendor from '../repos/vendor.js';
import { body, int, oneOf, str, ulidParam, SUB_ORDER_STATES } from './validate.js';
import type { SubOrderState } from '../dto.js';

/** Resolve the acting vendor id; refuses non-vendor principals. */
async function vendorId(ctx: Ctx): Promise<string> {
  const auth = await requireRole(ctx, 'VENDOR', 'ADMIN');
  return auth.subject;
}

/** Register vendor portal routes onto `router`. */
export function register(router: Router): void {

  router.get('/api/v1/vendor/dashboard', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  return vendor.getDashboard(id);
});

/* ------------------------------------------------------------------ *
 * Listings (FR-VEN-003)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/vendor/listings', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const state = ctx.query.get('state') ?? undefined;
  const rows = await vendor.listVendorListings(id, state ?? undefined);
  return { items: rows };
});

  /** Create a first listing (FR-VEN-003). Starts SUBMITTED, entering admin approval. */
  router.post('/api/v1/vendor/listings', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const b = body<{ title?: unknown; mrpPaise?: unknown; pricePaise?: unknown; hsnCode?: unknown; categoryId?: unknown }>(ctx);
  const title = str(b.title);
  if (!title) throw unprocessable('title is required', { title: 'required' });
  const mrp = int(b.mrpPaise);
  if (mrp === undefined || mrp < 0) throw unprocessable('mrpPaise must be a non-negative integer', { mrpPaise: 'must be >= 0' });
  const price = int(b.pricePaise);
  if (price === undefined || price < 0) throw unprocessable('pricePaise must be a non-negative integer', { pricePaise: 'must be >= 0' });
  if (price > mrp) throw unprocessable('price cannot exceed mrp', { pricePaise: 'must be <= mrpPaise' });
  const hsnCode = str(b.hsnCode);
  if (!hsnCode) throw unprocessable('hsnCode is required', { hsnCode: 'required' });
  const categoryId = ulidParam(b.categoryId, 'categoryId');
  return vendor.createListing({ vendorId: id, title, mrpPaise: mrp, pricePaise: price, hsnCode, categoryId });
});

  router.get('/api/v1/vendor/listings/:id', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const listingId = ulidParam(ctx.params.id, 'id');
  return vendor.getVendorListing(id, listingId);
});

  router.post('/api/v1/vendor/listings/:id/revisions', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const listingId = ulidParam(ctx.params.id, 'id');
  const b = body<{ title?: unknown; mrpPaise?: unknown; pricePaise?: unknown; hsnCode?: unknown }>(ctx);
  const mrp = b.mrpPaise === undefined ? undefined : int(b.mrpPaise);
  const price = b.pricePaise === undefined ? undefined : int(b.pricePaise);
  if (mrp !== undefined && mrp < 0) throw unprocessable('mrpPaise must be >= 0', { mrpPaise: 'must be >= 0' });
  if (price !== undefined && price < 0) throw unprocessable('pricePaise must be >= 0', { pricePaise: 'must be >= 0' });
  if (mrp !== undefined && price !== undefined && price > mrp) {
    throw unprocessable('price cannot exceed mrp', { pricePaise: 'must be <= mrpPaise' });
  }
  return vendor.createListingRevision({
    vendorId: id, listingId, title: str(b.title), mrpPaise: mrp, pricePaise: price, hsnCode: str(b.hsnCode),
  });
});

/* ------------------------------------------------------------------ *
 * Inventory (FR-VEN-008)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/vendor/inventory', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  return { items: await vendor.listInventory(id) };
});

  router.post('/api/v1/vendor/inventory/adjust', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const b = body<{ variantSku?: unknown; locationId?: unknown; delta?: unknown; onHand?: unknown }>(ctx);
  const variantSku = str(b.variantSku);
  if (!variantSku) throw unprocessable('variantSku is required', { variantSku: 'required' });

  // Absolute mode: the console edits the number it sees (InventoryRow.onHand),
  // not a delta. `setOnHand` resolves the vendor's row without a client-supplied
  // locationId and refuses an ambiguous multi-location variant by name.
  if (b.onHand !== undefined) {
    if (b.delta !== undefined || b.locationId !== undefined) {
      throw unprocessable('send either onHand or delta+locationId, not both',
        { onHand: 'conflicts with delta/locationId' });
    }
    const onHand = int(b.onHand);
    if (onHand === undefined || onHand < 0) throw unprocessable('onHand must be a non-negative integer', { onHand: 'non-negative integer' });
    await vendor.setOnHand(id, variantSku, onHand);
    return { items: await vendor.listInventory(id) };
  }

  const locationId = ulidParam(b.locationId, 'locationId');
  const delta = int(b.delta);
  if (delta === undefined || delta === 0) throw unprocessable('delta must be a non-zero integer', { delta: 'non-zero integer' });
  await vendor.adjustInventory(id, variantSku, locationId, delta);
  return { items: await vendor.listInventory(id) };
});

/* ------------------------------------------------------------------ *
 * Orders & state transitions (FR-VEN-007)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/vendor/orders', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const state = ctx.query.get('state') ?? undefined;
  const limit = int(ctx.query.get('limit')) ?? 50;
  const validatedState = state ? oneOf(state, 'state', SUB_ORDER_STATES) : undefined;
  return { items: await vendor.listVendorOrders(id, validatedState, Math.min(limit, 200)) };
});

  router.post('/api/v1/vendor/orders/:subOrderId/transition', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const subOrderId = ulidParam(ctx.params.subOrderId, 'subOrderId');
  const b = body<{ to?: unknown }>(ctx);
  const to = oneOf(b.to, 'to', SUB_ORDER_STATES) as SubOrderState;
  const result = await vendor.transitionSubOrder(id, subOrderId, to);
  return { ...result, to };
});

/* ------------------------------------------------------------------ *
 * Ledger & settlements (FR-FIN-*)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/vendor/ledger', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  const period = ctx.query.get('period') ?? undefined;
  if (period && !/^\d{4}-\d{2}$/.test(period)) throw unprocessable('period must be YYYY-MM', { period: 'must be YYYY-MM' });
  return { items: await vendor.listLedger(id, period ?? undefined) };
});

  router.get('/api/v1/vendor/settlements', async (ctx: Ctx) => {
  const id = await vendorId(ctx);
  return { items: await vendor.listSettlements(id) };
});

/* ------------------------------------------------------------------ *
 * Onboarding (FR-VEN-001/002)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/vendor/onboarding', async (ctx: Ctx) => {
    const id = await vendorId(ctx);
    return vendor.getOnboarding(id);
  });

  /**
   * Edit the onboarding profile (FR-VEN-001). Fields absent from the body keep
   * their value; an empty string on gstin/pan is an explicit clear (the repo
   * refuses empty displayName/legalName/email/mobile by name), matching the
   * console's "leave blank to clear" hint.
   */
  router.patch('/api/v1/vendor/onboarding', async (ctx: Ctx) => {
    const id = await vendorId(ctx);
    const b = body<{
      displayName?: unknown; legalName?: unknown; gstin?: unknown; pan?: unknown;
      email?: unknown; mobile?: unknown;
    }>(ctx);
    // Pass strings through verbatim (including '') so the repo's own empty-value
    // refusals and clear semantics stay the single decision point.
    const passthrough = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    await vendor.updateOnboarding(id, {
      displayName: passthrough(b.displayName), legalName: passthrough(b.legalName),
      gstin: passthrough(b.gstin), pan: passthrough(b.pan),
      email: passthrough(b.email), mobile: passthrough(b.mobile),
    });
    return vendor.getOnboarding(id);
  });
}
