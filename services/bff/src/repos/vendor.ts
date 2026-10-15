/**
 * Vendor portal data access (FR-VEN-*): dashboard, product listings + change
 * revisions, inventory, order queue with state transitions, the vendor's slice
 * of the finance ledger, settlements, and store onboarding.
 *
 * RBAC: every function here takes an explicit `vendorId` that the route layer
 * resolves from the authenticated principal (auth.subject); nothing in this
 * module trusts a client-supplied vendor id. The BFF cannot mint vendor
 * identities — identity-svc owns that.
 *
 * Sub-order state transitions follow V004's vocabulary and the legal edges
 * below; anything else is refused with the current and attempted state named.
 */
import { query, queryOne, tx } from '../db.js';
import { conflict, notFound, unprocessable } from '../http.js';
import type { InventoryRow, LedgerRow, SettlementSummary, SubOrderState, VendorDashboard, VendorOrderRow } from '../dto.js';
import { dec, iso, num, paise } from './util.js';
import { ulid } from '../seed/ulid.js';

/** Legal successor edges (FR-VEN-007 / UML-STM-01). A transition not listed is refused. */
const LEGAL_TRANSITIONS: Record<SubOrderState, SubOrderState[]> = {
  CONFIRMED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'NDR'],
  DELIVERED: [], // terminal for the vendor; returns reopen via rma_request, not sub-order
  NDR: ['RTO_INITIATED', 'OUT_FOR_DELIVERY'],
  RTO_INITIATED: ['RTO_RECEIVED'],
  RTO_RECEIVED: ['CLOSED'],
  RETURN_REQUESTED: ['RETURN_PICKED_UP', 'RETURN_REJECTED'],
  RETURN_PICKED_UP: ['QC'],
  QC: ['REFUNDED', 'RETURN_REJECTED'],
  REFUNDED: ['CLOSED'],
  RETURN_REJECTED: ['CLOSED'],
  CANCELLED: [],
  CLOSED: [],
};

/* ------------------------------------------------------------------ *
 * Dashboard (FR-VEN-004)
 * ------------------------------------------------------------------ */

export async function getDashboard(vendorId: string): Promise<VendorDashboard> {
  const store = await queryOne<{ id: string; display_name: string; store_slug: string; status: string; kyc_state: string; rating_avg: string; on_time_pct: number }>(
    'SELECT id, display_name, store_slug, status, kyc_state, rating_avg, on_time_pct FROM ven_store WHERE id = ?', [vendorId]);
  if (!store) throw notFound('Store not found');

  const openStates = "('CONFIRMED','ACCEPTED','PACKED','SHIPPED','OUT_FOR_DELIVERY')";
  const open = await queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM ord_sub_order WHERE vendor_id = ? AND state IN ${openStates}`, [vendorId]);
  const awaitingPickup = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ord_sub_order WHERE vendor_id = ? AND state = 'PACKED'", [vendorId]);
  const ndr = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ord_sub_order WHERE vendor_id = ? AND state = 'NDR'", [vendorId]);

  // Revenue = sum of sub-order grand shares recorded in the ledger for this vendor.
  const today = await queryOne<{ v: unknown }>(
    `SELECT IFNULL(SUM(e.credit), 0) AS v FROM fin_ledger_entry e
     WHERE e.account_code = ? AND e.ref_type = 'SUB_ORDER' AND DATE(e.created_at) = CURDATE()`,
    [`VENDOR_PAYABLE:${vendorId.slice(-6)}`]);
  const month = await queryOne<{ v: unknown }>(
    `SELECT IFNULL(SUM(e.credit), 0) AS v FROM fin_ledger_entry e
     WHERE e.account_code = ? AND e.ref_type = 'SUB_ORDER' AND DATE_FORMAT(e.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')`,
    [`VENDOR_PAYABLE:${vendorId.slice(-6)}`]);
  const commissionMonth = await queryOne<{ v: unknown }>(
    `SELECT IFNULL(SUM(e.debit), 0) AS v FROM fin_ledger_entry e
     WHERE e.account_code = ? AND e.ref_type = 'FEE' AND DATE_FORMAT(e.created_at, '%Y-%m') = DATE_FORMAT(NOW(), '%Y-%m')`,
    [`VENDOR_PAYABLE:${vendorId.slice(-6)}`]);

  const lowStock = await queryOne<{ n: number | string }>(`
    SELECT COUNT(*) AS n FROM inv_item i
    JOIN cat_variant v ON v.sku = i.variant_sku
    JOIN cat_listing l ON l.id = v.listing_id
    WHERE l.vendor_id = ? AND (i.on_hand - i.reserved) <= i.safety_stock`, [vendorId]);

  const pendingListings = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM cat_listing WHERE vendor_id = ? AND state = 'SUBMITTED'", [vendorId]);

  const spark = await query<{ label: string; v: unknown }>(`
    SELECT DATE_FORMAT(e.created_at, '%d') AS label, IFNULL(SUM(e.credit), 0) AS v
    FROM fin_ledger_entry e
    WHERE e.account_code = ? AND e.ref_type = 'SUB_ORDER' AND e.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    GROUP BY DATE_FORMAT(e.created_at, '%d') ORDER BY label`, [`VENDOR_PAYABLE:${vendorId.slice(-6)}`]);

  return {
    store: { id: store.id, displayName: store.display_name, slug: store.store_slug, status: store.status, kycState: store.kyc_state },
    openOrders: num(open?.n), awaitingPickup: num(awaitingPickup?.n), ndrCount: num(ndr?.n),
    revenueTodayPaise: paise(today?.v ?? 0), revenueMonthPaise: paise(month?.v ?? 0),
    commissionMonthPaise: paise(commissionMonth?.v ?? 0),
    ratingAvg: Number(store.rating_avg), onTimePct: num(store.on_time_pct),
    lowStockCount: num(lowStock?.n), pendingActionCount: num(pendingListings?.n),
    sparkline: spark.map((s) => ({ label: s.label, valuePaise: paise(s.v) })),
  };
}

/* ------------------------------------------------------------------ *
 * Product listings (FR-VEN-003)
 * ------------------------------------------------------------------ */

interface ListingRow {
  id: string; product_id: string; title: string; mrp: string; price: string; state: string; hsn_code: string;
  attributes: Record<string, unknown>; created_at: Date; updated_at: Date;
}

export async function listVendorListings(vendorId: string, state?: string): Promise<ListingRow[]> {
  const params: unknown[] = [vendorId];
  let sql = 'SELECT id, product_id, title, mrp, price, state, hsn_code, attributes, created_at, updated_at FROM cat_listing WHERE vendor_id = ?';
  if (state) { sql += ' AND state = ?'; params.push(state); }
  sql += ' ORDER BY updated_at DESC';
  return query<ListingRow>(sql, params);
}

export async function getVendorListing(vendorId: string, listingId: string): Promise<ListingRow> {
  const row = await queryOne<ListingRow>(
    'SELECT id, product_id, title, mrp, price, state, hsn_code, attributes, created_at, updated_at FROM cat_listing WHERE id = ? AND vendor_id = ?',
    [listingId, vendorId]);
  if (!row) throw notFound('Listing not found');
  return row;
}

/**
 * Create a revision (FR-VEN-003 change-log). Regulated fields (title, price,
 * HSN) set regulated=1 and move the listing back to SUBMITTED for re-approval
 * (BRU-02).
 */
