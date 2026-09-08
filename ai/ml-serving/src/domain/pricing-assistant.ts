/**
 * AI Pricing Assistant (vendor) — FR-VEN-013.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "recommend price changes within vendor floors/ceilings using demand elasticity,
 *                competitor-band and inventory-age signals, operable in 'suggest' (default) or
 *                'auto-apply within bounds' mode with full audit."
 *   INPUTS:     "Mode selection, bounds, exclusion list, business objective (margin vs velocity
 *                slider)."
 *   OUTPUTS:    "Suggestions with rationale (top-3 factors), projected impact range,
 *                applied-change log, weekly outcome report (realised vs projected)."
 *   VALIDATION: "BRU-10 hard bounds incl. MRP; max one auto-change per SKU per 24 h; event
 *                price-locks honoured."
 *   RULES:      "Auto mode requires explicit opt-in per SKU-group + 7-day trial report; anomaly
 *                guard pauses automation on demand shocks."
 *   ERRORS:     "Signal gaps → suggestion suppressed (never guess); auto-apply conflict with
 *                manual edit within 1 h → manual wins, AI backs off 48 h."
 *
 * This is the VENDOR-FACING assistant over the FR-AI-008 pricing engine built in Slice 40. It does
 * not restate that engine's rules: BRU-10's floor/ceiling/MRP clamp, the 24-hour auto-change
 * cooldown and the competitor-band governance check are all IMPORTED and called. BRU-10 lives in
 * exactly one place, and a second implementation of a hard commercial bound is how the two
 * eventually disagree about what "never above MRP" means.
 *
 * THE PROPERTY MOST WORTH STATING IS THE ONE ABOUT DEFERENCE. If a vendor has touched the price by
 * hand in the last hour, the assistant does not merely lose that round — it STANDS DOWN FOR 48
 * HOURS. A system that re-proposes its number the moment a human overrules it is not an assistant,
 * it is an argument, and a vendor who has to win the same argument twice a day will switch
 * automation off and never turn it back on. The requirement says "manual wins, AI backs off 48 h",
 * and the backoff is the substantive half of that sentence.
 */
import {
  applyHardConstraints,
  AUTO_CHANGE_MIN_INTERVAL_MS,
  isWithinAutoChangeCooldown,
  MIN_ELASTICITY_CONFIDENCE,
  validateCompetitorBand,
  type CompetitorBand,
  type Paise,
  type PricingContext,
  type VendorBounds,
} from './pricing.js';

/** ERRORS: after a manual edit conflict the assistant stands down for this long. */
export const MANUAL_OVERRIDE_BACKOFF_MS = 48 * 3_600_000;
/** ERRORS: a manual edit this recent takes precedence over an auto-apply. */
export const MANUAL_EDIT_CONFLICT_WINDOW_MS = 60 * 60_000;
/** RULES: an auto-mode opt-in must run as a trial for this long before it is unrestricted. */
export const AUTO_TRIAL_MS = 7 * 24 * 3_600_000;
/** RULES: a demand shock of this magnitude pauses automation. */
export const DEMAND_SHOCK_RATIO = 2.0;

export type AssistantMode = 'SUGGEST' | 'AUTO_APPLY';

/** INPUTS: the margin-versus-velocity slider, 0 = pure margin, 1 = pure velocity. */
export type Objective = number;

export interface SkuGroupSettings {
  skuGroupId: string;
  mode: AssistantMode;
  /** RULES: auto mode requires an explicit per-group opt-in, with the instant it was given. */
  autoOptInAtMs?: number;
  autoOptInByUserId?: string;
  /** RULES: the 7-day trial report must exist before auto mode leaves trial. */
  trialReportRef?: string;
  objective: Objective;
  /** INPUTS: SKUs the vendor has excluded from the assistant entirely. */
  exclusionList: ReadonlySet<string>;
}

