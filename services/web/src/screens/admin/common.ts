/**
 * Shared helpers for the admin console screens.
 *
 * Everything here mirrors a real wire shape or a real server vocabulary — the
 * status lists come from contracts/dto.ts (the canonical wire contract, mirrored
 * by services/bff/src/dto.ts) and the route evidence in
 * services/bff/src/routes/admin.ts + services/bff/src/repos/admin.ts.
 * Nothing is invented; where the BFF does not implement a route the screen says
 * so in its error state rather than rendering fake data.
 */
import { ApiProblem } from '../../lib/api';
import type { BadgeTone } from '../../design';

/** Every BFF list route answers `{ items: [...] }` (services/bff/src/routes/*.ts). */
export interface ItemsResponse<T> {
  items: T[];
}

/** 'OUT_FOR_DELIVERY' → 'Out For Delivery'. Display only; the wire value is never mutated. */
export function humanise(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Field map from a 422 problem (E-VAL-001), or undefined for any other failure.
 * The caller decides whether the message lands on a field or a form-level alert.
 */
export function problemFields(error: unknown): Record<string, string> | undefined {
  return error instanceof ApiProblem && error.status === 422 ? error.fields : undefined;
}

/* ------------------------------------------------------------------ *
 * Status vocabularies (contracts/dto.ts) — tone maps so status is never
 * colour-only: the design-system Badge renders a glyph with every tone.
 * ------------------------------------------------------------------ */

/** CouponRow.status — contracts/dto.ts. */
const COUPON_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  PAUSED: 'warning',
  EXHAUSTED: 'warning',
  EXPIRED: 'neutral',
};

export function couponStatusTone(status: string): BadgeTone {
  return COUPON_STATUS_TONE[status] ?? 'neutral';
}

/** CmsRow.status — contracts/dto.ts. */
const CMS_STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'progress',
  PUBLISHED: 'success',
  UNPUBLISHED: 'warning',
};

export function cmsStatusTone(status: string): BadgeTone {
  return CMS_STATUS_TONE[status] ?? 'neutral';
}

/** StaffUser.status — contracts/dto.ts ('ACTIVE' | 'SUSPENDED' | 'DELETED'). */
const STAFF_STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  DELETED: 'danger',
};

export function staffStatusTone(status: string): BadgeTone {
  return STAFF_STATUS_TONE[status] ?? 'neutral';
}

/** Role badges — the role is the wire value; the tone never replaces the text. */
const ROLE_TONE: Record<string, BadgeTone> = {
  SUPER_ADMIN: 'info',
  ADMIN: 'info',
  FINANCE: 'progress',
  MARKETING: 'progress',
  WAREHOUSE: 'neutral',
  DELIVERY: 'neutral',
  SUPPORT: 'neutral',
  CUSTOMER: 'neutral',
  VENDOR: 'neutral',
};

export function roleTone(role: string): BadgeTone {
  return ROLE_TONE[role] ?? 'neutral';
}

/** ApprovalCase.state — contracts/dto.ts plus the PENDING value the queue emits. */
const APPROVAL_STATE_TONE: Record<string, BadgeTone> = {
  OPEN: 'progress',
  PENDING: 'progress',
  ESCALATED: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

export function approvalStateTone(state: string): BadgeTone {
  return APPROVAL_STATE_TONE[state] ?? 'neutral';
}

/* ------------------------------------------------------------------ *
 * Numeric input parsing — money in as rupees, out as integer paise;
 * rates in as percent, out as integer basis points. Nothing but display
 * ever sees a float, and display divides exactly once (lib/format.ts).
 * ------------------------------------------------------------------ */

/**
 * Rupees → integer paise. Returns null when the text is not a valid amount
 * (the form then shows a field error; nothing is silently coerced).
 */
export function toPaise(input: string): number | null {
  const t = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/**
 * Percent → integer basis points (10% → 1000). Returns null when invalid.
 * The BFF accepts 1..10000 bps for PERCENT coupons (repos/admin.ts).
 */
export function toBps(input: string): number | null {
  const t = input.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Parse a `datetime-local` value to epoch ms, or null when empty/invalid. */
export function toEpochMs(input: string): number | null {
  if (!input.trim()) return null;
  const ms = new Date(input).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Epoch ms → `datetime-local` input value (local time, minute precision).
 * Used only to prefill edit forms; the wire value is never mutated.
 */
export function toDateTimeLocal(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
