/**
 * Churn prediction & win-back targeting — FR-AI-011.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "score active customers monthly (plus event-triggered) for 90-day churn
 *                probability with top drivers, feeding win-back journeys (FR-MKT-002) and CX
 *                prioritisation, with measured incremental retention via holdouts."
 *   INPUTS:     "Behavioural features (recency/frequency/monetary, engagement, service incidents),
 *                consent state."
 *   OUTPUTS:    "Churn scores + driver attributions, audience segments (high-risk-high-value
 *                first), campaign holdout design, retention-lift reports."
 *   VALIDATION: "Model AUC ≥ 0.75 gate on holdout; calibration checked (Brier) before activation."
 *   RULES:      "Only consented users targetable; incentives from win-back budget with claw-back
 *                on abuse patterns."
 *   ERRORS:     "Feature pipeline gap → skip cycle with alert (no stale-score sends)."
 *   SECURITY:   "Scores are internal."
 *
 * THREE PROPERTIES CARRY THE WEIGHT, and each guards against a different way of being confidently
 * wrong:
 *
 *  1. DISCRIMINATION AND CALIBRATION ARE SEPARATE GATES. A model can rank customers correctly
 *     (good AUC) while its numbers mean nothing as probabilities (bad Brier) — predicting 0.9 for
 *     everyone who churns at 0.3 ranks perfectly and is calibrated appallingly. Since the score
 *     sizes the incentive, an uncalibrated model overspends on customers who were never going to
 *     leave. Both gates must pass independently, and neither substitutes for the other.
 *
 *  2. THE HOLDOUT MUST NOT BE TARGETED. Incremental retention is the difference between the
 *     targeted group and an untouched holdout; target the holdout and there is nothing left to
 *     measure against, so every subsequent lift claim is unfalsifiable. Exclusion is therefore
 *     enforced in the targeting decision rather than left to a campaign's own filter.
 *
 *  3. A STALE SCORE NEVER DRIVES A SEND. When the feature pipeline has a gap the cycle is SKIPPED
 *     with an alert, and a send attempted against a score older than one cycle is refused. Sending
 *     a win-back discount on last month's behaviour reaches customers who have since bought
 *     happily — spending budget to annoy the people it worked on.
 */

/** VALIDATION: the discrimination gate. */
export const MIN_AUC = 0.75;
/**
 * VALIDATION: the calibration gate. 0.25 is the Brier score of always predicting 0.5, so a model
 * worse than that is not informative regardless of how it ranks.
 */
export const MAX_BRIER = 0.25;
/** DESC: the prediction horizon. */
export const HORIZON_DAYS = 90;
/** ERRORS: a score older than one cycle may not drive a send. */
export const MAX_SCORE_AGE_MS = 31 * 24 * 3_600_000;

export type FeatureName =
  | 'recencyDays'
  | 'frequency90d'
  | 'monetaryPaise'
  | 'engagementScore'
  | 'serviceIncidents90d';

export interface Features {
  customerId: string;
  recencyDays: number;
  frequency90d: number;
  monetaryPaise: number;
  /** 0..1 */
  engagementScore: number;
  serviceIncidents90d: number;
  /** INPUTS: consent state travels with the features, so targeting cannot forget it. */
  consentMarketing: boolean;
}

export interface Driver {
  feature: FeatureName;
  contributionPct: number;
  direction: 'INCREASES_RISK' | 'REDUCES_RISK';
}

export interface ChurnScore {
  customerId: string;
  /** 0..1 probability of churn within the horizon. */
  probability: number;
  drivers: Driver[];
  scoredAtMs: number;
  modelVersion: string;
  /** SECURITY: scores are internal. Never rendered to the customer. */
  internalOnly: true;
}

export type ChurnModel = (features: Features) =>
  { probability: number; drivers: Driver[] };

// ================================================= model gates

export interface LabelledScore {
  score: number;
  /** True if the customer actually churned within the horizon. */
  churned: boolean;
}

