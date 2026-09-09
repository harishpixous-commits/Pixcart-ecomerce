/**
 * FR-ADM-015 operator notification centre. Two rules here are about who may break what: marketing
 * cannot edit a transactional template, and a complaint breach pauses promotional sends only.
 */
import { describe, expect, it } from 'vitest';
import {
  applyFailover,
  BROADCAST_CONFIRMATION_THRESHOLD,
  channelHealth,
  COMPLAINT_RATE_THRESHOLD,
  HARD_BOUNCE_RATE_THRESHOLD,
  launchBroadcast,
  mayEdit,
  maySend,
  TemplateRegistry,
  validateTemplate,
  type BroadcastDefinition,
  type ChannelHealth,
  type OperatorRole,
  type ProviderStats,
  type ProviderWeight,
  type Template,
} from '../src/domain/notification-centre.js';
import { isTransactional, type Category } from '../src/domain/policy.js';

const NOW = Date.UTC(2026, 7, 25, 10, 0, 0);

const SAMPLE = { orderId: 'PIX-1001', customerName: 'Priya', amount: '2,400' };

const template = (over: Partial<Template> = {}): Template => ({
  templateId: 'TPL-ORDER-SHIPPED',
  version: 1,
  locale: 'en-IN',
  category: 'ORDER',
  channel: 'EMAIL',
  body: 'Hello {{customerName}}, your order {{orderId}} has shipped.',
  declaredVariables: ['customerName', 'orderId'],
  state: 'DRAFT',
  ...over,
});

const promo = (over: Partial<Template> = {}): Template => template({
  templateId: 'TPL-DIWALI',
  category: 'PROMOTIONAL',
  body: 'Hello {{customerName}}, our Diwali sale is live.',
  declaredVariables: ['customerName'],
  ...over,
});

const stats = (over: Partial<ProviderStats> = {}): ProviderStats => ({
  providerId: 'ESP-PRIMARY',
  channel: 'EMAIL',
  attempted: 100_000,
  delivered: 99_000,
  hardBounces: 500,
  complaints: 20,
  ...over,
});

const health = (over: Partial<ChannelHealth> = {}): ChannelHealth => ({
  ...channelHealth(stats()),
  ...over,
});

// ============================================ transactional lock

describe('transactional templates are LOCKED from marketing (RULES)', () => {
  it('refuses a marketing edit of an order template', () => {
    const r = mayEdit('MARKETING', template({ category: 'ORDER' }));
    expect(r.permitted).toBe(false);
    // an order-confirmation template is part of a payment record: a tone edit that drops
    // {{orderId}} turns every receipt that month into an unusable document
    if (!r.permitted) expect(r.reason).toContain('TRANSACTIONAL_TEMPLATE_LOCKED_FROM_MARKETING');
  });

  it('the lock covers EVERY transactional category, using the FR-CUS-022 list', () => {
    for (const category of ['ORDER', 'PAYMENT', 'SECURITY', 'SHIPPING', 'REFUND'] as Category[]) {
      expect(isTransactional(category)).toBe(true);
      // a second list here could disagree with the policy engine's; this uses the same one
      expect(mayEdit('MARKETING', template({ category })).permitted).toBe(false);
    }
  });

  it('marketing MAY edit a promotional template', () => {
    expect(mayEdit('MARKETING', promo()).permitted).toBe(true);
  });

  it('admins may edit transactional templates', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as OperatorRole[]) {
      expect(mayEdit(role, template()).permitted).toBe(true);
    }
  });

  it('an archived template is immutable to everyone', () => {
    const r = mayEdit('SUPER_ADMIN', template({ state: 'ARCHIVED' }));
    expect(r.permitted).toBe(false);
    if (!r.permitted) expect(r.reason).toBe('ARCHIVED_TEMPLATES_ARE_IMMUTABLE');
  });

  it('the registry enforces the lock on save, not merely on a permission check', () => {
    const reg = new TemplateRegistry();
    const r = reg.save(template(), 'MARKETING', SAMPLE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].code).toBe('EDIT_NOT_PERMITTED');
    expect(reg.template('TPL-ORDER-SHIPPED', 1, 'en-IN')).toBeUndefined();
  });
});

// ============================================ template validation

