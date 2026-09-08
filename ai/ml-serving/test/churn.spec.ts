/**
 * FR-AI-011 churn prediction & win-back targeting. The suite is built around three ways of being
 * confidently wrong: a model that ranks well but is miscalibrated, a holdout that gets targeted,
 * and a stale score that drives a send.
 */
import { describe, expect, it } from 'vitest';
import {
  ABUSE_REDEMPTION_LIMIT,
  activationDecision,
  auc,
  audience,
  brierScore,
  clawbackDecision,
  cxPriority,
  designHoldout,
  MAX_BRIER,
  MAX_SCORE_AGE_MS,
  MIN_ARM_SIZE,
  MIN_AUC,
  retentionLift,
  runCycle,
  targetingDecision,
  type ChurnModel,
  type ChurnScore,
  type Features,
  type HoldoutAssignment,
  type LabelledScore,
  type WinBackBudget,
} from '../src/domain/churn.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const DAY = 24 * 3_600_000;

const features = (over: Partial<Features> = {}): Features => ({
  customerId: 'CUS-1',
  recencyDays: 75,
  frequency90d: 1,
  monetaryPaise: 250_000,
  engagementScore: 0.2,
  serviceIncidents90d: 1,
  consentMarketing: true,
  ...over,
});

const model: ChurnModel = (f) => ({
  probability: Math.min(0.99, f.recencyDays / 100),
  drivers: [
    { feature: 'recencyDays', contributionPct: 60, direction: 'INCREASES_RISK' },
    { feature: 'engagementScore', contributionPct: 25, direction: 'INCREASES_RISK' },
    { feature: 'frequency90d', contributionPct: 15, direction: 'REDUCES_RISK' },
  ],
});

/** A well-behaved holdout sample: confident and correct. */
const goodSamples = (): LabelledScore[] => [
  ...Array.from({ length: 50 }, () => ({ score: 0.85, churned: true })),
  ...Array.from({ length: 50 }, () => ({ score: 0.15, churned: false })),
];

const activated = () => activationDecision(goodSamples());

const score = (over: Partial<ChurnScore> = {}): ChurnScore => ({
  customerId: 'CUS-1',
  probability: 0.8,
  drivers: [],
  scoredAtMs: NOW,
  modelVersion: 'churn-v2',
  internalOnly: true,
  ...over,
});

const budget = (over: Partial<WinBackBudget> = {}): WinBackBudget => ({
  campaignId: 'WB-1',
  budgetPaise: 10_000_00,
  spentPaise: 0,
  maxIncentivePaise: 500_00,
  ...over,
});

// ============================================ the two gates