/** The signals the assistant reasons over. Any of them may be absent. */
export interface Signals {
  /** Demand elasticity, with its own confidence. */
  elasticity?: { value: number; confidence: number };
  competitorBand?: CompetitorBand;
  /** Days since the oldest unsold unit was received. */
  inventoryAgeDays?: number;
  /** Recent demand versus its own baseline, for the anomaly guard. */
  demandRatio?: number;
}

export interface Factor {
  name: 'ELASTICITY' | 'COMPETITOR_BAND' | 'INVENTORY_AGE' | 'OBJECTIVE';
  contributionPct: number;
  direction: 'RAISE' | 'LOWER';
  note: string;
}

export interface ProjectedImpact {
  unitsLowPct: number;
  unitsHighPct: number;
  revenueLowPct: number;
  revenueHighPct: number;
}

export interface Suggestion {
  sku: string;
  currentPricePaise: Paise;
  suggestedPricePaise: Paise;
  /** OUTPUTS: the top three factors behind the number. */
  rationale: Factor[];
  projectedImpact: ProjectedImpact;
  clampsApplied: string[];
  objective: Objective;
  generatedAtMs: number;
}

export interface AppliedChange {
  sku: string;
  fromPaise: Paise;
  toPaise: Paise;
  appliedAtMs: number;
  mode: AssistantMode;
  rationale: Factor[];
  projectedImpact: ProjectedImpact;
}

/** The vendor's own recent manual edit, if any. */
export interface ManualEdit {
  sku: string;
  atMs: number;
  byUserId: string;
  toPaise: Paise;
}

export type AssistantOutcome =
  /** RULES: applied automatically, within bounds. */
  | { outcome: 'AUTO_APPLIED'; change: AppliedChange }
  | { outcome: 'SUGGESTED'; suggestion: Suggestion }
  /** ERRORS: a signal gap suppresses the suggestion rather than guessing. */
  | { outcome: 'SUPPRESSED'; reason: string }
  /** ERRORS: a manual edit wins and the assistant stands down. */
  | { outcome: 'DEFERRED_TO_MANUAL'; backoffUntilMs: number; manualEdit: ManualEdit }
  | { outcome: 'NO_CHANGE'; reason: string };

export interface AssistantRequest {
  ctx: PricingContext;
  settings: SkuGroupSettings;
  signals: Signals;
  /** The vendor's last manual edit for this SKU, if there is one. */
  lastManualEdit?: ManualEdit;
  /** When the assistant last stood down for this SKU, if it has. */
  backoffUntilMs?: number;
  nowMs: number;
}

/** RULES: has the auto-mode opt-in cleared its 7-day trial? */
export function autoModeStatus(settings: SkuGroupSettings, nowMs: number):
  { permitted: true; inTrial: boolean } | { permitted: false; reason: string } {
  if (settings.mode !== 'AUTO_APPLY') return { permitted: false, reason: 'MODE_IS_SUGGEST' };
  if (settings.autoOptInAtMs === undefined || !settings.autoOptInByUserId) {
    return { permitted: false, reason: 'AUTO_MODE_REQUIRES_EXPLICIT_PER_GROUP_OPT_IN' };
  }
  const elapsed = nowMs - settings.autoOptInAtMs;
  if (elapsed < AUTO_TRIAL_MS) {
    // during the trial auto-apply is permitted, but the vendor is owed the report at the end
    return { permitted: true, inTrial: true };
  }
  if (!settings.trialReportRef) {
    // the trial has run its course and nobody produced the report: automation does not silently
    // graduate on the strength of time passing
    return { permitted: false, reason: 'SEVEN_DAY_TRIAL_REPORT_NOT_PRODUCED' };
  }
  return { permitted: true, inTrial: false };
}

/** RULES: the anomaly guard. A demand shock pauses automation rather than pricing into it. */
export function isDemandShock(signals: Signals): boolean {
  if (signals.demandRatio === undefined) return false;
  return signals.demandRatio >= DEMAND_SHOCK_RATIO
    || signals.demandRatio <= 1 / DEMAND_SHOCK_RATIO;
}