/**
 * Area under the ROC curve, computed pairwise so ties are handled explicitly at 0.5 rather than
 * silently favouring one class.
 */
export function auc(samples: LabelledScore[]): number | null {
  const positives = samples.filter((s) => s.churned);
  const negatives = samples.filter((s) => !s.churned);
  if (positives.length === 0 || negatives.length === 0) return null;

  let concordant = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p.score > n.score) concordant += 1;
      else if (p.score === n.score) concordant += 0.5;
    }
  }
  return Math.round((concordant / (positives.length * negatives.length)) * 10_000) / 10_000;
}

/**
 * Brier score: the mean squared error of the predicted probabilities. Lower is better. This is
 * what catches a model that ranks well but whose numbers are not probabilities.
 */
export function brierScore(samples: LabelledScore[]): number | null {
  if (samples.length === 0) return null;
  const total = samples.reduce((a, s) => a + (s.score - (s.churned ? 1 : 0)) ** 2, 0);
  return Math.round((total / samples.length) * 10_000) / 10_000;
}

export type ActivationDecision =
  | { activate: true; auc: number; brier: number }
  | { activate: false; reason: 'AUC_BELOW_GATE'; auc: number; gate: number }
  | { activate: false; reason: 'CALIBRATION_BELOW_GATE'; brier: number; gate: number }
  | { activate: false; reason: 'NO_HOLDOUT_LABELS' };

/**
 * VALIDATION: both gates, checked independently. The AUC test runs first only because a model that
 * cannot rank is not worth calibrating; passing one never excuses failing the other.
 */
export function activationDecision(holdoutSamples: LabelledScore[]): ActivationDecision {
  const a = auc(holdoutSamples);
  const b = brierScore(holdoutSamples);
  if (a === null || b === null) return { activate: false, reason: 'NO_HOLDOUT_LABELS' };
  if (a < MIN_AUC) return { activate: false, reason: 'AUC_BELOW_GATE', auc: a, gate: MIN_AUC };
  if (b > MAX_BRIER) {
    return { activate: false, reason: 'CALIBRATION_BELOW_GATE', brier: b, gate: MAX_BRIER };
  }
  return { activate: true, auc: a, brier: b };
}

// ================================================= scoring cycle

/** ERRORS: the health of each feature feed for this cycle. */
export interface FeatureHealth {
  /** Feeds that failed to land for this cycle. */
  missingFeeds: FeatureName[];
}

export type CycleResult =
  | { outcome: 'SCORED'; scores: ChurnScore[]; modelVersion: string; cycleAtMs: number }
  /** ERRORS: the cycle is skipped with an alert rather than scoring on partial features. */
  | { outcome: 'SKIPPED'; alert: string; missingFeeds: FeatureName[] }
  | { outcome: 'BLOCKED'; reason: string };

/**
 * Run a scoring cycle.
 *
 * ERRORS: a feature-pipeline gap SKIPS the cycle. Scoring on partial features would produce
 * confident numbers built from absent evidence, and those numbers would then size real
 * incentives — so no scores are produced at all and the previous cycle's scores age out naturally
 * rather than being silently reused.
 */
export function runCycle(
  population: Features[],
  model: ChurnModel,
  health: FeatureHealth,
  activation: ActivationDecision,
  modelVersion: string,
  nowMs: number,
): CycleResult {
  if (!activation.activate) {
    return { outcome: 'BLOCKED', reason: `MODEL_NOT_ACTIVATED: ${activation.reason}` };
  }
  if (health.missingFeeds.length > 0) {
    return {
      outcome: 'SKIPPED',
      alert: `Churn scoring cycle skipped: ${health.missingFeeds.join(', ')} did not land. `
        + 'No scores were produced and no win-back sends will use last cycle\'s scores.',
      missingFeeds: [...health.missingFeeds],
    };
  }

  const scores: ChurnScore[] = [];
  for (const f of population) {
    let out: { probability: number; drivers: Driver[] };
    try {
      out = model(f);
    } catch {
      continue;      // a per-customer model failure skips that customer, not the cycle
    }
    if (!Number.isFinite(out.probability) || out.probability < 0 || out.probability > 1) continue;
    scores.push({
      customerId: f.customerId,
      probability: Math.round(out.probability * 10_000) / 10_000,
      drivers: [...out.drivers].sort((x, y) => y.contributionPct - x.contributionPct).slice(0, 3),
      scoredAtMs: nowMs,
      modelVersion,
      internalOnly: true,
    });
  }
  return { outcome: 'SCORED', scores, modelVersion, cycleAtMs: nowMs };
}