describe('discrimination and calibration are SEPARATE gates (VALIDATION)', () => {
  it('activates a model that passes both', () => {
    const d = activated();
    expect(d.activate).toBe(true);
    if (d.activate) {
      expect(d.auc).toBe(1);
      expect(d.brier).toBeLessThan(MAX_BRIER);
    }
  });

  it('REFUSES a model that ranks well but is badly CALIBRATED', () => {
    // perfect ordering — every churner scores above every non-churner — but the numbers are
    // nowhere near probabilities
    const wellRankedMiscalibrated: LabelledScore[] = [
      ...Array.from({ length: 50 }, () => ({ score: 0.60, churned: false })),
      ...Array.from({ length: 50 }, () => ({ score: 0.61, churned: true })),
    ];
    expect(auc(wellRankedMiscalibrated)).toBe(1);

    const d = activationDecision(wellRankedMiscalibrated);
    expect(d.activate).toBe(false);
    if (!d.activate && d.reason === 'CALIBRATION_BELOW_GATE') {
      // since the score sizes the incentive, an uncalibrated model overspends on customers who
      // were never going to leave
      expect(d.brier).toBeGreaterThan(MAX_BRIER);
      expect(d.gate).toBe(MAX_BRIER);
    } else {
      throw new Error('expected a calibration refusal, got ' + JSON.stringify(d));
    }
  });

  it('REFUSES a model that is calibrated on average but cannot rank', () => {
    // predicting the base rate for everyone: a respectable Brier, useless AUC
    const cannotRank: LabelledScore[] = [
      ...Array.from({ length: 20 }, () => ({ score: 0.2, churned: true })),
      ...Array.from({ length: 80 }, () => ({ score: 0.2, churned: false })),
    ];
    expect(auc(cannotRank)).toBe(0.5);
    const d = activationDecision(cannotRank);
    expect(d.activate).toBe(false);
    if (!d.activate && d.reason === 'AUC_BELOW_GATE') {
      expect(d.auc).toBe(0.5);
      expect(d.gate).toBe(MIN_AUC);
    } else {
      throw new Error('expected an AUC refusal');
    }
  });

  it('the AUC gate boundary is inclusive', () => {
    expect(MIN_AUC).toBe(0.75);
    // construct exactly 0.75: 3 of 4 pairs concordant
    const samples: LabelledScore[] = [
      { score: 0.9, churned: true }, { score: 0.4, churned: true },
      { score: 0.5, churned: false }, { score: 0.1, churned: false },
    ];
    expect(auc(samples)).toBe(0.75);
    // and with a calibration good enough to pass, activation succeeds at the boundary
    expect(activationDecision(samples).activate).toBe(true);
  });

  it('computes AUC pairwise with ties at half', () => {
    expect(auc([{ score: 0.5, churned: true }, { score: 0.5, churned: false }])).toBe(0.5);
    expect(auc([{ score: 0.9, churned: true }, { score: 0.1, churned: false }])).toBe(1);
    expect(auc([{ score: 0.1, churned: true }, { score: 0.9, churned: false }])).toBe(0);
  });

  it('returns null rather than a number when one class is absent', () => {
    expect(auc([{ score: 0.5, churned: true }])).toBeNull();
    expect(auc([])).toBeNull();
    expect(brierScore([])).toBeNull();
    const d = activationDecision([{ score: 0.5, churned: true }]);
    expect(d.activate).toBe(false);
    if (!d.activate) expect(d.reason).toBe('NO_HOLDOUT_LABELS');
  });

  it('computes the Brier score as mean squared error', () => {
    expect(brierScore([{ score: 1, churned: true }, { score: 0, churned: false }])).toBe(0);
    expect(brierScore([{ score: 0.5, churned: true }, { score: 0.5, churned: false }])).toBe(0.25);
    expect(brierScore([{ score: 0, churned: true }])).toBe(1);
  });
});

// ============================================ scoring cycle

describe('a feature-pipeline gap SKIPS the cycle (ERRORS)', () => {
  it('produces no scores and alerts, naming the missing feeds', () => {
    const r = runCycle([features()], model, { missingFeeds: ['engagementScore'] },
      activated(), 'churn-v2', NOW);
    expect(r.outcome).toBe('SKIPPED');
    if (r.outcome !== 'SKIPPED') return;
    expect(r.missingFeeds).toEqual(['engagementScore']);
    expect(r.alert).toContain('engagementScore');
    // scoring on partial features would produce confident numbers built from absent evidence,
    // and those numbers would then size real incentives
    expect(r.alert).toContain('No scores were produced');
  });

  it('scores normally when every feed landed', () => {
    const r = runCycle([features(), features({ customerId: 'CUS-2', recencyDays: 5 })],
      model, { missingFeeds: [] }, activated(), 'churn-v2', NOW);
    expect(r.outcome).toBe('SCORED');
    if (r.outcome !== 'SCORED') return;
    expect(r.scores).toHaveLength(2);
    expect(r.scores[0].probability).toBe(0.75);
    expect(r.scores[1].probability).toBe(0.05);
    expect(r.scores[0].internalOnly).toBe(true);
  });

  it('refuses to run at all when the model was never activated', () => {
    const notActivated = activationDecision([{ score: 0.2, churned: true }, { score: 0.9, churned: false }]);
    const r = runCycle([features()], model, { missingFeeds: [] }, notActivated, 'churn-v2', NOW);
    expect(r.outcome).toBe('BLOCKED');
    if (r.outcome === 'BLOCKED') expect(r.reason).toContain('MODEL_NOT_ACTIVATED');
  });

  it('keeps only the top three drivers, strongest first', () => {
    const r = runCycle([features()], model, { missingFeeds: [] }, activated(), 'churn-v2', NOW);
    if (r.outcome !== 'SCORED') throw new Error('expected scores');
    const drivers = r.scores[0].drivers;
    expect(drivers).toHaveLength(3);
    expect(drivers[0].feature).toBe('recencyDays');
    expect(drivers[0].contributionPct).toBeGreaterThan(drivers[1].contributionPct);
  });

  it('a per-customer model failure skips that customer, not the cycle', () => {
    const flaky: ChurnModel = (f) => {
      if (f.customerId === 'CUS-BAD') throw new Error('feature lookup failed');
      return { probability: 0.5, drivers: [] };
    };
    const r = runCycle(
      [features({ customerId: 'CUS-1' }), features({ customerId: 'CUS-BAD' }), features({ customerId: 'CUS-3' })],
      flaky, { missingFeeds: [] }, activated(), 'churn-v2', NOW);
    if (r.outcome !== 'SCORED') throw new Error('expected scores');
    expect(r.scores.map((s) => s.customerId)).toEqual(['CUS-1', 'CUS-3']);
  });

  it('an out-of-range probability is dropped rather than clamped into plausibility', () => {
    const rogue: ChurnModel = () => ({ probability: 1.4, drivers: [] });
    const r = runCycle([features()], rogue, { missingFeeds: [] }, activated(), 'churn-v2', NOW);
    if (r.outcome !== 'SCORED') throw new Error('expected scores');
    expect(r.scores).toEqual([]);

    const nan: ChurnModel = () => ({ probability: Number.NaN, drivers: [] });
    const r2 = runCycle([features()], nan, { missingFeeds: [] }, activated(), 'churn-v2', NOW);
    if (r2.outcome === 'SCORED') expect(r2.scores).toEqual([]);
  });
});