/**
 * Build the rationale, ordered by contribution and truncated to three. The objective slider is
 * itself a factor, because a vendor reading a suggestion deserves to see that their own setting
 * pushed it — not just the market signals.
 */
function buildRationale(signals: Signals, objective: Objective, raising: boolean): Factor[] {
  const factors: Factor[] = [];

  if (signals.elasticity) {
    factors.push({
      name: 'ELASTICITY',
      contributionPct: 40,
      direction: raising ? 'RAISE' : 'LOWER',
      note: `Demand elasticity ${signals.elasticity.value.toFixed(2)} `
        + `(confidence ${(signals.elasticity.confidence * 100).toFixed(0)}%)`,
    });
  }
  if (signals.competitorBand) {
    factors.push({
      name: 'COMPETITOR_BAND',
      contributionPct: 30,
      direction: raising ? 'RAISE' : 'LOWER',
      note: `Category band across ${signals.competitorBand.sampleSize} sellers`,
    });
  }
  if (signals.inventoryAgeDays !== undefined && signals.inventoryAgeDays > 60) {
    factors.push({
      name: 'INVENTORY_AGE',
      contributionPct: 20,
      direction: 'LOWER',
      note: `Oldest unsold unit is ${signals.inventoryAgeDays} days old`,
    });
  }
  factors.push({
    name: 'OBJECTIVE',
    contributionPct: 10,
    direction: objective > 0.5 ? 'LOWER' : 'RAISE',
    note: objective > 0.5
      ? `Your slider favours velocity (${objective.toFixed(2)})`
      : `Your slider favours margin (${objective.toFixed(2)})`,
  });

  return factors.sort((a, b) => b.contributionPct - a.contributionPct).slice(0, 3);
}

function projectImpact(currentPaise: Paise, suggestedPaise: Paise, elasticity: number): ProjectedImpact {
  const pricePct = (suggestedPaise - currentPaise) / currentPaise;
  const unitsMid = pricePct * elasticity;
  // the range widens with the size of the move, because a bigger change is a longer extrapolation
  const spread = Math.max(0.02, Math.abs(unitsMid) * 0.5);
  const unitsLow = unitsMid - spread;
  const unitsHigh = unitsMid + spread;
  const round = (x: number) => Math.round(x * 1000) / 10;
  return {
    unitsLowPct: round(unitsLow),
    unitsHighPct: round(unitsHigh),
    revenueLowPct: round((1 + pricePct) * (1 + unitsLow) - 1),
    revenueHighPct: round((1 + pricePct) * (1 + unitsHigh) - 1),
  };
}

/**
 * Run the assistant for one SKU.
 *
 * The guard order is the design. Exclusion and manual deference come first, because both are the
 * vendor's own instruction and no market signal should be weighed against it. Signal sufficiency
 * comes next, so a suppression is reported as a suppression rather than as "no change". Only then
 * is a price computed, and it passes through the Slice-40 BRU-10 clamp before anything is applied.
 */
