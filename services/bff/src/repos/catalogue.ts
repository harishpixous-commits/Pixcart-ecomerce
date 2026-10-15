/**
 * Catalogue data access: category tree, listing detail, search with facets and
 * relaxations, reviews and the wishlist.
 *
 * Every statement is parameterised; user input never reaches the SQL string.
 * Money leaves this module as integer paise via `paise()` (util.ts) - the only
 * sanctioned conversion from DECIMAL(12,2)/BIGINT.
 *
 * Known schema gaps this module works around honestly (see the BFF report):
 *   - `cat_listing` has no description and no image columns, so
 *     `ListingDetail.description` is '' and `images` is [] - absence is
 *     reported, never invented.
 *   - Listing rating is aggregated from PUBLISHED `rev_review` rows (the
 *     listing table carries no rating columns).
 */
import { query, queryOne } from '../db.js';
import { unprocessable, conflict, notFound, forbidden } from '../http.js';
import type { Category, ListingSummary, Review, ReviewSummary, SearchResponse } from '../dto.js';
import { parseQuery, sanitise } from './query-understanding.js';
import { decodeCursor, encodeCursor, iso, jsonCol, num, paise } from './util.js';
import { ulid } from '../seed/ulid.js';

/* ------------------------------------------------------------------ *
 * Shared row shape for a listing summary query.
 * ------------------------------------------------------------------ */

const SUMMARY_FROM = `
  FROM cat_listing l
  JOIN cat_product p ON p.id = l.product_id
  JOIN ven_store vs ON vs.id = l.vendor_id
  LEFT JOIN cat_brand b ON b.id = p.brand_id
  JOIN cat_category cc ON cc.id = p.category_id
  LEFT JOIN (
    SELECT v.listing_id AS lid, SUM(i.on_hand - i.reserved) AS avail
    FROM cat_variant v JOIN inv_item i ON i.variant_sku = v.sku
    GROUP BY v.listing_id
  ) stk ON stk.lid = l.id
  LEFT JOIN (
    SELECT listing_id AS lid, AVG(rating) AS avg, COUNT(*) AS cnt
    FROM rev_review WHERE status = 'PUBLISHED' GROUP BY listing_id
  ) rat ON rat.lid = l.id`;

const SUMMARY_COLS = `
  l.id AS id, l.product_id AS productId, l.vendor_id AS vendorId, vs.display_name AS vendorName,
  l.title AS title, l.mrp AS mrp, l.price AS price, l.state AS state,
  l.hsn_code AS hsnCode, cc.slug AS categorySlug, cc.id AS categoryId,
  IFNULL(b.name, '') AS brand, IFNULL(rat.avg, 0) AS ratingAvg, IFNULL(rat.cnt, 0) AS ratingCount,
  IFNULL(stk.avail, 0) AS avail`;

interface SummaryRow {
  id: string; productId: string; vendorId: string; vendorName: string;
  title: string; mrp: string; price: string; state: string; hsnCode: string;
  categorySlug: string; categoryId: string; brand: string;
  ratingAvg: number | string; ratingCount: number | string; avail: number | string;
}

export function toSummary(r: SummaryRow): ListingSummary {
  return {
    id: r.id,
    productId: r.productId,
    vendorId: r.vendorId,
    vendorName: r.vendorName,
    title: r.title,
    mrpPaise: paise(r.mrp),
    pricePaise: paise(r.price),
    state: r.state,
    ratingAvg: Number(r.ratingAvg),
    ratingCount: num(r.ratingCount),
    inStock: num(r.avail) > 0,
    categorySlug: r.categorySlug,
  };
}

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

interface CategoryRow {
  id: string; parentId: string | null; name: string; slug: string;
  productCount: number | string;
}

function toCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    parentId: r.parentId,
    name: r.name,
    slug: r.slug,
    productCount: num(r.productCount),
  };
}

