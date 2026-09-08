/**
 * FR-MKT-003 email marketing channel. The suite is built around two asymmetries that are easy to
 * get wrong and costly when wrong: suppression scope depends on the REASON, and ESP failover is
 * transactional-only.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  blockedClassesFor,
  domainHealth,
  isPermanent,
  listUnsubscribeHeaders,
  MAX_HTML_BYTES,
  processEvent,
  send,
  signClickUrl,
  SuppressionList,
  validatePayload,
  verifyClickUrl,
  verifyWebhook,
  WARMUP_DAYS,
  warmupDailyCap,
  type EmailPayload,
  type EspEvent,
  type SendContext,
  type SendingDomain,
} from '../src/domain/email/channel.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);
const SECRET = 'x'.repeat(48);

const domain = (over: Partial<SendingDomain> = {}): SendingDomain => ({
  domain: 'mail.pixcart.pixoustech.com', spf: true, dkim: true, dmarc: true, ageDays: 90, ...over,
});

const promo = (over: Partial<EmailPayload> = {}): EmailPayload => ({
  messageId: 'MSG-1',
  to: 'harish@example.com',
  subject: 'Festive picks for you',
  htmlBody: '<html><body><h1>Festive picks</h1></body></html>',
  messageClass: 'PROMOTIONAL',
  unsubscribeUrl: 'https://pixcart.pixoustech.com/unsubscribe/abc',
  images: [],
  ...over,
});

const transactional = (over: Partial<EmailPayload> = {}): EmailPayload => ({
  messageId: 'MSG-T1',
  to: 'harish@example.com',
  subject: 'Your order PIX-1001 has shipped',
  htmlBody: '<html><body>Your order has shipped</body></html>',
  messageClass: 'TRANSACTIONAL',
  images: [],
  ...over,
});

const ctx = (over: Partial<SendContext> = {}): SendContext => ({
  suppression: new SuppressionList(),
  domain: domain(),
  primaryHealth: 'HEALTHY',
  secondaryHealth: 'HEALTHY',
  steadyStateCap: 100_000,
  sentToday: 0,
  ...over,
});

// ============================================ the acceptance criterion

describe('the documented acceptance scenario: a prior complainant targeted by a promo', () => {
  it('suppresses the send with reason=complaint and counts it in the report', () => {
    const suppression = new SuppressionList();
    // the recipient complained about an earlier campaign
    processEvent({ messageId: 'MSG-OLD', email: 'harish@example.com', type: 'COMPLAINT', atMs: NOW - 86_400_000 },
      suppression);

    const result = send(promo(), ctx({ suppression }));
    expect(result.outcome).toBe('SUPPRESSED');
    if (result.outcome !== 'SUPPRESSED') return;
    expect(result.reason).toBe('COMPLAINT');

    const report = suppression.report();
    expect(report.total).toBe(1);
    expect(report.byReason.COMPLAINT).toBe(1);
  });

  it('a complaint feeds back to the journey so it stops targeting them', () => {
    const suppression = new SuppressionList();
    const effect = processEvent(
      { messageId: 'MSG-1', email: 'harish@example.com', type: 'COMPLAINT', atMs: NOW }, suppression);
    expect(effect.suppressed).toBe(true);
    expect(effect.reason).toBe('COMPLAINT');
    expect(effect.journeyFeedback).toBe('STOP_TARGETING');
  });
});

// ============================================ suppression scope by reason

describe('suppression scope depends on the reason (RULES)', () => {
  it('a complaint blocks promos but NOT the order confirmation', () => {
    const suppression = new SuppressionList();
    suppression.add('harish@example.com', 'COMPLAINT', NOW);

    expect(send(promo(), ctx({ suppression })).outcome).toBe('SUPPRESSED');
    // a customer who complained about marketing has not waived their receipt
    expect(send(transactional(), ctx({ suppression })).outcome).toBe('SENT');
  });

  it('an unsubscribe blocks promos but NOT transactional mail', () => {
    const suppression = new SuppressionList();
    suppression.add('harish@example.com', 'UNSUBSCRIBED', NOW);
    expect(suppression.isSuppressedFor('harish@example.com', 'PROMOTIONAL')).toBe(true);
    expect(suppression.isSuppressedFor('harish@example.com', 'TRANSACTIONAL')).toBe(false);
    expect(send(transactional(), ctx({ suppression })).outcome).toBe('SENT');
  });

  it('a hard bounce blocks EVERYTHING, because the mailbox does not exist', () => {
    const suppression = new SuppressionList();
    suppression.add('gone@example.com', 'HARD_BOUNCE', NOW);
    expect(suppression.isSuppressedFor('gone@example.com', 'PROMOTIONAL')).toBe(true);
    expect(suppression.isSuppressedFor('gone@example.com', 'TRANSACTIONAL')).toBe(true);

    const r = send(transactional({ to: 'gone@example.com' }), ctx({ suppression }));
    expect(r.outcome).toBe('SUPPRESSED');
    if (r.outcome === 'SUPPRESSED') expect(r.reason).toBe('HARD_BOUNCE');
  });

  it('the scope mapping is explicit for every reason', () => {
    expect([...blockedClassesFor('HARD_BOUNCE')].sort()).toEqual(['PROMOTIONAL', 'TRANSACTIONAL']);
    expect([...blockedClassesFor('COMPLAINT')]).toEqual(['PROMOTIONAL']);
    expect([...blockedClassesFor('UNSUBSCRIBED')]).toEqual(['PROMOTIONAL']);
    expect([...blockedClassesFor('MANUAL')]).toEqual(['PROMOTIONAL']);
  });

  it('an address with no suppression is not suppressed for anything', () => {
    const s = new SuppressionList();
    expect(s.isSuppressedFor('new@example.com', 'PROMOTIONAL')).toBe(false);
    expect(s.isSuppressedFor('new@example.com', 'TRANSACTIONAL')).toBe(false);
    expect(s.entry('new@example.com')).toBeUndefined();
  });

  it('suppression matching is case- and whitespace-insensitive', () => {
    const s = new SuppressionList();
    s.add('  Harish@Example.COM ', 'COMPLAINT', NOW);
    expect(s.isSuppressedFor('harish@example.com', 'PROMOTIONAL')).toBe(true);
  });
});

describe('permanence and re-consent', () => {
  it('a hard bounce and a complaint are permanent; an unsubscribe is not', () => {
    expect(isPermanent('HARD_BOUNCE')).toBe(true);
    expect(isPermanent('COMPLAINT')).toBe(true);
    expect(isPermanent('UNSUBSCRIBED')).toBe(false);
    expect(isPermanent('MANUAL')).toBe(false);
  });

  it('fresh consent clears an unsubscribe but never a complaint', () => {
    const s = new SuppressionList();
    s.add('a@example.com', 'UNSUBSCRIBED', NOW);
    expect(s.reconsent('a@example.com').ok).toBe(true);
    expect(s.isSuppressedFor('a@example.com', 'PROMOTIONAL')).toBe(false);

    s.add('b@example.com', 'COMPLAINT', NOW);
    const refused = s.reconsent('b@example.com');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('SUPPRESSION_IS_PERMANENT');
    expect(s.isSuppressedFor('b@example.com', 'PROMOTIONAL')).toBe(true);
  });

  it('a weaker reason never narrows an existing permanent suppression', () => {
    const s = new SuppressionList();
    s.add('gone@example.com', 'HARD_BOUNCE', NOW);
    s.add('gone@example.com', 'UNSUBSCRIBED', NOW + 1000);
    // the hard bounce must stand: transactional mail is still blocked
    expect(s.entry('gone@example.com')!.reason).toBe('HARD_BOUNCE');
    expect(s.isSuppressedFor('gone@example.com', 'TRANSACTIONAL')).toBe(true);
  });

  it('a hard bounce after a complaint escalates the scope', () => {
    const s = new SuppressionList();
    s.add('x@example.com', 'COMPLAINT', NOW);
    expect(s.isSuppressedFor('x@example.com', 'TRANSACTIONAL')).toBe(false);
    s.add('x@example.com', 'HARD_BOUNCE', NOW + 1000);
    expect(s.isSuppressedFor('x@example.com', 'TRANSACTIONAL')).toBe(true);
  });

  it('re-consenting an address that was never suppressed is a no-op success', () => {
    expect(new SuppressionList().reconsent('never@example.com').ok).toBe(true);
  });
});

// ============================================ the promo unsubscribe hard gate

describe('promotional sends require an unsubscribe link — a hard gate (VALIDATION)', () => {
  it('refuses a promo with no unsubscribe link', () => {
    const v = validatePayload(promo({ unsubscribeUrl: undefined }), domain());
    expect(v.some((x) => x.code === 'PROMOTIONAL_SEND_REQUIRES_UNSUBSCRIBE_LINK')).toBe(true);

    const r = send(promo({ unsubscribeUrl: undefined }), ctx());
    expect(r.outcome).toBe('REJECTED');
  });

  it('refuses an unsubscribe link that is not HTTPS', () => {
    const v = validatePayload(promo({ unsubscribeUrl: 'http://insecure/unsub' }), domain());
    expect(v.some((x) => x.code === 'UNSUBSCRIBE_LINK_MUST_BE_HTTPS')).toBe(true);
  });

  it('does NOT require one on a transactional send, because a receipt has nothing to opt out of', () => {
    expect(validatePayload(transactional(), domain())).toEqual([]);
    expect(send(transactional(), ctx()).outcome).toBe('SENT');
  });

  it('emits one-click List-Unsubscribe headers for promos only', () => {
    const headers = listUnsubscribeHeaders(promo());
    expect(headers['List-Unsubscribe']).toBe('<https://pixcart.pixoustech.com/unsubscribe/abc>');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(listUnsubscribeHeaders(transactional())).toEqual({});
  });
});

describe('payload validation (VALIDATION)', () => {
  it('enforces the 100 KB HTML ceiling', () => {
    const big = promo({ htmlBody: 'x'.repeat(MAX_HTML_BYTES + 1) });
    expect(validatePayload(big, domain()).some((v) => v.code === 'HTML_EXCEEDS_100KB')).toBe(true);
    const atLimit = promo({ htmlBody: 'x'.repeat(MAX_HTML_BYTES) });
    expect(validatePayload(atLimit, domain()).some((v) => v.code === 'HTML_EXCEEDS_100KB')).toBe(false);
  });

  it('lints every image for alt text and names the offender', () => {
    const v = validatePayload(promo({
      images: [{ src: 'cdn://a.jpg', alt: 'Diwali sale banner' }, { src: 'cdn://b.jpg' }],
    }), domain());
    const missing = v.filter((x) => x.code === 'IMAGE_MISSING_ALT_TEXT');
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toBe('cdn://b.jpg');
  });

  it('refuses an empty body, empty subject or malformed recipient', () => {
    const v = validatePayload(promo({ htmlBody: '  ', subject: '', to: 'not-an-email' }), domain());
    expect(v.some((x) => x.code === 'HTML_BODY_EMPTY')).toBe(true);
    expect(v.some((x) => x.code === 'SUBJECT_REQUIRED')).toBe(true);
    expect(v.some((x) => x.code === 'RECIPIENT_MALFORMED')).toBe(true);
  });

  it('refuses to send from a domain without complete SPF, DKIM and DMARC', () => {
    const v = validatePayload(promo(), domain({ spf: false, dkim: false, dmarc: false }));
    expect(v.some((x) => x.code === 'SENDING_DOMAIN_MISSING_SPF')).toBe(true);
    expect(v.some((x) => x.code === 'SENDING_DOMAIN_MISSING_DKIM')).toBe(true);
    expect(v.some((x) => x.code === 'SENDING_DOMAIN_MISSING_DMARC')).toBe(true);
  });

  it('validation runs BEFORE suppression, so a malformed promo is fixed rather than silently dropped', () => {
    const suppression = new SuppressionList();
    suppression.add('harish@example.com', 'COMPLAINT', NOW);
    const r = send(promo({ unsubscribeUrl: undefined }), ctx({ suppression }));
    expect(r.outcome).toBe("REJECTED");
  });
});

// ============================================ transactional-only failover

describe('ESP outage: failover is transactional-only (ERRORS)', () => {
  it('a transactional send fails over to the secondary', () => {
    const r = send(transactional(), ctx({ primaryHealth: 'OUTAGE' }));
    expect(r.outcome).toBe('SENT');
    if (r.outcome === 'SENT') expect(r.esp).toBe('SECONDARY');
  });

  it('a promotional send QUEUES rather than failing over', () => {
    const r = send(promo(), ctx({ primaryHealth: 'OUTAGE' }));
    expect(r.outcome).toBe('QUEUED');
    if (r.outcome === 'QUEUED') {
      expect(r.reason).toBe('PROMOTIONAL_SENDS_QUEUE_DURING_ESP_OUTAGE');
    }
  });

  it('with both ESPs down even transactional mail queues rather than being lost', () => {
    const r = send(transactional(), ctx({ primaryHealth: 'OUTAGE', secondaryHealth: 'OUTAGE' }));
    expect(r.outcome).toBe('QUEUED');
    if (r.outcome === 'QUEUED') expect(r.reason).toBe('BOTH_ESPS_UNAVAILABLE');
  });

  it('a healthy primary is used in preference to the secondary', () => {
    const r = send(transactional(), ctx());
    if (r.outcome === 'SENT') expect(r.esp).toBe('PRIMARY');
  });
});

// ============================================ warm-up throttle

describe('warm-up throttles for a new domain (RULES)', () => {
  it('ramps the daily cap across the warm-up window', () => {
    expect(WARMUP_DAYS).toBe(30);
    const day1 = warmupDailyCap(domain({ ageDays: 1 }), 300_000);
    const day15 = warmupDailyCap(domain({ ageDays: 15 }), 300_000);
    const day30 = warmupDailyCap(domain({ ageDays: 30 }), 300_000);
    expect(day1).toBeLessThan(day15);
    expect(day15).toBeLessThan(day30);
    expect(day30).toBe(300_000);
    expect(warmupDailyCap(domain({ ageDays: 90 }), 300_000)).toBe(300_000);
  });

  it('never drops below a floor, so a brand-new domain can still send something', () => {
    expect(warmupDailyCap(domain({ ageDays: 0 }), 100)).toBeGreaterThanOrEqual(50);
  });

  it('throttles a promo past the cap', () => {
    const c = ctx({ domain: domain({ ageDays: 1 }), steadyStateCap: 30_000, sentToday: 1_000_000 });
    const r = send(promo(), c);
    expect(r.outcome).toBe('THROTTLED');
    if (r.outcome === 'THROTTLED') expect(r.dailyCap).toBeGreaterThan(0);
  });

  it('NEVER throttles transactional mail, because a customer is waiting for it', () => {
    const c = ctx({ domain: domain({ ageDays: 1 }), steadyStateCap: 100, sentToday: 999_999 });
    expect(send(transactional(), c).outcome).toBe('SENT');
  });
});

// ============================================ event processing

describe('bounce and complaint processing (RULES)', () => {
  it('a hard bounce suppresses permanently', () => {
    const s = new SuppressionList();
    const effect = processEvent({ messageId: 'M', email: 'gone@example.com', type: 'HARD_BOUNCE', atMs: NOW }, s);
    expect(effect.suppressed).toBe(true);
    expect(s.entry('gone@example.com')!.permanent).toBe(true);
  });

  it('a SOFT bounce does NOT suppress, because a full mailbox is not a dead address', () => {
    const s = new SuppressionList();
    const effect = processEvent({ messageId: 'M', email: 'full@example.com', type: 'SOFT_BOUNCE', atMs: NOW }, s);
    expect(effect.suppressed).toBe(false);
    expect(s.size()).toBe(0);
  });

  it('delivery, open and click events change nothing', () => {
    const s = new SuppressionList();
    for (const type of ['DELIVERED', 'OPEN', 'CLICK'] as const) {
      expect(processEvent({ messageId: 'M', email: 'a@example.com', type, atMs: NOW }, s).suppressed).toBe(false);
    }
    expect(s.size()).toBe(0);
  });

  it('the suppression report counts by reason', () => {
    const s = new SuppressionList();
    s.add('a@example.com', 'HARD_BOUNCE', NOW);
    s.add('b@example.com', 'COMPLAINT', NOW);
    s.add('c@example.com', 'COMPLAINT', NOW);
    s.add('d@example.com', 'UNSUBSCRIBED', NOW);
    const r = s.report();
    expect(r.total).toBe(4);
    expect(r.byReason).toEqual({ HARD_BOUNCE: 1, COMPLAINT: 2, UNSUBSCRIBED: 1, MANUAL: 0 });
  });
});

describe('domain health metrics (OUTPUTS)', () => {
  const events = (delivered: number, hard: number, complaints: number): EspEvent[] => [
    ...Array.from({ length: delivered }, (_, i) =>
      ({ messageId: `D${i}`, email: `d${i}@x.com`, type: 'DELIVERED' as const, atMs: NOW })),
    ...Array.from({ length: hard }, (_, i) =>
      ({ messageId: `H${i}`, email: `h${i}@x.com`, type: 'HARD_BOUNCE' as const, atMs: NOW })),
    ...Array.from({ length: complaints }, (_, i) =>
      ({ messageId: `C${i}`, email: `c${i}@x.com`, type: 'COMPLAINT' as const, atMs: NOW })),
  ];

  it('reports healthy for a clean send', () => {
    const h = domainHealth(events(1000, 5, 0));
    expect(h.delivered).toBe(1000);
    expect(h.hardBounceRate).toBeCloseTo(0.005, 4);
    expect(h.healthy).toBe(true);
  });

  it('flags an unhealthy hard-bounce rate at the threshold providers act on', () => {
    expect(domainHealth(events(1000, 30, 0)).healthy).toBe(false);
  });

  it('flags an unhealthy complaint rate even with few bounces', () => {
    const h = domainHealth(events(1000, 0, 5));
    expect(h.complaintRate).toBeCloseTo(0.005, 4);
    expect(h.healthy).toBe(false);
  });

  it('an empty event stream does not divide by zero', () => {
    expect(domainHealth([])).toEqual({
      delivered: 0, hardBounceRate: 0, complaintRate: 0, healthy: true,
    });
  });
});

// ============================================ security

describe('click tracking links are signed and PII-free (SECURITY)', () => {
  it('a signed link round-trips and carries no recipient address', () => {
    const url = signClickUrl('https://t.pixcart.in/c', 'MSG-1',
      'https://pixcart.pixoustech.com/p/saree-123', SECRET);
    // the recipient's address must never appear in a URL every hop will log
    expect(url).not.toContain('harish');
    expect(url).not.toContain('@');

    const v = verifyClickUrl(url, SECRET);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.targetUrl).toBe('https://pixcart.pixoustech.com/p/saree-123');
      expect(v.messageId).toBe('MSG-1');
    }
  });

  it('a tampered destination fails verification', () => {
    const url = signClickUrl('https://t.pixcart.in/c', 'MSG-1', 'https://pixcart.pixoustech.com/p/a', SECRET);
    const tampered = url.replace('%2Fp%2Fa', '%2Fp%2Fevil');
    const v = verifyClickUrl(tampered, SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('CLICK_URL_SIGNATURE_INVALID');
  });

  it('a link signed with a different secret fails', () => {
    const url = signClickUrl('https://t.pixcart.in/c', 'MSG-1', 'https://x/p/a', SECRET);
    expect(verifyClickUrl(url, 'y'.repeat(48)).ok).toBe(false);
  });

  it('a malformed or incomplete link is refused rather than throwing', () => {
    expect(verifyClickUrl('not a url', SECRET).ok).toBe(false);
    const v = verifyClickUrl('https://t.pixcart.in/c?m=MSG-1', SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('CLICK_URL_MISSING_PARAMETERS');
  });
});

describe('ESP webhooks are verified (SECURITY)', () => {
  it('accepts a correctly signed body and rejects everything else', () => {
    const body = JSON.stringify({ type: 'HARD_BOUNCE', email: 'gone@example.com' });
    const good = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(verifyWebhook(body, good, SECRET)).toBe(true);
    expect(verifyWebhook(body, good, 'other-secret')).toBe(false);
    expect(verifyWebhook('{"tampered":true}', good, SECRET)).toBe(false);
    expect(verifyWebhook(body, 'short', SECRET)).toBe(false);
    expect(verifyWebhook(body, '', SECRET)).toBe(false);
  });
});
