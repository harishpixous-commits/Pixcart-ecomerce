/**
 * FR-CUS-022 notification policy as tests: transactional-cannot-opt-out, promotional
 * needs consent (BRU-12), quiet hours 22:00–08:00 local, SMS DLT requirement (FR-MKT-004),
 * legal STOP. Plus template-variable completeness (VALIDATION).
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  isTransactional,
  isWithinQuietHours,
  missingTemplateVariables,
  type NotificationRequest,
  type RecipientProfile,
} from '../src/domain/policy.js';

// 2026-08-15T15:00:00Z = 20:30 IST (outside quiet hours); +07:00 later crosses into night.
const UTC_1500 = Date.UTC(2026, 7, 15, 15, 0, 0);
const UTC_1900 = Date.UTC(2026, 7, 15, 19, 0, 0); // 00:30 IST → quiet

const IST = 330; // +5:30 in minutes

const profile = (over: Partial<RecipientProfile> = {}): RecipientProfile => ({
  recipientId: 'CUS-1',
  tzOffsetMinutes: IST,
  channelPreferences: [{ channel: 'SMS', enabled: true }, { channel: 'EMAIL', enabled: true }, { channel: 'WHATSAPP', enabled: true }],
  consents: [],
  ...over,
});

const req = (over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  notificationId: 'N1', recipientId: 'CUS-1', category: 'ORDER', channel: 'EMAIL',
  templateId: 'tmpl.order.confirmed', variables: {}, nowMs: UTC_1500, ...over,
});

describe('category classification', () => {
  it('order/payment/security/shipping/refund are transactional; promotional is not', () => {
    for (const c of ['ORDER', 'PAYMENT', 'SECURITY', 'SHIPPING', 'REFUND'] as const) {
      expect(isTransactional(c)).toBe(true);
    }
    expect(isTransactional('PROMOTIONAL')).toBe(false);
  });
});

describe('transactional messages cannot be opted out (only channel choice)', () => {
  it('sends a transactional order message with no consent on record', () => {
    expect(decide(req({ category: 'ORDER', channel: 'EMAIL' }), profile())).toEqual({ send: true });
  });

  it('sends transactional even during quiet hours (quiet hours are promo-only)', () => {
    expect(decide(req({ category: 'PAYMENT', channel: 'EMAIL', nowMs: UTC_1900 }), profile())).toEqual({ send: true });
  });

  it('still refuses a transactional message on a disabled channel (pick another)', () => {
    const p = profile({ channelPreferences: [{ channel: 'EMAIL', enabled: false }] });
    const d = decide(req({ category: 'ORDER', channel: 'EMAIL' }), p);
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('CHANNEL_DISABLED');
  });
});

describe('promotional messages require consent (BRU-12) and respect quiet hours', () => {
  it('refuses promotional without an active consent', () => {
    const d = decide(req({ category: 'PROMOTIONAL', channel: 'WHATSAPP' }), profile());
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('NO_CONSENT');
  });

  it('sends promotional with an active consent, outside quiet hours', () => {
    const p = profile({ consents: [{ category: 'PROMOTIONAL', channel: 'WHATSAPP', grantedAt: '2026-01-01T00:00:00Z' }] });
    expect(decide(req({ category: 'PROMOTIONAL', channel: 'WHATSAPP' }), p)).toEqual({ send: true });
  });

  it('a revoked consent is treated as no consent', () => {
    const p = profile({ consents: [{ category: 'PROMOTIONAL', channel: 'WHATSAPP', grantedAt: '2026-01-01T00:00:00Z', revokedAt: '2026-06-01T00:00:00Z' }] });
    const d = decide(req({ category: 'PROMOTIONAL', channel: 'WHATSAPP' }), p);
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('NO_CONSENT');
  });

  it('refuses consented promotional during quiet hours (00:30 IST)', () => {
    const p = profile({ consents: [{ category: 'PROMOTIONAL', channel: 'WHATSAPP', grantedAt: '2026-01-01T00:00:00Z' }] });
    const d = decide(req({ category: 'PROMOTIONAL', channel: 'WHATSAPP', nowMs: UTC_1900 }), p);
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('QUIET_HOURS');
  });
});

describe('quiet-hours boundary (22:00–08:00 local)', () => {
  it('is inclusive of 22:00 and exclusive of 08:00', () => {
    // 22:00 IST = 16:30 UTC ; 07:59 IST = 02:29 UTC ; 08:00 IST = 02:30 UTC
    const at2200IST = Date.UTC(2026, 7, 15, 16, 30, 0);
    const at0759IST = Date.UTC(2026, 7, 15, 2, 29, 0);
    const at0800IST = Date.UTC(2026, 7, 15, 2, 30, 0);
    expect(isWithinQuietHours(at2200IST, IST)).toBe(true);
    expect(isWithinQuietHours(at0759IST, IST)).toBe(true);
    expect(isWithinQuietHours(at0800IST, IST)).toBe(false);
  });
});

describe('SMS DLT + legal STOP (FR-MKT-004)', () => {
  it('refuses SMS without a DLT template id', () => {
    const d = decide(req({ channel: 'SMS', category: 'ORDER', dltTemplateId: undefined }), profile());
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('DLT_TEMPLATE_ID_REQUIRED');
  });

  it('sends transactional SMS when a DLT template id is present', () => {
    expect(decide(req({ channel: 'SMS', category: 'ORDER', dltTemplateId: 'DLT-1101' }), profile())).toEqual({ send: true });
  });

  it('a STOPPED channel is refused even for transactional (service falls back)', () => {
    const p = profile({ stopList: ['SMS'] });
    const d = decide(req({ channel: 'SMS', category: 'ORDER', dltTemplateId: 'DLT-1101' }), p);
    expect(d.send).toBe(false);
    if (!d.send) expect(d.reason).toContain('CHANNEL_STOPPED');
  });
});

describe('template variable completeness (VALIDATION)', () => {
  it('flags missing/empty declared variables', () => {
    const body = 'Hi {{name}}, order {{orderId}} is {{status}}.';
    expect(missingTemplateVariables(body, { name: 'Harish', orderId: 'ORD1', status: 'shipped' })).toEqual([]);
    expect(missingTemplateVariables(body, { name: 'Harish', orderId: '' })).toEqual(['orderId', 'status']);
  });
});
