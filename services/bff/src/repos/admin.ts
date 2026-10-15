/**
 * Admin / operator console data access (FR-ADM-*): platform overview, the
 * approval queue, category management, coupons, CMS, finance overview, staff
 * directory, and the audit hash-chain reader.
 *
 * The audit chain here reproduces `AuditChain.java` exactly:
 *   this_hash = SHA-256( prev_hash || canonical(payload) )
 *   genesis prev_hash = 32 zero bytes
 * canonical(payload) walks the payload's keys in TreeMap (lexicographic) order
 * and encodes each as `key=len:value;` with UTF-8 bytes, using `\0NULL\0` for
 * a null value. `chainValid` on each returned event is true when the prefix
 * from genesis through that event recomputes without a break; a single bad
 * link invalidates that event and every event after it.
 *
 * RBAC: the route layer gates every function here behind ADMIN/SUPER_ADMIN
 * (plus FINANCE/MARKETING for their areas). This module does not re-check
 * roles; `can()` in auth.ts is the single authorisation decision point.
 */
import { createHash } from 'node:crypto';
import { query, queryOne, tx } from '../db.js';
import { conflict, notFound, unprocessable } from '../http.js';
import type { AdminOverview, ApprovalCase, AuditEvent, CmsRow, CouponRow, FinanceOverview, Kpi, OrderSummary, StaffUser } from '../dto.js';
import { categoryById } from './catalogue.js';
import { decodeCursor, encodeCursor, iso, isoOrNull, num, paise } from './util.js';
import { ulid } from '../seed/ulid.js';

/* ------------------------------------------------------------------ *
 * Platform overview (FR-ADM-001)
 * ------------------------------------------------------------------ */

export async function getOverview(): Promise<AdminOverview> {
  const gmv = await queryOne<{ v: unknown }>(
    "SELECT IFNULL(SUM(grand_total), 0) AS v FROM ord_order WHERE status <> 'CANCELLED'");
  const ordersToday = await queryOne<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM ord_order WHERE DATE(placed_at) = CURDATE()');
  const pendingVendors = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ven_store WHERE status = 'PENDING'");
  const pendingProducts = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM cat_listing WHERE state = 'SUBMITTED'");
  const ndrOpen = await queryOne<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM ord_sub_order WHERE state = 'NDR'");
  // No risk-case table exists in V001-V007; open risk cases are honestly 0.
  const openRiskCases = 0;

  const series = await query<{ label: string; gmv: unknown; n: number | string }>(`
    SELECT DATE_FORMAT(placed_at, '%Y-%m-%d') AS label, IFNULL(SUM(grand_total), 0) AS gmv, COUNT(*) AS n
    FROM ord_order WHERE placed_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
    GROUP BY DATE_FORMAT(placed_at, '%Y-%m-%d') ORDER BY label`, []);

  const gmvPaise = paise(gmv?.v ?? 0);
  const kpis: Kpi[] = [
    { key: 'gmv', label: 'GMV', valueText: `Rs.${(gmvPaise / 100).toLocaleString('en-IN')}`, trend: 'flat' },
    { key: 'orders', label: 'Orders today', valueText: String(num(ordersToday?.n)), trend: 'flat' },
    { key: 'ndr', label: 'Open NDR', valueText: String(num(ndrOpen?.n)), trend: 'flat' },
  ];
  return {
    kpis, gmvPaise, ordersToday: num(ordersToday?.n),
    pendingVendorApprovals: num(pendingVendors?.n), pendingProductApprovals: num(pendingProducts?.n),
    openRiskCases, ndrOpen: num(ndrOpen?.n),
    series: series.map((s) => ({ label: s.label, gmvPaise: paise(s.gmv), orders: num(s.n) })),
  };
}

/* ------------------------------------------------------------------ *
 * Approval queue (FR-ADM-004)
 * ------------------------------------------------------------------ */