// ================================================= holdout design

export interface HoldoutAssignment {
  campaignId: string;
  holdoutFraction: number;
  /** Customer ids withheld from targeting so lift can be measured. */
  holdout: ReadonlySet<string>;
  targetable: string[];
}

/**
 * OUTPUTS: a deterministic holdout split. Deterministic rather than random per call, so re-running
 * the assignment for the same campaign cannot quietly move a customer from holdout to targeted
 * mid-flight and destroy the measurement.
 */
export function designHoldout(campaignId: string, customerIds: string[],
                              holdoutFraction: number): HoldoutAssignment {
  const fraction = Math.min(0.5, Math.max(0, holdoutFraction));
  const holdout = new Set<string>();
  const targetable: string[] = [];

  for (const id of [...customerIds].sort()) {
    // a stable hash of campaign+customer, so the same pair always lands the same way
    let h = 0x811c9dc5;
    const key = `${campaignId}:${id}`;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const bucket = ((h >>> 0) % 10_000) / 10_000;
    if (bucket < fraction) holdout.add(id);
    else targetable.push(id);
  }
  return { campaignId, holdoutFraction: fraction, holdout, targetable };
}

// ================================================= targeting

export type TargetingDecision =
  | { target: true; incentivePaise: number }
  | { target: false; reason: string };

export interface WinBackBudget {
  campaignId: string;
  budgetPaise: number;
  spentPaise: number;
  /** Incentive ceiling per customer. */
  maxIncentivePaise: number;
}

/** Abuse signals that trigger a clawback of a granted incentive. */
export interface AbuseSignals {
  ordersReturnedAfterIncentive: number;
  incentivesRedeemedLast90d: number;
  sharedInstrumentWithOtherAccounts: boolean;
}

export const ABUSE_REDEMPTION_LIMIT = 3;

/**
 * RULES: who may be targeted.
 *
 * The guard order is deliberate. Consent is checked FIRST because a non-consenting customer is not
 * a targeting decision at all, and the holdout check comes before the budget check so that a
 * holdout member is never even considered for spend — a holdout that consumes budget is both a
 * measurement failure and a waste.
 */
export function targetingDecision(
  score: ChurnScore,
  features: Features,
  assignment: HoldoutAssignment,
  budget: WinBackBudget,
  riskThreshold: number,
  nowMs: number,
): TargetingDecision {
  // RULES: only consented users are targetable
  if (!features.consentMarketing) {
    return { target: false, reason: 'NO_MARKETING_CONSENT' };
  }
  // ERRORS: a stale score never drives a send
  if (nowMs - score.scoredAtMs > MAX_SCORE_AGE_MS) {
    return { target: false, reason: 'SCORE_STALE_NO_SEND' };
  }
  // OUTPUTS: the holdout is withheld so lift remains measurable
  if (assignment.holdout.has(score.customerId)) {
    return { target: false, reason: 'IN_MEASUREMENT_HOLDOUT' };
  }
  if (score.probability < riskThreshold) {
    return { target: false, reason: 'BELOW_RISK_THRESHOLD' };
  }

  // incentive scales with risk, capped by the per-customer ceiling
  const incentivePaise = Math.min(
    budget.maxIncentivePaise,
    Math.round(budget.maxIncentivePaise * score.probability),
  );
  if (budget.spentPaise + incentivePaise > budget.budgetPaise) {
    return { target: false, reason: 'WIN_BACK_BUDGET_EXHAUSTED' };
  }
  return { target: true, incentivePaise };
}

