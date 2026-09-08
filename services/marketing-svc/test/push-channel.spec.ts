/**
 * FR-MKT-005 push notification channel.
 *
 * The delegation to the FR-CUS-022 policy engine is tested against the REAL engine rather than a
 * stub, because the whole point of delegating is that there is exactly one implementation of
 * consent and quiet hours. A stub here would prove only that this module can call a function.
 */
import { describe, expect, it } from 'vitest';
import {
  adaptForDevice,
  capabilitiesFor,
  collapseDecision,
  compareVersions,
  DEFAULT_ROUTES,
  deviceInQuietHours,
  isCdnHosted,
  isRegisteredRoute,
  MAX_IMAGE_BYTES,
  MAX_PAYLOAD_BYTES,
  orderStatusCollapseKey,
  payloadBytes,
  piiInPayload,
  quietHoursEndMs,
  RETRY_MAX_ATTEMPTS,
  retryDelayMs,
  sendToDevice,
  TOKEN_PRUNE_WINDOW_MS,
  TokenRegistry,
  validatePayload,
  type DeviceToken,
  type PushPayload,
  type PushSendContext,
} from '../src/domain/push/channel.js';
import type { RecipientProfile } from '../../notification-svc/src/domain/policy.js';

const CDN_HOSTS = new Set(['cdn.pixcart.pixoustech.com']);
const IST = 330;

/** 14:00 IST on 20 Aug 2026 — comfortably outside quiet hours. */
const DAYTIME = Date.UTC(2026, 7, 20, 8, 30);
/** 02:00 IST on 21 Aug 2026 — inside quiet hours. */
const NIGHT = Date.UTC(2026, 7, 20, 20, 30);

const device = (over: Partial<DeviceToken> = {}): DeviceToken => ({
  token: 'TOK-1',
  customerId: 'CUS-1',
  platform: 'FCM',
  tzOffsetMinutes: IST,
  appVersion: '3.6.0',
  registeredAtMs: DAYTIME - 86_400_000,
  lastSeenAtMs: DAYTIME,
  state: 'ACTIVE',
  ...over,
});

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
  messageId: 'MSG-1',
  category: 'ORDER',
  title: 'Your order has shipped',
  body: 'Tap to track your parcel',
  deepLink: 'pixcart://order/ORD-1001/track',
  detailRef: 'order:ORD-1001',
  ...over,
});

/** A profile with promotional push consent granted and nothing stopped. */
const profile = (over: Partial<RecipientProfile> = {}): RecipientProfile => ({
  recipientId: 'CUS-1',
  tzOffsetMinutes: IST,
  channelPreferences: [{ channel: 'PUSH', enabled: true }],
  consents: [{ category: 'PROMOTIONAL', channel: 'PUSH', grantedAt: '2026-01-01T00:00:00Z' }],
  ...over,
});

const ctx = (over: Partial<PushSendContext> = {}): PushSendContext => ({
  routes: DEFAULT_ROUTES,
  cdnHosts: CDN_HOSTS,
  profile: profile(),
  templateId: 'TPL-ORDER-SHIPPED',
  nowMs: DAYTIME,
  ...over,
});

// ============================================ deep links

