/**
 * Dynamic pricing engine — FR-AI-008.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "compute price recommendations/auto-adjustments within vendor bounds using
 *                elasticity estimates, inventory position, competitor bands (where lawfully
 *                sourced) and objective settings, with full simulation ('what-if') before
 *                enablement."
 *   VALIDATION: "Hard constraints (BRU-10, MRP, event locks) enforced IN THE ENGINE, not just
 *                UI; change-rate limiter (≤ 1/24 h/SKU auto)."
 *   RULES:      "Collusion-safe design: no cross-vendor price coordination signals; fairness
 *                review documented (Decision D-014)."
 *   ERRORS:     "Elasticity confidence below threshold → suggest-only regardless of mode;
 *                guard-trip (demand shock) pauses automation category-wide with alert."
 *   SECURITY:   "Every change audited with model version + factors; kill-switch ≤ 60 s."
 *   BRU-10:     "Dynamic pricing may move a price only within vendor-set floor/ceiling and never
 *                above MRP."
 *
 * The elasticity model is INJECTED, following the pattern established for the recommendation
 * ranker and the risk model: it can be swapped or shadowed, a failing model degrades safely, and
 * every guardrail in this file is testable with no model at all.
 *
 * TWO PROPERTIES ARE STRUCTURAL RATHER THAN ADVISORY:
 *
 *  1. HARD CONSTRAINTS LIVE HERE, NOT IN THE UI. BRU-10's floor/ceiling and the MRP ceiling are
 *     applied to the model's suggestion inside {@link decidePrice}; a model that returns a price
 *     above MRP cannot produce a price above MRP, because the engine clamps before it decides.
 *     The requirement says "in the engine, not just UI", and a UI-only check is exactly the class
 *     of bug that ships a price above MRP the first time someone calls the API directly.
 *
 *  2. COLLUSION-SAFETY IS ENFORCED BY THE TYPE. The engine accepts only an aggregated competitor
 *     BAND carrying a sample size, and refuses a band whose sample is too small to be anything
 *     but an individual rival's price. A single competitor's price is a coordination signal; an
 *     aggregate over many is a market observation. Making the narrow case unrepresentable is
 *     stronger than asking callers not to pass one.
 */

export type Paise = number;

export type Mode = 'SUGGEST_ONLY' | 'AUTO_ADJUST';

/** SECURITY: kill-switch must take effect within this window. */
export const KILL_SWITCH_MAX_PROPAGATION_MS = 60_000;
/** VALIDATION: at most one automatic change per SKU per 24 hours. */
export const AUTO_CHANGE_MIN_INTERVAL_MS = 24 * 3600 * 1000;
/** ERRORS: below this confidence the engine suggests only, whatever the mode. */
export const MIN_ELASTICITY_CONFIDENCE = 0.60;
/**
 * RULES: the minimum number of distinct sellers an aggregated competitor band must cover. Below
 * this, the "band" is effectively one rival's price — a coordination signal, not a market view.
 */
export const MIN_COMPETITOR_BAND_SAMPLE = 5;

/** An aggregated, lawfully-sourced competitor band. Never an individual seller's price. */
export interface CompetitorBand {
  lowPaise: Paise;
  highPaise: Paise;
  /** Number of distinct sellers aggregated into the band. */
  sampleSize: number;
  sourceGovernanceRef: string;
}

/** BRU-10: the vendor-set floor and ceiling the engine may move within. */
export interface VendorBounds {
  floorPaise: Paise;
  ceilingPaise: Paise;
}

export interface PricingContext {
  sku: string;
  vendorId: string;
  categoryId: string;
  currentPricePaise: Paise;
  mrpPaise: Paise;
  bounds: VendorBounds;
  inventoryOnHand: number;
  inventoryAgeDays: number;
  /** VALIDATION: an event lock (a live campaign price) forbids automatic movement. */
  eventLocked: boolean;
  lastAutoChangeAtMs?: number;
  competitorBand?: CompetitorBand;
  nowMs: number;
}