/** RULES: clawback on abuse patterns. */
export function clawbackDecision(signals: AbuseSignals):
  { clawback: true; reason: string } | { clawback: false } {
  if (signals.sharedInstrumentWithOtherAccounts) {
    return { clawback: true, reason: 'SHARED_INSTRUMENT_ACROSS_ACCOUNTS' };
  }
  if (signals.incentivesRedeemedLast90d > ABUSE_REDEMPTION_LIMIT) {
    return { clawback: true, reason: 'EXCESSIVE_INCENTIVE_REDEMPTION' };
  }
  if (signals.ordersReturnedAfterIncentive > 0
      && signals.incentivesRedeemedLast90d > 0
      && signals.ordersReturnedAfterIncentive >= signals.incentivesRedeemedLast90d) {
    // every incentivised order came back: the discount was the purchase, not the product
    return { clawback: true, reason: 'ALL_INCENTIVISED_ORDERS_RETURNED' };
  }
  return { clawback: false };
}

// ================================================= audience segments

export interface AudienceMember {
  customerId: string;
  probability: number;
  lifetimeValuePaise: number;
  priority: number;
}

/**
 * OUTPUTS: audience segments with high-risk-high-value first. Ordering by risk alone would put the
 * platform's effort behind customers who were cheap to lose; ordering by value alone would chase
 * customers who were never leaving.
 */
export function audience(scores: ChurnScore[], ltvByCustomer: Record<string, number>,
                         riskThreshold: number): AudienceMember[] {
  return scores
    .filter((s) => s.probability >= riskThreshold)
    .map((s) => {
      const ltv = ltvByCustomer[s.customerId] ?? 0;
      return {
        customerId: s.customerId,
        probability: s.probability,
        lifetimeValuePaise: ltv,
        // expected value at risk: the money actually in play
        priority: Math.round(s.probability * ltv),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.customerId.localeCompare(b.customerId));
}

// ================================================= lift reporting

export interface RetentionLift {
  campaignId: string;
  targetedRetained: number;
  targetedTotal: number;
  holdoutRetained: number;
  holdoutTotal: number;
  targetedRate: number;
  holdoutRate: number;
  /** The incremental effect, in percentage points. */
  liftPts: number;
  /** True when either arm is too small for the number to mean anything. */
  underpowered: boolean;
}

export const MIN_ARM_SIZE = 100;

/**
 * OUTPUTS: the retention-lift report. It reports the raw rates alongside the lift, and flags an
 * underpowered comparison rather than presenting a difference of two small numbers as a result.
 */
export function retentionLift(
  campaignId: string,
  targeted: { retained: number; total: number },
  holdout: { retained: number; total: number },
): RetentionLift {
  const targetedRate = targeted.total === 0 ? 0 : targeted.retained / targeted.total;
  const holdoutRate = holdout.total === 0 ? 0 : holdout.retained / holdout.total;
  return {
    campaignId,
    targetedRetained: targeted.retained,
    targetedTotal: targeted.total,
    holdoutRetained: holdout.retained,
    holdoutTotal: holdout.total,
    targetedRate: Math.round(targetedRate * 10_000) / 10_000,
    holdoutRate: Math.round(holdoutRate * 10_000) / 10_000,
    liftPts: Math.round((targetedRate - holdoutRate) * 1000) / 10,
    underpowered: targeted.total < MIN_ARM_SIZE || holdout.total < MIN_ARM_SIZE,
  };
}

// ================================================= CX prioritisation

/**
 * DESC: churn risk feeds CX prioritisation. Note this path does NOT require marketing consent — a
 * support queue ordering is not a marketing communication, and refusing to prioritise a
 * non-consenting customer's ticket would punish them for declining offers.
 */
export function cxPriority(score: ChurnScore, openTicketAgeHours: number): number {
  return Math.round(score.probability * 100 + Math.min(openTicketAgeHours, 72));
}