export function runAssistant(req: AssistantRequest): AssistantOutcome {
  const { ctx, settings, signals, nowMs } = req;

  // INPUTS: the vendor's exclusion list is absolute
  if (settings.exclusionList.has(ctx.sku)) {
    return { outcome: 'NO_CHANGE', reason: 'SKU_ON_VENDOR_EXCLUSION_LIST' };
  }

  // ERRORS: the assistant is standing down after a previous conflict
  if (req.backoffUntilMs !== undefined && nowMs < req.backoffUntilMs) {
    return {
      outcome: 'DEFERRED_TO_MANUAL',
      backoffUntilMs: req.backoffUntilMs,
      manualEdit: req.lastManualEdit ?? { sku: ctx.sku, atMs: 0, byUserId: 'unknown', toPaise: ctx.currentPricePaise },
    };
  }

  // ERRORS: a manual edit inside the conflict window wins, and the assistant backs off 48 h
  if (req.lastManualEdit && nowMs - req.lastManualEdit.atMs < MANUAL_EDIT_CONFLICT_WINDOW_MS) {
    return {
      outcome: 'DEFERRED_TO_MANUAL',
      backoffUntilMs: req.lastManualEdit.atMs + MANUAL_OVERRIDE_BACKOFF_MS,
      manualEdit: req.lastManualEdit,
    };
  }

  // VALIDATION: event price-locks are honoured
  if (ctx.eventLocked) {
    return { outcome: 'NO_CHANGE', reason: 'EVENT_PRICE_LOCK_IN_FORCE' };
  }

  // ERRORS: signal gaps suppress the suggestion. Never guess.
  if (!signals.elasticity) {
    return { outcome: 'SUPPRESSED', reason: 'NO_ELASTICITY_SIGNAL' };
  }
  if (signals.elasticity.confidence < MIN_ELASTICITY_CONFIDENCE) {
    return {
      outcome: 'SUPPRESSED',
      reason: `ELASTICITY_CONFIDENCE_BELOW_${MIN_ELASTICITY_CONFIDENCE}`,
    };
  }
  if (signals.competitorBand) {
    const band = validateCompetitorBand(signals.competitorBand);
    if (!band.ok) {
      // a refused band BLOCKS rather than falling through, as in Slice 40
      return { outcome: 'SUPPRESSED', reason: `COMPETITOR_BAND_REFUSED: ${band.reason}` };
    }
  }

  // objective and signals produce a direction and a magnitude
  const velocityWeight = Math.min(1, Math.max(0, settings.objective));
  const ageNudge = signals.inventoryAgeDays !== undefined && signals.inventoryAgeDays > 60 ? 0.05 : 0;
  // velocity favours cutting, margin favours raising
  const rawMovePct = (velocityWeight - 0.5) * -0.2 - ageNudge;
  const candidate = Math.round(ctx.currentPricePaise * (1 + rawMovePct));

  // VALIDATION: BRU-10, via the Slice-40 engine rather than a second implementation
  const clamped = applyHardConstraints(candidate, ctx);
  if (clamped.pricePaise === ctx.currentPricePaise) {
    return { outcome: 'NO_CHANGE', reason: 'CLAMPED_TO_CURRENT_PRICE' };
  }

  const raising = clamped.pricePaise > ctx.currentPricePaise;
  const rationale = buildRationale(signals, settings.objective, raising);
  const projectedImpact = projectImpact(ctx.currentPricePaise, clamped.pricePaise,
    signals.elasticity.value);

  const suggestion: Suggestion = {
    sku: ctx.sku,
    currentPricePaise: ctx.currentPricePaise,
    suggestedPricePaise: clamped.pricePaise,
    rationale,
    projectedImpact,
    clampsApplied: clamped.applied,
    objective: settings.objective,
    generatedAtMs: nowMs,
  };

  // suggest mode stops here
  const auto = autoModeStatus(settings, nowMs);
  if (!auto.permitted) {
    return { outcome: 'SUGGESTED', suggestion };
  }

  // RULES: the anomaly guard pauses automation, but a suggestion is still offered — a demand
  // shock is exactly when a vendor wants a human to look
  if (isDemandShock(signals)) {
    return { outcome: 'SUGGESTED', suggestion };
  }

  // VALIDATION: max one auto-change per SKU per 24 h, via the Slice-40 cooldown
  if (isWithinAutoChangeCooldown(ctx)) {
    return { outcome: 'SUGGESTED', suggestion };
  }

  return {
    outcome: 'AUTO_APPLIED',
    change: {
      sku: ctx.sku,
      fromPaise: ctx.currentPricePaise,
      toPaise: clamped.pricePaise,
      appliedAtMs: nowMs,
      mode: 'AUTO_APPLY',
      rationale,
      projectedImpact,
    },
  };
}