describe('template validation (VALIDATION)', () => {
  it('accepts a complete template', () => {
    expect(validateTemplate(template(), SAMPLE)).toEqual([]);
  });

  it('REUSES the policy engine parser to find variables absent from the sample payload', () => {
    const v = validateTemplate(
      template({ body: 'Hi {{customerName}}, order {{orderId}} ships to {{city}}.' }), SAMPLE);
    // two template parsers would eventually disagree about what counts as a variable, and the one
    // that disagrees silently is the one in the less-used path
    expect(v.filter((x) => x.code === 'VARIABLE_MISSING_FROM_SAMPLE_PAYLOAD').map((x) => x.detail))
      .toEqual(['city']);
  });

  it('requires a registered DLT id on SMS', () => {
    const v = validateTemplate(template({ channel: 'SMS' }), SAMPLE);
    const dlt = v.find((x) => x.code === 'SMS_TEMPLATE_REQUIRES_REGISTERED_DLT_ID')!;
    expect(dlt).toBeDefined();
    // an unregistered SMS template is rejected by the operator, not by us
    expect(dlt.detail).toContain('rejected by the operator');
    expect(validateTemplate(template({ channel: 'SMS', dltId: 'DLT-110022' }), SAMPLE)).toEqual([]);
  });

  it('refuses a DLT id on a non-SMS channel, which would be meaningless', () => {
    const v = validateTemplate(template({ channel: 'EMAIL', dltId: 'DLT-110022' }), SAMPLE);
    expect(v.some((x) => x.code === 'DLT_ID_ONLY_APPLIES_TO_SMS')).toBe(true);
  });

  it('refuses a malformed locale, empty body and non-positive version', () => {
    const v = validateTemplate(template({ locale: 'english', body: '  ', version: 0 }), SAMPLE);
    const codes = v.map((x) => x.code);
    expect(codes).toContain('LOCALE_MALFORMED');
    expect(codes).toContain('BODY_REQUIRED');
    expect(codes).toContain('VERSION_MUST_BE_POSITIVE');
  });

  it('accepts both a bare and a regioned locale', () => {
    expect(validateTemplate(template({ locale: 'ta' }), SAMPLE)).toEqual([]);
    expect(validateTemplate(template({ locale: 'ta-IN' }), SAMPLE)).toEqual([]);
  });
});

// ============================================ versioning & approval

describe('approval and versioning (OUTPUTS)', () => {
  it('an approved version is immutable — a revision is a NEW version', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-1', NOW);

    const rewrite = reg.save(template({ body: 'Different {{customerName}} {{orderId}}' }), 'ADMIN', SAMPLE);
    expect(rewrite.ok).toBe(false);
    if (!rewrite.ok) {
      expect(rewrite.violations[0].code).toBe('APPROVED_VERSION_IS_IMMUTABLE_RAISE_A_NEW_VERSION');
    }
    expect(reg.save(template({ version: 2 }), 'ADMIN', SAMPLE).ok).toBe(true);
  });

  it('approval records its approver and the instant', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    const r = reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-7', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.template.state).toBe('APPROVED');
    expect(r.template.approvedByUserId).toBe('ADM-7');
    expect(r.template.approvedAtMs).toBe(NOW);
  });

  it('a saved revision returns to DRAFT rather than inheriting approval', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-1', NOW);
    reg.save(template({ version: 2 }), 'ADMIN', SAMPLE);
    expect(reg.template('TPL-ORDER-SHIPPED', 2, 'en-IN')!.state).toBe('DRAFT');
    expect(reg.template('TPL-ORDER-SHIPPED', 2, 'en-IN')!.approvedByUserId).toBeUndefined();
  });

  it('refuses a double approval, an unknown template and a nameless approver', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-1', NOW);
    expect(reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-1', NOW).ok).toBe(false);
    expect(reg.approve('NOPE', 1, 'en-IN', 'ADM-1', NOW).ok).toBe(false);

    reg.save(template({ version: 3 }), 'ADMIN', SAMPLE);
    expect(reg.approve('TPL-ORDER-SHIPPED', 3, 'en-IN', '  ', NOW).ok).toBe(false);
  });

  it('tracks approved locales per version, which is multi-locale support', () => {
    const reg = new TemplateRegistry();
    for (const locale of ['en-IN', 'ta-IN', 'hi-IN']) {
      reg.save(template({ locale }), 'ADMIN', SAMPLE);
    }
    reg.approve('TPL-ORDER-SHIPPED', 1, 'en-IN', 'ADM-1', NOW);
    reg.approve('TPL-ORDER-SHIPPED', 1, 'ta-IN', 'ADM-1', NOW);
    expect(reg.approvedLocales('TPL-ORDER-SHIPPED', 1)).toEqual(['en-IN', 'ta-IN']);
  });

  it('a test-send works from a DRAFT, which is the point of a test-send', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    const r = reg.testSend('TPL-ORDER-SHIPPED', 1, 'en-IN', SAMPLE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rendered).toBe('Hello Priya, your order PIX-1001 has shipped.');
  });

  it('a test-send with an incomplete payload names the missing variables', () => {
    const reg = new TemplateRegistry();
    reg.save(template(), 'ADMIN', SAMPLE);
    const r = reg.testSend('TPL-ORDER-SHIPPED', 1, 'en-IN', { customerName: 'Priya' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('orderId');
    expect(reg.testSend('NOPE', 1, 'en-IN', SAMPLE).ok).toBe(false);
  });
});