/** What the injected model returns. */
export interface ElasticityEstimate {
  suggestedPricePaise: Paise;
  elasticity: number;
  /** 0..1. Below MIN_ELASTICITY_CONFIDENCE the engine will only suggest. */
  confidence: number;
  modelVersion: string;
  /** The rationale factors, carried into the audit record. */
  factors: string[];
}

export type ElasticityModel = (ctx: PricingContext) => ElasticityEstimate;

export type Action = 'AUTO_APPLIED' | 'SUGGESTED' | 'NO_CHANGE';

export interface AuditRecord {
  sku: string;
  vendorId: string;
  modelVersion: string | null;
  fromPaise: Paise;
  toPaise: Paise;
  action: Action;
  factors: string[];
  guardrailsApplied: string[];
  atMs: number;
}

export interface Decision {
  action: Action;
  /** The price after every hard constraint has been applied. */
  pricePaise: Paise;
  reasons: string[];
  /** Named guardrails that altered or downgraded the outcome. */
  guardrailsApplied: string[];
  audit: AuditRecord;
}

/** ERRORS: a category-wide guard trip pauses automation until it is cleared. */
export class CategoryGuard {
  private readonly tripped = new Map<string, { reason: string; atMs: number }>();

  trip(categoryId: string, reason: string, atMs: number): void {
    this.tripped.set(categoryId, { reason, atMs });
  }

  clear(categoryId: string): void {
    this.tripped.delete(categoryId);
  }

  isTripped(categoryId: string): boolean {
    return this.tripped.has(categoryId);
  }

  reasonFor(categoryId: string): string | undefined {
    return this.tripped.get(categoryId)?.reason;
  }
}

/** SECURITY: the kill switch, with its propagation deadline. */
export class PricingKillSwitch {
  private engagedAtMs: number | null = null;

  engage(atMs: number): { propagateByMs: number } {
    this.engagedAtMs = atMs;
    return { propagateByMs: atMs + KILL_SWITCH_MAX_PROPAGATION_MS };
  }

  release(): void {
    this.engagedAtMs = null;
  }

  isEngaged(): boolean {
    return this.engagedAtMs !== null;
  }
}

/**
 * RULES: validate a competitor band before it may influence a price. A band that aggregates too
 * few sellers is refused — it would be a coordination signal wearing a band's clothing.
 */
export function validateCompetitorBand(band: CompetitorBand):
  { ok: true } | { ok: false; reason: string } {
  if (band.sampleSize < MIN_COMPETITOR_BAND_SAMPLE) {
    return {
      ok: false,
      reason: `COMPETITOR_BAND_SAMPLE_TOO_SMALL: ${band.sampleSize} < ${MIN_COMPETITOR_BAND_SAMPLE}`,
    };
  }
  if (band.highPaise < band.lowPaise) return { ok: false, reason: 'COMPETITOR_BAND_INVERTED' };
  if (!band.sourceGovernanceRef || band.sourceGovernanceRef.trim().length === 0) {
    return { ok: false, reason: 'COMPETITOR_BAND_SOURCE_NOT_GOVERNED' };
  }
  return { ok: true };
}

/**
 * VALIDATION/BRU-10: clamp a candidate price to the vendor floor/ceiling and the MRP. Applied
 * inside the engine so no caller can bypass it. Returns the clamped price and the names of the
 * constraints that bit, so the audit record can say why the price is what it is.
 */
export function applyHardConstraints(candidatePaise: Paise, ctx: PricingContext):
  { pricePaise: Paise; applied: string[] } {
  const applied: string[] = [];
  let price = candidatePaise;

  // The effective ceiling is the tighter of the vendor ceiling and the MRP: BRU-10 forbids ever
  // exceeding MRP, whatever the vendor set.
  const effectiveCeiling = Math.min(ctx.bounds.ceilingPaise, ctx.mrpPaise);

  if (price > ctx.mrpPaise) {
    price = ctx.mrpPaise;
    applied.push('MRP_CEILING');
  }
  if (price > ctx.bounds.ceilingPaise) {
    price = ctx.bounds.ceilingPaise;
    applied.push('VENDOR_CEILING');
  }
  if (price < ctx.bounds.floorPaise) {
    price = ctx.bounds.floorPaise;
    applied.push('VENDOR_FLOOR');
  }
  // If the vendor's own floor sits above the effective ceiling the bounds are contradictory; the
  // safe resolution is the ceiling, never a price above MRP.
  if (price > effectiveCeiling) {
    price = effectiveCeiling;
    applied.push('CONTRADICTORY_BOUNDS_RESOLVED_TO_CEILING');
  }
  return { pricePaise: price, applied };
}

