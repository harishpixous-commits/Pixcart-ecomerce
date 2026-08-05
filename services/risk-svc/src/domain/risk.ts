/**
 * Fraud detection & risk scoring — FR-AI-010.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "score risk in real time (< 150 ms p95) for payment attempts, COD orders,
 *                promo redemptions, referrals, returns and vendor behaviours, combining
 *                velocity rules and ML models, producing actions {allow, step-up,
 *                hold-review, deny} with explainable reason codes."
 *   RULES:      "Customer-visible friction budget: step-up rate cap per cohort monitored;
 *                auto-decisions above monetary cap escalate to human hold instead of deny."
 *   VALIDATION: "Deny requires ≥ threshold + at least one interpretable rule/feature reason;
 *                thresholds per flow with FIN/Risk sign-off."
 *   FR-ADM-012 RULES: "repeat-offender policy engine (3 strikes configurable)."
 *   Vol.5 §5.5: producer of risk.decision.v1.
 *
 * This module is the producer of the `fraudScore` that the FR-CUS-014 quote engine and the
 * FR-LOG-001 COD gate consume — until now a pre-computed input.
 *
 * TWO SAFETY INVARIANTS ARE STRUCTURAL, not advisory:
 *   1. NO BLACK-BOX DENIAL. A denial requires the score to clear the threshold AND at least
 *      one interpretable rule hit. A high ML score with no explainable reason can never
 *      deny — it escalates to human review instead. This is enforced in one place and
 *      cannot be bypassed by tuning weights.
 *   2. MONETARY-CAP ESCALATION. Above the configured amount, an automatic decision may not
 *      deny; it becomes a human hold.
 *
 * The ML model is INJECTED (like the recommendation ranker), so it can be swapped or
 * shadowed without touching the decision logic, and every test here runs without a model.
 */

export type Flow = 'PAYMENT' | 'COD_ORDER' | 'PROMO_REDEMPTION' | 'REFERRAL' | 'RETURN' | 'VENDOR_BEHAVIOUR';

export type Action = 'ALLOW' | 'STEP_UP' | 'HOLD_REVIEW' | 'DENY';

/** Interpretable facts the velocity rules read. All are counts/ages, never opaque vectors. */
export interface RiskSignals {
  amountPaise: number;
  accountAgeDays: number;
  ordersLastHour: number;
  failedPaymentsLastHour: number;
  distinctInstrumentsLastDay: number;
  codRefusalsLast90d: number;
  promoRedemptionsLastDay: number;
  returnsLast90d: number;
  ordersLast90d: number;
  devicesLast30d: number;
  /** Self-referral detection: referrer and referee share device / instrument / address. */
  selfReferralMatch?: boolean;
  /** FR-ADM-012 repeat-offender counter. */
  priorStrikes: number;
}

/** An interpretable reason code — the "at least one" a denial must cite. */
export interface RuleHit {
  code: string;
  description: string;
  /** Contribution to the rule score, 0..1. */
  weight: number;
}

/** Per-flow thresholds (FIN/Risk sign-off; these are the defaults). */
export interface FlowThresholds {
  stepUp: number;
  holdReview: number;
  deny: number;
  /** Above this amount an automatic decision may not deny (RULES). */
  autoDenyMonetaryCapPaise: number;
}

export const DEFAULT_THRESHOLDS: Record<Flow, FlowThresholds> = {
  PAYMENT:          { stepUp: 0.35, holdReview: 0.60, deny: 0.85, autoDenyMonetaryCapPaise: 50_000 * 100 },
  COD_ORDER:        { stepUp: 0.30, holdReview: 0.55, deny: 0.80, autoDenyMonetaryCapPaise: 10_000 * 100 },
  PROMO_REDEMPTION: { stepUp: 0.40, holdReview: 0.65, deny: 0.85, autoDenyMonetaryCapPaise: 5_000 * 100 },
  REFERRAL:         { stepUp: 0.40, holdReview: 0.60, deny: 0.75, autoDenyMonetaryCapPaise: 2_000 * 100 },
  RETURN:           { stepUp: 0.40, holdReview: 0.65, deny: 0.90, autoDenyMonetaryCapPaise: 25_000 * 100 },
  VENDOR_BEHAVIOUR: { stepUp: 0.35, holdReview: 0.60, deny: 0.85, autoDenyMonetaryCapPaise: 100_000 * 100 },
};

export const REPEAT_OFFENDER_STRIKES = 3;   // FR-ADM-012, configurable

/** The ML model, injected. Returns 0..1; throwing degrades to rules-only, never to deny. */
export type RiskModel = (flow: Flow, signals: RiskSignals) => number;

export interface RiskDecision {
  flow: Flow;
  action: Action;
  /** Final blended score, 0..1 — this is the `fraudScore` downstream flows consume. */
  score: number;
  ruleScore: number;
  modelScore: number | null;   // null when no model ran (or it failed)
  reasons: RuleHit[];
  /** Set when an invariant changed what the raw thresholds would have decided. */
  escalationNote?: string;
}

/** Weight split between interpretable rules and the model in the blended score. */
export const RULE_WEIGHT = 0.6;
export const MODEL_WEIGHT = 0.4;

/**
 * Velocity + heuristic rules per flow. Each returns interpretable hits; nothing here is
 * opaque, which is what makes a lawful denial possible.
 */