/** Full tree: roots each carrying their children; productCount = LIVE listings in the subtree. */
export async function categoryTree(): Promise<Category[]> {
  const rows = await query<CategoryRow>(`
    SELECT c.id, c.parent_id AS parentId, c.name, c.slug,
      (SELECT COUNT(*) FROM cat_listing l
         JOIN cat_product p ON p.id = l.product_id
         JOIN cat_category pc ON pc.id = p.category_id
        WHERE l.state = 'LIVE' AND (pc.id = c.id OR pc.parent_id = c.id)) AS productCount
    FROM cat_category c WHERE c.status = 'ACTIVE'
    ORDER BY c.parent_id IS NOT NULL, c.name`);
  const byId = new Map<string, Category>();
  for (const r of rows) byId.set(r.id, { ...toCategory(r) });
  const roots: Category[] = [];
  for (const r of rows) {
    const c = byId.get(r.id)!;
    if (r.parentId && byId.has(r.parentId)) {
      (byId.get(r.parentId)!.children ??= []).push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

/** Resolve a slug to its category row (active only). */
export async function categoryBySlug(slug: string): Promise<Category | undefined> {
  const r = await queryOne<CategoryRow>(`
    SELECT c.id, c.parent_id AS parentId, c.name, c.slug, 0 AS productCount
    FROM cat_category c WHERE c.slug = ? AND c.status = 'ACTIVE'`, [slug]);
  return r ? toCategory(r) : undefined;
}

/**
 * Admin tree: EVERY category regardless of status (ACTIVE and RETIRED).
 *
 * The storefront tree hides RETIRED rows; the operator console must be able to
 * see and edit them, so this variant drops the status filter. `Category` carries
 * no status field (contracts/dto.ts is frozen), so a retired row is present but
 * not marked as retired in the payload — disclosed rather than invented.
 */
export async function categoryTreeAll(): Promise<Category[]> {
  const rows = await query<CategoryRow>(`
    SELECT c.id, c.parent_id AS parentId, c.name, c.slug,
      (SELECT COUNT(*) FROM cat_listing l
         JOIN cat_product p ON p.id = l.product_id
         JOIN cat_category pc ON pc.id = p.category_id
        WHERE l.state = 'LIVE' AND (pc.id = c.id OR pc.parent_id = c.id)) AS productCount
    FROM cat_category c
    ORDER BY c.parent_id IS NOT NULL, c.name`);
  const byId = new Map<string, Category>();
  for (const r of rows) byId.set(r.id, { ...toCategory(r) });
  const roots: Category[] = [];
  for (const r of rows) {
    const c = byId.get(r.id)!;
    if (r.parentId && byId.has(r.parentId)) {
      (byId.get(r.parentId)!.children ??= []).push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

/** Resolve a category id to its row (any status), for admin edits. */
export async function categoryById(id: string): Promise<Category | undefined> {
  const r = await queryOne<CategoryRow>(
    'SELECT id, parent_id AS parentId, name, slug, 0 AS productCount FROM cat_category WHERE id = ?', [id]);
  return r ? toCategory(r) : undefined;
}

/** Category ids covered by a slug: the category itself, plus its children when it is a root. */
export async function categoryIdsForSlug(slug: string): Promise<string[] | null> {
  const cat = await categoryBySlug(slug);
  if (!cat) return null;
  if (cat.parentId) return [cat.id];
  const kids = await query<{ id: string }>(
    'SELECT id FROM cat_category WHERE parent_id = ? AND status = \'ACTIVE\'', [cat.id]);
  return [cat.id, ...kids.map((k) => k.id)];
}

/* ------------------------------------------------------------------ *
 * Search — FR-CUS-009..013
 * ------------------------------------------------------------------ */

export type SortKey = 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'newest';
export const SORT_KEYS: readonly SortKey[] = ['relevance', 'price_asc', 'price_desc', 'rating', 'newest'];

export interface SearchFilters {
  text: string;
  categoryIds: string[] | null;
  categorySlug?: string;
  brand?: string;
  minPricePaise?: number;
  maxPricePaise?: number;
  sort: SortKey;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

/** Build the WHERE fragment. `skip` drops one dimension so facet counts ignore their own filter. */
function buildWhere(f: SearchFilters, skip: 'brand' | 'price' | 'category' | null = null): WhereClause {
  const clauses = ["l.state = 'LIVE'", "vs.status = 'APPROVED'"];
  const params: unknown[] = [];
  if (f.text) {
    for (const token of f.text.split(' ').filter(Boolean)) {
      clauses.push('(l.title LIKE ? OR p.title LIKE ? OR IFNULL(b.name, \'\') LIKE ?)');
      const like = `%${token}%`;
      params.push(like, like, like);
    }
  }
  if (skip !== 'category' && f.categoryIds && f.categoryIds.length > 0) {
    clauses.push(`cc.id IN (${f.categoryIds.map(() => '?').join(',')})`);
    params.push(...f.categoryIds);
  }
  if (skip !== 'brand' && f.brand) {
    clauses.push('b.name = ?');
    params.push(f.brand);
  }
  if (skip !== 'price') {
    if (f.minPricePaise !== undefined) { clauses.push('l.price >= ?'); params.push((f.minPricePaise / 100).toFixed(2)); }
    if (f.maxPricePaise !== undefined) { clauses.push('l.price <= ?'); params.push((f.maxPricePaise / 100).toFixed(2)); }
  }
  return { sql: clauses.join(' AND '), params };
}

function orderByFor(sort: SortKey): string {
  switch (sort) {
    case 'price_asc': return 'l.price ASC, l.id ASC';
    case 'price_desc': return 'l.price DESC, l.id DESC';
    case 'rating': return 'COALESCE(rat.avg, 0) DESC, l.id DESC';
    case 'newest': return 'l.created_at DESC, l.id DESC';
    case 'relevance': return "(CASE WHEN l.title LIKE ? THEN 1 ELSE 0 END) DESC, COALESCE(rat.avg, 0) DESC, l.id DESC";
  }
}

interface Page {
  items: ListingSummary[];
  total: number;
  nextCursor: string | null;
}

/** One search execution: count + page. Cursor is keyset on (sort key, id). */
async function runSearch(
  f: SearchFilters,
  limit: number,
  cursorRaw: string | null,
  skipFacet: 'brand' | 'price' | 'category' | null = null,
): Promise<Page> {
  const where = buildWhere(f, skipFacet);
  const totalRow = await queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n ${SUMMARY_FROM} WHERE ${where.sql}`, where.params);

  const orderParams: unknown[] = [];
  const order = orderByFor(f.sort);
  const cursor = decodeCursor(cursorRaw);
  const cursorClause = cursor && f.sort !== 'relevance' ? cursorPredicate(f.sort, cursor) : null;
  if (f.sort === 'relevance') orderParams.push(`%${f.text}%`);

  const fullWhere = cursorClause
    ? { sql: `${where.sql} AND ${cursorClause.sql}`, params: [...where.params, ...cursorClause.params] }
    : where;

  const rows = await query<SummaryRow>(
    `SELECT ${SUMMARY_COLS} ${SUMMARY_FROM} WHERE ${fullWhere.sql} ORDER BY ${order} LIMIT ?`,
    [...fullWhere.params, ...orderParams, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toSummary),
    total: num(totalRow?.n ?? 0),
    nextCursor: hasMore && last ? encodeCursor(cursorKeyFor(f.sort, last)) : null,
  };
}

function cursorKeyFor(sort: SortKey, r: SummaryRow): { k: string | number; id: string } {
  if (sort === 'price_asc' || sort === 'price_desc') return { k: r.price, id: r.id };
  if (sort === 'rating') return { k: Number(r.ratingAvg), id: r.id };
  return { k: r.id, id: r.id }; // newest: keyset only uses id (ULID order == creation order)
}

function cursorPredicate(sort: SortKey, c: { k: string | number; id: string }): WhereClause {
  switch (sort) {
    case 'price_asc':
      return { sql: '(l.price > ? OR (l.price = ? AND l.id > ?))', params: [c.k, c.k, c.id] };
    case 'price_desc':
      return { sql: '(l.price < ? OR (l.price = ? AND l.id < ?))', params: [c.k, c.k, c.id] };
    case 'rating':
      return { sql: '(COALESCE(rat.avg, 0) < ? OR (COALESCE(rat.avg, 0) = ? AND l.id < ?))', params: [c.k, c.k, c.id] };
    case 'newest':
      return { sql: '(l.id < ?)', params: [c.id] }; // ULID id order == created_at order
    case 'relevance':
      return { sql: '1=1', params: [] }; // unreachable: relevance carries no cursor
  }
}

const PRICE_BANDS: Array<{ label: string; minPaise: number; maxPaise: number | null }> = [
  { label: 'under-500', minPaise: 0, maxPaise: 49_999 },
  { label: '500-1000', minPaise: 50_000, maxPaise: 99_999 },
  { label: '1000-2000', minPaise: 100_000, maxPaise: 199_999 },
  { label: '2000-5000', minPaise: 200_000, maxPaise: 499_999 },
  { label: '5000-10000', minPaise: 500_000, maxPaise: 999_999 },
  { label: 'above-10000', minPaise: 1_000_000, maxPaise: null },
];

/** Facets over the matched set, each dimension computed with its own filter removed. */
async function facetsFor(f: SearchFilters): Promise<SearchResponse['facets']> {
  const catWhere = buildWhere(f, 'category');
  const category = (await query<{ slug: string; name: string; n: number | string }>(
    `SELECT cc.slug, cc.name, COUNT(*) AS n ${SUMMARY_FROM} WHERE ${catWhere.sql}
     GROUP BY cc.id, cc.slug, cc.name ORDER BY n DESC, cc.name LIMIT 12`, catWhere.params,
  )).map((r) => ({ slug: r.slug, name: r.name, count: num(r.n) }));

  const brandWhere = buildWhere(f, 'brand');
  const brand = (await query<{ name: string; n: number | string }>(
    `SELECT b.name, COUNT(*) AS n ${SUMMARY_FROM} WHERE ${brandWhere.sql} AND b.name IS NOT NULL
     GROUP BY b.name ORDER BY n DESC, b.name LIMIT 12`, brandWhere.params,
  )).map((r) => ({ name: r.name, count: num(r.n) }));

  // price bands ignore the explicit price bounds (a band is an alternative to them)
  const priceWhere = buildWhere(f, 'price');
  const rows = await query<{ price: string }>(
    `SELECT l.price ${SUMMARY_FROM} WHERE ${priceWhere.sql}`, priceWhere.params);
  const priceBand = PRICE_BANDS.map((band) => ({
    minPaise: band.minPaise,
    maxPaise: band.maxPaise ?? Number.MAX_SAFE_INTEGER,
    count: rows.filter((r) => {
      const v = paise(r.price);
      return v >= band.minPaise && (band.maxPaise === null || v <= band.maxPaise);
    }).length,
  })).filter((b) => b.count > 0);

  return { category, brand, priceBand };
}

/**
 * Full search: sanitised query understanding (FR-CUS-009/010 via the ported
 * discovery module), facets always present, and deterministic relaxations
 * whenever the strict query returns zero rows.
 */
export async function search(input: {
  q: string; category?: string; brand?: string;
  minPricePaise?: number; maxPricePaise?: number;
  sort: SortKey; limit: number; cursor: string | null;
}): Promise<SearchResponse> {
  const raw = input.q ?? '';
  const understood = parseQuery(raw);
  if (!understood.ok) {
    // Banned term: a policy refusal (403), not a field-validation failure.
    throw forbidden(understood.policyMessage);
  }
  const parsed = understood.parsed;

  // explicit query params win over phrases recognised inside q
  const minPricePaise = input.minPricePaise ?? parsed.minPricePaise;
  const maxPricePaise = input.maxPricePaise ?? parsed.maxPricePaise;

  let categoryIds: string[] | null = null;
  if (input.category) {
    categoryIds = await categoryIdsForSlug(input.category);
    if (categoryIds === null) {
      throw unprocessable(`Unknown category: ${input.category}`, { category: 'unknown category slug' });
    }
  }

  const base: SearchFilters = {
    text: sanitise(parsed.text),
    categoryIds,
    categorySlug: input.category,
    brand: input.brand,
    minPricePaise,
    maxPricePaise,
    sort: input.sort,
  };

  let page = await runSearch(base, input.limit, input.cursor);
  const relaxations: string[] = [];

  if (page.total === 0 && input.cursor === null) {
    // Deterministic relaxation ladder; each step is only claimed if it was applied.
    const attempts: Array<{ apply: () => void; note: () => string }> = [];
    const tokens = base.text.split(' ').filter(Boolean);
    if (tokens.length >= 2) {
      attempts.push({
        apply: () => { base.text = tokens.slice(0, -1).join(' '); },
        note: () => `dropped the term "${tokens[tokens.length - 1]}"`,
      });
    }
    if (base.minPricePaise !== undefined || base.maxPricePaise !== undefined) {
      attempts.push({
        apply: () => { delete base.minPricePaise; delete base.maxPricePaise; },
        note: () => 'removed the price range',
      });
    }
    if (base.brand) {
      attempts.push({ apply: () => { delete base.brand; }, note: () => `ignored the brand filter "${base.brand}"` });
    }
    if (base.categoryIds) {
      attempts.push({ apply: () => { base.categoryIds = null; }, note: () => `searched outside category "${base.categorySlug}"` });
    }
    for (const a of attempts) {
      a.apply();
      relaxations.push(a.note());
      page = await runSearch(base, input.limit, null);
      if (page.total > 0) break;
    }
  }

  return {
    items: page.items,
    total: page.total,
    relaxations,
    facets: await facetsFor(base),
    query: raw,
  };
}

/* ------------------------------------------------------------------ *
 * Listing detail, reviews
 * ------------------------------------------------------------------ */

export interface ListingDetailRow extends SummaryRow {
  attributes: Record<string, unknown>;
  productAttributes: Record<string, unknown>;
  description: string;
}

export async function listingDetail(id: string): Promise<{
  detail: ListingDetailRow;
  variants: { id: string; sku: string; optionMap: Record<string, string>; inStock: boolean }[];
  similar: ListingSummary[];
} | null> {
  const detail = await queryOne<ListingDetailRow>(`
    SELECT ${SUMMARY_COLS}, l.attributes AS attributes, p.attributes AS productAttributes
    ${SUMMARY_FROM} WHERE l.id = ?`, [id]);
  if (!detail) return null;

  const variants = await query<{ id: string; sku: string; option_map: Record<string, unknown>; avail: number | string }>(`
    SELECT v.id, v.sku, v.option_map,
      IFNULL((SELECT SUM(i.on_hand - i.reserved) FROM inv_item i WHERE i.variant_sku = v.sku), 0) AS avail
    FROM cat_variant v WHERE v.listing_id = ? ORDER BY v.sku`, [id]);

  const similar = await query<SummaryRow>(`
    SELECT ${SUMMARY_COLS} ${SUMMARY_FROM}
    WHERE l.state = 'LIVE' AND vs.status = 'APPROVED' AND cc.id = ? AND l.id <> ?
    ORDER BY COALESCE(rat.avg, 0) DESC, l.id ASC LIMIT 8`, [detail.categoryId, id]);

  return {
    detail,
    variants: variants.map((v) => ({
      id: v.id, sku: v.sku,
      optionMap: jsonCol<Record<string, string>>(v.option_map, {}),
      inStock: num(v.avail) > 0,
    })),
    similar: similar.map(toSummary),
  };
}

export async function listingExists(id: string): Promise<{ vendorId: string; categoryId: string; productId: string } | undefined> {
  return queryOne<{ vendorId: string; categoryId: string; productId: string }>(`
    SELECT l.vendor_id AS vendorId, p.category_id AS categoryId, l.product_id AS productId
    FROM cat_listing l JOIN cat_product p ON p.id = l.product_id WHERE l.id = ?`, [id]);
}

export async function listReviews(listingId: string, limit: number, cursorRaw: string | null): Promise<{ items: Review[]; nextCursor: string | null }> {
  const cursor = decodeCursor(cursorRaw);
  const params: unknown[] = [listingId];
  let cursorSql = '';
  if (cursor) {
    cursorSql = ' AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))';
    params.push(cursor.k, cursor.k, cursor.id);
  }
  const rows = await query<{
    id: string; listing_id: string; customer_id: string; full_name: string; rating: number;
    title: string | null; body: string | null; created_at: Date; helpful_up: number; status: string;
    order_id: string | null;
  }>(`
    SELECT r.id, r.listing_id, r.customer_id, c.full_name, r.rating, r.title, r.body,
           r.created_at, r.helpful_up, r.status, r.order_id
    FROM rev_review r JOIN id_customer c ON c.id = r.customer_id
    WHERE r.listing_id = ? AND r.status = 'PUBLISHED'${cursorSql}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, [...params, limit + 1]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      listingId: r.listing_id,
      customerId: r.customer_id,
      customerName: r.full_name,
      rating: num(r.rating),
      title: r.title ?? undefined,
      body: r.body ?? undefined,
      createdAt: iso(r.created_at),
      // order_id is only non-null when the DB proved a delivered sub-order of the listing's vendor (see createReview).
      verifiedPurchase: r.order_id !== null,
      helpfulUp: num(r.helpful_up),
      status: r.status as Review['status'],
    })),
    nextCursor: hasMore && last ? encodeCursor({ k: iso(last.created_at), id: last.id }) : null,
  };
}

/** PUBLISHED-only histogram — the review summary customers see (FR-CUS-024). */
export async function reviewSummary(listingId: string): Promise<ReviewSummary> {
  const rows = await query<{ rating: number; n: number | string }>(
    'SELECT rating, COUNT(*) AS n FROM rev_review WHERE listing_id = ? AND status = \'PUBLISHED\' GROUP BY rating',
    [listingId]);
  const histogram: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    const k = String(num(r.rating)) as '1' | '2' | '3' | '4' | '5';
    if (histogram[k] !== undefined) histogram[k] = num(r.n);
    count += num(r.n);
    sum += num(r.rating) * num(r.n);
  }
  return { average: count === 0 ? 0 : Math.round((sum / count) * 10) / 10, count, histogram };
}

/**
 * FR-CUS-023 create review. `verifiedPurchase` is only set when the database
 * proves a DELIVERED sub-order of this customer for the listing's VENDOR.
 *
 * DEVIATION, disclosed: schema V001-V007 has no order-line table, so "a
 * DELIVERED order contains this listing" is not verifiable; the strongest
 * genuine proof available is a delivered sub-order from the listing's vendor.
 * `order_id` stores that proof's order. Without any proof the review is
 * stored with order_id NULL and verifiedPurchase=false.
 */
export async function createReview(input: {
  listingId: string; customerId: string; rating: number; title?: string; body?: string;
}): Promise<Review> {
  const listing = await listingExists(input.listingId);
  if (!listing) throw notFound('Listing not found');

  const proof = await queryOne<{ order_id: string }>(`
    SELECT so.order_id
    FROM ord_sub_order so JOIN ord_order o ON o.id = so.order_id
    WHERE o.customer_id = ? AND so.vendor_id = ? AND so.state = 'DELIVERED'
    ORDER BY so.created_at DESC LIMIT 1`, [input.customerId, listing.vendorId]);

  const id = ulid();
  try {
    await query(
      `INSERT INTO rev_review (id, listing_id, product_id, vendor_id, customer_id, order_id,
        rating, title, body, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [id, input.listingId, listing.productId, listing.vendorId, input.customerId,
        proof?.order_id ?? null, input.rating, input.title ?? null, input.body ?? null],
    );
  } catch (err) {
    const e = err as { code?: string; errno?: number };
    if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
      throw conflict('You have already reviewed this listing', 'ALREADY_REVIEWED');
    }
    throw err;
  }
  return {
    id,
    listingId: input.listingId,
    customerId: input.customerId,
    customerName: '',
    rating: input.rating,
    title: input.title,
    body: input.body,
    createdAt: new Date().toISOString(),
    verifiedPurchase: proof !== undefined,
    helpfulUp: 0,
    status: 'PENDING',
  };
}

/* ------------------------------------------------------------------ *
 * Wishlist — FR-CUS-006
 * ------------------------------------------------------------------ */

export async function listWishlist(customerId: string): Promise<ListingSummary[]> {
  const rows = await query<SummaryRow>(`
    SELECT ${SUMMARY_COLS} ${SUMMARY_FROM}
    JOIN cus_wishlist w ON w.listing_id = l.id
    WHERE w.customer_id = ? ORDER BY w.created_at DESC`, [customerId]);
  return rows.map(toSummary);
}

export async function addWishlist(customerId: string, listingId: string): Promise<void> {
  const listing = await listingExists(listingId);
  if (!listing) throw notFound('Listing not found');
  try {
    await query('INSERT INTO cus_wishlist (id, customer_id, listing_id) VALUES (?, ?, ?)',
      [ulid(), customerId, listingId]);
  } catch (err) {
    const e = err as { code?: string; errno?: number };
    if (e.code === 'ER_DUP_ENTRY' || e.errno === 1062) {
      throw conflict('Listing is already on your wishlist', 'ALREADY_WISHLISTED');
    }
    throw err;
  }
}

export async function removeWishlist(customerId: string, listingId: string): Promise<boolean> {
  const res = await query<{ affectedRows: number }>(
    'DELETE FROM cus_wishlist WHERE customer_id = ? AND listing_id = ?', [customerId, listingId]);
  // DELETE returns an OkPacket with affectedRows, not rows (mariadb driver behaviour).
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  return affected > 0;
}