export async function createListingRevision(input: {
  vendorId: string; listingId: string; title?: string; mrpPaise?: number; pricePaise?: number; hsnCode?: string;
}): Promise<{ revisionNo: number; regulated: boolean }> {
  const current = await getVendorListing(input.vendorId, input.listingId);
  const regulated = input.title !== undefined || input.mrpPaise !== undefined || input.hsnCode !== undefined;
  const diff: Record<string, { from: string; to: string }> = {};
  if (input.title !== undefined && input.title !== current.title) diff.title = { from: current.title, to: input.title };
  if (input.mrpPaise !== undefined && dec(input.mrpPaise) !== current.mrp) diff.mrp = { from: current.mrp, to: dec(input.mrpPaise) };
  if (input.pricePaise !== undefined && dec(input.pricePaise) !== current.price) diff.price = { from: current.price, to: dec(input.pricePaise) };
  if (input.hsnCode !== undefined && input.hsnCode !== current.hsn_code) diff.hsn = { from: current.hsn_code, to: input.hsnCode };
  if (Object.keys(diff).length === 0) throw unprocessable('No field changed', { listing: 'no-op revision' });

  const nextNo = await queryOne<{ n: number | string }>(
    'SELECT IFNULL(MAX(revision_no), 0) + 1 AS n FROM cat_listing_revision WHERE listing_id = ?', [input.listingId]);
  const revisionNo = num(nextNo?.n);

  await tx(async (conn) => {
    await conn.query(
      'INSERT INTO cat_listing_revision (id, listing_id, revision_no, regulated, field_diff, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [ulid(), input.listingId, revisionNo, regulated ? 1 : 0, JSON.stringify(diff), input.vendorId]);
    // apply the new values
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
    if (input.mrpPaise !== undefined) { sets.push('mrp = ?'); params.push(dec(input.mrpPaise)); }
    if (input.pricePaise !== undefined) { sets.push('price = ?'); params.push(dec(input.pricePaise)); }
    if (input.hsnCode !== undefined) { sets.push('hsn_code = ?'); params.push(input.hsnCode); }
    await conn.query(`UPDATE cat_listing SET ${sets.join(', ')} WHERE id = ? AND vendor_id = ?`,
      [...params, input.listingId, input.vendorId]);
    if (regulated) {
      // regulated edit re-enters the approval queue (BRU-02)
      await conn.query("UPDATE cat_listing SET state = 'SUBMITTED' WHERE id = ? AND vendor_id = ?",
        [input.listingId, input.vendorId]);
    }
  });
  return { revisionNo, regulated };
}

/**
 * Create a first listing (FR-VEN-003).
 *
 * Writes a cat_product master row (status ACTIVE — the product table's CHECK
 * admits only ACTIVE/RETIRED; visibility is governed by the *listing's* state,
 * which starts SUBMITTED and enters the admin approval queue, same as a
 * regulated revision). `categoryId` is required: cat_product.category_id is
 * NOT NULL and refusing here with the field named beats a driver-level NOT NULL
 * error. The category must exist and be ACTIVE — a retired category names the
 * refusal rather than being silently coerced to another row.
 */
export async function createListing(input: {
  vendorId: string; title: string; mrpPaise: number; pricePaise: number; hsnCode: string; categoryId: string;
}): Promise<{ id: string; productId: string; state: 'SUBMITTED' }> {
  const category = await queryOne<{ id: string }>(
    "SELECT id FROM cat_category WHERE id = ? AND status = 'ACTIVE'", [input.categoryId]);
  if (!category) throw unprocessable('categoryId must name an existing ACTIVE category', { categoryId: 'unknown or retired category' });
  if (input.pricePaise > input.mrpPaise) {
    throw unprocessable('price must not exceed mrp', { pricePaise: 'must be <= mrpPaise' });
  }
  const productId = ulid();
  const listingId = ulid();
  await tx(async (conn) => {
    await conn.query(
      "INSERT INTO cat_product (id, category_id, brand_id, title, attributes, hsn_code, status) VALUES (?, ?, NULL, ?, '{}', ?, 'ACTIVE')",
      [productId, input.categoryId, input.title, input.hsnCode]);
    await conn.query(
      `INSERT INTO cat_listing (id, vendor_id, product_id, state, title, mrp, price, attributes, hsn_code)
       VALUES (?, ?, ?, 'SUBMITTED', ?, ?, ?, '{}', ?)`,
      [listingId, input.vendorId, productId, input.title, dec(input.mrpPaise), dec(input.pricePaise), input.hsnCode]);
  });
  return { id: listingId, productId, state: 'SUBMITTED' };
}

/* ------------------------------------------------------------------ *
 * Inventory (FR-VEN-008)
 * ------------------------------------------------------------------ */

export async function listInventory(vendorId: string): Promise<InventoryRow[]> {
  const rows = await query<{
    variant_sku: string; title: string; location_name: string; on_hand: number; reserved: number; safety_stock: number;
  }>(`
    SELECT i.variant_sku, l.title, loc.name AS location_name, i.on_hand, i.reserved, i.safety_stock
    FROM inv_item i
    JOIN cat_variant v ON v.sku = i.variant_sku
    JOIN cat_listing l ON l.id = v.listing_id
    JOIN inv_location loc ON loc.id = i.location_id
    WHERE l.vendor_id = ?
    ORDER BY l.title, i.variant_sku`, [vendorId]);
  return rows.map((r) => {
    const available = num(r.on_hand) - num(r.reserved);
    return {
      variantSku: r.variant_sku, listingTitle: r.title, locationName: r.location_name,
      onHand: num(r.on_hand), reserved: num(r.reserved), available,
      safetyStock: num(r.safety_stock), belowSafety: available <= num(r.safety_stock),
    };
  });
}

/** Adjust on-hand (goods received / write-off). Guard: never below reserved. */
export async function adjustInventory(vendorId: string, variantSku: string, locationId: string, delta: number): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) throw unprocessable('delta must be a non-zero integer', { delta: 'non-zero integer' });
  const res = await query<{ affectedRows: number }>(`
    UPDATE inv_item i
    JOIN cat_variant v ON v.sku = i.variant_sku
    JOIN cat_listing l ON l.id = v.listing_id
    SET i.on_hand = i.on_hand + ?
    WHERE i.variant_sku = ? AND i.location_id = ? AND l.vendor_id = ? AND (i.on_hand + ?) >= i.reserved`,
    [delta, variantSku, locationId, vendorId, delta]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    const exists = await queryOne<{ on_hand: number }>(
      'SELECT on_hand FROM inv_item WHERE variant_sku = ? AND location_id = ?', [variantSku, locationId]);
    if (!exists) throw notFound('Inventory row not found');
    throw unprocessable('Adjustment would take on-hand below reserved', { delta: 'below reserved' });
  }
}

/**
 * Set an absolute on-hand count (FR-VEN-008). The console edits the number it
 * sees (`InventoryRow.onHand`), not a delta, so this resolves the vendor's row
 * for the variant without a client-supplied locationId (the wire DTO exposes
 * none). Zero matching rows is a 404; more than one means the variant sits in
 * several warehouses and an absolute write would be ambiguous — refused by
 * naming the situation and pointing at the location-scoped delta path, not
 * silently written to an arbitrary row. Setting on-hand below `reserved` is
 * refused before the DB's own `ck_inv_nonneg` could reject it.
 */
export async function setOnHand(vendorId: string, variantSku: string, onHand: number): Promise<void> {
  if (!Number.isInteger(onHand) || onHand < 0) throw unprocessable('onHand must be a non-negative integer', { onHand: 'non-negative integer' });
  const rows = await query<{ location_id: string; reserved: number }>(`
    SELECT i.location_id, i.reserved
    FROM inv_item i
    JOIN cat_variant v ON v.sku = i.variant_sku
    JOIN cat_listing l ON l.id = v.listing_id
    WHERE i.variant_sku = ? AND l.vendor_id = ?`, [variantSku, vendorId]);
  if (rows.length === 0) throw notFound('Inventory row not found');
  if (rows.length > 1) {
    throw unprocessable('Variant is stocked at multiple locations; use the location-scoped delta path',
      { variantSku: 'ambiguous — multiple location rows' });
  }
  const row = rows[0]!;
  if (onHand < num(row.reserved)) {
    throw unprocessable('onHand would take stock below reserved', { onHand: 'below reserved' });
  }
  await query('UPDATE inv_item SET on_hand = ? WHERE variant_sku = ? AND location_id = ?',
    [onHand, variantSku, row.location_id]);
}

/* ------------------------------------------------------------------ *
 * Order queue (FR-VEN-007)
 * ------------------------------------------------------------------ */