export function evaluateRules(flow: Flow, s: RiskSignals): RuleHit[] {
  const hits: RuleHit[] = [];
  const add = (code: string, description: string, weight: number) => hits.push({ code, description, weight });

  // ---- cross-flow signals ----
  if (s.accountAgeDays < 1 && s.amountPaise > 20_000 * 100) {
    add('NEW_ACCOUNT_HIGH_VALUE', 'Account under 1 day old attempting a high-value transaction', 0.45);
  }
  if (s.failedPaymentsLastHour >= 3) {
    add('CARD_TESTING_VELOCITY', `${s.failedPaymentsLastHour} failed payment attempts in the last hour`, 0.5);
  }
  if (s.distinctInstrumentsLastDay >= 4) {
    add('INSTRUMENT_CYCLING', `${s.distinctInstrumentsLastDay} distinct payment instruments in 24 h`, 0.4);
  }
  if (s.ordersLastHour >= 6) {
    add('ORDER_VELOCITY', `${s.ordersLastHour} orders in the last hour`, 0.3);
  }
  if (s.devicesLast30d >= 6) {
    add('DEVICE_SPRAY', `${s.devicesLast30d} distinct devices in 30 days`, 0.25);
  }
  if (s.priorStrikes >= REPEAT_OFFENDER_STRIKES) {
    add('REPEAT_OFFENDER', `${s.priorStrikes} prior confirmed abuse strikes`, 0.5);
  }

  // ---- flow-specific ----
  switch (flow) {
    case 'COD_ORDER':
      if (s.codRefusalsLast90d >= 2) {
        add('COD_REFUSAL_HISTORY', `${s.codRefusalsLast90d} refused COD deliveries in 90 days`, 0.5);
      }
      break;
    case 'PROMO_REDEMPTION':
      if (s.promoRedemptionsLastDay >= 5) {
        add('PROMO_VELOCITY', `${s.promoRedemptionsLastDay} promo redemptions in 24 h`, 0.45);
      }
      break;
    case 'REFERRAL':
      if (s.selfReferralMatch) {
        add('SELF_REFERRAL_MATCH', 'Referrer and referee share a device, instrument or address', 0.8);
      }
      break;
    case 'RETURN': {
      const rate = s.ordersLast90d > 0 ? s.returnsLast90d / s.ordersLast90d : 0;
      if (s.ordersLast90d >= 5 && rate >= 0.6) {
        add('SERIAL_RETURNER', `Return rate ${Math.round(rate * 100)}% over ${s.ordersLast90d} orders`, 0.45);
      }
      break;
    }
    default:
      break;
  }
  return hits;
}

/** Rule score: saturating sum so several moderate hits can matter without exceeding 1. */
export function ruleScoreFrom(hits: RuleHit[]): number {
  const combined = hits.reduce((acc, h) => acc + (1 - acc) * h.weight, 0);  // noisy-OR
  return Math.min(1, combined);
}

/**
 * Decide. Order: rules → model (optional, failure-tolerant) → blend → threshold → then the
 * two structural invariants, which can only ever REDUCE severity below deny.
 */
export function decide(
  flow: Flow,
  signals: RiskSignals,
  model?: RiskModel,
  thresholds: FlowThresholds = DEFAULT_THRESHOLDS[flow],
): RiskDecision {
  const reasons = evaluateRules(flow, signals);
  const ruleScore = ruleScoreFrom(reasons);

  let modelScore: number | null = null;
  if (model) {
    try {
      const m = model(flow, signals);
      if (Number.isFinite(m) && m >= 0 && m <= 1) modelScore = m;
    } catch {
      modelScore = null;             // a failing model degrades to rules-only
    }
  }

  const score = modelScore === null
    ? ruleScore
    : RULE_WEIGHT * ruleScore + MODEL_WEIGHT * modelScore;

  // raw threshold decision
  let action: Action;
  if (score >= thresholds.deny) action = 'DENY';
  else if (score >= thresholds.holdReview) action = 'HOLD_REVIEW';
  else if (score >= thresholds.stepUp) action = 'STEP_UP';
  else action = 'ALLOW';

  let escalationNote: string | undefined;

  // INVARIANT 1 — no black-box denial: a deny must cite at least one interpretable reason.
  if (action === 'DENY' && reasons.length === 0) {
    action = 'HOLD_REVIEW';
    escalationNote = 'DENY_WITHOUT_INTERPRETABLE_REASON_ESCALATED_TO_REVIEW';
  }

  // INVARIANT 2 — above the monetary cap, an automatic decision may not deny.
  if (action === 'DENY' && signals.amountPaise > thresholds.autoDenyMonetaryCapPaise) {
    action = 'HOLD_REVIEW';
    escalationNote = 'ABOVE_MONETARY_CAP_ESCALATED_TO_HUMAN_HOLD';
  }

  return { flow, action, score, ruleScore, modelScore, reasons, escalationNote };
}

/** risk.decision.v1 payload shape (Vol.5 §5.5 producer: Risk). */
export interface RiskDecisionEvent {
  subjectType: 'CUSTOMER' | 'VENDOR';
  subjectId: string;
  flow: Flow;
  action: Action;
  score: number;
  reasonCodes: string[];
}

export function toEvent(d: RiskDecision, subjectType: 'CUSTOMER' | 'VENDOR', subjectId: string): RiskDecisionEvent {
  return {
    subjectType, subjectId, flow: d.flow, action: d.action,
    score: Math.round(d.score * 1000) / 1000,
    reasonCodes: d.reasons.map((r) => r.code),
  };
}
