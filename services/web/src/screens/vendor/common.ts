/**
 * Shared helpers for the vendor portal screens.
 *
 * Every constant here mirrors a real wire shape or a real DB vocabulary — the
 * store status / KYC lists come from V006's ck_store_status / ck_store_kyc, and
 * `{ items: [...] }` is what every BFF vendor list route returns
 * (services/bff/src/routes/vendor.ts). Nothing is invented.
 */
import { ApiProblem } from '../../lib/api';
import type { BadgeTone } from '../../design';

/** Every BFF list route answers `{ items: [...] }` (services/bff/src/routes/vendor.ts). */
export interface ItemsResponse<T> {
  items: T[];
}

/** ven_store.status — V006 ck_store_status. Unknown values still render, as neutral. */
const STORE_STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: 'progress',
  APPROVED: 'success',
  REJECTED: 'danger',
  SUSPENDED: 'danger',
  PAUSED: 'warning',
};

export function storeStatusTone(status: string): BadgeTone {
  return STORE_STATUS_TONE[status] ?? 'neutral';
}

/** ven_store.kyc_state — V006 ck_store_kyc. */
const KYC_TONE: Record<string, BadgeTone> = {
  NOT_STARTED: 'neutral',
  DOCUMENTS_SUBMITTED: 'progress',
  UNDER_REVIEW: 'progress',
  VERIFIED: 'success',
  REJECTED: 'danger',
};

export function kycTone(kycState: string): BadgeTone {
  return KYC_TONE[kycState] ?? 'neutral';
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
