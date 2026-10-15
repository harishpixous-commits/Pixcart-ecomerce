/**
 * Account routes: profile, address book (FR-CUS-005), wallet (FR-CUS-019),
 * loyalty (FR-CUS-020), consent (BRU-12) and notifications (FR-CUS-022).
 *
 * All customer-only via `customer(ctx)`. Profile reads resolve the principal
 * to a customer/staff/vendor row (identity-svc owns the mapping).
 */
import { Router, unprocessable } from '../http.js';
import { requireAuth } from '../auth.js';
import type { Ctx } from '../db.js';
import * as account from '../repos/account.js';
import { limitOf } from '../repos/util.js';
import { body, customer, oneOf, str, ulidParam, ADDRESS_LABELS, CONSENT_PURPOSES } from './validate.js';

/** Register account routes onto `router`. */
export function register(router: Router): void {
  /** Who am I (FR-CUS-004). Any signed-in principal; the profile kind differs. */
  router.get('/api/v1/account', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    return account.getProfile(auth.subject);
  });

  /**
   * Edit the customer's display name and/or language (FR-CUS-001/004).
   * Customer-only: staff/vendor profiles are not editable through this path,
   * and identity-svc keeps ownership of email and every credential.
   */
  router.patch('/api/v1/account', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const b = body<{ displayName?: unknown; locale?: unknown }>(ctx);
    await account.updateProfile(auth.subject, str(b.displayName), str(b.locale));
    return account.getProfile(auth.subject);
  });

/* ------------------------------------------------------------------ *
 * Address book (FR-CUS-005)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/account/addresses', async (ctx: Ctx) => {
  const auth = customer(ctx);
  return { items: await account.listAddresses(auth.subject) };
});

  router.post('/api/v1/account/addresses', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const b = body<{
    label?: unknown; line1?: unknown; line2?: unknown; landmark?: unknown;
    city?: unknown; state?: unknown; pincode?: unknown; country?: unknown;
    mobile?: unknown; isDefault?: unknown;
  }>(ctx);
  const label = oneOf(b.label ?? 'HOME', 'label', ADDRESS_LABELS);
  const line1 = str(b.line1);
  if (!line1) throw unprocessable('line1 is required', { line1: 'required' });
  const city = str(b.city);
  if (!city) throw unprocessable('city is required', { city: 'required' });
  const stateName = str(b.state);
  if (!stateName) throw unprocessable('state is required', { state: 'required' });
  const pinRaw = str(b.pincode);
  if (!pinRaw || !/^\d{6}$/.test(pinRaw)) throw unprocessable('pincode must be 6 digits', { pincode: 'must be 6 digits' });
  const mobile = str(b.mobile);
  if (!mobile) throw unprocessable('mobile is required', { mobile: 'required' });

  return account.createAddress(auth.subject, {
    label, line1, line2: str(b.line2), landmark: str(b.landmark),
    city, state: stateName, pincode: pinRaw, country: str(b.country) ?? 'IN', mobile,
    isDefault: b.isDefault === true,
  });
});

  router.put('/api/v1/account/addresses/:id/default', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    await account.setDefaultAddress(auth.subject, id);
    return { items: await account.listAddresses(auth.subject) };
  });

  /** Edit an address (FR-CUS-005). Absent fields keep their value; `isDefault: true` promotes. */
  router.patch('/api/v1/account/addresses/:id', async (ctx: Ctx) => {
    const auth = customer(ctx);
    const id = ulidParam(ctx.params.id, 'id');
    const b = body<{
      label?: unknown; line1?: unknown; line2?: unknown; landmark?: unknown;
      city?: unknown; state?: unknown; pincode?: unknown; mobile?: unknown; isDefault?: unknown;
    }>(ctx);
    if (b.isDefault !== undefined && typeof b.isDefault !== 'boolean') {
      throw unprocessable('isDefault must be true or false', { isDefault: 'must be boolean' });
    }
    await account.updateAddress(auth.subject, id, {
      label: str(b.label), line1: str(b.line1), line2: str(b.line2), landmark: str(b.landmark),
      city: str(b.city), state: str(b.state), pincode: str(b.pincode), mobile: str(b.mobile),
      isDefault: b.isDefault === undefined ? undefined : b.isDefault,
    });
    return { items: await account.listAddresses(auth.subject) };
  });

  router.delete('/api/v1/account/addresses/:id', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const id = ulidParam(ctx.params.id, 'id');
  await account.deleteAddress(auth.subject, id);
  return { items: await account.listAddresses(auth.subject) };
});

/* ------------------------------------------------------------------ *
 * Wallet & loyalty (FR-CUS-019/020) — read-only here; movement is the
 * payment/refund service's job.
 * ------------------------------------------------------------------ */

  router.get('/api/v1/account/wallet', async (ctx: Ctx) => {
  const auth = customer(ctx);
  return account.getWallet(auth.subject);
});

  router.get('/api/v1/account/loyalty', async (ctx: Ctx) => {
  const auth = customer(ctx);
  return account.getLoyalty(auth.subject);
});

/* ------------------------------------------------------------------ *
 * Consent (BRU-12) — append-only ledger, latest row wins
 * ------------------------------------------------------------------ */

  router.get('/api/v1/account/consents', async (ctx: Ctx) => {
  const auth = customer(ctx);
  return { items: await account.getConsents(auth.subject) };
});

  router.post('/api/v1/account/consents', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const b = body<{ purpose?: unknown; granted?: unknown; policyVer?: unknown; channel?: unknown }>(ctx);
  const purpose = oneOf(b.purpose, 'purpose', CONSENT_PURPOSES);
  if (typeof b.granted !== 'boolean') throw unprocessable('granted must be true or false', { granted: 'must be boolean' });
  const policyVer = str(b.policyVer);
  if (!policyVer) throw unprocessable('policyVer is required', { policyVer: 'required' });
  const channel = str(b.channel) ?? 'WEB';
  await account.setConsent(auth.subject, purpose, b.granted, policyVer, channel);
  return { items: await account.getConsents(auth.subject) };
});

/* ------------------------------------------------------------------ *
 * Notifications (FR-CUS-022)
 * ------------------------------------------------------------------ */

  router.get('/api/v1/account/notifications', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const limit = limitOf(ctx.query.get('limit'), 20, 50);
  const unreadOnly = ctx.query.get('unread') === 'true';
  return { items: await account.listNotifications(auth.subject, limit, unreadOnly) };
});

  router.post('/api/v1/account/notifications/:id/read', async (ctx: Ctx) => {
  const auth = customer(ctx);
  const id = ulidParam(ctx.params.id, 'id');
  await account.markNotificationRead(auth.subject, id);
  return { ok: true };
});

  router.post('/api/v1/account/notifications/read-all', async (ctx: Ctx) => {
    const auth = customer(ctx);
    return account.markAllNotificationsRead(auth.subject);
  });
}