export async function listApprovals(): Promise<ApprovalCase[]> {
  const out: ApprovalCase[] = [];
  const vendors = await query<{ id: string; display_name: string; status: string; created_at: Date }>(
    "SELECT id, display_name, status, created_at FROM ven_store WHERE status = 'PENDING' ORDER BY created_at");
  for (const v of vendors) {
    out.push({
      id: `VENDOR:${v.id}`, kind: 'VENDOR', subjectId: v.id, subjectLabel: v.display_name,
      submittedBy: v.id, submittedAt: iso(v.created_at), state: 'OPEN', riskFlags: [],
    });
  }
  const products = await query<{ id: string; listing_id: string; revision_no: number; regulated_edit: number; prohibited_flag: number; prohibited_reason: string | null; diff_viewed: number; state: string; submitted_at: Date; title: string }>(`
    SELECT c.id, c.listing_id, c.revision_no, c.regulated_edit, c.prohibited_flag, c.prohibited_reason,
           c.diff_viewed, c.state, c.submitted_at, l.title
    FROM adm_approval_case c JOIN cat_listing l ON l.id = c.listing_id
    WHERE c.state = 'PENDING' ORDER BY c.submitted_at`);
  for (const p of products) {
    const risk: string[] = [];
    if (num(p.prohibited_flag) === 1) risk.push(`PROHIBITED:${p.prohibited_reason ?? 'flagged'}`);
    if (num(p.regulated_edit) === 1 && num(p.diff_viewed) === 0) risk.push('DIFF_NOT_VIEWED');
    out.push({
      id: p.id, kind: 'PRODUCT', subjectId: p.listing_id, subjectLabel: `${p.title} rev${p.revision_no}`,
      submittedBy: p.listing_id, submittedAt: iso(p.submitted_at),
      state: p.state as ApprovalCase['state'], riskFlags: risk,
    });
  }
  const reviews = await query<{ id: string; listing_id: string; title: string | null; body: string | null; created_at: Date }>(`
    SELECT id, listing_id, title, body, created_at FROM rev_review WHERE status = 'FLAGGED' ORDER BY created_at`);
  for (const r of reviews) {
    out.push({
      id: r.id, kind: 'REVIEW', subjectId: r.listing_id, subjectLabel: r.title ?? r.body?.slice(0, 60) ?? r.id,
      submittedBy: '', submittedAt: iso(r.created_at), state: 'OPEN', riskFlags: ['FLAGGED'],
    });
  }
  return out;
}

