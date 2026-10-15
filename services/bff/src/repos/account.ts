/**
 * Account data access: profile, address book (FR-CUS-005), wallet (FR-CUS-019),
 * loyalty (FR-CUS-020), consent ledger (BRU-12) and the notification inbox
 * (FR-CUS-022).
 *
 * Money is integer paise via util.ts. Wallet and loyalty are append-only
 * ledgers (V005): a balance is the SUM of its entries, never a mutable field.
 * Consent is append-only too (V001): current state = latest row per
 * (customer, purpose).
 */
import { query, queryOne, tx } from '../db.js';
import { notFound, unprocessable } from '../http.js';
import type { Address, LoyaltyView, NotificationItem, SessionUser, WalletView } from '../dto.js';
import { iso, isoOrNull, num, paise } from './util.js';
import { ulid } from '../seed/ulid.js';

/* ------------------------------------------------------------------ *
 * Profile (FR-CUS-001 / FR-CUS-004)
 * ------------------------------------------------------------------ */

/**
 * Resolve the session subject to a customer/staff/vendor profile row.
 * `subject` is the ULID identity-svc put in the bearer token; it may name an
 * id_customer, an id_staff, or a ven_store (vendor principal).
 */
export async function getProfile(subject: string): Promise<SessionUser> {
  const cust = await queryOne<{ id: string; full_name: string; email: string | null; mobile: string | null; lang: string }>(
    'SELECT id, full_name, email, mobile, lang FROM id_customer WHERE id = ? AND deleted_at IS NULL', [subject]);
  if (cust) {
    return { id: cust.id, displayName: cust.full_name, role: 'CUSTOMER', email: cust.email ?? undefined, mobile: cust.mobile ?? undefined, locale: cust.lang };
  }
  const staff = await queryOne<{ id: string; full_name: string; email: string; role: string }>(
    'SELECT id, full_name, email, role FROM id_staff WHERE id = ?', [subject]);
  if (staff) {
    return { id: staff.id, displayName: staff.full_name, role: staff.role as SessionUser['role'], email: staff.email, locale: 'en' };
  }
  const vendor = await queryOne<{ id: string; display_name: string; email: string; mobile: string }>(
    'SELECT id, display_name, email, mobile FROM ven_store WHERE id = ?', [subject]);
  if (vendor) {
    return { id: vendor.id, displayName: vendor.display_name, role: 'VENDOR', email: vendor.email, mobile: vendor.mobile, locale: 'en' };
  }
  throw notFound('No profile for this subject');
}

/**
 * Edit the customer's display name and/or UI language (FR-CUS-001/004).
 *
 * Only these two profile fields: identity-svc owns every credential and the
 * email (login identity), and a silent email write here would fork the
 * authority that issues tokens. A subject with no id_customer row is refused
 * by name — staff and vendor profiles are not editable through this path.
 */
export async function updateProfile(customerId: string, displayName?: string, locale?: string): Promise<void> {
  if (displayName === undefined && locale === undefined) {
    throw unprocessable('no field to update', { account: 'at least one of displayName, locale is required' });
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (displayName !== undefined) {
    if (!displayName.trim()) throw unprocessable('displayName must not be empty', { displayName: 'required' });
    sets.push('full_name = ?');
    params.push(displayName);
  }
  if (locale !== undefined) {
    if (!/^[a-z]{2}(-[A-Za-z0-9]{2,8})$/.test(locale) && !/^[a-z]{2}$/.test(locale)) {
      throw unprocessable('locale must be a language tag like en or hi', { locale: 'invalid language tag' });
    }
    sets.push('lang = ?');
    params.push(locale);
  }
  const res = await query<{ affectedRows: number }>(
    `UPDATE id_customer SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, customerId]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    // The driver reports 0 when every value already equalled its target, so a
    // no-op edit of an existing row must not masquerade as a missing subject.
    const exists = await queryOne<{ id: string }>(
      'SELECT id FROM id_customer WHERE id = ? AND deleted_at IS NULL', [customerId]);
    if (!exists) throw notFound('No profile for this subject');
  }
}

/* ------------------------------------------------------------------ *
 * Address book (FR-CUS-005)
 * ------------------------------------------------------------------ */

interface AddressRow {
  id: string; label: string; line1: string; line2: string | null; landmark: string | null;
  city: string; state: string; pincode: string; country: string; mobile: string; is_default: number;
}

function toAddress(r: AddressRow): Address {
  return {
    id: r.id, label: r.label as Address['label'], line1: r.line1, line2: r.line2 ?? undefined,
    landmark: r.landmark ?? undefined, city: r.city, state: r.state, pincode: r.pincode,
    country: r.country, mobile: r.mobile, isDefault: num(r.is_default) === 1,
  };
}

export async function listAddresses(customerId: string): Promise<Address[]> {
  const rows = await query<AddressRow>(
    'SELECT id, label, line1, line2, landmark, city, state, pincode, country, mobile, is_default FROM id_address WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC',
    [customerId]);
  return rows.map(toAddress);
}

export async function createAddress(customerId: string, input: Omit<Address, 'id' | 'isDefault'> & { isDefault?: boolean }): Promise<Address> {
  if (!/^\d{6}$/.test(input.pincode)) throw unprocessable('pincode must be 6 digits', { pincode: 'must be 6 digits' });
  if (!['HOME', 'WORK', 'OTHER'].includes(input.label)) throw unprocessable('label must be HOME, WORK or OTHER', { label: 'invalid label' });
  const id = ulid();
  const makeDefault = input.isDefault === true;
  await tx(async (conn) => {
    if (makeDefault) {
      await conn.query('UPDATE id_address SET is_default = 0 WHERE customer_id = ? AND is_default = 1', [customerId]);
    }
    await conn.query(
      `INSERT INTO id_address (id, customer_id, label, line1, line2, landmark, city, state, pincode, country, mobile, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, customerId, input.label, input.line1, input.line2 ?? null, input.landmark ?? null,
        input.city, input.state, input.pincode, input.country, input.mobile, makeDefault ? 1 : 0]);
  });
  return { ...input, id, isDefault: makeDefault };
}