/** VALIDATION: at most one automatic change per SKU per 24 hours. */
export function isWithinAutoChangeCooldown(ctx: PricingContext): boolean {
  if (ctx.lastAutoChangeAtMs === undefined) return false;
  return ctx.nowMs - ctx.lastAutoChangeAtMs < AUTO_CHANGE_MIN_INTERVAL_MS;
}

/**
 * Decide a price. The order of checks is deliberate: the kill switch and the category guard stop
 * everything, then the constraints that force suggest-only, then the hard clamps, and only then
 * the mode. Anything that downgrades the outcome names itself in guardrailsApplied.
 */
export function decidePrice(
  ctx: PricingContext,
  mode: Mode,
  model?: ElasticityModel,
  killSwitch?: PricingKillSwitch,
  guard?: CategoryGuard,
): Decision {
  const reasons: string[] = [];
  const guardrails: string[] = [];

  const noChange = (modelVersion: string | null, factors: string[]): Decision => ({
    action: 'NO_CHANGE',
    pricePaise: ctx.currentPricePaise,
    reasons,
    guardrailsApplied: guardrails,
    audit: {
      sku: ctx.sku, vendorId: ctx.vendorId, modelVersion,
      fromPaise: ctx.currentPricePaise, toPaise: ctx.currentPricePaise,
      action: 'NO_CHANGE', factors, guardrailsApplied: [...guardrails], atMs: ctx.nowMs,
    },
  });

  // SECURITY: the kill switch stops the engine outright.
  if (killSwitch?.isEngaged()) {
    reasons.push('KILL_SWITCH_ENGAGED');
    guardrails.push('KILL_SWITCH');
    return noChange(null, []);
  }

  // ERRORS: a category guard trip pauses automation category-wide.
  if (guard?.isTripped(ctx.categoryId)) {
    reasons.push(`CATEGORY_GUARD_TRIPPED: ${guard.reasonFor(ctx.categoryId)}`);
    guardrails.push('CATEGORY_GUARD');
    return noChange(null, []);
  }

  if (!model) {
    reasons.push('NO_MODEL_AVAILABLE');
    guardrails.push('NO_MODEL');
    return noChange(null, []);
  }

  let estimate: ElasticityEstimate;
  try {
    estimate = model(ctx);
  } catch {
    // A failing model must never move a price.
    reasons.push('MODEL_FAILED');
    guardrails.push('MODEL_FAILURE_SAFE_DEFAULT');
    return noChange(null, []);
  }

  if (!Number.isFinite(estimate.suggestedPricePaise) || estimate.suggestedPricePaise <= 0) {
    reasons.push('MODEL_RETURNED_INVALID_PRICE');
    guardrails.push('MODEL_OUTPUT_REJECTED');
    return noChange(estimate.modelVersion, estimate.factors ?? []);
  }

  // RULES: an ungoverned or too-narrow competitor band must not influence the price at all.
  if (ctx.competitorBand) {
    const bandCheck = validateCompetitorBand(ctx.competitorBand);
    if (!bandCheck.ok) {
      reasons.push(bandCheck.reason);
      guardrails.push('COMPETITOR_BAND_REJECTED');
      return noChange(estimate.modelVersion, estimate.factors);
    }
  }

  // BRU-10 and the MRP ceiling, applied in the engine.
  const clamped = applyHardConstraints(estimate.suggestedPricePaise, ctx);
  guardrails.push(...clamped.applied);

  let effectiveMode: Mode = mode;

  // ERRORS: low elasticity confidence forces suggest-only regardless of the configured mode.
  if (estimate.confidence < MIN_ELASTICITY_CONFIDENCE) {
    effectiveMode = 'SUGGEST_ONLY';
    reasons.push(`ELASTICITY_CONFIDENCE_BELOW_THRESHOLD: ${estimate.confidence}`);
    guardrails.push('LOW_CONFIDENCE_SUGGEST_ONLY');
  }

  // VALIDATION: an event lock forbids automatic movement, but a suggestion is still useful.
  if (ctx.eventLocked) {
    effectiveMode = 'SUGGEST_ONLY';
    reasons.push('EVENT_LOCKED');
    guardrails.push('EVENT_LOCK_SUGGEST_ONLY');
  }

  // VALIDATION: the change-rate limiter.
  if (effectiveMode === 'AUTO_ADJUST' && isWithinAutoChangeCooldown(ctx)) {
    effectiveMode = 'SUGGEST_ONLY';
    reasons.push('AUTO_CHANGE_COOLDOWN_ACTIVE');
    guardrails.push('CHANGE_RATE_LIMITER');
  }

  if (clamped.pricePaise === ctx.currentPricePaise) {
    reasons.push('PRICE_UNCHANGED_AFTER_CONSTRAINTS');
    return noChange(estimate.modelVersion, estimate.factors);
  }

  const action: Action = effectiveMode === 'AUTO_ADJUST' ? 'AUTO_APPLIED' : 'SUGGESTED';
  return {
    action,
    pricePaise: clamped.pricePaise,
    reasons,
    guardrailsApplied: guardrails,
    audit: {
      sku: ctx.sku, vendorId: ctx.vendorId, modelVersion: estimate.modelVersion,
      fromPaise: ctx.currentPricePaise, toPaise: clamped.pricePaise,
      action, factors: estimate.factors, guardrailsApplied: [...guardrails], atMs: ctx.nowMs,
    },
  };
}