// ============================================ holdout design

describe('the holdout is deterministic and withheld from targeting (OUTPUTS)', () => {
  const ids = Array.from({ length: 1_000 }, (_, i) => `CUS-${i}`);

  it('splits roughly to the requested fraction', () => {
    const a = designHoldout('WB-1', ids, 0.1);
    expect(a.holdout.size).toBeGreaterThan(60);
    expect(a.holdout.size).toBeLessThan(140);
    expect(a.holdout.size + a.targetable.length).toBe(1_000);
  });

  it('is DETERMINISTIC, so re-running cannot move a customer mid-flight', () => {
    const first = designHoldout('WB-1', ids, 0.2);
    const second = designHoldout('WB-1', [...ids].reverse(), 0.2);
    expect([...second.holdout].sort()).toEqual([...first.holdout].sort());
  });

  it('a different campaign gets a different split, so the same customers are not always held out', () => {
    const a = designHoldout('WB-1', ids, 0.2);
    const b = designHoldout('WB-2', ids, 0.2);
    expect([...b.holdout].sort()).not.toEqual([...a.holdout].sort());
  });

  it('clamps an absurd fraction rather than holding out everyone', () => {
    expect(designHoldout('WB-1', ids, 5).holdoutFraction).toBe(0.5);
    expect(designHoldout('WB-1', ids, -1).holdoutFraction).toBe(0);
    expect(designHoldout('WB-1', ids, 0).holdout.size).toBe(0);
  });
});

// ============================================ targeting

describe('targeting guards, in a deliberate order (RULES / ERRORS)', () => {
  const assignment = designHoldout('WB-1', ['CUS-1', 'CUS-2', 'CUS-3'], 0);

  it('targets a consented, at-risk, in-date customer and scales the incentive with risk', () => {
    const d = targetingDecision(score({ probability: 0.8 }), features(), assignment, budget(), 0.5, NOW);
    expect(d.target).toBe(true);
    if (d.target) expect(d.incentivePaise).toBe(400_00);   // 80% of the 500 ceiling
  });

  it('REFUSES a customer without marketing consent, whatever their risk', () => {
    const d = targetingDecision(score({ probability: 0.99 }),
      features({ consentMarketing: false }), assignment, budget(), 0.5, NOW);
    expect(d.target).toBe(false);
    if (!d.target) expect(d.reason).toBe('NO_MARKETING_CONSENT');
  });

  it('REFUSES a stale score, so last month behaviour cannot drive a send', () => {
    const stale = score({ scoredAtMs: NOW - MAX_SCORE_AGE_MS - 1 });
    const d = targetingDecision(stale, features(), assignment, budget(), 0.5, NOW);
    expect(d.target).toBe(false);
    // a win-back discount on stale behaviour reaches customers who have since bought happily
    if (!d.target) expect(d.reason).toBe('SCORE_STALE_NO_SEND');

    const fresh = score({ scoredAtMs: NOW - MAX_SCORE_AGE_MS });
    expect(targetingDecision(fresh, features(), assignment, budget(), 0.5, NOW).target).toBe(true);
  });

  it('REFUSES a holdout member, so the lift stays measurable', () => {
    // built explicitly rather than via designHoldout, which correctly clamps the fraction to 0.5
    // and so cannot be coerced into holding out a single-member population
    const held: HoldoutAssignment = {
      campaignId: 'WB-1', holdoutFraction: 0.1, holdout: new Set(['CUS-1']), targetable: [],
    };
    const d = targetingDecision(score(), features(), held, budget(), 0.5, NOW);
    expect(d.target).toBe(false);
    if (!d.target) expect(d.reason).toBe('IN_MEASUREMENT_HOLDOUT');
  });

  it('a holdout member consumes NO budget, because the check precedes the spend', () => {
    const held: HoldoutAssignment = {
      campaignId: 'WB-1', holdoutFraction: 0.1, holdout: new Set(['CUS-1']), targetable: [],
    };
    // even with the budget already almost exhausted, the reason is the holdout rather than money
    const d = targetingDecision(score(), features(), held,
      budget({ spentPaise: 9_999_00 }), 0.5, NOW);
    if (!d.target) expect(d.reason).toBe('IN_MEASUREMENT_HOLDOUT');
  });

  it('refuses below the risk threshold', () => {
    const d = targetingDecision(score({ probability: 0.2 }), features(), assignment, budget(), 0.5, NOW);
    expect(d.target).toBe(false);
    if (!d.target) expect(d.reason).toBe('BELOW_RISK_THRESHOLD');
  });

  it('refuses once the win-back budget is exhausted', () => {
    const d = targetingDecision(score({ probability: 0.9 }), features(), assignment,
      budget({ budgetPaise: 100_00, spentPaise: 90_00 }), 0.5, NOW);
    expect(d.target).toBe(false);
    if (!d.target) expect(d.reason).toBe('WIN_BACK_BUDGET_EXHAUSTED');
  });

  it('caps the incentive at the per-customer ceiling', () => {
    const d = targetingDecision(score({ probability: 0.99 }), features(), assignment,
      budget({ maxIncentivePaise: 200_00 }), 0.5, NOW);
    if (d.target) expect(d.incentivePaise).toBeLessThanOrEqual(200_00);
  });
});

// ============================================ clawback

describe('clawback on abuse patterns (RULES)', () => {
  const clean = { ordersReturnedAfterIncentive: 0, incentivesRedeemedLast90d: 1, sharedInstrumentWithOtherAccounts: false };

  it('claws back a shared payment instrument across accounts', () => {
    const d = clawbackDecision({ ...clean, sharedInstrumentWithOtherAccounts: true });
    expect(d.clawback).toBe(true);
    if (d.clawback) expect(d.reason).toBe('SHARED_INSTRUMENT_ACROSS_ACCOUNTS');
  });

  it('claws back excessive redemption', () => {
    const d = clawbackDecision({ ...clean, incentivesRedeemedLast90d: ABUSE_REDEMPTION_LIMIT + 1 });
    expect(d.clawback).toBe(true);
    if (d.clawback) expect(d.reason).toBe('EXCESSIVE_INCENTIVE_REDEMPTION');
    expect(clawbackDecision({ ...clean, incentivesRedeemedLast90d: ABUSE_REDEMPTION_LIMIT }).clawback).toBe(false);
  });

  it('claws back when every incentivised order came back', () => {
    // the discount was the purchase, not the product
    const d = clawbackDecision({ ordersReturnedAfterIncentive: 2, incentivesRedeemedLast90d: 2, sharedInstrumentWithOtherAccounts: false });
    expect(d.clawback).toBe(true);
    if (d.clawback) expect(d.reason).toBe('ALL_INCENTIVISED_ORDERS_RETURNED');
  });

  it('does NOT claw back an ordinary single return', () => {
    expect(clawbackDecision({ ordersReturnedAfterIncentive: 1, incentivesRedeemedLast90d: 3, sharedInstrumentWithOtherAccounts: false })
      .clawback).toBe(false);
    expect(clawbackDecision(clean).clawback).toBe(false);
  });
});

// ============================================ audience ordering

describe('audience ordering is high-risk-HIGH-VALUE first (OUTPUTS)', () => {
  it('orders by the money actually at risk, not by risk alone', () => {
    const scores = [
      score({ customerId: 'CUS-CHEAP', probability: 0.95 }),
      score({ customerId: 'CUS-RICH', probability: 0.60 }),
    ];
    const ltv = { 'CUS-CHEAP': 100_00, 'CUS-RICH': 50_000_00 };
    const list = audience(scores, ltv, 0.5);

    // risk alone would put effort behind the customer who was cheap to lose
    expect(list[0].customerId).toBe('CUS-RICH');
    expect(list[0].priority).toBe(Math.round(0.6 * 50_000_00));
    expect(list[1].customerId).toBe('CUS-CHEAP');
  });

  it('excludes customers below the risk threshold', () => {
    const scores = [score({ customerId: 'A', probability: 0.9 }), score({ customerId: 'B', probability: 0.1 })];
    expect(audience(scores, { A: 1000, B: 999_999 }, 0.5).map((m) => m.customerId)).toEqual(['A']);
  });

  it('treats a missing LTV as zero rather than throwing', () => {
    const list = audience([score({ customerId: 'A', probability: 0.9 })], {}, 0.5);
    expect(list[0].lifetimeValuePaise).toBe(0);
    expect(list[0].priority).toBe(0);
  });
});

// ============================================ lift reporting

describe('retention lift reports raw rates and flags underpowered arms (OUTPUTS)', () => {
  it('computes the incremental effect in percentage points', () => {
    const r = retentionLift('WB-1', { retained: 620, total: 1_000 }, { retained: 550, total: 1_000 });
    expect(r.targetedRate).toBe(0.62);
    expect(r.holdoutRate).toBe(0.55);
    expect(r.liftPts).toBe(7);
    expect(r.underpowered).toBe(false);
  });

  it('reports a NEGATIVE lift honestly rather than flooring at zero', () => {
    const r = retentionLift('WB-1', { retained: 500, total: 1_000 }, { retained: 560, total: 1_000 });
    expect(r.liftPts).toBe(-6);
  });

  it('flags an underpowered comparison rather than presenting it as a result', () => {
    const r = retentionLift('WB-1', { retained: 8, total: 10 }, { retained: 4, total: 10 });
    expect(r.liftPts).toBe(40);
    // a difference of two small numbers is not a finding
    expect(r.underpowered).toBe(true);
    expect(MIN_ARM_SIZE).toBe(100);
  });

  it('flags underpowered when only ONE arm is small', () => {
    expect(retentionLift('WB-1', { retained: 600, total: 1_000 }, { retained: 5, total: 10 })
      .underpowered).toBe(true);
  });

  it('handles an empty arm without dividing by zero', () => {
    const r = retentionLift('WB-1', { retained: 0, total: 0 }, { retained: 0, total: 0 });
    expect(r.targetedRate).toBe(0);
    expect(r.holdoutRate).toBe(0);
    expect(r.liftPts).toBe(0);
    expect(r.underpowered).toBe(true);
  });
});

// ============================================ CX prioritisation

describe('CX prioritisation does not require marketing consent (DESC)', () => {
  it('prioritises by risk and ticket age together', () => {
    expect(cxPriority(score({ probability: 0.9 }), 24)).toBe(114);
    expect(cxPriority(score({ probability: 0.1 }), 24)).toBe(34);
  });

  it('caps the ticket-age contribution so an old ticket cannot dominate entirely', () => {
    expect(cxPriority(score({ probability: 0.5 }), 500)).toBe(50 + 72);
  });

  it('a non-consenting customer still gets prioritised support', () => {
    // a support queue ordering is not a marketing communication, and refusing to prioritise a
    // non-consenting customer's ticket would punish them for declining offers
    const s = score({ probability: 0.9 });
    expect(cxPriority(s, 10)).toBeGreaterThan(cxPriority(score({ probability: 0.1 }), 10));
  });
});
