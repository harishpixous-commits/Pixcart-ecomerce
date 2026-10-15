/**
 * Development seed for the PixCart BFF.
 *
 * Idempotency strategy — verified by running this twice against the same
 * database:
 *
 *   Every row's primary key is derived deterministically from its natural key
 *   (slug, email, code, order key, journal+account+leg …) via `seedId()`, so a
 *   second run derives the SAME ids. All writes go through one transaction as
 *   `INSERT … ON DUPLICATE KEY UPDATE`: a first run inserts; a second run
 *   matches on a primary or unique key and updates the row in place. No
 *   duplicates, no duplicate-key errors, no partial state on failure.
 *   Append-only ledgers (fin_ledger_entry, wal_entry, loy_entry, rma_event)
 *   use the no-op update `id = id` so a replay never mutates history.
 *
 * Money travels as integer paise end-to-end and is formatted to DECIMAL(12,2)
 * strings only at the insert boundary; `*_paise` columns receive the integers
 * directly. The double-entry ledger is posted per sub-order with a
 * largest-remainder allocation of order-level discount/shipping/tax so every
 * journal balances to the paisa and the table nets to exactly zero.
 */
import type { Connection } from 'mariadb';
import { config } from '../config.js';
import { closePool, query, tx } from '../db.js';
import { ulid, seedId } from './ulid.js';
import {
  brands,
  categoryTree,
  colourPairs,
  cmsEntries,
  coupons,
  customers,
  addresses,
  notifTemplates,
  orderPlan,
  products,
  rmaPlan,
  rmaStatePaths,
  staff,
  vendors,
  walletCashPaise,
  WALLET_PROMO_EXPIRES,
  WALLET_PROMO_PAISE,
  type CouponDef,
  type CmsDef,
  type OrderPlan,
  type RmaPlan,
} from './data.js';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

/** Integer paise → DECIMAL(12,2) string. */
function dec(paise: number): string {
  return (paise / 100).toFixed(2);
}

/** Format a Date as 'YYYY-MM-DD HH:MM:SS.mmm' (UTC fields, TZ-independent). */
function ts(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Parse a 'YYYY-MM-DD HH:MM:SS.mmm' seed timestamp as UTC. */
function parseTs(s: string): Date {
  return new Date(s.replace(' ', 'T') + 'Z');
}

/** Add hours to a seed timestamp, returning a formatted timestamp. */
function plusHours(s: string, hours: number): string {
  return ts(new Date(parseTs(s).getTime() + hours * 3600_000));
}

/** Largest-remainder allocation of `total` across `weights` (all integers). */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  const rem = total - floors.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  for (let k = 0; k < rem; k++) {
    const j = byFrac[k % byFrac.length]!.i;
    out[j] = out[j]! + 1;
  }
  return out;
}

type Row = Record<string, unknown>;

/**
 * Insert rows with `ON DUPLICATE KEY UPDATE` so the seed can be re-run.
 * `updateCols` lists the non-key columns to refresh on conflict; append-only
 * ledgers pass an empty list and get the no-op `id = id`.
 */