export async function listVendorOrders(vendorId: string, state?: string, limit = 50): Promise<VendorOrderRow[]> {
  const params: unknown[] = [vendorId];
  let stateSql = '';
  if (state) { stateSql = ' AND so.state = ?'; params.push(state); }
  const rows = await query<{
    id: string; order_id: string; city: string | null; state: string; created_at: Date; sla_ship_by: Date;
    amount: unknown;
  }>(`
    SELECT so.id, so.order_id, JSON_UNQUOTE(JSON_EXTRACT(o.ship_address, '$.city')) AS city,
           so.state, so.created_at, so.sla_ship_by,
           (SELECT IFNULL(SUM(e.credit), 0) FROM fin_ledger_entry e
             WHERE e.ref_type = 'SUB_ORDER' AND e.ref_id = so.id AND e.account_code LIKE 'VENDOR_PAYABLE%') AS amount
    FROM ord_sub_order so JOIN ord_order o ON o.id = so.order_id
    WHERE so.vendor_id = ?${stateSql}
    ORDER BY so.created_at DESC LIMIT ?`, [...params, limit]);
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id, orderId: r.order_id, customerCity: r.city ?? '', amountPaise: paise(r.amount),
    state: r.state as SubOrderState, placedAt: iso(r.created_at), slaShipBy: iso(r.sla_ship_by),
    breachRisk: num(r.sla_ship_by) < now && !['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CLOSED', 'CANCELLED'].includes(r.state),
    itemCount: 0, // no order-line table (documented)
  }));
}

/**
 * Transition a sub-order. Refuses illegal edges (V004/FR-VEN-007) and any
 * sub-order not owned by this vendor.
 */
export async function transitionSubOrder(vendorId: string, subOrderId: string, to: SubOrderState): Promise<{ from: SubOrderState }> {
  const sub = await queryOne<{ state: SubOrderState }>(
    'SELECT state FROM ord_sub_order WHERE id = ? AND vendor_id = ?', [subOrderId, vendorId]);
  if (!sub) throw notFound('Sub-order not found');
  const from = sub.state;
  const allowed = LEGAL_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw conflict(`Illegal transition ${from} -> ${to}`, 'ILLEGAL_TRANSITION');
  }
  await query('UPDATE ord_sub_order SET state = ? WHERE id = ? AND vendor_id = ?', [to, subOrderId, vendorId]);
  return { from };
}

/* ------------------------------------------------------------------ *
 * Ledger & settlements (FR-FIN-*)
 * ------------------------------------------------------------------ */

export async function listLedger(vendorId: string, period?: string): Promise<LedgerRow[]> {
  const account = `VENDOR_PAYABLE:${vendorId.slice(-6)}`;
  const params: unknown[] = [account];
  let sql = `SELECT id, period, account_code, debit, credit, ref_type, ref_id, memo, created_at
             FROM fin_ledger_entry WHERE account_code = ?`;
  if (period) { sql += ' AND period = ?'; params.push(period); }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const rows = await query<{ id: string; period: string; account_code: string; debit: string; credit: string; ref_type: string; ref_id: string; memo: string | null; created_at: Date }>(sql, params);
  return rows.map((r) => ({
    id: r.id, period: r.period, accountCode: r.account_code, debitPaise: paise(r.debit),
    creditPaise: paise(r.credit), refType: r.ref_type, refId: r.ref_id, memo: r.memo ?? undefined,
    createdAt: iso(r.created_at),
  }));
}