describe('deep links must resolve against the route registry (VALIDATION)', () => {
  it('accepts a registered route with a substituted parameter', () => {
    expect(isRegisteredRoute('pixcart://order/ORD-1001/track', DEFAULT_ROUTES)).toBe(true);
    expect(isRegisteredRoute('pixcart://product/LST-77', DEFAULT_ROUTES)).toBe(true);
    expect(isRegisteredRoute('pixcart://cart', DEFAULT_ROUTES)).toBe(true);
  });

  it('refuses an unregistered route rather than sending hopefully', () => {
    // a push whose link lands nowhere is worse than no push: the customer is interrupted and failed
    expect(isRegisteredRoute('pixcart://secret-admin-panel', DEFAULT_ROUTES)).toBe(false);
    expect(isRegisteredRoute('https://evil.example.com/phish', DEFAULT_ROUTES)).toBe(false);
    expect(isRegisteredRoute('pixcart://order', DEFAULT_ROUTES)).toBe(false);
    expect(isRegisteredRoute('pixcart://order/ORD-1/track/extra', DEFAULT_ROUTES)).toBe(false);
  });

  it('a parameter cannot smuggle path segments', () => {
    expect(isRegisteredRoute('pixcart://product/../../admin', DEFAULT_ROUTES)).toBe(false);
    expect(isRegisteredRoute('pixcart://product/a/b', DEFAULT_ROUTES)).toBe(false);
  });

  it('an unregistered main link is rejected at validation', () => {
    const v = validatePayload(payload({ deepLink: 'pixcart://nowhere' }),
      { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') });
    expect(v.some((x) => x.code === 'DEEP_LINK_NOT_IN_ROUTE_REGISTRY')).toBe(true);
  });

  it('ACTION deep links are validated too, not just the main one', () => {
    const v = validatePayload(payload({
      actions: [
        { id: 'track', label: 'Track', deepLink: 'pixcart://order/ORD-1/track' },
        { id: 'bad', label: 'Open', deepLink: 'pixcart://not-a-route' },
      ],
    }), { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') });
    const offenders = v.filter((x) => x.code === 'ACTION_DEEP_LINK_NOT_IN_ROUTE_REGISTRY');
    expect(offenders).toHaveLength(1);
    expect(offenders[0].detail).toBe('pixcart://not-a-route');
  });
});

// ============================================ no PII in payloads

describe('no sensitive detail travels in the payload (SECURITY)', () => {
  it('refuses an amount, an email, a phone, a card tail and a pincode', () => {
    expect(piiInPayload(payload({ body: 'Your refund of ₹2,450 is on its way' }))
      .some((v) => v.code === 'PAYLOAD_CONTAINS_AMOUNT')).toBe(true);
    expect(piiInPayload(payload({ body: 'Reply to harish@example.com' }))
      .some((v) => v.code === 'PAYLOAD_CONTAINS_EMAIL')).toBe(true);
    expect(piiInPayload(payload({ body: 'Call +91 98765 43210' }))
      .some((v) => v.code === 'PAYLOAD_CONTAINS_PHONE')).toBe(true);
    expect(piiInPayload(payload({ body: 'Card ending 4417 was charged' }))
      .some((v) => v.code === 'PAYLOAD_CONTAINS_CARD_TAIL')).toBe(true);
    expect(piiInPayload(payload({ body: 'Delivering to 641012 today' }))
      .some((v) => v.code === 'PAYLOAD_CONTAINS_PINCODE')).toBe(true);
  });

  it('checks action labels as well as the title and body', () => {
    const v = piiInPayload(payload({
      actions: [{ id: 'a', label: 'Pay ₹500 now', deepLink: 'pixcart://cart' }],
    }));
    expect(v.some((x) => x.code === 'PAYLOAD_CONTAINS_AMOUNT')).toBe(true);
  });

  it('permits a fetch-on-open payload carrying only a reference', () => {
    const clean = payload({ body: 'Tap to see your refund details', detailRef: 'refund:RF-9' });
    expect(piiInPayload(clean)).toEqual([]);
    expect(validatePayload(clean,
      { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') })).toEqual([]);
  });

  it('a payload carrying PII is REJECTED at send, not merely flagged', () => {
    const r = sendToDevice(payload({ body: 'Your order total is ₹4,999' }), device(), ctx());
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') {
      expect(r.violations.some((v) => v.code === 'PAYLOAD_CONTAINS_AMOUNT')).toBe(true);
    }
  });
});

// ============================================ size and CDN

describe('payload size and image hosting (VALIDATION)', () => {
  it('refuses a payload beyond the FCM ceiling', () => {
    const big = payload({ body: 'x'.repeat(MAX_PAYLOAD_BYTES) });
    expect(payloadBytes(big)).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const v = validatePayload(big,
      { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') });
    expect(v.some((x) => x.code.startsWith('PAYLOAD_EXCEEDS'))).toBe(true);
    expect(MAX_PAYLOAD_BYTES).toBe(4096);
  });

  it('requires an image to be CDN-hosted over HTTPS', () => {
    expect(isCdnHosted('https://cdn.pixcart.pixoustech.com/a.jpg', CDN_HOSTS)).toBe(true);
    expect(isCdnHosted('http://cdn.pixcart.pixoustech.com/a.jpg', CDN_HOSTS)).toBe(false);
    expect(isCdnHosted('https://tracker.example.com/pixel.gif', CDN_HOSTS)).toBe(false);
    expect(isCdnHosted('not a url', CDN_HOSTS)).toBe(false);
  });

  it('rejects a non-CDN image at validation', () => {
    const v = validatePayload(payload({ imageUrl: 'https://tracker.example.com/pixel.gif' }),
      { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') });
    expect(v.some((x) => x.code === 'IMAGE_URL_NOT_CDN_HOSTED')).toBe(true);
  });

  it('requires a title and a body', () => {
    const v = validatePayload(payload({ title: '  ', body: '' }),
      { routes: DEFAULT_ROUTES, cdnHosts: CDN_HOSTS, capabilities: capabilitiesFor('3.6.0') });
    expect(v.some((x) => x.code === 'TITLE_REQUIRED')).toBe(true);
    expect(v.some((x) => x.code === 'BODY_REQUIRED')).toBe(true);
  });
});

// ============================================ capability gating

describe('per-app-version capability gating (RULES)', () => {
  it('compares versions correctly, including unequal lengths', () => {
    expect(compareVersions('3.4.0', '3.4.0')).toBe(0);
    expect(compareVersions('3.4.1', '3.4.0')).toBe(1);
    expect(compareVersions('2.9.9', '3.0.0')).toBe(-1);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
    expect(compareVersions('10.0.0', '9.9.9')).toBe(1);
  });

  it('gates rich images, action buttons and collapse keys by version', () => {
    expect(capabilitiesFor('2.7.0')).toEqual({ richImage: false, actionButtons: false, collapseKeys: false });
    expect(capabilitiesFor('2.8.0').collapseKeys).toBe(true);
    expect(capabilitiesFor('3.0.0').richImage).toBe(true);
    expect(capabilitiesFor('3.0.0').actionButtons).toBe(false);
    expect(capabilitiesFor('3.4.0').actionButtons).toBe(true);
  });

  it('strips a capability the client cannot render rather than sending it to be dropped', () => {
    const rich = payload({
      imageUrl: 'https://cdn.pixcart.pixoustech.com/a.jpg',
      imageBytes: 100_000,
      actions: [{ id: 'track', label: 'Track', deepLink: 'pixcart://order/ORD-1/track' }],
      collapseKey: 'order-status:ORD-1',
    });
    const old = adaptForDevice(rich, capabilitiesFor('2.7.0'));
    expect(old.imageUrl).toBeUndefined();
    expect(old.actions).toBeUndefined();
    expect(old.collapseKey).toBeUndefined();
    expect(old.capabilitiesStripped.sort()).toEqual(['actionButtons', 'collapseKeys', 'richImage']);

    const modern = adaptForDevice(rich, capabilitiesFor('3.6.0'));
    expect(modern.imageUrl).toBeDefined();
    expect(modern.actions).toHaveLength(1);
    expect(modern.capabilitiesStripped).toEqual([]);
  });
});

// ============================================ image fallback

describe('an oversized image falls back to text-only rather than failing (ERRORS)', () => {
  it('drops the image and records why, keeping the message deliverable', () => {
    const heavy = payload({
      imageUrl: 'https://cdn.pixcart.pixoustech.com/huge.jpg',
      imageBytes: MAX_IMAGE_BYTES + 1,
    });
    const adapted = adaptForDevice(heavy, capabilitiesFor('3.6.0'));
    expect(adapted.imageUrl).toBeUndefined();
    expect(adapted.imageDroppedReason).toContain('FALLBACK_TO_TEXT');
    // the customer still gets told their order shipped
    expect(adapted.title).toBe('Your order has shipped');
    expect(adapted.body).toBe('Tap to track your parcel');
  });

  it('an image at the limit is kept', () => {
    const atLimit = payload({
      imageUrl: 'https://cdn.pixcart.pixoustech.com/ok.jpg',
      imageBytes: MAX_IMAGE_BYTES,
    });
    const adapted = adaptForDevice(atLimit, capabilitiesFor('3.6.0'));
    expect(adapted.imageUrl).toBeDefined();
    expect(adapted.imageDroppedReason).toBeUndefined();
  });

  it('an oversized image is a fallback, NOT a send failure', () => {
    const r = sendToDevice(payload({
      imageUrl: 'https://cdn.pixcart.pixoustech.com/huge.jpg',
      imageBytes: MAX_IMAGE_BYTES + 5,
    }), device(), ctx());
    expect(r.outcome).toBe('SENT');
    if (r.outcome === 'SENT') expect(r.payload.imageUrl).toBeUndefined();
  });
});

// ============================================ delegated policy (cross-slice)

describe('consent and quiet hours are DELEGATED to the real FR-CUS-022 policy engine', () => {
  it('a transactional order push sends at 2 a.m., because quiet hours are promotional-only', () => {
    const r = sendToDevice(payload({ category: 'ORDER' }), device(), ctx({ nowMs: NIGHT }));
    expect(deviceInQuietHours(device(), NIGHT)).toBe(true);
    expect(r.outcome).toBe('SENT');
  });

  it('a PROMOTIONAL push at 2 a.m. is DEFERRED to the end of the quiet window', () => {
    const r = sendToDevice(
      payload({ category: 'PROMOTIONAL', deepLink: 'pixcart://offers' }),
      device(), ctx({ nowMs: NIGHT }));
    expect(r.outcome).toBe('DEFERRED');
    if (r.outcome !== 'DEFERRED') return;
    expect(r.reason).toContain('QUIET_HOURS');
    // 08:00 IST on 21 Aug is 02:30 UTC on 21 Aug
    expect(r.sendAfterMs).toBe(Date.UTC(2026, 7, 21, 2, 30));
    expect(r.sendAfterMs).toBeGreaterThan(NIGHT);
  });

  it('the same promotional push sends in the afternoon', () => {
    const r = sendToDevice(
      payload({ category: 'PROMOTIONAL', deepLink: 'pixcart://offers' }),
      device(), ctx({ nowMs: DAYTIME }));
    expect(r.outcome).toBe('SENT');
  });

  it('a promotional push without consent is SUPPRESSED by policy, not deferred', () => {
    const r = sendToDevice(
      payload({ category: 'PROMOTIONAL', deepLink: 'pixcart://offers' }),
      device(), ctx({ profile: profile({ consents: [] }) }));
    expect(r.outcome).toBe('SUPPRESSED_BY_POLICY');
    if (r.outcome === 'SUPPRESSED_BY_POLICY') expect(r.reason).toContain('NO_CONSENT');
  });

  it('a legal stop-list entry suppresses even a transactional push', () => {
    const r = sendToDevice(payload({ category: 'ORDER' }), device(),
      ctx({ profile: profile({ stopList: ['PUSH'] }) }));
    expect(r.outcome).toBe('SUPPRESSED_BY_POLICY');
    if (r.outcome === 'SUPPRESSED_BY_POLICY') expect(r.reason).toContain('CHANNEL_STOPPED');
  });

  it('quiet hours are evaluated PER DEVICE, using that device timezone', () => {
    // the same instant is night in India and afternoon in London
    const indian = device({ token: 'TOK-IN', tzOffsetMinutes: IST });
    const british = device({ token: 'TOK-UK', tzOffsetMinutes: 60 });
    expect(deviceInQuietHours(indian, NIGHT)).toBe(true);
    expect(deviceInQuietHours(british, NIGHT)).toBe(false);

    const promo = payload({ category: 'PROMOTIONAL', deepLink: 'pixcart://offers' });
    expect(sendToDevice(promo, indian, ctx({ nowMs: NIGHT })).outcome).toBe('DEFERRED');
    expect(sendToDevice(promo, british, ctx({ nowMs: NIGHT })).outcome).toBe('SENT');
  });

  it('the quiet-window end is computed for the device own day', () => {
    // at 23:00 IST the window closes at 08:00 IST the NEXT day
    const lateEvening = Date.UTC(2026, 7, 20, 17, 30);   // 23:00 IST 20 Aug
    expect(quietHoursEndMs(device(), lateEvening)).toBe(Date.UTC(2026, 7, 21, 2, 30));
  });
});

// ============================================ token lifecycle

describe('token lifecycle and hygiene (RULES)', () => {
  it('registers, refreshes and does not duplicate on re-registration', () => {
    const r = new TokenRegistry();
    r.register(device());
    r.register(device());
    expect(r.size()).toBe(1);

    expect(r.refresh('TOK-1', 'TOK-2', DAYTIME).ok).toBe(true);
    expect(r.token('TOK-1')).toBeUndefined();
    expect(r.token('TOK-2')!.state).toBe('ACTIVE');
    expect(r.token('TOK-2')!.customerId).toBe('CUS-1');
    expect(r.refresh('MISSING', 'TOK-3', DAYTIME).ok).toBe(false);
  });

  it('invalid feedback marks the token and pruning removes it', () => {
    const r = new TokenRegistry();
    r.register(device());
    expect(r.markInvalid('TOK-1', DAYTIME)).toBe(true);
    expect(r.token('TOK-1')!.state).toBe('INVALID');
    expect(r.hygiene(DAYTIME).awaitingPrune).toBe(1);

    expect(r.prune(DAYTIME + 1000)).toEqual(['TOK-1']);
    expect(r.size()).toBe(0);
    expect(r.markInvalid('TOK-1', DAYTIME)).toBe(false);
  });

  it('reports an SLA breach when an invalid token sits unpruned beyond 24 hours', () => {
    const r = new TokenRegistry();
    r.register(device());
    r.markInvalid('TOK-1', DAYTIME);
    expect(r.hygiene(DAYTIME + TOKEN_PRUNE_WINDOW_MS).pruneSlaBreached).toBe(false);
    expect(r.hygiene(DAYTIME + TOKEN_PRUNE_WINDOW_MS + 1).pruneSlaBreached).toBe(true);
    expect(TOKEN_PRUNE_WINDOW_MS).toBe(86_400_000);
  });

  it('the hygiene report counts each state and lists active tokens per customer', () => {
    const r = new TokenRegistry();
    r.register(device({ token: 'A' }));
    r.register(device({ token: 'B' }));
    r.register(device({ token: 'C', customerId: 'CUS-2' }));
    r.markInvalid('B', DAYTIME);

    const h = r.hygiene(DAYTIME);
    expect(h.active).toBe(2);
    expect(h.invalid).toBe(1);
    expect(r.activeFor('CUS-1').map((t) => t.token)).toEqual(['A']);
    expect(r.activeFor('CUS-2').map((t) => t.token)).toEqual(['C']);
  });

  it('a send to a non-active token is dropped rather than attempted', () => {
    const r = sendToDevice(payload(), device({ state: 'INVALID' }), ctx());
    expect(r.outcome).toBe('DROPPED');
    if (r.outcome === 'DROPPED') expect(r.reason).toBe('TOKEN_INVALID');
    expect(sendToDevice(payload(), device({ state: 'STALE' }), ctx()).outcome).toBe('DROPPED');
  });
});

// ============================================ collapse keys

describe('order-status pushes collapse so the latest state wins (RULES)', () => {
  it('keys by order, so one order collapses independently of another', () => {
    expect(orderStatusCollapseKey('ORD-1')).toBe('order-status:ORD-1');
    expect(orderStatusCollapseKey('ORD-2')).not.toBe(orderStatusCollapseKey('ORD-1'));
  });

  it('a newer state supersedes the pending one', () => {
    const pending = new Map([['order-status:ORD-1', { messageId: 'MSG-PACKED', sequence: 2 }]]);
    const d = collapseDecision('order-status:ORD-1', 3, pending);
    expect(d.send).toBe(true);
    expect(d.supersedes).toBe('MSG-PACKED');
  });

  it('an OLDER state arriving late is dropped, because it would actively misinform', () => {
    // delivering "packed" after "delivered" is worse than delivering nothing
    const pending = new Map([['order-status:ORD-1', { messageId: 'MSG-DELIVERED', sequence: 5 }]]);
    const d = collapseDecision('order-status:ORD-1', 3, pending);
    expect(d.send).toBe(false);
    expect(d.reason).toBe('SUPERSEDED_BY_NEWER_STATE');
  });

  it('an equal sequence is treated as a duplicate and dropped', () => {
    const pending = new Map([['order-status:ORD-1', { messageId: 'MSG-A', sequence: 4 }]]);
    expect(collapseDecision('order-status:ORD-1', 4, pending).send).toBe(false);
  });

  it('the first push for a key always sends', () => {
    expect(collapseDecision('order-status:ORD-9', 1, new Map()).send).toBe(true);
  });
});

// ============================================ retry with jitter

describe('a partial provider outage retries with jitter (ERRORS)', () => {
  it('backs off exponentially and applies jitter within bounds', () => {
    // attempt 1 base 1000ms: with jitter the delay lies in [500, 1000]
    expect(retryDelayMs(1, 0)).toBe(500);
    expect(retryDelayMs(1, 1)).toBe(1000);
    expect(retryDelayMs(2, 1)).toBe(2000);
    expect(retryDelayMs(3, 1)).toBe(4000);
    expect(retryDelayMs(1, 0.5)).toBe(750);
  });

  it('jitter genuinely spreads retries rather than being cosmetic', () => {
    // without jitter every queued push would retry in the same instant and hammer a recovering
    // provider; distinct jitter fractions must yield distinct delays
    const delays = new Set([0, 0.25, 0.5, 0.75, 1].map((j) => retryDelayMs(3, j)));
    expect(delays.size).toBe(5);
  });

  it('stops after the maximum attempts rather than retrying for ever', () => {
    expect(retryDelayMs(RETRY_MAX_ATTEMPTS, 1)).not.toBeNull();
    expect(retryDelayMs(RETRY_MAX_ATTEMPTS + 1, 1)).toBeNull();
    expect(retryDelayMs(0, 1)).toBeNull();
  });

  it('clamps an out-of-range jitter fraction rather than producing a nonsense delay', () => {
    expect(retryDelayMs(1, -5)).toBe(500);
    expect(retryDelayMs(1, 99)).toBe(1000);
  });
});
