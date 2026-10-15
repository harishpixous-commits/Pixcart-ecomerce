/**
 * Request-edge validation helpers.
 *
 * Every field failure becomes a 422 whose `fields` map is keyed by the wire
 * field name, so the form can highlight the offending input (Vol. 7 §7.2 /
 * §8.3). The rules below are the accept/reject decisions the domain modules
 * enforce; this module only turns a bad shape into a named refusal before any
 * SQL runs.
 */
import { badRequest, unprocessable } from '../http.js';
import type { Ctx } from '../db.js';
import type { AuthContext } from '../db.js';
import { requireAuth } from '../auth.js';

export function body<T = Record<string, unknown>>(ctx: Ctx): T {
  if (ctx.body === undefined || ctx.body === null) {
    throw badRequest('A JSON body is required', 'BODY_REQUIRED');
  }
  if (typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
    throw badRequest('Request body must be a JSON object', 'MALFORMED_BODY');
  }
  return ctx.body as T;
}

/** Collect field errors and throw once, so the client sees every bad field. */
export class Fields {
  private errors: Record<string, string> = {};
  req<T>(value: unknown, name: string, what: string): T {
    if (value === undefined || value === null || value === '') {
      this.errors[name] = `required (${what})`;
      return undefined as T;
    }
    return value as T;
  }
  fail(name: string, message: string): void {
    this.errors[name] = message;
  }
  done(): void {
    if (Object.keys(this.errors).length > 0) {
      throw unprocessable('Some fields need attention', this.errors);
    }
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function int(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return undefined;
}

/** An id we will put in a parameterised query: 26-char Crockford base32 ULID. */
export function ulidParam(v: unknown, name: string): string {
  const s = str(v);
  if (!s || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) {
    throw unprocessable('Some fields need attention', { [name]: 'must be a 26-character ULID' });
  }
  return s;
}

export function pincode(v: unknown, name = 'pincode'): string {
  const s = str(v);
  if (!s || !/^\d{6}$/.test(s)) {
    throw unprocessable('Some fields need attention', { [name]: 'must be a 6-digit PIN' });
  }
  return s;
}

/** Integer paise the client is asserting (capture amount, etc.). */
export function paiseField(v: unknown, name: string): number {
  const n = int(v);
  if (n === undefined || n < 0) {
    throw unprocessable('Some fields need attention', { [name]: 'must be a non-negative integer (paise)' });
  }
  return n;
}

/** Parse a query-string paise bound (a decimal string like "8000.50" is allowed). */
export function paiseInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw unprocessable('Some fields need attention', { [name]: 'must be a non-negative integer (paise)' });
  }
  return n;
}

export function oneOf<T extends string>(v: unknown, name: string, allowed: readonly T[]): T {
  const s = str(v);
  if (!s || !allowed.includes(s as T)) {
    throw unprocessable('Some fields need attention', { [name]: `must be one of: ${allowed.join(', ')}` });
  }
  return s as T;
}

/** Authenticated customer principal; only CUSTOMER may touch cart/account. */
export function customer(ctx: Ctx): AuthContext {
  const auth = requireAuth(ctx);
  if (auth.role !== 'CUSTOMER') {
    throw unprocessable('This surface is for customer accounts', { role: 'customer only' });
  }
  return auth;
}

export const SORTS = ['relevance', 'price_asc', 'price_desc', 'rating', 'newest'] as const;
export const PAYMENT_METHODS = ['PREPAID', 'COD'] as const;
export const RMA_REASONS = [
  'DAMAGED', 'WRONG_ITEM', 'MISSING_PARTS', 'NOT_AS_DESCRIBED',
  'SIZE_ISSUE', 'CHANGED_MIND', 'LATE_DELIVERY', 'QUALITY_ISSUE',
] as const;
export const SUB_ORDER_STATES = [
  'CONFIRMED', 'ACCEPTED', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'NDR', 'RTO_INITIATED', 'RTO_RECEIVED', 'RETURN_REQUESTED', 'RETURN_PICKED_UP',
  'QC', 'REFUNDED', 'RETURN_REJECTED', 'CANCELLED', 'CLOSED',
] as const;
export const CONSENT_PURPOSES = [
  'MARKETING_EMAIL', 'PERSONALISATION', 'VOICE', 'PROFILE_SYNC', 'SMS', 'WHATSAPP',
] as const;
export const ADDRESS_LABELS = ['HOME', 'WORK', 'OTHER'] as const;