async function insertAll(
  conn: Connection,
  table: string,
  cols: string[],
  rows: Row[],
  updateCols: string[],
): Promise<void> {
  if (rows.length === 0) return;
  const updates =
    updateCols.length > 0
      ? updateCols.map((c) => `${c} = VALUES(${c})`).join(', ')
      : 'id = id';
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES `;
  const CHUNK = 150;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const stmt =
      sql +
      slice.map(() => `(${cols.map(() => '?').join(',')})`).join(', ') +
      ` ON DUPLICATE KEY UPDATE ${updates}`;
    const params = slice.flatMap((r) => cols.map((c) => r[c] ?? null));
    await conn.query(stmt, params);
  }
}

/* ------------------------------------------------------------------ *
 * Derived catalogue: listings, variants, inventory
 * ------------------------------------------------------------------ */

interface ListRow {
  id: string;
  idx: number;
  productIdx: number;
  vendorIdx: number;
  categoryId: string;
  brandId: string | null;
  title: string;
  hsn: string;
  mrpPaise: number;
  pricePaise: number;
  vendorId: string;
}

function buildListings(): { listings: ListRow[]; variantRows: Row[]; invRows: Row[] } {
  const listings: ListRow[] = [];
  const variantRows: Row[] = [];
  const invRows: Row[] = [];
  const leafCategoryId = new Map<string, string>();
  for (const root of categoryTree) {
    for (const child of root.children) leafCategoryId.set(child.slug, seedId('category', child.slug));
  }
  const vendorById = new Map(vendors.map((v, i) => [i, v]));

  const addListing = (productIdx: number, vendorIdx: number, idx: number): void => {
    const p = products[productIdx]!;
    const v = vendorById.get(vendorIdx)!;
    const mrpPaise = p.mrpPaise;
    const pricePaise = Math.round((mrpPaise * 95) / 100);
    const id = seedId('listing', `p${productIdx}:v${vendorIdx}`);
    const colours = colourPairs[productIdx % colourPairs.length]!;
    listings.push({
      id,
      idx,
      productIdx,
      vendorIdx,
      categoryId: leafCategoryId.get(p.leaf)!,
      brandId: seedId('brand', brands[p.brand]!.slug),
      title: p.title,
      hsn: p.hsn,
      mrpPaise,
      pricePaise,
      vendorId: seedId('vendor', v.key),
    });
    const isFashion = p.leaf.startsWith('fashion-');
    for (let k = 0; k < 2; k++) {
      const sku = `${v.skuCode}-${String(productIdx + 1).padStart(2, '0')}${k === 0 ? 'A' : 'B'}`;
      const optionMap = isFashion
        ? { colour: colours[k], size: k === 0 ? 'M' : 'L' }
        : { colour: colours[k] };
      variantRows.push({
        id: seedId('variant', sku),
        listing_id: id,
        sku,
        option_map: JSON.stringify(optionMap),
      });
      const onHand = 10 + ((idx * 7 + k * 3) % 41);
      const reserved = (idx + k) % 3;
      invRows.push({
        variant_sku: sku,
        location_id: seedId('location', v.key),
        on_hand: onHand,
        reserved,
        safety_stock: 5 + ((idx + k) % 5),
      });
    }
  };

  // Primary listing per product (40), vendor = productIdx % 4.
  for (let i = 0; i < products.length; i++) addListing(i, i % 4, i);
  // Second listing (different vendor) for every 5th product, indices 40–47.
  let extra = 40;
  for (let i = 0; i < products.length; i += 5) addListing(i, (i + 2) % 4, extra++);
  return { listings, variantRows, invRows };
}

/* ------------------------------------------------------------------ *
 * Order assembly
 * ------------------------------------------------------------------ */

interface BuiltLine {
  listing: ListRow;
  qty: number;
  unitPaise: number;
  amountPaise: number;
}

interface BuiltSub {
  vendorIdx: number;
  vendorId: string;
  state: string;
  lines: BuiltLine[];
  itemPaise: number;
}

interface BuiltOrder {
  plan: OrderPlan;
  orderId: string;
  quoteId: string;
  customerId: string;
  customerIdx: number;
  shipAddress: Row;
  lines: BuiltLine[];
  itemPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  grandPaise: number;
  subs: BuiltSub[];
  placedAt: string;
}

function buildOrders(listings: ListRow[]): { orders: BuiltOrder[]; listingById: Map<string, ListRow> } {
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const orders: BuiltOrder[] = [];
  for (const plan of orderPlan) {
    const lines: BuiltLine[] = plan.lines.map((pl) => {
      const listing = listings[pl.listing]!;
      return {
        listing,
        qty: pl.qty,
        unitPaise: listing.pricePaise,
        amountPaise: listing.pricePaise * pl.qty,
      };
    });
    const itemPaise = lines.reduce((a, l) => a + l.amountPaise, 0);
    const discountPaise =
      plan.discountPaise ?? (plan.discountBps ? Math.round((itemPaise * plan.discountBps) / 10000) : 0);
    const shippingPaise = plan.shippingPaise;
    const taxPaise = Math.round((itemPaise * 18) / 100);
    const grandPaise = itemPaise - discountPaise + shippingPaise + taxPaise;

    const byVendor = new Map<number, BuiltLine[]>();
    for (const line of lines) {
      const arr = byVendor.get(line.listing.vendorIdx) ?? [];
      arr.push(line);
      byVendor.set(line.listing.vendorIdx, arr);
    }
    const subs: BuiltSub[] = [...byVendor.entries()].map(([vendorIdx, vLines]) => ({
      vendorIdx,
      vendorId: seedId('vendor', vendors[vendorIdx]!.key),
      state: plan.subStates.find(([v]) => v === vendorIdx)![1],
      lines: vLines,
      itemPaise: vLines.reduce((a, l) => a + l.amountPaise, 0),
    }));

    const cust = customers[plan.customer]!;
    const addr = addresses.find((a) => a.customer === plan.customer && a.isDefault)!;
    orders.push({
      plan,
      orderId: seedId('order', plan.key),
      quoteId: seedId('quote', plan.key),
      customerId: seedId('customer', cust.key),
      customerIdx: plan.customer,
      shipAddress: {
        recipient: cust.name,
        label: addr.label,
        line1: addr.line1,
        line2: addr.line2,
        city: addr.city,
        state: addr.state,
        pincode: addr.pincode,
        country: 'IN',
        mobile: cust.mobile,
      },
      lines,
      itemPaise,
      discountPaise,
      shippingPaise,
      taxPaise,
      grandPaise,
      subs,
      placedAt: plan.placedAt,
    });
  }
  return { orders, listingById };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const runId = ulid();
  console.log(`PixCart dev seed — run ${runId}`);
  console.log(`Target: ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);

  const { listings, variantRows, invRows } = buildListings();
  const { orders } = buildOrders(listings);

  const staffByRole = new Map(staff.map((s) => [s.role, seedId('staff', s.key)]));
  const marketingId = staffByRole.get('MARKETING')!;
  const adminId = staffByRole.get('ADMIN')!;

  const counts = await tx(async (conn) => {
    const c: Record<string, number> = {};

    /* ---- identity ---- */
    const staffRows: Row[] = staff.map((s) => ({
      id: seedId('staff', s.key),
      email: s.email,
      full_name: s.name,
      role: s.role,
      status: 'ACTIVE',
      mfa_enforced: 1,
    }));
    await insertAll(conn, 'id_staff', ['id', 'email', 'full_name', 'role', 'status', 'mfa_enforced'], staffRows,
      ['email', 'full_name', 'role', 'status', 'mfa_enforced']);
    c['id_staff'] = staffRows.length;

    const customerRows: Row[] = customers.map((cu) => ({
      id: seedId('customer', cu.key),
      mobile: cu.mobile,
      email: cu.email,
      password_hash: null, // OTP-based login; identity-svc owns credential storage
      full_name: cu.name,
      lang: cu.lang,
      status: 'ACTIVE',
      kyc_tier: cu.kycTier,
    }));
    await insertAll(conn, 'id_customer',
      ['id', 'mobile', 'email', 'password_hash', 'full_name', 'lang', 'status', 'kyc_tier'],
      customerRows, ['mobile', 'email', 'password_hash', 'full_name', 'lang', 'status', 'kyc_tier']);
    c['id_customer'] = customerRows.length;

    const addressRows: Row[] = addresses.map((a, i) => ({
      id: seedId('address', `addr${i}`),
      customer_id: seedId('customer', customers[a.customer]!.key),
      label: a.label,
      line1: a.line1,
      line2: a.line2,
      landmark: a.landmark,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
      country: 'IN',
      mobile: customers[a.customer]!.mobile,
      is_default: a.isDefault ? 1 : 0,
    }));
    await insertAll(conn, 'id_address',
      ['id', 'customer_id', 'label', 'line1', 'line2', 'landmark', 'city', 'state', 'pincode', 'country', 'mobile', 'is_default'],
      addressRows,
      ['customer_id', 'label', 'line1', 'line2', 'landmark', 'city', 'state', 'pincode', 'country', 'mobile', 'is_default']);
    c['id_address'] = addressRows.length;

    /* ---- vendors & inventory ---- */
    const vendorRows: Row[] = vendors.map((v) => ({
      id: seedId('vendor', v.key),
      legal_name: v.legalName,
      display_name: v.displayName,
      gstin: v.gstin,
      pan: v.pan,
      email: v.email,
      mobile: v.mobile,
      status: 'APPROVED',
      kyc_state: 'VERIFIED',
      rating_avg: v.ratingAvg,
      rating_count: v.ratingCount,
      on_time_pct: v.onTimePct,
      store_slug: v.storeSlug,
      logo_url: v.logoUrl,
      settings: JSON.stringify(v.settings),
    }));
    await insertAll(conn, 'ven_store',
      ['id', 'legal_name', 'display_name', 'gstin', 'pan', 'email', 'mobile', 'status', 'kyc_state',
        'rating_avg', 'rating_count', 'on_time_pct', 'store_slug', 'logo_url', 'settings'],
      vendorRows,
      ['legal_name', 'display_name', 'gstin', 'pan', 'email', 'mobile', 'status', 'kyc_state',
        'rating_avg', 'rating_count', 'on_time_pct', 'store_slug', 'logo_url', 'settings']);
    c['ven_store'] = vendorRows.length;

    const locationRows: Row[] = vendors.map((v) => ({
      id: seedId('location', v.key),
      vendor_id: seedId('vendor', v.key),
      name: v.location.name,
      pincode: v.location.pincode,
      kind: v.location.kind,
    }));
    await insertAll(conn, 'inv_location', ['id', 'vendor_id', 'name', 'pincode', 'kind'], locationRows,
      ['vendor_id', 'name', 'pincode', 'kind']);
    c['inv_location'] = locationRows.length;

    /* ---- catalogue ---- */
    // Roots before children: cat_category.parent_id is a self FK.
    const categoryRows: Row[] = [];
    for (const root of categoryTree) {
      categoryRows.push({
        id: seedId('category', root.slug), parent_id: null, name: root.name, slug: root.slug,
        attribute_schema: JSON.stringify(root.schema), status: 'ACTIVE',
      });
      for (const child of root.children) {
        categoryRows.push({
          id: seedId('category', child.slug), parent_id: seedId('category', root.slug),
          name: child.name, slug: child.slug,
          attribute_schema: JSON.stringify(child.schema), status: 'ACTIVE',
        });
      }
    }
    await insertAll(conn, 'cat_category',
      ['id', 'parent_id', 'name', 'slug', 'attribute_schema', 'status'],
      categoryRows, ['parent_id', 'name', 'slug', 'attribute_schema', 'status']);
    c['cat_category'] = categoryRows.length;

    const brandRows: Row[] = brands.map((b) => ({
      id: seedId('brand', b.slug), name: b.name, slug: b.slug, status: 'ACTIVE',
    }));
    await insertAll(conn, 'cat_brand', ['id', 'name', 'slug', 'status'], brandRows, ['name', 'slug', 'status']);
    c['cat_brand'] = brandRows.length;

    const productRows: Row[] = products.map((p, i) => ({
      id: seedId('product', `p${i}`),
      category_id: seedId('category', p.leaf),
      brand_id: seedId('brand', brands[p.brand]!.slug),
      title: p.title,
      attributes: JSON.stringify({ hsnMaster: p.hsn, warrantyMonths: 12 }),
      hsn_code: p.hsn,
      status: 'ACTIVE',
    }));
    await insertAll(conn, 'cat_product',
      ['id', 'category_id', 'brand_id', 'title', 'attributes', 'hsn_code', 'status'],
      productRows, ['category_id', 'brand_id', 'title', 'attributes', 'hsn_code', 'status']);
    c['cat_product'] = productRows.length;

    // Listing states: index 0–39 primary, 40–47 second listings. A few sit in
    // non-LIVE states so the admin approval queue and vendor dashboards have
    // realistic variety.
    const listingRows: Row[] = listings.map((l) => {
      const state = l.idx === 7 ? 'PAUSED' : l.idx === 19 ? 'SUBMITTED' : l.idx >= 45 ? 'APPROVED' : 'LIVE';
      return {
        id: l.id,
        vendor_id: l.vendorId,
        product_id: seedId('product', `p${l.productIdx}`),
        state,
        title: l.title,
        mrp: dec(l.mrpPaise),
        price: dec(l.pricePaise),
        price_floor: dec(Math.round((l.pricePaise * 85) / 100)),
        price_ceiling: dec(l.mrpPaise),
        attributes: JSON.stringify({ vendorSkuPrefix: vendors[l.vendorIdx]!.skuCode, warrantyMonths: 12 }),
        hsn_code: l.hsn,
        qc_score: state === 'LIVE' || state === 'APPROVED' ? (l.idx % 10 === 0 ? '89.5' : '94.5') : null,
      };
    });
    await insertAll(conn, 'cat_listing',
      ['id', 'vendor_id', 'product_id', 'state', 'title', 'mrp', 'price', 'price_floor', 'price_ceiling', 'attributes', 'hsn_code', 'qc_score'],
      listingRows,
      ['vendor_id', 'product_id', 'state', 'title', 'mrp', 'price', 'price_floor', 'price_ceiling', 'attributes', 'hsn_code', 'qc_score']);
    c['cat_listing'] = listingRows.length;

    await insertAll(conn, 'cat_variant', ['id', 'listing_id', 'sku', 'option_map'], variantRows,
      ['listing_id', 'sku', 'option_map']);
    c['cat_variant'] = variantRows.length;

    await insertAll(conn, 'inv_item',
      ['variant_sku', 'location_id', 'on_hand', 'reserved', 'safety_stock'],
      invRows, ['on_hand', 'reserved', 'safety_stock']);
    c['inv_item'] = invRows.length;

    /* ---- wallet & loyalty ---- */
    // Every funded entry is non-negative, so balance = Σ entries ≥ 0 always.
    const walEntryRows: Row[] = [];
    const walCash = new Map<number, number>();
    const walPromo = new Map<number, number>();
    const addWal = (custIdx: number, bucket: 'CASH' | 'PROMO', amount: number, reason: string, reference: string, expiresAt: string | null): void => {
      walEntryRows.push({
        id: seedId('walentry', `${reference}:${reason}`),
        customer_id: seedId('customer', customers[custIdx]!.key),
        bucket,
        amount_paise: amount,
        reason,
        reference,
        expires_at: expiresAt,
      });
      const m = bucket === 'CASH' ? walCash : walPromo;
      m.set(custIdx, (m.get(custIdx) ?? 0) + amount);
    };
    for (let i = 0; i < customers.length; i++) {
      addWal(i, 'CASH', walletCashPaise[i]!, 'CASHBACK', `WELCOME-CASH-${i}`, null);
      addWal(i, 'PROMO', WALLET_PROMO_PAISE, 'CASHBACK', `WELCOME-PROMO-${i}`, WALLET_PROMO_EXPIRES);
    }
    // PC1002 was captured entirely from Rohit's wallet.
    const o2 = orders.find((o) => o.plan.key === 'PC1002')!;
    addWal(1, 'CASH', -o2.grandPaise, 'SPEND', `ORDER-PC1002`, null);
    // PC1007 applied a Rs.50 wallet credit at checkout.
    const o7 = orders.find((o) => o.plan.key === 'PC1007')!;
    addWal(0, 'CASH', -o7.discountPaise, 'SPEND', `ORDER-PC1007-WALLET`, null);
    // RMA06 refunds into the wallet.
    const rma06 = rmaPlan.find((r) => r.key === 'RMA06')!;
    const o2Line = o2.lines.find((l) => l.listing.idx === rma06.listing)!;
    addWal(1, 'CASH', o2Line.amountPaise, 'REFUND', `RMA-RMA06`, null);

    await insertAll(conn, 'wal_entry',
      ['id', 'customer_id', 'bucket', 'amount_paise', 'reason', 'reference', 'expires_at'],
      walEntryRows, []);
    c['wal_entry'] = walEntryRows.length;

    const walBalanceRows: Row[] = customers.map((cu, i) => ({
      customer_id: seedId('customer', cu.key),
      cash_paise: walCash.get(i) ?? 0,
      promo_paise: walPromo.get(i) ?? 0,
    }));
    await insertAll(conn, 'wal_balance', ['customer_id', 'cash_paise', 'promo_paise'],
      walBalanceRows, ['cash_paise', 'promo_paise']);
    c['wal_balance'] = walBalanceRows.length;

    // Loyalty: accrue 1 pt per Rs.100 on settled orders; claw back the refunded
    // PC1007 portion; one redemption for Ananya (she has ample balance).
    const loyEntryRows: Row[] = [];
    const loyPts = new Map<number, number>();
    const addLoy = (custIdx: number, points: number, reason: string, reference: string): void => {
      loyEntryRows.push({
        id: seedId('loyentry', `${reference}:${reason}`),
        customer_id: seedId('customer', customers[custIdx]!.key),
        points,
        reason,
        reference,
      });
      loyPts.set(custIdx, (loyPts.get(custIdx) ?? 0) + points);
    };
    const settled = orders.filter((o) => o.plan.status === 'DELIVERED' || o.plan.status === 'PARTIALLY_REFUNDED');
    for (const o of settled) addLoy(o.customerIdx, Math.floor(o.grandPaise / 10000), 'ACCRUAL', `LOY-${o.plan.key}`);
    const o7Pts = Math.floor(o7.grandPaise / 10000);
    addLoy(0, -o7Pts, 'CLAWBACK', 'RMA-RMA01');
    addLoy(0, -50, 'REDEEM', 'LOYREDEEM-ANANYA-1');

    await insertAll(conn, 'loy_entry', ['id', 'customer_id', 'points', 'reason', 'reference'],
      loyEntryRows, []);
    c['loy_entry'] = loyEntryRows.length;

    const loyBalanceRows: Row[] = customers.map((cu, i) => {
      const points = loyPts.get(i) ?? 0;
      const tier = points >= 250 ? 'PLATINUM' : points >= 100 ? 'GOLD' : 'SILVER';
      return { customer_id: seedId('customer', cu.key), points, tier };
    });
    await insertAll(conn, 'loy_balance', ['customer_id', 'points', 'tier'], loyBalanceRows, ['points', 'tier']);
    c['loy_balance'] = loyBalanceRows.length;

    /* ---- orders, sub-orders, payments ---- */
    const orderRows: Row[] = [];
    const subRows: Row[] = [];
    const payRows: Row[] = [];
    for (const o of orders) {
      orderRows.push({
        id: o.orderId,
        customer_id: o.customerId,
        quote_id: o.quoteId,
        status: o.plan.status,
        currency: 'INR',
        item_total: dec(o.itemPaise),
        discount_total: dec(o.discountPaise),
        shipping_total: dec(o.shippingPaise),
        tax_total: dec(o.taxPaise),
        grand_total: dec(o.grandPaise),
        promo_allocation: JSON.stringify(o.plan.promoAllocation),
        ship_address: JSON.stringify(o.shipAddress),
        placed_at: o.placedAt,
      });
      for (const s of o.subs) {
        subRows.push({
          id: seedId('suborder', `${o.plan.key}:${s.vendorIdx}`),
          order_id: o.orderId,
          vendor_id: s.vendorId,
          state: s.state,
          sla_accept_by: plusHours(o.placedAt, 12),
          sla_ship_by: plusHours(o.placedAt, 48),
        });
      }
      payRows.push({
        id: seedId('payment', o.plan.key),
        order_id: o.orderId,
        method: o.plan.payment.method,
        status: o.plan.payment.status,
        amount: dec(o.grandPaise),
        gateway: 'RAZORPAY_SANDBOX',
        gateway_order_ref: `gw_${o.plan.key.toLowerCase()}`,
        auth_ref: o.plan.payment.status === 'CAPTURED' ? `auth_${o.plan.key.toLowerCase()}` : null,
        capture_ref: o.plan.payment.status === 'CAPTURED' ? `cap_${o.plan.key.toLowerCase()}` : null,
        idempotency_key: `seed_${o.plan.key.toLowerCase()}_v1`,
      });
    }
    await insertAll(conn, 'ord_order',
      ['id', 'customer_id', 'quote_id', 'status', 'currency', 'item_total', 'discount_total',
        'shipping_total', 'tax_total', 'grand_total', 'promo_allocation', 'ship_address', 'placed_at'],
      orderRows,
      ['customer_id', 'quote_id', 'status', 'currency', 'item_total', 'discount_total',
        'shipping_total', 'tax_total', 'grand_total', 'promo_allocation', 'ship_address']);
    c['ord_order'] = orderRows.length;

    await insertAll(conn, 'ord_sub_order',
      ['id', 'order_id', 'vendor_id', 'state', 'sla_accept_by', 'sla_ship_by'],
      subRows, ['order_id', 'vendor_id', 'state', 'sla_accept_by', 'sla_ship_by']);
    c['ord_sub_order'] = subRows.length;

    await insertAll(conn, 'pay_payment',
      ['id', 'order_id', 'method', 'status', 'amount', 'gateway', 'gateway_order_ref',
        'auth_ref', 'capture_ref', 'idempotency_key'],
      payRows,
      ['order_id', 'method', 'status', 'amount', 'gateway', 'gateway_order_ref',
        'auth_ref', 'capture_ref']);
    c['pay_payment'] = payRows.length;

    /* ---- double-entry ledger ---- */
    // Per sub-order journal:
    //   DR CUSTOMER_RECEIVABLE (share of grand), DR PROMO_EXPENSE (share of discount)
    //   CR TAX_PAYABLE, CR SHIPPING_INCOME, CR PLATFORM_FEE (5%), CR VENDOR_PAYABLE
    // Shares use largest-remainder allocation so each journal balances exactly.
    // Payout journals settle delivered sub-orders; refund journals settle RMAs.
    // Zero-amount legs are never written (a 0/0 row would violate ck_ledger_oneside).
    const ledgerRows: Row[] = [];
    const postJournal = (
      journalKey: string,
      period: string,
      refType: string,
      refId: string,
      memo: string,
      legs: { account: string; debit: number; credit: number }[],
    ): void => {
      const journalId = seedId('journal', journalKey);
      const eventId = seedId('event', journalKey);
      for (const leg of legs) {
        if (leg.debit === 0 && leg.credit === 0) continue;
        if (leg.debit > 0 && leg.credit > 0) {
          throw new Error(`ledger leg ${journalKey}/${leg.account} has both sides set`);
        }
        ledgerRows.push({
          id: seedId('ledger', `${journalKey}:${leg.account}:${refId}`),
          journal_id: journalId,
          account_code: leg.account,
          debit: dec(leg.debit),
          credit: dec(leg.credit),
          currency: 'INR',
          ref_type: refType,
          ref_id: refId,
          event_id: eventId,
          period,
          memo,
        });
      }
    };

    for (const o of orders) {
      if (o.plan.status === 'CANCELLED') continue; // no money moved
      const weights = o.subs.map((s) => s.itemPaise);
      const dShares = allocate(o.discountPaise, weights);
      const shShares = allocate(o.shippingPaise, weights);
      const txShares = allocate(o.taxPaise, weights);
      for (let i = 0; i < o.subs.length; i++) {
        const s = o.subs[i]!;
        const d = dShares[i]!;
        const sh = shShares[i]!;
        const tx = txShares[i]!;
        const g = s.itemPaise - d + sh + tx; // this sub-order's share of grand_total
        const fee = Math.round((s.itemPaise * 500) / 10000); // 5% platform commission
        const vendorShare = s.itemPaise - fee;
        const subId = seedId('suborder', `${o.plan.key}:${s.vendorIdx}`);
        const period = o.placedAt.slice(0, 7);
        postJournal(`order:${o.plan.key}:${s.vendorIdx}`, period, 'SUB_ORDER', subId,
          `Order ${o.plan.key} sub-order settlement`,
          [
            { account: 'CUSTOMER_RECEIVABLE', debit: g, credit: 0 },
            { account: 'PROMO_EXPENSE', debit: d, credit: 0 },
            { account: 'TAX_PAYABLE', debit: 0, credit: tx },
            { account: 'SHIPPING_INCOME', debit: 0, credit: sh },
            { account: 'PLATFORM_FEE', debit: 0, credit: fee },
            { account: `VENDOR_PAYABLE:${seedId('vendor', vendors[s.vendorIdx]!.key).slice(-6)}`, debit: 0, credit: vendorShare },
          ]);
        if (s.state === 'DELIVERED' || s.state === 'CLOSED') {
          postJournal(`payout:${o.plan.key}:${s.vendorIdx}`, period, 'PAYOUT', subId,
            `Payout for delivered sub-order of ${o.plan.key}`,
            [
              { account: `VENDOR_PAYABLE:${seedId('vendor', vendors[s.vendorIdx]!.key).slice(-6)}`, debit: vendorShare, credit: 0 },
              { account: 'PAYOUT_BANK', debit: 0, credit: vendorShare },
            ]);
        }
      }
    }

    // Refund journals for RMAs that settle money.
    const buildOrderByKey = new Map(orders.map((o) => [o.plan.key, o]));
    for (const r of rmaPlan) {
      if (!r.refundFull || !r.refundMethod) continue;
      const o = buildOrderByKey.get(r.orderKey)!;
      const line = o.lines.find((l) => l.listing.idx === r.listing)!;
      const rmaId = seedId('rma', r.key);
      const period = plusHours(o.placedAt, 24 * 12).slice(0, 7);
      postJournal(`refund:${r.key}`, period, 'REFUND', rmaId,
        `Refund for ${r.key} (order ${r.orderKey})`,
        [
          { account: 'REFUND_EXPENSE', debit: line.amountPaise, credit: 0 },
          { account: r.refundMethod === 'WALLET' ? 'WALLET_CLEARING' : 'CUSTOMER_RECEIVABLE', debit: 0, credit: line.amountPaise },
        ]);
    }

    await insertAll(conn, 'fin_ledger_entry',
      ['id', 'journal_id', 'account_code', 'debit', 'credit', 'currency', 'ref_type', 'ref_id',
        'event_id', 'period', 'memo'],
      ledgerRows, []);
    c['fin_ledger_entry'] = ledgerRows.length;

    /* ---- reviews ---- */
    // Unique (customer, listing) pairs: customer i%6 reviews listing (3i)%48.
    const orderForPair = new Map<string, string>();
    for (const o of orders) {
      for (const l of o.lines) orderForPair.set(`${o.customerIdx}:${l.listing.idx}`, o.orderId);
    }
    const ratings = [5, 4, 5, 3, 4, 5, 2, 4, 5, 3, 5, 4, 1, 5, 4, 5, 3, 4, 5, 2, 5, 4, 5, 3, 4];
    const good = [
      { t: 'Exactly as described', b: 'Product matched the listing photos and description. Delivery was quick too.' },
      { t: 'Great value', b: 'Quality feels premium for the price. Would order from this seller again.' },
      { t: 'Happy with the purchase', b: 'Packaging was solid and the item works perfectly. Five stars.' },
      { t: 'Highly recommend', b: 'Second time buying this brand on PixCart, consistently good.' },
    ];
    const mid = [
      { t: 'Decent, with a caveat', b: 'The product is fine overall, but the colour is slightly different from the photos.' },
      { t: 'Okay for the price', b: 'Does the job. Build quality could be better at this price point.' },
    ];
    const bad = [
      { t: 'Not impressed', b: 'Quality did not match the listing. Raised a return, let us see how that goes.' },
      { t: 'Disappointed', b: 'Item arrived with a defect. Docking a star until support resolves this.' },
    ];
    const reviewRows: Row[] = [];
    for (let i = 0; i < 25; i++) {
      const custIdx = i % 6;
      const listingIdx = (i * 3) % listings.length;
      const listing = listings[listingIdx]!;
      const rating = ratings[i]!;
      const tmpl = rating >= 4 ? good[i % good.length]! : rating === 3 ? mid[i % mid.length]! : bad[i % bad.length]!;
      const status = i === 7 ? 'FLAGGED' : i === 13 ? 'PENDING' : i === 21 ? 'REJECTED' : 'PUBLISHED';
      reviewRows.push({
        id: seedId('review', `${customers[custIdx]!.key}:${listingIdx}`),
        listing_id: listing.id,
        product_id: seedId('product', `p${listing.productIdx}`),
        vendor_id: listing.vendorId,
        customer_id: seedId('customer', customers[custIdx]!.key),
        order_id: orderForPair.get(`${custIdx}:${listingIdx}`) ?? null,
        rating,
        title: tmpl.t,
        body: tmpl.b,
        status,
        helpful_up: i % 4,
        helpful_down: i % 7 === 0 ? 1 : 0,
        created_at: plusHours('2026-08-05 10:00:00.000', i * 26),
      });
    }
    await insertAll(conn, 'rev_review',
      ['id', 'listing_id', 'product_id', 'vendor_id', 'customer_id', 'order_id', 'rating',
        'title', 'body', 'status', 'helpful_up', 'helpful_down', 'created_at'],
      reviewRows,
      ['listing_id', 'product_id', 'vendor_id', 'customer_id', 'order_id', 'rating',
        'title', 'body', 'status', 'helpful_up', 'helpful_down']);
    c['rev_review'] = reviewRows.length;

    /* ---- RMA requests & events ---- */
    const rmaRows: Row[] = [];
    const rmaEventRows: Row[] = [];
    for (const r of rmaPlan) {
      const o = buildOrderByKey.get(r.orderKey)!;
      const line = o.lines.find((l) => l.listing.idx === r.listing)!;
      const rmaId = seedId('rma', r.key);
      const requestedAt = plusHours(o.placedAt, 24 * 10);
      const path = rmaStatePaths[r.state]!;
      const decided = path.length > 1 ? plusHours(requestedAt, 24 * 2 * (path.length - 1)) : null;
      const settled = r.state === 'REFUND_INITIATED' || r.state === 'REFUNDED' || r.state === 'CLOSED';
      rmaRows.push({
        id: rmaId,
        order_id: o.orderId,
        sub_order_id: seedId('suborder', `${o.plan.key}:${line.listing.vendorIdx}`),
        customer_id: o.customerId,
        vendor_id: line.listing.vendorId,
        listing_id: line.listing.id,
        qty: 1,
        reason_code: r.reasonCode,
        reason_text: r.reasonText,
        state: r.state,
        refund_paise: settled ? line.amountPaise : null,
        refund_method: settled ? r.refundMethod : null,
        requested_at: requestedAt,
        decided_at: decided,
      });
      for (let k = 0; k < path.length; k++) {
        const toState = path[k]!;
        const fromState = k === 0 ? null : path[k - 1]!;
        const actorType = toState === 'REQUESTED' ? 'CUSTOMER'
          : toState === 'APPROVED' || toState.startsWith('PICKUP') || toState === 'PICKED_UP' ? 'VENDOR'
          : toState === 'QC_PASSED' || toState === 'REFUNDED' || toState === 'CLOSED' ? 'SYSTEM'
          : 'ADMIN';
        const actorId = actorType === 'CUSTOMER' ? o.customerId
          : actorType === 'VENDOR' ? line.listing.vendorId
          : actorType === 'ADMIN' ? adminId
          : null;
        rmaEventRows.push({
          id: seedId('rmaevent', `${r.key}:${k}`),
          rma_id: rmaId,
          from_state: fromState,
          to_state: toState,
          actor_type: actorType,
          actor_id: actorId,
          note: k === 0 ? r.reasonText : `State advanced to ${toState}`,
          created_at: plusHours(requestedAt, 24 * 2 * k),
        });
      }
    }
    await insertAll(conn, 'rma_request',
      ['id', 'order_id', 'sub_order_id', 'customer_id', 'vendor_id', 'listing_id', 'qty',
        'reason_code', 'reason_text', 'state', 'refund_paise', 'refund_method', 'requested_at', 'decided_at'],
      rmaRows,
      ['order_id', 'sub_order_id', 'customer_id', 'vendor_id', 'listing_id', 'qty',
        'reason_code', 'reason_text', 'state', 'refund_paise', 'refund_method', 'requested_at', 'decided_at']);
    c['rma_request'] = rmaRows.length;

    await insertAll(conn, 'rma_event',
      ['id', 'rma_id', 'from_state', 'to_state', 'actor_type', 'actor_id', 'note', 'created_at'],
      rmaEventRows, []);
    c['rma_event'] = rmaEventRows.length;

    /* ---- coupons ---- */
    const couponRows: Row[] = coupons.map((cp: CouponDef) => ({
      id: seedId('coupon', cp.code),
      code: cp.code,
      description: cp.description,
      kind: cp.kind,
      value_bps: cp.valueBps,
      value_paise: cp.valuePaise,
      max_redemptions: cp.maxRedemptions,
      used_count: cp.usedCount,
      min_cart_paise: cp.minCartPaise,
      per_user_limit: cp.perUserLimit,
      starts_at: cp.startsAt,
      ends_at: cp.endsAt,
      status: cp.status,
      created_by: marketingId,
    }));
    await insertAll(conn, 'mkt_coupon',
      ['id', 'code', 'description', 'kind', 'value_bps', 'value_paise', 'max_redemptions',
        'used_count', 'min_cart_paise', 'per_user_limit', 'starts_at', 'ends_at', 'status', 'created_by'],
      couponRows,
      ['code', 'description', 'kind', 'value_bps', 'value_paise', 'max_redemptions',
        'used_count', 'min_cart_paise', 'per_user_limit', 'starts_at', 'ends_at', 'status', 'created_by']);
    c['mkt_coupon'] = couponRows.length;

    /* ---- CMS ---- */
    const cmsRows: Row[] = cmsEntries.map((e: CmsDef) => ({
      id: seedId('cms', `${e.slug}:${e.locale}`),
      kind: e.kind,
      slug: e.slug,
      title: e.title,
      body: e.body,
      media_url: e.mediaUrl,
      link_url: e.linkUrl,
      locale: e.locale,
      status: e.status,
      publish_at: e.publishAt,
      unpublish_at: e.unpublishAt,
      created_by: staffByRole.get(e.createdByRole) ?? adminId,
    }));
    await insertAll(conn, 'cms_content',
      ['id', 'kind', 'slug', 'title', 'body', 'media_url', 'link_url', 'locale', 'status',
        'publish_at', 'unpublish_at', 'created_by'],
      cmsRows,
      ['kind', 'slug', 'title', 'body', 'media_url', 'link_url', 'locale', 'status',
        'publish_at', 'unpublish_at', 'created_by']);
    c['cms_content'] = cmsRows.length;

    /* ---- notifications ---- */
    const notifRows: Row[] = [];
    for (let i = 0; i < 20; i++) {
      const t = notifTemplates[i % notifTemplates.length]!;
      const custIdx = i % 6;
      const orderRef = orderPlan[i % orderPlan.length]!.key;
      const createdAt = plusHours('2026-09-22 09:00:00.000', i * 8);
      notifRows.push({
        id: seedId('notif', `n${i}`),
        customer_id: seedId('customer', customers[custIdx]!.key),
        category: t.category,
        title: t.title.replace('{ref}', orderRef),
        body: t.body,
        link_url: t.linkPrefix ? `${t.linkPrefix}${orderRef}` : null,
        severity: t.severity,
        read_at: i % 2 === 0 ? plusHours(createdAt, 3) : null,
        created_at: createdAt,
      });
    }
    await insertAll(conn, 'notif_message',
      ['id', 'customer_id', 'category', 'title', 'body', 'link_url', 'severity', 'read_at', 'created_at'],
      notifRows,
      ['customer_id', 'category', 'title', 'body', 'link_url', 'severity', 'read_at']);
    c['notif_message'] = notifRows.length;

    /* ---- carts ---- */
    // Three active customer carts, one checked-out, one abandoned, one guest.
    const cartPlans: { key: string; customerIdx: number | null; guestToken: string | null; status: string; lines: { listing: number; qty: number; saved: number }[] }[] = [
      { key: 'cart-ananya', customerIdx: 0, guestToken: null, status: 'ACTIVE', lines: [{ listing: 45, qty: 1, saved: 0 }, { listing: 32, qty: 2, saved: 0 }] },
      { key: 'cart-rohit', customerIdx: 1, guestToken: null, status: 'ACTIVE', lines: [{ listing: 9, qty: 1, saved: 0 }, { listing: 24, qty: 1, saved: 1 }] },
      { key: 'cart-vikram', customerIdx: 3, guestToken: null, status: 'ACTIVE', lines: [{ listing: 21, qty: 1, saved: 0 }, { listing: 37, qty: 1, saved: 0 }, { listing: 3, qty: 1, saved: 0 }] },
      { key: 'cart-priya-n', customerIdx: 4, guestToken: null, status: 'CHECKED_OUT', lines: [{ listing: 17, qty: 1, saved: 0 }] },
      { key: 'cart-arjun', customerIdx: 5, guestToken: null, status: 'ABANDONED', lines: [{ listing: 27, qty: 1, saved: 0 }] },
      { key: 'cart-guest-1', customerIdx: null, guestToken: 'guest_8f3a2b7c9d1e4f56', status: 'ACTIVE', lines: [{ listing: 5, qty: 1, saved: 0 }, { listing: 40, qty: 1, saved: 0 }] },
    ];
    const cartRows: Row[] = [];
    const cartLineRows: Row[] = [];
    for (const cp of cartPlans) {
      const cartId = seedId('cart', cp.key);
      cartRows.push({
        id: cartId,
        customer_id: cp.customerIdx === null ? null : seedId('customer', customers[cp.customerIdx]!.key),
        guest_token: cp.guestToken,
        status: cp.status,
        expires_at: '2026-11-10 00:00:00.000',
      });
      for (let i = 0; i < cp.lines.length; i++) {
        const cl = cp.lines[i]!;
        const listing = listings[cl.listing]!;
        const sku = `${vendors[listing.vendorIdx]!.skuCode}-${String(listing.productIdx + 1).padStart(2, '0')}${i % 2 === 0 ? 'A' : 'B'}`;
        cartLineRows.push({
          id: seedId('cartline', `${cp.key}:${i}`),
          cart_id: cartId,
          listing_id: listing.id,
          variant_sku: sku,
          vendor_id: listing.vendorId,
          qty: cl.qty,
          unit_mrppaise: listing.mrpPaise,
          unit_salepaise: listing.pricePaise,
          saved_for_later: cl.saved,
        });
      }
    }
    await insertAll(conn, 'cart', ['id', 'customer_id', 'guest_token', 'status', 'expires_at'],
      cartRows, ['customer_id', 'guest_token', 'status', 'expires_at']);
    c['cart'] = cartRows.length;

    await insertAll(conn, 'cart_line',
      ['id', 'cart_id', 'listing_id', 'variant_sku', 'vendor_id', 'qty', 'unit_mrppaise', 'unit_salepaise', 'saved_for_later'],
      cartLineRows,
      ['cart_id', 'listing_id', 'variant_sku', 'vendor_id', 'qty', 'unit_mrppaise', 'unit_salepaise', 'saved_for_later']);
    c['cart_line'] = cartLineRows.length;

    return c;
  });

  /* ---- post-commit verification ---- */
  const unbalanced = await query<{ journal_id: string }>(
    'SELECT journal_id FROM fin_ledger_entry GROUP BY journal_id HAVING SUM(debit) <> SUM(credit)',
  );
  const net = await query<{ net: string }>(
    'SELECT CAST(SUM(debit - credit) AS DECIMAL(18,2)) AS net FROM fin_ledger_entry',
  );
  if (unbalanced.length > 0) {
    throw new Error(`ledger invariant violated: ${unbalanced.length} unbalanced journals`);
  }
  if (String(net[0]?.net) !== '0.00') {
    throw new Error(`ledger nets to ${net[0]?.net}, expected 0.00`);
  }

  const summaryTables = [
    'id_staff', 'id_customer', 'id_address', 'ven_store', 'inv_location', 'inv_item',
    'cat_category', 'cat_brand', 'cat_product', 'cat_listing', 'cat_variant',
    'wal_entry', 'wal_balance', 'loy_entry', 'loy_balance',
    'ord_order', 'ord_sub_order', 'pay_payment', 'fin_ledger_entry',
    'rev_review', 'rma_request', 'rma_event', 'mkt_coupon', 'cms_content',
    'notif_message', 'cart', 'cart_line',
  ];
  console.log('\nSeeded row counts (live from the database):');
  for (const t of summaryTables) {
    const row = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`);
    console.log(`  ${t.padEnd(18)} ${row[0]!.n}`);
  }
  console.log(`\nLedger check — unbalanced journals: ${unbalanced.length} (must be 0)`);
  console.log(`Ledger check — SUM(debit-credit): ${net[0]!.net} (must be 0.00)`);
  console.log('\nSeed complete.');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    closePool()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });
