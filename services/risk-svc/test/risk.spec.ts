/**
 * FR-AI-010 as tests, with special attention to the two structural safety invariants, plus
 * a cross-slice proof that this engine's score is the `fraudScore` the Slice-3 quote engine
 * uses for the BRU-05 COD gate (previously a pre-computed input).
 */
import { describe, expect, it } from 'vitest';
import {
  decide,
  DEFAULT_THRESHOLDS,
  evaluateRules,
  REPEAT_OFFENDER_STRIKES,
  ruleScoreFrom,
  toEvent,
  type RiskModel,
  type RiskSignals,
} from '../src/domain/risk.js';
import { createQuote, hashQuoteId, type CheckoutLine } from '../../cart-checkout-svc/src/domain/checkout/quote.js';

const clean = (over: Partial<RiskSignals> = {}): RiskSignals => ({
  amountPaise: 100_000, accountAgeDays: 400, ordersLastHour: 1, failedPaymentsLastHour: 0,
  distinctInstrumentsLastDay: 1, codRefusalsLast90d: 0, promoRedemptionsLastDay: 0,
  returnsLast90d: 0, ordersLast90d: 10, devicesLast30d: 1, priorStrikes: 0, ...over,
});

describe('velocity rules are interpretable', () => {
  it('a clean profile produces no hits and ALLOW', () => {
    const d = decide('PAYMENT', clean());
    expect(d.reasons).toHaveLength(0);
    expect(d.action).toBe('ALLOW');
    expect(d.score).toBe(0);
  });

  it('card-testing velocity fires with a human-readable reason', () => {
    const hits = evaluateRules('PAYMENT', clean({ failedPaymentsLastHour: 4 }));
    expect(hits.map((h) => h.code)).toContain('CARD_TESTING_VELOCITY');
    expect(hits.find((h) => h.code === 'CARD_TESTING_VELOCITY')!.description).toContain('4 failed payment attempts');
  });

  it('flow-specific rules only fire in their flow', () => {
    const codSignals = clean({ codRefusalsLast90d: 3 });
    expect(evaluateRules('COD_ORDER', codSignals).map((h) => h.code)).toContain('COD_REFUSAL_HISTORY');
    expect(evaluateRules('PAYMENT', codSignals).map((h) => h.code)).not.toContain('COD_REFUSAL_HISTORY');
  });

  it('self-referral match is a strong referral signal', () => {
    const hits = evaluateRules('REFERRAL', clean({ selfReferralMatch: true }));
    expect(hits.map((h) => h.code)).toContain('SELF_REFERRAL_MATCH');
  });

  it('serial returner needs both volume and a high rate', () => {
    expect(evaluateRules('RETURN', clean({ ordersLast90d: 3, returnsLast90d: 3 })).map((h) => h.code))
      .not.toContain('SERIAL_RETURNER');                       // too few orders to conclude
    expect(evaluateRules('RETURN', clean({ ordersLast90d: 10, returnsLast90d: 7 })).map((h) => h.code))
      .toContain('SERIAL_RETURNER');
  });

  it('repeat-offender strikes fire at the configured count', () => {
    expect(evaluateRules('PAYMENT', clean({ priorStrikes: REPEAT_OFFENDER_STRIKES - 1 })).map((h) => h.code))
      .not.toContain('REPEAT_OFFENDER');
    expect(evaluateRules('PAYMENT', clean({ priorStrikes: REPEAT_OFFENDER_STRIKES })).map((h) => h.code))
      .toContain('REPEAT_OFFENDER');
  });

  it('rule score is a saturating noisy-OR bounded by 1', () => {
    expect(ruleScoreFrom([])).toBe(0);
    expect(ruleScoreFrom([{ code: 'A', description: '', weight: 0.5 }])).toBeCloseTo(0.5, 10);
    expect(ruleScoreFrom([
      { code: 'A', description: '', weight: 0.5 },
      { code: 'B', description: '', weight: 0.5 },
    ])).toBeCloseTo(0.75, 10);                                  // 0.5 + 0.5×0.5
    const many = Array.from({ length: 20 }, (_, i) => ({ code: `R${i}`, description: '', weight: 0.9 }));
    expect(ruleScoreFrom(many)).toBeLessThanOrEqual(1);
  });
});

describe('INVARIANT 1 — no black-box denial (VALIDATION)', () => {
  it('DEFENCE IN DEPTH, layer 1: the weighting alone stops a model-only score reaching deny', () => {
    const blackBox: RiskModel = () => 1.0;
    const d = decide('PAYMENT', clean(), blackBox);           // clean profile ⇒ zero rule hits
    expect(d.reasons).toHaveLength(0);
    expect(d.modelScore).toBe(1.0);
    // MODEL_WEIGHT caps a rules-free score at 0.4, far below the 0.85 deny threshold
    expect(d.score).toBeCloseTo(0.4, 10);
    expect(d.score).toBeLessThan(DEFAULT_THRESHOLDS.PAYMENT.deny);
    expect(d.action).toBe('STEP_UP');
    expect(d.action).not.toBe('DENY');
  });

  it('DEFENCE IN DEPTH, layer 2: even with thresholds a model-only score COULD clear, deny is refused', () => {
    const blackBox: RiskModel = () => 1.0;
    // deliberately mis-configured thresholds where 0.4 clears deny — the invariant must hold
    const permissive = { stepUp: 0.1, holdReview: 0.2, deny: 0.3, autoDenyMonetaryCapPaise: 10_000_000_00 };
    const d = decide('PAYMENT', clean(), blackBox, permissive);
    expect(d.reasons).toHaveLength(0);
    expect(d.score).toBeGreaterThanOrEqual(permissive.deny);   // thresholds WOULD deny
    expect(d.action).toBe('HOLD_REVIEW');                      // but there is no reason to cite
    expect(d.escalationNote).toBe('DENY_WITHOUT_INTERPRETABLE_REASON_ESCALATED_TO_REVIEW');
  });

  it('the same score WITH an interpretable reason may deny', () => {
    const blackBox: RiskModel = () => 1.0;
    // small amount so the monetary cap does not intervene; strong rule hits present
    const d = decide('REFERRAL', clean({
      amountPaise: 50_000, selfReferralMatch: true, priorStrikes: 3,
    }), blackBox, DEFAULT_THRESHOLDS.REFERRAL);
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.action).toBe('DENY');
    expect(d.escalationNote).toBeUndefined();
  });
});

describe('INVARIANT 2 — above the monetary cap, auto-deny becomes a human hold (RULES)', () => {
  it('a deny-worthy case above the cap escalates instead of denying', () => {
    const signals = clean({
      amountPaise: DEFAULT_THRESHOLDS.PAYMENT.autoDenyMonetaryCapPaise + 1,
      accountAgeDays: 0, failedPaymentsLastHour: 5, distinctInstrumentsLastDay: 6, priorStrikes: 4,
    });
    const d = decide('PAYMENT', signals);
    expect(d.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.PAYMENT.deny);
    expect(d.reasons.length).toBeGreaterThan(0);               // interpretable reasons exist
    expect(d.action).toBe('HOLD_REVIEW');                      // but the cap forbids auto-deny
    expect(d.escalationNote).toBe('ABOVE_MONETARY_CAP_ESCALATED_TO_HUMAN_HOLD');
  });

  it('the identical case at or below the cap does deny', () => {
    const signals = clean({
      amountPaise: DEFAULT_THRESHOLDS.PAYMENT.autoDenyMonetaryCapPaise,
      accountAgeDays: 0, failedPaymentsLastHour: 5, distinctInstrumentsLastDay: 6, priorStrikes: 4,
    });
    const d = decide('PAYMENT', signals);
    expect(d.action).toBe('DENY');
  });
});

describe('action ladder and per-flow thresholds', () => {
  it('walks ALLOW → STEP_UP → HOLD_REVIEW as risk accumulates', () => {
    const allow = decide('PAYMENT', clean());
    expect(allow.action).toBe('ALLOW');

    const stepUp = decide('PAYMENT', clean({ devicesLast30d: 7, ordersLastHour: 7 }));
    expect(['STEP_UP', 'HOLD_REVIEW']).toContain(stepUp.action);
    expect(stepUp.score).toBeGreaterThan(allow.score);

    const hold = decide('PAYMENT', clean({
      failedPaymentsLastHour: 4, distinctInstrumentsLastDay: 5, devicesLast30d: 7,
    }));
    expect(['HOLD_REVIEW', 'DENY']).toContain(hold.action);
    expect(hold.score).toBeGreaterThan(stepUp.score);
  });

  it('thresholds differ per flow, so the same score can decide differently', () => {
    expect(DEFAULT_THRESHOLDS.REFERRAL.deny).toBeLessThan(DEFAULT_THRESHOLDS.RETURN.deny);
    expect(DEFAULT_THRESHOLDS.COD_ORDER.autoDenyMonetaryCapPaise)
      .toBeLessThan(DEFAULT_THRESHOLDS.PAYMENT.autoDenyMonetaryCapPaise);
  });
});

describe('model failure tolerance', () => {
  it('a throwing model degrades to rules-only and never fabricates a score', () => {
    const broken: RiskModel = () => { throw new Error('model down'); };
    const d = decide('PAYMENT', clean({ failedPaymentsLastHour: 4 }), broken);
    expect(d.modelScore).toBeNull();
    expect(d.score).toBe(d.ruleScore);
    expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('an out-of-range model output is ignored rather than trusted', () => {
    const rogue: RiskModel = () => 42;
    const d = decide('PAYMENT', clean(), rogue);
    expect(d.modelScore).toBeNull();
    expect(d.score).toBe(d.ruleScore);
  });
});

describe('risk.decision.v1 event shape', () => {
  it('carries the action, rounded score and reason codes', () => {
    const d = decide('COD_ORDER', clean({ codRefusalsLast90d: 3 }));
    const e = toEvent(d, 'CUSTOMER', '01CUS000000000000000000001');
    expect(e.flow).toBe('COD_ORDER');
    expect(e.reasonCodes).toContain('COD_REFUSAL_HISTORY');
    expect(e.score).toBeCloseTo(d.score, 3);
    expect(e.subjectType).toBe('CUSTOMER');
  });
});

describe('cross-slice: the risk score IS the quote engine fraudScore (BRU-05 COD gate)', () => {
  const line = (over: Partial<CheckoutLine> = {}): CheckoutLine => ({
    lineId: 'L1', listingId: 'LST1', vendorId: 'V1', categoryId: 'CAT1', qty: 1,
    unitListPaise: 50_000, availableStock: 10, serviceablePin: true, taxBps: 0, ...over,
  });

  it('a clean customer gets COD; a COD-abusing customer is forced to prepaid', () => {
    const cleanDecision = decide('COD_ORDER', clean({ amountPaise: 50_000 }));
    const goodQuote = createQuote({
      cartId: 'C1', customerId: 'CU1', addressPin: '641012', lines: [line()], coupons: [],
      requestedPaymentMethod: 'COD', fraudScore: cleanDecision.score, codFraudThreshold: 0.7,
      nowMs: Date.UTC(2026, 7, 15),
    }, hashQuoteId);
    expect(goodQuote.ok).toBe(true);
    if (goodQuote.ok) expect(goodQuote.quote.paymentMethod).toBe('COD');

    // a customer with COD refusals plus velocity: the engine's own score drives the gate
    const risky = decide('COD_ORDER', clean({
      amountPaise: 50_000, codRefusalsLast90d: 4, failedPaymentsLastHour: 4, priorStrikes: 3,
    }));
    expect(risky.score).toBeGreaterThanOrEqual(0.7);
    const badQuote = createQuote({
      cartId: 'C2', customerId: 'CU2', addressPin: '641012', lines: [line()], coupons: [],
      requestedPaymentMethod: 'COD', fraudScore: risky.score, codFraudThreshold: 0.7,
      nowMs: Date.UTC(2026, 7, 15),
    }, hashQuoteId);
    expect(badQuote.ok).toBe(true);
    if (badQuote.ok) {
      expect(badQuote.quote.codEligible).toBe(false);
      expect(badQuote.quote.codReasons).toContain('FRAUD_SCORE_ABOVE_THRESHOLD');
      expect(badQuote.quote.paymentMethod).toBe('PREPAID');
    }
  });
});