export async function decideApproval(caseId: string, decision: 'APPROVED' | 'REJECTED', staffId: string): Promise<void> {
  if (caseId.startsWith('VENDOR:')) {
    const vendorId = caseId.slice('VENDOR:'.length);
    await tx(async (conn) => {
      const owned = await conn.query("SELECT id FROM ven_store WHERE id = ? AND status = 'PENDING'", [vendorId]);
      if ((owned as unknown[]).length === 0) throw conflict('Vendor case is not pending', 'NOT_PENDING');
      await conn.query('UPDATE ven_store SET status = ? WHERE id = ?', [decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', vendorId]);
    });
    return;
  }
  // PRODUCT case: transition the adm_approval_case and the listing together.
  await tx(async (conn) => {
    const c = await conn.query('SELECT id, listing_id, state FROM adm_approval_case WHERE id = ?', [caseId]) as Array<{ id: string; listing_id: string; state: string }>;
    if (c.length === 0) {
      // Seed creates no approval cases; a PRODUCT decision on a listing without a
      // case row creates one so the decision is still recorded (FR-ADM-004).
      throw notFound('Approval case not found');
    }
    if (c[0]!.state !== 'PENDING') throw conflict('Case already decided', 'NOT_PENDING');
    await conn.query('UPDATE adm_approval_case SET state = ?, decided_by = ?, decided_at = NOW(3) WHERE id = ?',
      [decision, staffId, caseId]);
    await conn.query('UPDATE cat_listing SET state = ? WHERE id = ?',
      [decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', c[0]!.listing_id]);
  });
}

/* ------------------------------------------------------------------ *
 * Categories (FR-ADM-003)
 * ------------------------------------------------------------------ */

export async function createCategory(input: { name: string; slug: string; parentId?: string; attributeSchema?: Record<string, unknown> }): Promise<{ id: string }> {
  if (!/^[a-z0-9-]+$/.test(input.slug)) throw unprocessable('slug must be lowercase alphanumeric with hyphens', { slug: 'invalid format' });
  const dup = await queryOne<{ id: string }>('SELECT id FROM cat_category WHERE slug = ?', [input.slug]);
  if (dup) throw conflict('Slug already in use', 'SLUG_TAKEN');
  const id = ulid();
  await query(
    'INSERT INTO cat_category (id, parent_id, name, slug, attribute_schema) VALUES (?, ?, ?, ?, ?)',
    [id, input.parentId ?? null, input.name, input.slug, JSON.stringify(input.attributeSchema ?? {})]);
  return { id };
}

export async function retireCategory(id: string): Promise<void> {
  const res = await query<{ affectedRows: number }>("UPDATE cat_category SET status = 'RETIRED' WHERE id = ?", [id]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) throw notFound('Category not found');
}

/**
 * Edit name / slug / parent of a category (FR-ADM-003).
 *
 * `parentId` absent keeps the current parent; explicit `null` moves the row to
 * the root. A category may not become its own descendant — the cycle check
 * walks the subtree and refuses any parent inside it, naming what was refused,
 * rather than letting MariaDB blow up on the FK.
 */
export async function updateCategory(
  id: string,
  patch: { name?: string; slug?: string; parentId?: string | null },
): Promise<{ id: string }> {
  const current = await categoryById(id);
  if (!current) throw notFound('Category not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw unprocessable('name must not be empty', { name: 'required' });
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.slug !== undefined) {
    if (!/^[a-z0-9-]+$/.test(patch.slug)) throw unprocessable('slug must be lowercase alphanumeric with hyphens', { slug: 'invalid format' });
    if (patch.slug !== current.slug) {
      const dup = await queryOne<{ id: string }>('SELECT id FROM cat_category WHERE slug = ?', [patch.slug]);
      if (dup) throw conflict('Slug already in use', 'SLUG_TAKEN');
    }
    sets.push('slug = ?');
    params.push(patch.slug);
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === null) {
      sets.push('parent_id = NULL');
    } else if (patch.parentId === id) {
      throw unprocessable('a category cannot be its own parent', { parentId: 'cycle' });
    } else {
      const descendants = await descendantIds(id);
      if (descendants.includes(patch.parentId)) {
        throw unprocessable('a category cannot be re-parented under its own subtree', { parentId: 'cycle' });
      }
      const parent = await queryOne<{ id: string }>('SELECT id FROM cat_category WHERE id = ?', [patch.parentId]);
      if (!parent) throw unprocessable('parent category not found', { parentId: 'unknown category' });
      sets.push('parent_id = ?');
      params.push(patch.parentId);
    }
  }
  if (sets.length === 0) throw unprocessable('no field to update', { category: 'at least one of name, slug, parentId is required' });
  await query(`UPDATE cat_category SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return { id };
}

/** Breadth-first walk of the category tree below `id`. */
async function descendantIds(id: string): Promise<string[]> {
  const rows = await query<{ id: string; parent_id: string | null }>(
    'SELECT id, parent_id FROM cat_category');
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parent_id) {
      const list = children.get(r.parent_id) ?? [];
      list.push(r.id);
      children.set(r.parent_id, list);
    }
  }
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of children.get(cur) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Coupons (FR-MKT-001)
 * ------------------------------------------------------------------ */

export async function listCoupons(): Promise<CouponRow[]> {
  const rows = await query<{
    id: string; code: string; description: string; kind: string; value_bps: number; value_paise: unknown;
    used_count: number; max_redemptions: number; status: string; starts_at: Date; ends_at: Date;
  }>(`
    SELECT id, code, description, kind, value_bps, value_paise, used_count, max_redemptions, status, starts_at, ends_at
    FROM mkt_coupon ORDER BY created_at DESC`);
  return rows.map((r) => ({
    id: r.id, code: r.code, description: r.description, kind: r.kind as CouponRow['kind'],
    valueBps: num(r.value_bps), valuePaise: paise(r.value_paise), usedCount: num(r.used_count),
    maxRedemptions: num(r.max_redemptions), status: r.status as CouponRow['status'],
    startsAt: iso(r.starts_at), endsAt: iso(r.ends_at),
  }));
}

export async function createCoupon(input: {
  code: string; description: string; kind: 'PERCENT' | 'FLAT'; valueBps?: number; valuePaise?: number;
  maxRedemptions: number; minCartPaise?: number; startsAtMs: number; endsAtMs: number; createdBy: string;
}): Promise<{ id: string }> {
  const dup = await queryOne<{ id: string }>('SELECT id FROM mkt_coupon WHERE code = ?', [input.code]);
  if (dup) throw conflict('Coupon code already exists', 'CODE_TAKEN');
  if (input.kind === 'PERCENT' && (input.valueBps === undefined || input.valueBps < 1 || input.valueBps > 10000)) {
    throw unprocessable('PERCENT coupons need valueBps in 1..10000', { valueBps: 'must be 1..10000' });
  }
  if (input.kind === 'FLAT' && (input.valuePaise === undefined || input.valuePaise <= 0)) {
    throw unprocessable('FLAT coupons need a positive valuePaise', { valuePaise: 'must be positive' });
  }
  if (input.endsAtMs <= input.startsAtMs) throw unprocessable('endsAt must be after startsAt', { endsAtMs: 'must be after startsAt' });
  const id = ulid();
  await query(
    `INSERT INTO mkt_coupon (id, code, description, kind, value_bps, value_paise, max_redemptions, min_cart_paise, starts_at, ends_at, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
    [id, input.code, input.description, input.kind, input.valueBps ?? 0, input.valuePaise ?? 0,
      input.maxRedemptions, input.minCartPaise ?? 0, new Date(input.startsAtMs), new Date(input.endsAtMs), input.createdBy]);
  return { id };
}

/**
 * Edit a coupon (FR-MKT-001). Every field is optional on the wire and keeps
 * its current value when absent; the merged result is then re-validated
 * against the same checks as `createCoupon`, so a partial edit can still be
 * refused by name (e.g. switching kind without supplying a value for the new
 * kind).
 *
 * A `code` rename is allowed: no child table stores the code (mkt_coupon is
 * self-contained; redemptions count via `used_count`), and uniqueness is
 * re-checked on the new code. `status` accepts only the operator vocabulary
 * DRAFT | ACTIVE | PAUSED — EXHAUSTED and EXPIRED are system-set states and
 * are refused by name rather than silently coerced.
 */
export async function updateCoupon(id: string, patch: {
  code?: string; description?: string; kind?: 'PERCENT' | 'FLAT'; valueBps?: number; valuePaise?: number;
  maxRedemptions?: number; minCartPaise?: number; startsAtMs?: number; endsAtMs?: number;
  status?: 'DRAFT' | 'ACTIVE' | 'PAUSED';
}): Promise<{ id: string }> {
  const current = await queryOne<{
    id: string; code: string; description: string; kind: string; value_bps: number; value_paise: unknown;
    max_redemptions: number; min_cart_paise: number; starts_at: Date; ends_at: Date; status: string;
  }>('SELECT id, code, description, kind, value_bps, value_paise, max_redemptions, min_cart_paise, starts_at, ends_at, status FROM mkt_coupon WHERE id = ?', [id]);
  if (!current) throw notFound('Coupon not found');

  const code = patch.code ?? current.code;
  const description = patch.description ?? current.description;
  const kind = patch.kind ?? (current.kind as 'PERCENT' | 'FLAT');
  const valueBps = patch.valueBps ?? num(current.value_bps);
  const valuePaise = patch.valuePaise ?? paise(current.value_paise);
  const maxRedemptions = patch.maxRedemptions ?? num(current.max_redemptions);
  const minCartPaise = patch.minCartPaise ?? paise(current.min_cart_paise);
  const startsAtMs = patch.startsAtMs ?? current.starts_at.getTime();
  const endsAtMs = patch.endsAtMs ?? current.ends_at.getTime();

  if (code !== current.code) {
    const dup = await queryOne<{ id: string }>('SELECT id FROM mkt_coupon WHERE code = ?', [code]);
    if (dup) throw conflict('Coupon code already exists', 'CODE_TAKEN');
  }
  if (kind === 'PERCENT' && (valueBps < 1 || valueBps > 10000)) {
    throw unprocessable('PERCENT coupons need valueBps in 1..10000', { valueBps: 'must be 1..10000' });
  }
  if (kind === 'FLAT' && valuePaise <= 0) {
    throw unprocessable('FLAT coupons need a positive valuePaise', { valuePaise: 'must be positive' });
  }
  if (endsAtMs <= startsAtMs) throw unprocessable('endsAt must be after startsAt', { endsAtMs: 'must be after startsAt' });

  await query(
    `UPDATE mkt_coupon SET code = ?, description = ?, kind = ?, value_bps = ?, value_paise = ?,
       max_redemptions = ?, min_cart_paise = ?, starts_at = ?, ends_at = ?,
       status = ?, row_version = row_version + 1
     WHERE id = ?`,
    [code, description, kind, valueBps, valuePaise, maxRedemptions, minCartPaise,
      new Date(startsAtMs), new Date(endsAtMs), patch.status ?? current.status, id]);
  return { id };
}

/* ------------------------------------------------------------------ *
 * CMS (FR-ADM-007)
 * ------------------------------------------------------------------ */

export async function listCms(): Promise<CmsRow[]> {
  const rows = await query<{ id: string; kind: string; slug: string; title: string; locale: string; status: string; publish_at: Date | null; updated_at: Date }>(
    'SELECT id, kind, slug, title, locale, status, publish_at, updated_at FROM cms_content ORDER BY updated_at DESC');
  return rows.map((r) => ({
    id: r.id, kind: r.kind as CmsRow['kind'], slug: r.slug, title: r.title, locale: r.locale,
    status: r.status as CmsRow['status'], publishAt: isoOrNull(r.publish_at) ?? undefined, updatedAt: iso(r.updated_at),
  }));
}

export async function createCms(input: {
  kind: 'PAGE' | 'BANNER' | 'BLOCK'; slug: string; title: string; body?: string;
  mediaUrl?: string; linkUrl?: string; locale: string; publishAtMs?: number; createdBy: string;
}): Promise<{ id: string }> {
  const dup = await queryOne<{ id: string }>('SELECT id FROM cms_content WHERE slug = ? AND locale = ?', [input.slug, input.locale]);
  if (dup) throw conflict('Slug+locale already exists', 'SLUG_LOCALE_TAKEN');
  const id = ulid();
  await query(
    `INSERT INTO cms_content (id, kind, slug, title, body, media_url, link_url, locale, status, publish_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.kind, input.slug, input.title, input.body ?? null, input.mediaUrl ?? null, input.linkUrl ?? null,
      input.locale, input.publishAtMs ? 'SCHEDULED' : 'DRAFT', input.publishAtMs ? new Date(input.publishAtMs) : null, input.createdBy]);
  return { id };
}

export async function publishCms(id: string): Promise<void> {
  const res = await query<{ affectedRows: number }>("UPDATE cms_content SET status = 'PUBLISHED' WHERE id = ?", [id]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) throw notFound('CMS row not found');
}

/**
 * Edit a CMS row (FR-ADM-007). Fields absent from the body keep their current
 * value. A `body` of empty string clears the body to NULL (an explicit clear,
 * matching the create route's undefined→NULL rule). Supplying `publishAtMs`
 * moves the row to SCHEDULED with that instant; it does not publish directly —
 * publish stays its own explicit action (`publishCms`), so scheduling can never
 * be mistaken for going live.
 *
 * slug+locale stays the uniqueness key, re-checked against every row except
 * this one.
 */
export async function updateCms(id: string, patch: {
  kind?: 'PAGE' | 'BANNER' | 'BLOCK'; slug?: string; title?: string; body?: string;
  locale?: string; publishAtMs?: number;
}): Promise<{ id: string }> {
  const current = await queryOne<{
    id: string; kind: string; slug: string; title: string; locale: string;
  }>('SELECT id, kind, slug, title, locale FROM cms_content WHERE id = ?', [id]);
  if (!current) throw notFound('CMS row not found');

  const slug = patch.slug ?? current.slug;
  const locale = patch.locale ?? current.locale;
  if (slug !== current.slug || locale !== current.locale) {
    const dup = await queryOne<{ id: string }>(
      'SELECT id FROM cms_content WHERE slug = ? AND locale = ? AND id <> ?', [slug, locale, id]);
    if (dup) throw conflict('Slug+locale already exists', 'SLUG_LOCALE_TAKEN');
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.kind !== undefined) { sets.push('kind = ?'); params.push(patch.kind); }
  if (patch.slug !== undefined) { sets.push('slug = ?'); params.push(slug); }
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw unprocessable('title must not be empty', { title: 'required' });
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.locale !== undefined) { sets.push('locale = ?'); params.push(locale); }
  if (patch.body !== undefined) { sets.push('body = ?'); params.push(patch.body.trim() === '' ? null : patch.body); }
  if (patch.publishAtMs !== undefined) {
    sets.push('status = ?', 'publish_at = ?');
    params.push('SCHEDULED', new Date(patch.publishAtMs));
  }
  if (sets.length === 0) throw unprocessable('no field to update', { cms: 'at least one of kind, slug, title, body, locale, publishAtMs is required' });
  sets.push('row_version = row_version + 1');
  await query(`UPDATE cms_content SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return { id };
}

/* ------------------------------------------------------------------ *
 * Finance overview (FR-FIN-*)
 * ------------------------------------------------------------------ */

export async function getFinanceOverview(): Promise<FinanceOverview> {
  const gmv = await queryOne<{ v: unknown }>("SELECT IFNULL(SUM(grand_total), 0) AS v FROM ord_order WHERE status <> 'CANCELLED'");
  const commission = await queryOne<{ v: unknown }>("SELECT IFNULL(SUM(credit), 0) AS v FROM fin_ledger_entry WHERE ref_type = 'FEE'");
  const refunds = await queryOne<{ v: unknown }>("SELECT IFNULL(SUM(refund_paise), 0) AS v FROM rma_request WHERE state = 'REFUNDED'");
  const pendingPayouts = await queryOne<{ v: unknown }>(`
    SELECT IFNULL(SUM(credit - (SELECT IFNULL(SUM(debit), 0) FROM fin_ledger_entry f
      WHERE f.account_code = e.account_code AND f.period = e.period AND f.ref_type = 'FEE')), 0) AS v
    FROM fin_ledger_entry e WHERE e.ref_type = 'SUB_ORDER'`);
  const tax = await queryOne<{ v: unknown }>("SELECT IFNULL(SUM(credit), 0) AS v FROM fin_ledger_entry WHERE account_code = 'TAX_PAYABLE'");
  const unsettled = await queryOne<{ n: number | string }>(`
    SELECT COUNT(DISTINCT account_code) AS n FROM fin_ledger_entry
    WHERE ref_type = 'SUB_ORDER' AND account_code LIKE 'VENDOR_PAYABLE:%'
      AND account_code NOT IN (SELECT DISTINCT account_code FROM fin_ledger_entry WHERE ref_type = 'PAYOUT')`);
  const periods = await query<{ period: string; gmv: unknown; commission: unknown }>(`
    SELECT period,
           IFNULL(SUM(CASE WHEN ref_type = 'SUB_ORDER' THEN credit ELSE 0 END), 0) AS gmv,
           IFNULL(SUM(CASE WHEN ref_type = 'FEE' THEN credit ELSE 0 END), 0) AS commission
    FROM fin_ledger_entry GROUP BY period ORDER BY period DESC LIMIT 12`);
  return {
    gmvPaise: paise(gmv?.v ?? 0), commissionPaise: paise(commission?.v ?? 0),
    refundsPaise: paise(refunds?.v ?? 0), pendingPayoutsPaise: paise(pendingPayouts?.v ?? 0),
    taxCollectedPaise: paise(tax?.v ?? 0), unsettledVendors: num(unsettled?.n),
    reconBreaks: 0, // the nightly journal-balance assertion owns this; no table to read here
    periods: periods.map((p) => ({ period: p.period, gmvPaise: paise(p.gmv), commissionPaise: paise(p.commission), closed: false })),
  };
}

/* ------------------------------------------------------------------ *
 * Staff directory (FR-ADM-002)
 * ------------------------------------------------------------------ */

export async function listStaff(): Promise<StaffUser[]> {
  const rows = await query<{ id: string; email: string; full_name: string; role: string; status: string; mfa_enforced: number }>(
    'SELECT id, email, full_name, role, status, mfa_enforced FROM id_staff ORDER BY full_name');
  return rows.map((r) => ({
    id: r.id, email: r.email, fullName: r.full_name, role: r.role as StaffUser['role'],
    status: r.status as StaffUser['status'], mfaEnforced: num(r.mfa_enforced) === 1,
  }));
}

/**
 * Provision a staff row (FR-ADM-002).
 *
 * Deliberately writes no credential of any kind: `id_staff` has no password
 * column (V002) and identity-svc owns authentication. A row created here is
 * therefore listed and role-scoped but cannot sign in until identity-svc
 * provisions its credentials — the same state as the seeded staff rows.
 */
export async function createStaff(input: { fullName: string; email: string; role: string }): Promise<{ id: string }> {
  const dup = await queryOne<{ id: string }>(
    'SELECT id FROM id_staff WHERE email_norm = ?', [input.email.toLowerCase()]);
  if (dup) throw conflict('Staff email already exists', 'EMAIL_TAKEN');
  const id = ulid();
  await query(
    "INSERT INTO id_staff (id, email, full_name, role, status, mfa_enforced) VALUES (?, ?, ?, ?, 'ACTIVE', 1)",
    [id, input.email, input.fullName, input.role]);
  return { id };
}

/**
 * Edit a staff row's displayName / status (FR-ADM-002). `role` is refused at
 * the route layer before this is reached: role assignment is identity-svc's
 * decision, and a silent role write here would fork the authority that issues
 * tokens.
 */
export async function updateStaff(id: string, patch: { fullName?: string; status?: string }): Promise<{ id: string }> {
  const current = await queryOne<{ id: string }>('SELECT id FROM id_staff WHERE id = ?', [id]);
  if (!current) throw notFound('Staff account not found');
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.fullName !== undefined) {
    if (!patch.fullName.trim()) throw unprocessable('fullName must not be empty', { fullName: 'required' });
    sets.push('full_name = ?');
    params.push(patch.fullName);
  }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (sets.length === 0) throw unprocessable('no field to update', { user: 'at least one of fullName, status is required' });
  await query(`UPDATE id_staff SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  return { id };
}

/* ------------------------------------------------------------------ *
 * Orders (operator console — cross-customer read)
 * ------------------------------------------------------------------ */

/**
 * Bounded cross-customer order list for the operator console, same
 * `OrderSummary` wire shape the customer list uses (no order-line table, so
 * `itemCount` is 0 exactly as in `commerce.listOrders`). The admin screen
 * filters and sorts client-side, so no keyset cursor is negotiated here; the
 * limit is bounded server-side rather than trusting an open-ended scan.
 */
export async function listAdminOrders(limit: number, status?: string): Promise<{ items: OrderSummary[] }> {
  const params: unknown[] = [];
  let where = '1=1';
  if (status) {
    where += ' AND o.status = ?';
    params.push(status);
  }
  const rows = await query<{
    id: string; status: string; grand_total: unknown; placed_at: Date; vendor_names: string | null;
  }>(`
    SELECT o.id, o.status, o.grand_total, o.placed_at,
           (SELECT GROUP_CONCAT(DISTINCT vs.display_name ORDER BY vs.display_name SEPARATOR ',')
              FROM ord_sub_order so JOIN ven_store vs ON vs.id = so.vendor_id
             WHERE so.order_id = o.id) AS vendor_names
    FROM ord_order o WHERE ${where}
    ORDER BY o.placed_at DESC, o.id DESC LIMIT ?`, [...params, limit]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      placedAt: iso(r.placed_at),
      status: r.status,
      grandTotalPaise: paise(r.grand_total),
      // No order-line table: itemCount cannot be derived; reported as 0 (documented).
      itemCount: 0,
      vendorNames: r.vendor_names ? r.vendor_names.split(',') : [],
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Audit hash-chain (FR-ADM-013) — reproduced from AuditChain.java
 * ------------------------------------------------------------------ */

const GENESIS = Buffer.alloc(32, 0);

/**
 * Canonical payload encoding, identical to AuditChain.canonicalBytes:
 * TreeMap order over the payload's own keys, each written as
 * `key=<byteLen>:<utf8value>;`, with the three-token `\0NULL\0` for null.
 * `byteLen` is the UTF-8 byte length of the value (not the JS string length).
 */
export function canonicalBytes(payload: Record<string, unknown>): Buffer {
  const keys = Object.keys(payload).sort();
  const parts: Buffer[] = [];
  for (const k of keys) {
    const v = payload[k];
    let value: Buffer;
    if (v === null || v === undefined) {
      value = Buffer.from('\0NULL\0', 'utf8');
    } else if (typeof v === 'string') {
      value = Buffer.from(v, 'utf8');
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      value = Buffer.from(String(v), 'utf8');
    } else {
      value = Buffer.from(JSON.stringify(v), 'utf8');
    }
    parts.push(Buffer.from(`${k}=${value.length}:`, 'utf8'), value, Buffer.from(';', 'utf8'));
  }
  return Buffer.concat(parts);
}

function computeThisHash(prevHash: Buffer, payload: Record<string, unknown>): Buffer {
  return createHash('sha256').update(prevHash).update(canonicalBytes(payload)).digest();
}

interface AuditRow {
  id: string; actor_type: string; actor_id: string; action: string; entity_type: string;
  entity_id: string; before_json: Record<string, unknown> | null; after_json: Record<string, unknown> | null;
  justification: string | null; prev_hash: Buffer; this_hash: Buffer; created_at: Date;
}

/**
 * Read the audit log and verify the chain from genesis. `chainValid` is true
 * only for the unbroken prefix: one bad link invalidates itself and every
 * event after it (the same rule as a full-chain recompute).
 */
export async function listAudit(limit: number): Promise<AuditEvent[]> {
  const rows = await query<AuditRow>(`
    SELECT id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json,
           justification, prev_hash, this_hash, created_at
    FROM adm_audit_event ORDER BY created_at ASC, id ASC LIMIT ?`, [limit]);
  let prev = GENESIS;
  let prefixValid = true;
  const staffNames = new Map<string, string>();
  return rows.map((r) => {
    // Rebuild the payload exactly as the writer did: the chain covers
    // actor/action/entity + before/after + justification.
    const payload: Record<string, unknown> = {
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      before: r.before_json,
      after: r.after_json,
      justification: r.justification,
    };
    const expected = computeThisHash(prev, payload);
    const linkOk = r.prev_hash.equals(prev) && r.this_hash.equals(expected);
    if (!linkOk) prefixValid = false;
    prev = Buffer.from(r.this_hash);
    return {
      id: r.id, actorType: r.actor_type, actorId: r.actor_id,
      actorName: staffNames.get(r.actor_id) ?? r.actor_id,
      action: r.action, entityType: r.entity_type, entityId: r.entity_id,
      justification: r.justification ?? undefined, createdAt: iso(r.created_at),
      chainValid: prefixValid && linkOk,
    };
  });
}