export async function setDefaultAddress(customerId: string, addressId: string): Promise<void> {
  await tx(async (conn) => {
    const owned = await conn.query('SELECT id FROM id_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
    if ((owned as unknown[]).length === 0) throw notFound('Address not found');
    await conn.query('UPDATE id_address SET is_default = 0 WHERE customer_id = ? AND is_default = 1', [customerId]);
    await conn.query('UPDATE id_address SET is_default = 1 WHERE id = ? AND customer_id = ?', [addressId, customerId]);
  });
}

/**
 * Edit an address (FR-CUS-005). Fields absent from the body keep their value;
 * present fields go through the same validation as create (pincode shape,
 * label vocabulary). `isDefault: true` runs the same clear-others-then-set
 * transaction as `setDefaultAddress`; `isDefault: false` is refused by name —
 * demoting the default with no promotion target would leave the book with none,
 * and the dedicated default endpoint is the honest way to move the flag.
 */
export async function updateAddress(customerId: string, addressId: string, patch: {
  label?: string; line1?: string; line2?: string; landmark?: string;
  city?: string; state?: string; pincode?: string; mobile?: string; isDefault?: boolean;
}): Promise<void> {
  if (patch.pincode !== undefined && !/^\d{6}$/.test(patch.pincode)) {
    throw unprocessable('pincode must be 6 digits', { pincode: 'must be 6 digits' });
  }
  if (patch.label !== undefined && !['HOME', 'WORK', 'OTHER'].includes(patch.label)) {
    throw unprocessable('label must be HOME, WORK or OTHER', { label: 'invalid label' });
  }
  if (patch.isDefault === false) {
    throw unprocessable('isDefault:false is not supported; promote another address to default instead', { isDefault: 'use PUT /account/addresses/:id/default to move the flag' });
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const put = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    params.push(value);
  };
  put('label', patch.label);
  put('line1', patch.line1);
  put('line2', patch.line2);
  put('landmark', patch.landmark);
  put('city', patch.city);
  put('state', patch.state);
  put('pincode', patch.pincode);
  put('mobile', patch.mobile);
  if (sets.length === 0 && patch.isDefault !== true) {
    throw unprocessable('no field to update', { address: 'at least one field is required' });
  }
  await tx(async (conn) => {
    const owned = await conn.query('SELECT id FROM id_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
    if ((owned as unknown[]).length === 0) throw notFound('Address not found');
    if (sets.length > 0) {
      await conn.query(`UPDATE id_address SET ${sets.join(', ')} WHERE id = ? AND customer_id = ?`, [...params, addressId, customerId]);
    }
    if (patch.isDefault === true) {
      await conn.query('UPDATE id_address SET is_default = 0 WHERE customer_id = ? AND is_default = 1', [customerId]);
      await conn.query('UPDATE id_address SET is_default = 1 WHERE id = ? AND customer_id = ?', [addressId, customerId]);
    }
  });
}

export async function deleteAddress(customerId: string, addressId: string): Promise<void> {
  const res = await query<{ affectedRows: number }>(
    'DELETE FROM id_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) throw notFound('Address not found');
}

/* ------------------------------------------------------------------ *
 * Wallet (FR-CUS-019) — balance is SUM(entries); CASH never expires,
 * PROMO expires 90 days. This module only READS the ledger; debits are
 * the payment/refund service's job.
 * ------------------------------------------------------------------ */

export async function getWallet(customerId: string): Promise<WalletView> {
  const bal = await queryOne<{ cash_paise: unknown; promo_paise: unknown }>(
    'SELECT cash_paise, promo_paise FROM wal_balance WHERE customer_id = ?', [customerId]);
  const entries = await query<{ id: string; bucket: string; amount_paise: unknown; reason: string; created_at: Date }>(
    'SELECT id, bucket, amount_paise, reason, created_at FROM wal_entry WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50',
    [customerId]);
  return {
    cashPaise: bal ? paise(bal.cash_paise) : 0,
    promoPaise: bal ? paise(bal.promo_paise) : 0,
    entries: entries.map((e) => ({
      id: e.id, bucket: e.bucket as 'CASH' | 'PROMO', amountPaise: paise(e.amount_paise),
      reason: e.reason, at: iso(e.created_at),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Loyalty (FR-CUS-020)
 * ------------------------------------------------------------------ */

export async function getLoyalty(customerId: string): Promise<LoyaltyView> {
  const bal = await queryOne<{ points: number; tier: string }>(
    'SELECT points, tier FROM loy_balance WHERE customer_id = ?', [customerId]);
  const entries = await query<{ id: string; points: number; reason: string; created_at: Date }>(
    'SELECT id, points, reason, created_at FROM loy_entry WHERE customer_id = ? ORDER BY created_at DESC LIMIT 50',
    [customerId]);
  return {
    points: bal ? num(bal.points) : 0,
    tier: (bal?.tier ?? 'SILVER') as LoyaltyView['tier'],
    entries: entries.map((e) => ({ id: e.id, points: num(e.points), reason: e.reason, at: iso(e.created_at) })),
  };
}

/* ------------------------------------------------------------------ *
 * Consent ledger (BRU-12) — append-only; latest row wins.
 * ------------------------------------------------------------------ */

const CONSENT_PURPOSES = new Set(['MARKETING_EMAIL', 'PERSONALISATION', 'VOICE', 'PROFILE_SYNC', 'SMS', 'WHATSAPP']);

export async function getConsents(customerId: string): Promise<{ purpose: string; granted: boolean; policyVer: string; at: string }[]> {
  const rows = await query<{ purpose: string; granted: number; policy_ver: string; created_at: Date }>(`
    SELECT c.purpose, c.granted, c.policy_ver, c.created_at
    FROM id_consent c
    JOIN (SELECT purpose, MAX(created_at) AS mx FROM id_consent WHERE customer_id = ? GROUP BY purpose) t
      ON t.purpose = c.purpose AND t.mx = c.created_at
    WHERE c.customer_id = ?`, [customerId, customerId]);
  return rows.map((r) => ({ purpose: r.purpose, granted: num(r.granted) === 1, policyVer: r.policy_ver, at: iso(r.created_at) }));
}

export async function setConsent(customerId: string, purpose: string, granted: boolean, policyVer: string, channel: string): Promise<void> {
  if (!CONSENT_PURPOSES.has(purpose)) {
    throw unprocessable('Unknown consent purpose', { purpose: `must be one of ${[...CONSENT_PURPOSES].join(', ')}` });
  }
  await query(
    'INSERT INTO id_consent (id, customer_id, purpose, granted, policy_ver, channel) VALUES (?, ?, ?, ?, ?, ?)',
    [ulid(), customerId, purpose, granted ? 1 : 0, policyVer, channel]);
}

/* ------------------------------------------------------------------ *
 * Notifications (FR-CUS-022) — inbox with read state
 * ------------------------------------------------------------------ */

export async function listNotifications(customerId: string, limit: number, unreadOnly: boolean): Promise<NotificationItem[]> {
  const rows = await query<{
    id: string; category: string; title: string; body: string; link_url: string | null;
    severity: string; read_at: Date | null; created_at: Date;
  }>(`
    SELECT id, category, title, body, link_url, severity, read_at, created_at
    FROM notif_message WHERE customer_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}
    ORDER BY created_at DESC LIMIT ?`, [customerId, limit]);
  return rows.map((r) => ({
    id: r.id, category: r.category as NotificationItem['category'], title: r.title, body: r.body,
    linkUrl: r.link_url ?? undefined, severity: r.severity as NotificationItem['severity'],
    readAt: isoOrNull(r.read_at), createdAt: iso(r.created_at),
  }));
}

export async function markNotificationRead(customerId: string, id: string): Promise<void> {
  const res = await query<{ affectedRows: number }>(
    'UPDATE notif_message SET read_at = NOW(3) WHERE id = ? AND customer_id = ? AND read_at IS NULL',
    [id, customerId]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  if (affected === 0) {
    const exists = await queryOne<{ id: string }>('SELECT id FROM notif_message WHERE id = ? AND customer_id = ?', [id, customerId]);
    if (!exists) throw notFound('Notification not found');
    // already read: idempotent no-op, not an error
  }
}

export async function markAllNotificationsRead(customerId: string): Promise<{ marked: number }> {
  const res = await query<{ affectedRows: number }>(
    'UPDATE notif_message SET read_at = NOW(3) WHERE customer_id = ? AND read_at IS NULL', [customerId]);
  const affected = Array.isArray(res) ? 0 : (res as unknown as { affectedRows?: number }).affectedRows ?? 0;
  return { marked: affected };
}