// ============================================ complaint-rate auto-pause

describe('a complaint breach pauses PROMOTIONAL sends only (RULES)', () => {
  it('computes the rates and reports healthy on a clean provider', () => {
    const h = channelHealth(stats());
    // the displayed rate is rounded to five places; the comparison is exact
    expect(h.complaintRate).toBeCloseTo(20 / 99_000, 5);
    expect(h.hardBounceRate).toBeCloseTo(0.005, 5);
    expect(h.healthy).toBe(true);
    expect(h.promotionalPaused).toBe(false);
  });

  it('PAUSES promotional sends above the complaint threshold', () => {
    const h = channelHealth(stats({ complaints: 500 }));      // ~0.5%
    expect(h.complaintRate).toBeGreaterThan(COMPLAINT_RATE_THRESHOLD);
    expect(h.promotionalPaused).toBe(true);
    expect(h.healthy).toBe(false);
    expect(h.reasons.some((r) => r.startsWith('COMPLAINT_RATE'))).toBe(true);
  });

  it('TRANSACTIONAL TRAFFIC KEEPS FLOWING on a channel paused for promotions', () => {
    const h = channelHealth(stats({ complaints: 500 }));
    expect(h.transactionalPaused).toBe(false);

    // complaints are about marketing: pausing a channel's order confirmations because its offers
    // annoyed people would punish customers for the platform's own marketing
    for (const category of ['ORDER', 'PAYMENT', 'SECURITY', 'SHIPPING', 'REFUND'] as Category[]) {
      expect(maySend(category, h).permitted).toBe(true);
    }
    const promoBlocked = maySend('PROMOTIONAL', h);
    expect(promoBlocked.permitted).toBe(false);
    if (!promoBlocked.permitted) expect(promoBlocked.reason).toContain('PROMOTIONAL_SENDS_PAUSED');
  });

  it('a hard-bounce breach marks the provider unhealthy but does NOT pause promotions by itself', () => {
    const h = channelHealth(stats({ hardBounces: 5_000 }));   // 5%
    expect(h.hardBounceRate).toBeGreaterThan(HARD_BOUNCE_RATE_THRESHOLD);
    expect(h.healthy).toBe(false);
    // a bounce problem is a list-hygiene or provider problem, not a signal that recipients
    // objected — so it drives failover rather than a promotional pause
    expect(h.promotionalPaused).toBe(false);
    expect(maySend('PROMOTIONAL', h).permitted).toBe(true);
  });

  it('the thresholds are the platform SINGLE definition', () => {
    expect(COMPLAINT_RATE_THRESHOLD).toBe(0.001);
    expect(HARD_BOUNCE_RATE_THRESHOLD).toBe(0.02);
  });

  it('COMPARES EXACT and rounds only for display, so a hair over the threshold still pauses', () => {
    // 1005 complaints in 1,000,000 delivered is 0.001005 — a genuine breach that would round to
    // 0.001 and escape a rounded comparison
    const h = channelHealth(stats({ attempted: 1_000_000, delivered: 1_000_000, complaints: 1_005 }));
    expect(h.promotionalPaused).toBe(true);
    expect(maySend('PROMOTIONAL', h).permitted).toBe(false);

    // and a hair under does not pause
    const under = channelHealth(stats({ attempted: 1_000_000, delivered: 1_000_000, complaints: 995 }));
    expect(under.promotionalPaused).toBe(false);
  });

  it('handles a provider with no traffic without dividing by zero', () => {
    const h = channelHealth(stats({ attempted: 0, delivered: 0, hardBounces: 0, complaints: 0 }));
    expect(h.deliveryRate).toBe(0);
    expect(h.complaintRate).toBe(0);
    expect(h.healthy).toBe(true);
  });
});

// ============================================ failover

describe('provider auto-failover records events (OUTPUTS)', () => {
  const weights = (): ProviderWeight[] => [
    { providerId: 'ESP-A', weight: 70 },
    { providerId: 'ESP-B', weight: 30 },
  ];

  it('moves weight off an unhealthy provider onto the healthiest remaining one', () => {
    const healths = [
      channelHealth(stats({ providerId: 'ESP-A', complaints: 500 })),
      channelHealth(stats({ providerId: 'ESP-B' })),
    ];
    const r = applyFailover('EMAIL', weights(), healths, NOW);

    expect(r.weights).toEqual([
      { providerId: 'ESP-A', weight: 0 },
      { providerId: 'ESP-B', weight: 100 },
    ]);
    // a weight that changed silently is a weight nobody can explain next quarter
    expect(r.events).toHaveLength(1);
    expect(r.events[0].fromProviderId).toBe('ESP-A');
    expect(r.events[0].toProviderId).toBe('ESP-B');
    expect(r.events[0].reason).toContain('COMPLAINT_RATE');
    expect(r.events[0].atMs).toBe(NOW);
  });

  it('picks the provider with the LOWEST complaint rate as the target', () => {
    const w: ProviderWeight[] = [
      { providerId: 'ESP-BAD', weight: 50 },
      { providerId: 'ESP-OK', weight: 25 },
      { providerId: 'ESP-BEST', weight: 25 },
    ];
    const healths = [
      channelHealth(stats({ providerId: 'ESP-BAD', complaints: 500 })),
      channelHealth(stats({ providerId: 'ESP-OK', complaints: 80 })),
      channelHealth(stats({ providerId: 'ESP-BEST', complaints: 5 })),
    ];
    const r = applyFailover('EMAIL', w, healths, NOW);
    expect(r.weights.find((x) => x.providerId === 'ESP-BEST')!.weight).toBe(75);
    expect(r.events[0].toProviderId).toBe('ESP-BEST');
  });

  it('LEAVES WEIGHTS ALONE when every provider is unhealthy', () => {
    const healths = [
      channelHealth(stats({ providerId: 'ESP-A', complaints: 500 })),
      channelHealth(stats({ providerId: 'ESP-B', complaints: 600 })),
    ];
    const r = applyFailover('EMAIL', weights(), healths, NOW);
    // shuffling traffic between equally bad providers achieves nothing and destroys the baseline
    // needed to tell which is recovering
    expect(r.weights).toEqual(weights());
    expect(r.events).toEqual([]);
  });

  it('does nothing when every provider is healthy', () => {
    const healths = [
      channelHealth(stats({ providerId: 'ESP-A' })),
      channelHealth(stats({ providerId: 'ESP-B' })),
    ];
    const r = applyFailover('EMAIL', weights(), healths, NOW);
    expect(r.weights).toEqual(weights());
    expect(r.events).toEqual([]);
  });

  it('skips an unhealthy provider that already carries no weight', () => {
    const w: ProviderWeight[] = [
      { providerId: 'ESP-A', weight: 100 },
      { providerId: 'ESP-DEAD', weight: 0 },
    ];
    const healths = [
      channelHealth(stats({ providerId: 'ESP-A' })),
      channelHealth(stats({ providerId: 'ESP-DEAD', complaints: 900 })),
    ];
    const r = applyFailover('EMAIL', w, healths, NOW);
    expect(r.events).toEqual([]);
    expect(r.weights.find((x) => x.providerId === 'ESP-A')!.weight).toBe(100);
  });
});

// ============================================ broadcasts

describe('a broadcast over 50,000 needs explicit confirmation (VALIDATION)', () => {
  const reg = () => {
    const r = new TemplateRegistry();
    r.save(promo(), 'MARKETING', SAMPLE);
    r.approve('TPL-DIWALI', 1, 'en-IN', 'ADM-1', NOW);
    return r;
  };

  const def = (over: Partial<BroadcastDefinition> = {}): BroadcastDefinition => ({
    broadcastId: 'BC-1',
    templateId: 'TPL-DIWALI',
    templateVersion: 1,
    category: 'PROMOTIONAL',
    channels: ['EMAIL'],
    segmentName: 'lapsed-90d',
    audienceSize: 10_000,
    scheduledForMs: NOW + 3_600_000,
    throttlePerMinute: 2_000,
    ...over,
  });

  it('launches a modest broadcast without confirmation', () => {
    const r = launchBroadcast(def(), reg(), [health()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.execution.totalQueued).toBe(10_000);
    expect(r.execution.estimatedMinutes).toBe(5);
  });

  it('REFUSES a large broadcast with no confirmation, and names the size', () => {
    const r = launchBroadcast(def({ audienceSize: 250_000 }), reg(), [health()]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // a broadcast is the one operation where a mis-typed segment reaches everybody before
      // anybody notices, and an undo does not exist
      const v = r.violations.find((x) => x.code.startsWith('BROADCAST_OVER_'))!;
      expect(v.detail).toBe('250000 recipients');
    }
  });

  it('launches once confirmed, naming who confirmed', () => {
    const r = launchBroadcast(
      def({ audienceSize: 250_000, sizeConfirmedByUserId: 'ADM-7' }), reg(), [health()]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.execution.totalQueued).toBe(250_000);
    expect(BROADCAST_CONFIRMATION_THRESHOLD).toBe(50_000);
  });

  it('the boundary is exact', () => {
    expect(launchBroadcast(def({ audienceSize: 50_000 }), reg(), [health()]).ok).toBe(true);
    expect(launchBroadcast(def({ audienceSize: 50_001 }), reg(), [health()]).ok).toBe(false);
  });

  it('refuses a broadcast on an UNAPPROVED template version', () => {
    const r = launchBroadcast(def({ templateVersion: 9 }), reg(), [health()]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((x) => x.code === 'TEMPLATE_VERSION_NOT_APPROVED_IN_ANY_LOCALE'))
        .toBe(true);
    }
  });

  it('a paused channel is reported as paused rather than silently dropped', () => {
    const paused = channelHealth(stats({ complaints: 500 }));
    const r = launchBroadcast(def({ channels: ['EMAIL', 'PUSH'] }), reg(), [paused]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const email = r.execution.perChannel.find((c) => c.channel === 'EMAIL')!;
    expect(email.paused).toBe(true);
    expect(email.queued).toBe(0);
    expect(email.pauseReason).toContain('PROMOTIONAL_SENDS_PAUSED');
    // the other channel still goes
    const push = r.execution.perChannel.find((c) => c.channel === 'PUSH')!;
    expect(push.paused).toBe(false);
    expect(push.queued).toBe(10_000);
    expect(r.execution.totalQueued).toBe(10_000);
  });

  it('a TRANSACTIONAL broadcast is not paused by a promotional pause', () => {
    const paused = channelHealth(stats({ complaints: 500 }));
    const reg2 = new TemplateRegistry();
    reg2.save(template({ templateId: 'TPL-OUTAGE', category: 'SECURITY' }), 'ADMIN', SAMPLE);
    reg2.approve('TPL-OUTAGE', 1, 'en-IN', 'ADM-1', NOW);

    const r = launchBroadcast(
      def({ templateId: 'TPL-OUTAGE', category: 'SECURITY' }), reg2, [paused]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.execution.perChannel[0].paused).toBe(false);
  });

  it('refuses no channels, a negative audience and a non-positive throttle', () => {
    expect(launchBroadcast(def({ channels: [] }), reg(), [health()]).ok).toBe(false);
    expect(launchBroadcast(def({ audienceSize: -1 }), reg(), [health()]).ok).toBe(false);
    expect(launchBroadcast(def({ throttlePerMinute: 0 }), reg(), [health()]).ok).toBe(false);
  });

  it('estimates the throttled duration', () => {
    const r = launchBroadcast(def({ audienceSize: 45_000, throttlePerMinute: 1_000 }), reg(), [health()]);
    if (r.ok) expect(r.execution.estimatedMinutes).toBe(45);
  });
});