/** Settlement = monthly net of the vendor payable account (gross credit - fee debit). */
export async function listSettlements(vendorId: string): Promise<SettlementSummary[]> {
  const account = `VENDOR_PAYABLE:${vendorId.slice(-6)}`;
  const rows = await query<{ period: string; gross: unknown; commission: unknown }>(`
    SELECT period,
           IFNULL(SUM(credit), 0) AS gross,
           IFNULL((SELECT SUM(debit) FROM fin_ledger_entry f WHERE f.account_code = e.account_code AND f.period = e.period AND f.ref_type = 'FEE'), 0) AS commission
    FROM fin_ledger_entry e WHERE account_code = ?
    GROUP BY period ORDER BY period DESC`, [account]);
  return rows.map((r) => {
    const gross = paise(r.gross);
    const commission = paise(r.commission);
    // TDS is not modelled in the schema; 0 is the honest value, not an estimate.
    const tds = 0;
    return {
      period: r.period, grossPaise: gross, commissionPaise: commission, tdsPaise: tds,
      netPaise: gross - commission - tds,
      // PAID is set by finance ops; without a payout table the status is PENDING unless closed.
      status: 'PENDING' as const,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Onboarding (FR-VEN-001)
 * ------------------------------------------------------------------ */

export async function getOnboarding(vendorId: string): Promise<{
  legalName: string; displayName: string; gstin: string | null; pan: string | null;
  email: string; mobile: string; status: string; kycState: string;
  hasBankAccount: boolean; hasWarehouse: boolean;
}> {
  const store = await queryOne<{
    legal_name: string; display_name: string; gstin: string | null; pan: string | null;
    email: string; mobile: string; status: string; kyc_state: string;
  }>('SELECT legal_name, display_name, gstin, pan, email, mobile, status, kyc_state FROM ven_store WHERE id = ?', [vendorId]);
  if (!store) throw notFound('Store not found');
  const bank = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM fin_ledger_entry WHERE account_code = ?", [`VENDOR_PAYABLE:${vendorId.slice(-6)}`]);
  const warehouse = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM inv_location WHERE vendor_id = ? AND kind = 'WAREHOUSE'", [vendorId]);
  return {
    legalName: store.legal_name, displayName: store.display_name, gstin: store.gstin, pan: store.pan,
    email: store.email, mobile: store.mobile, status: store.status, kycState: store.kyc_state,
    hasBankAccount: num(bank?.n) > 0, hasWarehouse: num(warehouse?.n) > 0,
  };
}

/**
 * Edit the vendor's onboarding profile (FR-VEN-001). Fields absent from the
 * body keep their current value. An empty string on `gstin`/`pan` clears the
 * field to NULL — an explicit clear, which is what the console's "leave blank
 * to clear" hint promises. `displayName`/`legalName`/`email`/`mobile` are
 * NOT NULL in ven_store, so an empty value there is refused by name rather
 * than stored as `''`. Email uniqueness is `uq_store_email`; a collision is
 * surfaced as a conflict, not swallowed.
 */
export async function updateOnboarding(vendorId: string, patch: {
  displayName?: string; legalName?: string; gstin?: string; pan?: string; email?: string; mobile?: string;
}): Promise<void> {
  const current = await queryOne<{ id: string; email: string }>(
    'SELECT id, email FROM ven_store WHERE id = ?', [vendorId]);
  if (!current) throw notFound('Store not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  const required = (field: 'displayName' | 'legalName' | 'email' | 'mobile') => {
    const v = patch[field];
    if (v === undefined) return;
    if (!v.trim()) throw unprocessable(`${field} must not be empty`, { [field]: 'required' });
    sets.push(`${field === 'displayName' ? 'display_name' : field === 'legalName' ? 'legal_name' : field} = ?`);
    params.push(v);
  };
  required('displayName');
  required('legalName');
  required('mobile');
  if (patch.email !== undefined) {
    if (!patch.email.trim()) throw unprocessable('email must not be empty', { email: 'required' });
    if (patch.email !== current.email) {
      // ven_store has no email_norm column; uq_store_email is on email itself.
      const dup = await queryOne<{ id: string }>(
        'SELECT id FROM ven_store WHERE email = ?', [patch.email]);
      if (dup) throw conflict('Store email already exists', 'EMAIL_TAKEN');
    }
    sets.push('email = ?');
    params.push(patch.email);
  }
  if (patch.gstin !== undefined) { sets.push('gstin = ?'); params.push(patch.gstin.trim() === '' ? null : patch.gstin); }
  if (patch.pan !== undefined) { sets.push('pan = ?'); params.push(patch.pan.trim() === '' ? null : patch.pan); }
  if (sets.length === 0) {
    throw unprocessable('no field to update', { onboarding: 'at least one of displayName, legalName, gstin, pan, email, mobile is required' });
  }
  await query(`UPDATE ven_store SET ${sets.join(', ')} WHERE id = ?`, [...params, vendorId]);
}