/**
 * DESC: full simulation ("what-if") before enablement. Runs the same decision path in
 * SUGGEST_ONLY so nothing can move a price during a simulation, and reports what WOULD have been
 * applied had the mode been AUTO_ADJUST.
 */
export interface SimulationRow {
  sku: string;
  fromPaise: Paise;
  wouldBePaise: Paise;
  wouldAutoApply: boolean;
  guardrailsApplied: string[];
}

export function simulate(contexts: PricingContext[], model: ElasticityModel,
                         guard?: CategoryGuard): SimulationRow[] {
  return contexts.map((ctx) => {
    const d = decidePrice(ctx, 'SUGGEST_ONLY', model, undefined, guard);
    // it would auto-apply only if nothing forced suggest-only for a reason other than the mode
    const blockers = ['LOW_CONFIDENCE_SUGGEST_ONLY', 'EVENT_LOCK_SUGGEST_ONLY',
      'CHANGE_RATE_LIMITER', 'KILL_SWITCH', 'CATEGORY_GUARD', 'NO_MODEL',
      'MODEL_FAILURE_SAFE_DEFAULT', 'MODEL_OUTPUT_REJECTED', 'COMPETITOR_BAND_REJECTED'];
    return {
      sku: ctx.sku,
      fromPaise: ctx.currentPricePaise,
      wouldBePaise: d.pricePaise,
      wouldAutoApply: d.action === 'SUGGESTED'
        && !d.guardrailsApplied.some((g) => blockers.includes(g)),
      guardrailsApplied: d.guardrailsApplied,
    };
  });
}

/** OUTPUTS: outcome attribution — realised margin and velocity deltas after a change. */
export interface OutcomeAttribution {
  sku: string;
  marginDeltaPaise: Paise;
  velocityDeltaUnits: number;
  attributableToPricing: boolean;
}

export function attributeOutcome(
  sku: string,
  before: { marginPaise: Paise; unitsPerDay: number },
  after: { marginPaise: Paise; unitsPerDay: number },
  priceChanged: boolean,
): OutcomeAttribution {
  return {
    sku,
    marginDeltaPaise: after.marginPaise - before.marginPaise,
    velocityDeltaUnits: after.unitsPerDay - before.unitsPerDay,
    // without a price change there is nothing for pricing to take credit or blame for
    attributableToPricing: priceChanged,
  };
}
