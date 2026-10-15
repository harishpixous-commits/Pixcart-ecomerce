/**
 * Admin / operator console routes (FR-ADM-*).
 *
 * RBAC by area (per the platform matrix, transported from identity-svc):
 *   overview / approvals / categories / users   -> ADMIN, SUPER_ADMIN
 *   coupons / CMS / finance                     -> + MARKETING (coupons/CMS), FINANCE (finance)
 *   audit log                                   -> ADMIN, SUPER_ADMIN
 * Every decision writes through the repo, which records the staff subject in
 * the audit chain (FR-ADM-013).
 */
import { Router, unprocessable } from '../http.js';
import type { Ctx } from '../db.js';
import { requireRole } from '../auth.js';
import * as admin from '../repos/admin.js';
import * as catalogue from '../repos/catalogue.js';
import { limitOf } from '../repos/util.js';
import { body, int, oneOf, str, ulidParam } from './validate.js';

async function staffId(ctx: Ctx, ...roles: string[]): Promise<string> {
  const auth = await requireRole(ctx, ...roles);
  return auth.subject;
}

/** Register admin / operator console routes onto `router`. */
export function register(router: Router): void {

  router.get('/api/v1/admin/overview', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  return admin.getOverview();
});

/* ------------------------------------------------------------------ *
 * Approval queue (FR-ADM-004)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/approvals', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  return { items: await admin.listApprovals() };
});

  router.post('/api/v1/admin/approvals/:id/decide', async (ctx: Ctx) => {
  const me = await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const id = str(ctx.params.id);
  if (!id) throw unprocessable('case id is required', { id: 'required' });
  const b = body<{ decision?: unknown }>(ctx);
  const decision = oneOf(b.decision, 'decision', ['APPROVED', 'REJECTED'] as const);
  await admin.decideApproval(id, decision, me);
  return { id, decision };
});

/* ------------------------------------------------------------------ *
 * Categories (FR-ADM-003)
 * ------------------------------------------------------------------ */

  /** Full tree including RETIRED rows — the operator console edits those too. */
  router.get('/api/v1/admin/categories', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  return { items: await catalogue.categoryTreeAll() };
});

  router.post('/api/v1/admin/categories', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const b = body<{ name?: unknown; slug?: unknown; parentId?: unknown; attributeSchema?: unknown }>(ctx);
  const name = str(b.name);
  if (!name) throw unprocessable('name is required', { name: 'required' });
  const slug = str(b.slug);
  if (!slug) throw unprocessable('slug is required', { slug: 'required' });
  const parentId = b.parentId === undefined || b.parentId === null ? undefined : ulidParam(b.parentId, 'parentId');
  const schema = (b.attributeSchema ?? {}) as Record<string, unknown>;
  return admin.createCategory({ name, slug, parentId, attributeSchema: schema });
});

  /** Edit name / slug / parent (FR-ADM-003). Absent fields keep their value; null parentId moves to root. */
  router.patch('/api/v1/admin/categories/:id', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const id = ulidParam(ctx.params.id, 'id');
  const b = body<{ name?: unknown; slug?: unknown; parentId?: unknown }>(ctx);
  const parentId = b.parentId === undefined
    ? undefined
    : b.parentId === null
      ? null
      : ulidParam(b.parentId, 'parentId');
  return admin.updateCategory(id, { name: str(b.name), slug: str(b.slug), parentId });
});

  router.post('/api/v1/admin/categories/:id/retire', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const id = ulidParam(ctx.params.id, 'id');
  await admin.retireCategory(id);
  return { id, status: 'RETIRED' };
});

/* ------------------------------------------------------------------ *
 * Orders (operator console — cross-customer read)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/orders', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const limit = limitOf(ctx.query.get('limit'), 50, 200);
  const status = ctx.query.get('status') ?? undefined;
  return admin.listAdminOrders(limit, status || undefined);
});

/* ------------------------------------------------------------------ *
 * Coupons (FR-MKT-001) — MARKETING may operate here too
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/coupons', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  return { items: await admin.listCoupons() };
});

  router.post('/api/v1/admin/coupons', async (ctx: Ctx) => {
  const me = await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  const b = body<{
    code?: unknown; description?: unknown; kind?: unknown; valueBps?: unknown;
    valuePaise?: unknown; maxRedemptions?: unknown; minCartPaise?: unknown;
    startsAtMs?: unknown; endsAtMs?: unknown;
  }>(ctx);
  const code = str(b.code);
  if (!code) throw unprocessable('code is required', { code: 'required' });
  const description = str(b.description);
  if (!description) throw unprocessable('description is required', { description: 'required' });
  const kind = oneOf(b.kind, 'kind', ['PERCENT', 'FLAT'] as const);
  const maxRedemptions = int(b.maxRedemptions);
  if (maxRedemptions === undefined || maxRedemptions < 1) throw unprocessable('maxRedemptions must be >= 1', { maxRedemptions: 'must be >= 1' });
  const startsAtMs = int(b.startsAtMs);
  const endsAtMs = int(b.endsAtMs);
  if (startsAtMs === undefined || endsAtMs === undefined) throw unprocessable('startsAtMs and endsAtMs are required', { startsAtMs: 'required' });
  return admin.createCoupon({
    code, description, kind, valueBps: int(b.valueBps), valuePaise: int(b.valuePaise),
    maxRedemptions, minCartPaise: int(b.minCartPaise), startsAtMs, endsAtMs, createdBy: me,
  });
});

  /** Edit a coupon (FR-ADM-006). Absent fields keep their value. */
  router.patch('/api/v1/admin/coupons/:id', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  const id = ulidParam(ctx.params.id, 'id');
  const b = body<{
    description?: unknown; kind?: unknown; status?: unknown; valueBps?: unknown;
    valuePaise?: unknown; maxRedemptions?: unknown; minCartPaise?: unknown;
    startsAtMs?: unknown; endsAtMs?: unknown;
  }>(ctx);
  const kind = b.kind === undefined ? undefined : oneOf(b.kind, 'kind', ['PERCENT', 'FLAT'] as const);
  const status = b.status === undefined ? undefined : oneOf(b.status, 'status', ['DRAFT', 'ACTIVE', 'PAUSED'] as const);
  return admin.updateCoupon(id, {
    description: str(b.description), kind, status,
    valueBps: b.valueBps === undefined ? undefined : int(b.valueBps),
    valuePaise: b.valuePaise === undefined ? undefined : int(b.valuePaise),
    maxRedemptions: b.maxRedemptions === undefined ? undefined : int(b.maxRedemptions),
    minCartPaise: b.minCartPaise === undefined ? undefined : int(b.minCartPaise),
    startsAtMs: b.startsAtMs === undefined ? undefined : int(b.startsAtMs),
    endsAtMs: b.endsAtMs === undefined ? undefined : int(b.endsAtMs),
  });
});