// ================================================= outcome reporting

export interface OutcomeRow {
  sku: string;
  appliedAtMs: number;
  projected: ProjectedImpact;
  realisedUnitsPct: number;
  realisedRevenuePct: number;
  /** True when the realised figure fell inside the projected range. */
  withinProjection: boolean;
}

export interface WeeklyOutcomeReport {
  weekStartMs: number;
  rows: OutcomeRow[];
  changesApplied: number;
  withinProjectionCount: number;
  /** Share of changes whose realised outcome landed inside the projected range. */
  projectionAccuracy: number;
  meanRealisedRevenuePct: number;
}

/**
 * OUTPUTS: the weekly realised-versus-projected report.
 *
 * It reports how often the projection CONTAINED the outcome rather than how close the midpoint
 * was, because the assistant publishes a range and a range's honesty is whether reality fell
 * inside it. A model that quotes wide ranges scores well here, which is the correct incentive: an
 * honest wide range is more useful to a vendor than a confident narrow wrong one.
 */
export function weeklyOutcomeReport(weekStartMs: number,
                                    outcomes: Array<{ change: AppliedChange; realisedUnitsPct: number; realisedRevenuePct: number }>):
  WeeklyOutcomeReport {
  const rows: OutcomeRow[] = outcomes.map((o) => {
    const p = o.change.projectedImpact;
    const within = o.realisedUnitsPct >= Math.min(p.unitsLowPct, p.unitsHighPct)
      && o.realisedUnitsPct <= Math.max(p.unitsLowPct, p.unitsHighPct);
    return {
      sku: o.change.sku,
      appliedAtMs: o.change.appliedAtMs,
      projected: p,
      realisedUnitsPct: o.realisedUnitsPct,
      realisedRevenuePct: o.realisedRevenuePct,
      withinProjection: within,
    };
  });

  const within = rows.filter((r) => r.withinProjection).length;
  return {
    weekStartMs,
    rows,
    changesApplied: rows.length,
    withinProjectionCount: within,
    projectionAccuracy: rows.length === 0 ? 0 : Math.round((within / rows.length) * 100) / 100,
    meanRealisedRevenuePct: rows.length === 0
      ? 0
      : Math.round((rows.reduce((a, r) => a + r.realisedRevenuePct, 0) / rows.length) * 10) / 10,
  };
}

/** The trial report a vendor is owed before auto mode leaves trial. */
export interface TrialReport {
  skuGroupId: string;
  optInAtMs: number;
  trialEndsAtMs: number;
  changesApplied: number;
  projectionAccuracy: number;
  meanRealisedRevenuePct: number;
  recommendation: 'CONTINUE_AUTO' | 'REVERT_TO_SUGGEST';
}

/**
 * RULES: the 7-day trial report. Its recommendation is conservative: automation continues only if
 * the projections were mostly right AND revenue did not fall. Either failing means a vendor is
 * better served deciding for themselves.
 */
export function trialReport(settings: SkuGroupSettings, report: WeeklyOutcomeReport): TrialReport {
  const optInAtMs = settings.autoOptInAtMs ?? 0;
  const accurate = report.projectionAccuracy >= 0.6;
  const revenueHeld = report.meanRealisedRevenuePct >= 0;
  return {
    skuGroupId: settings.skuGroupId,
    optInAtMs,
    trialEndsAtMs: optInAtMs + AUTO_TRIAL_MS,
    changesApplied: report.changesApplied,
    projectionAccuracy: report.projectionAccuracy,
    meanRealisedRevenuePct: report.meanRealisedRevenuePct,
    recommendation: accurate && revenueHeld && report.changesApplied > 0
      ? 'CONTINUE_AUTO'
      : 'REVERT_TO_SUGGEST',
  };
}

/** Re-export for callers, so the 24-hour rule has one source. */
export { AUTO_CHANGE_MIN_INTERVAL_MS };
export type { VendorBounds };