/* ------------------------------------------------------------------ *
 * CMS (FR-ADM-007)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/cms', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  return { items: await admin.listCms() };
});

  router.post('/api/v1/admin/cms', async (ctx: Ctx) => {
  const me = await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  const b = body<{
    kind?: unknown; slug?: unknown; title?: unknown; body?: unknown;
    mediaUrl?: unknown; linkUrl?: unknown; locale?: unknown; publishAtMs?: unknown;
  }>(ctx);
  const kind = oneOf(b.kind, 'kind', ['PAGE', 'BANNER', 'BLOCK'] as const);
  const slug = str(b.slug);
  if (!slug) throw unprocessable('slug is required', { slug: 'required' });
  const title = str(b.title);
  if (!title) throw unprocessable('title is required', { title: 'required' });
  const locale = str(b.locale) ?? 'en';
  return admin.createCms({
    kind, slug, title, body: str(b.body), mediaUrl: str(b.mediaUrl), linkUrl: str(b.linkUrl),
    locale, publishAtMs: int(b.publishAtMs), createdBy: me,
  });
});

  router.post('/api/v1/admin/cms/:id/publish', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  const id = ulidParam(ctx.params.id, 'id');
  await admin.publishCms(id);
  return { id, status: 'PUBLISHED' };
});

  /** Edit a CMS entry (FR-ADM-007). Absent fields keep their value. */
  router.patch('/api/v1/admin/cms/:id', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'MARKETING');
  const id = ulidParam(ctx.params.id, 'id');
  const b = body<{
    kind?: unknown; slug?: unknown; title?: unknown; body?: unknown;
    locale?: unknown; publishAtMs?: unknown;
  }>(ctx);
  return admin.updateCms(id, {
    kind: b.kind === undefined ? undefined : oneOf(b.kind, 'kind', ['PAGE', 'BANNER', 'BLOCK'] as const),
    slug: str(b.slug), title: str(b.title), body: str(b.body), locale: str(b.locale),
    publishAtMs: b.publishAtMs === undefined ? undefined : int(b.publishAtMs),
  });
});

/* ------------------------------------------------------------------ *
 * Finance (FR-FIN-*) — FINANCE role
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/finance/overview', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN', 'FINANCE');
  return admin.getFinanceOverview();
});

/* ------------------------------------------------------------------ *
 * Staff directory (FR-ADM-002)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/users', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  return { items: await admin.listStaff() };
});

  /** Create a staff account (FR-ADM-002). Identity-svc still issues its credentials. */
  router.post('/api/v1/admin/users', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const b = body<{ fullName?: unknown; email?: unknown; role?: unknown }>(ctx);
  const fullName = str(b.fullName);
  if (!fullName) throw unprocessable('fullName is required', { fullName: 'required' });
  const email = str(b.email);
  if (!email) throw unprocessable('email is required', { email: 'required' });
  const role = oneOf(b.role, 'role', ['ADMIN', 'SUPER_ADMIN', 'FINANCE', 'MARKETING', 'WAREHOUSE', 'DELIVERY', 'SUPPORT'] as const);
  return admin.createStaff({ fullName, email, role });
});

  /** Edit a staff row (FR-ADM-002). Role changes are refused by name — identity-svc owns roles. */
  router.patch('/api/v1/admin/users/:id', async (ctx: Ctx) => {
  await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
  const id = ulidParam(ctx.params.id, 'id');
  const b = body<{ fullName?: unknown; status?: unknown; role?: unknown }>(ctx);
  if (b.role !== undefined) {
    throw unprocessable('role cannot be changed here; use the identity service', { role: 'refused' });
  }
  const status = b.status === undefined ? undefined : oneOf(b.status, 'status', ['ACTIVE', 'SUSPENDED'] as const);
  return admin.updateStaff(id, { fullName: str(b.fullName), status });
});

/* ------------------------------------------------------------------ *
 * Audit log (FR-ADM-013) — hash-chain verified
 * ------------------------------------------------------------------ */

  router.get('/api/v1/admin/audit', async (ctx: Ctx) => {
    await staffId(ctx, 'ADMIN', 'SUPER_ADMIN');
    const limit = limitOf(ctx.query.get('limit'), 50, 200);
    return { items: await admin.listAudit(limit) };
  });
}
