/**
 * FR-AI-008 dynamic pricing engine. Every guardrail is tested with an in-test model double, so
 * the engine's safety properties are established without any real model — which is the point: the
 * hard constraints must hold whatever the model says, including when it says something absurd.
 */
import { describe, expect, it } from 'vitest';
import {
  applyHardConstraints,
  attributeOutcome,
  AUTO_CHANGE_MIN_INTERVAL_MS,
  CategoryGuard,
  decidePrice,
  isWithinAutoChangeCooldown,
  KILL_SWITCH_MAX_PROPAGATION_MS,
  MIN_COMPETITOR_BAND_SAMPLE,
  MIN_ELASTICITY_CONFIDENCE,
  PricingKillSwitch,
  simulate,
  validateCompetitorBand,
  type CompetitorBand,
  type ElasticityModel,
  type PricingContext,
} from '../src/domain/pricing.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  sku: 'SKU-1',
  vendorId: 'V1',
  categoryId: 'CAT-SAREES',
  currentPricePaise: 1_000_00,
  mrpPaise: 1_500_00,
  bounds: { floorPaise: 800_00, ceilingPaise: 1_400_00 },
  inventoryOnHand: 40,
  inventoryAgeDays: 20,
  eventLocked: false,
  nowMs: NOW,
  ...over,
});

/** A model double that suggests whatever it is told to, with full confidence by default. */
const model = (suggestedPricePaise: number, over: Partial<ReturnType<ElasticityModel>> = {}): ElasticityModel =>
  () => ({
    suggestedPricePaise,
    elasticity: -1.4,
    confidence: 0.9,
    modelVersion: 'elast-v7',
    factors: ['inventory_age_20d', 'elasticity_-1.4'],
    ...over,
  });

const band = (over: Partial<CompetitorBand> = {}): CompetitorBand => ({
  lowPaise: 900_00, highPaise: 1_200_00, sampleSize: 12, sourceGovernanceRef: 'GOV-FEED-3', ...over,
});

// ================================================= BRU-10 hard constraints

describe('BRU-10 and the MRP ceiling are enforced IN THE ENGINE', () => {
  it('a model suggesting above MRP cannot produce a price above MRP', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(9_999_00));
    expect(d.pricePaise).toBeLessThanOrEqual(ctx().mrpPaise);
    // the vendor ceiling is tighter than MRP here, so that is what binds
    expect(d.pricePaise).toBe(1_400_00);
    expect(d.guardrailsApplied).toContain('MRP_CEILING');
    expect(d.guardrailsApplied).toContain('VENDOR_CEILING');
  });

  it('a model suggesting below the vendor floor is clamped up to the floor', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_00));
    expect(d.pricePaise).toBe(800_00);
    expect(d.guardrailsApplied).toContain('VENDOR_FLOOR');
  });

  it('MRP binds even when the vendor ceiling is set above it', () => {
    const c = ctx({ mrpPaise: 1_100_00, bounds: { floorPaise: 800_00, ceilingPaise: 2_000_00 } });
    const d = decidePrice(c, 'AUTO_ADJUST', model(1_900_00));
    expect(d.pricePaise).toBe(1_100_00);
    expect(d.guardrailsApplied).toContain('MRP_CEILING');
  });

  it('contradictory bounds resolve to the ceiling, never above MRP', () => {
    // a vendor floor above MRP is contradictory; the safe answer is the MRP, not the floor
    const c = ctx({ mrpPaise: 900_00, bounds: { floorPaise: 1_200_00, ceilingPaise: 1_400_00 } });
    const out = applyHardConstraints(1_300_00, c);
    expect(out.pricePaise).toBeLessThanOrEqual(900_00);
    expect(out.applied).toContain('CONTRADICTORY_BOUNDS_RESOLVED_TO_CEILING');
  });

  it('clamping is a pure function callable independently of any model', () => {
    const c = ctx();
    expect(applyHardConstraints(1_200_00, c).pricePaise).toBe(1_200_00);
    expect(applyHardConstraints(1_200_00, c).applied).toEqual([]);
  });
});

// ================================================= collusion safety

describe('collusion-safe design (RULES)', () => {
  it('a band aggregating too few sellers is refused as a coordination signal', () => {
    for (let n = 1; n < MIN_COMPETITOR_BAND_SAMPLE; n++) {
      const r = validateCompetitorBand(band({ sampleSize: n }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('COMPETITOR_BAND_SAMPLE_TOO_SMALL');
    }
    expect(validateCompetitorBand(band({ sampleSize: MIN_COMPETITOR_BAND_SAMPLE })).ok).toBe(true);
  });

  it('an ungoverned or inverted band is refused', () => {
    expect(validateCompetitorBand(band({ sourceGovernanceRef: '  ' })).ok).toBe(false);
    expect(validateCompetitorBand(band({ lowPaise: 1_200_00, highPaise: 900_00 })).ok).toBe(false);
  });

  it('a rejected band prevents any price movement at all, rather than being ignored', () => {
    const d = decidePrice(ctx({ competitorBand: band({ sampleSize: 1 }) }), 'AUTO_ADJUST', model(1_200_00));
    expect(d.action).toBe('NO_CHANGE');
    expect(d.pricePaise).toBe(1_000_00);
    expect(d.guardrailsApplied).toContain('COMPETITOR_BAND_REJECTED');
    expect(d.reasons.some((r) => r.includes('SAMPLE_TOO_SMALL'))).toBe(true);
  });

  it('a properly aggregated governed band permits the change', () => {
    const d = decidePrice(ctx({ competitorBand: band() }), 'AUTO_ADJUST', model(1_200_00));
    expect(d.action).toBe('AUTO_APPLIED');
    expect(d.pricePaise).toBe(1_200_00);
  });
});

// ================================================= confidence gating

describe('elasticity confidence (ERRORS)', () => {
  it('below-threshold confidence forces suggest-only REGARDLESS of mode', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00, { confidence: MIN_ELASTICITY_CONFIDENCE - 0.01 }));
    expect(d.action).toBe('SUGGESTED');
    expect(d.pricePaise).toBe(1_200_00);
    expect(d.guardrailsApplied).toContain('LOW_CONFIDENCE_SUGGEST_ONLY');
    expect(d.reasons.some((r) => r.startsWith('ELASTICITY_CONFIDENCE_BELOW_THRESHOLD'))).toBe(true);
  });

  it('at the threshold, auto-adjust is permitted', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00, { confidence: MIN_ELASTICITY_CONFIDENCE }));
    expect(d.action).toBe('AUTO_APPLIED');
  });
});

// ================================================= event locks & rate limiter

describe('event locks and the change-rate limiter (VALIDATION)', () => {
  it('an event-locked SKU may be suggested but never auto-adjusted', () => {
    const d = decidePrice(ctx({ eventLocked: true }), 'AUTO_ADJUST', model(1_200_00));
    expect(d.action).toBe('SUGGESTED');
    expect(d.guardrailsApplied).toContain('EVENT_LOCK_SUGGEST_ONLY');
  });

  it('at most one automatic change per SKU per 24 hours', () => {
    const justChanged = ctx({ lastAutoChangeAtMs: NOW - AUTO_CHANGE_MIN_INTERVAL_MS + 1 });
    expect(isWithinAutoChangeCooldown(justChanged)).toBe(true);
    const limited = decidePrice(justChanged, 'AUTO_ADJUST', model(1_200_00));
    expect(limited.action).toBe('SUGGESTED');
    expect(limited.guardrailsApplied).toContain('CHANGE_RATE_LIMITER');

    const elapsed = ctx({ lastAutoChangeAtMs: NOW - AUTO_CHANGE_MIN_INTERVAL_MS });
    expect(isWithinAutoChangeCooldown(elapsed)).toBe(false);
    expect(decidePrice(elapsed, 'AUTO_ADJUST', model(1_200_00)).action).toBe('AUTO_APPLIED');
  });

  it('a SKU never auto-changed before is not in cooldown', () => {
    expect(isWithinAutoChangeCooldown(ctx())).toBe(false);
  });
});

// ================================================= kill switch & guard trip

describe('kill switch and category guard', () => {
  it('the kill switch stops the engine and reports a ≤60s propagation deadline', () => {
    const ks = new PricingKillSwitch();
    const { propagateByMs } = ks.engage(NOW);
    expect(propagateByMs).toBe(NOW + KILL_SWITCH_MAX_PROPAGATION_MS);
    expect(KILL_SWITCH_MAX_PROPAGATION_MS).toBeLessThanOrEqual(60_000);

    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00), ks);
    expect(d.action).toBe('NO_CHANGE');
    expect(d.pricePaise).toBe(1_000_00);
    expect(d.guardrailsApplied).toContain('KILL_SWITCH');

    ks.release();
    expect(decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00), ks).action).toBe('AUTO_APPLIED');
  });

  it('a demand-shock guard trip pauses automation category-wide', () => {
    const guard = new CategoryGuard();
    guard.trip('CAT-SAREES', 'DEMAND_SHOCK', NOW);

    const paused = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00), undefined, guard);
    expect(paused.action).toBe('NO_CHANGE');
    expect(paused.guardrailsApplied).toContain('CATEGORY_GUARD');
    expect(paused.reasons.some((r) => r.includes('DEMAND_SHOCK'))).toBe(true);

    // another category is unaffected
    const other = decidePrice(ctx({ categoryId: 'CAT-SHOES' }), 'AUTO_ADJUST', model(1_200_00), undefined, guard);
    expect(other.action).toBe('AUTO_APPLIED');

    guard.clear('CAT-SAREES');
    expect(decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00), undefined, guard).action).toBe('AUTO_APPLIED');
  });
});

// ================================================= model failure safety

describe('model failures never move a price', () => {
  it('a throwing model results in NO_CHANGE', () => {
    const broken: ElasticityModel = () => { throw new Error('model unavailable'); };
    const d = decidePrice(ctx(), 'AUTO_ADJUST', broken);
    expect(d.action).toBe('NO_CHANGE');
    expect(d.pricePaise).toBe(1_000_00);
    expect(d.guardrailsApplied).toContain('MODEL_FAILURE_SAFE_DEFAULT');
  });

  it('an absent model results in NO_CHANGE', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST');
    expect(d.action).toBe('NO_CHANGE');
    expect(d.guardrailsApplied).toContain('NO_MODEL');
  });

  it('a nonsensical model output is rejected rather than clamped into plausibility', () => {
    for (const bad of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = decidePrice(ctx(), 'AUTO_ADJUST', model(bad));
      expect(d.action).toBe('NO_CHANGE');
      expect(d.guardrailsApplied).toContain('MODEL_OUTPUT_REJECTED');
    }
  });

  it('a suggestion that clamps back to the current price is NO_CHANGE, not a spurious update', () => {
    const d = decidePrice(ctx({ currentPricePaise: 1_400_00 }), 'AUTO_ADJUST', model(9_999_00));
    expect(d.pricePaise).toBe(1_400_00);
    expect(d.action).toBe('NO_CHANGE');
    expect(d.reasons).toContain('PRICE_UNCHANGED_AFTER_CONSTRAINTS');
  });
});

// ================================================= audit (SECURITY)

describe('every decision is audited with model version and factors', () => {
  it('an applied change records the model version, both prices and the rationale factors', () => {
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00));
    expect(d.audit.modelVersion).toBe('elast-v7');
    expect(d.audit.fromPaise).toBe(1_000_00);
    expect(d.audit.toPaise).toBe(1_200_00);
    expect(d.audit.action).toBe('AUTO_APPLIED');
    expect(d.audit.factors).toContain('elasticity_-1.4');
    expect(d.audit.sku).toBe('SKU-1');
    expect(d.audit.atMs).toBe(NOW);
  });

  it('a refusal is audited too, with the guardrail that caused it', () => {
    const ks = new PricingKillSwitch();
    ks.engage(NOW);
    const d = decidePrice(ctx(), 'AUTO_ADJUST', model(1_200_00), ks);
    expect(d.audit.action).toBe('NO_CHANGE');
    expect(d.audit.guardrailsApplied).toContain('KILL_SWITCH');
    expect(d.audit.fromPaise).toBe(d.audit.toPaise);
  });
});

// ================================================= simulation

describe('what-if simulation (DESC)', () => {
  it('a simulation never applies a price and reports what would have happened', () => {
    const rows = simulate([ctx(), ctx({ sku: 'SKU-2', eventLocked: true })], model(1_200_00));
    expect(rows).toHaveLength(2);
    expect(rows[0].sku).toBe('SKU-1');
    expect(rows[0].wouldBePaise).toBe(1_200_00);
    expect(rows[0].wouldAutoApply).toBe(true);
    // the event-locked SKU would NOT auto-apply, and the simulation says so
    expect(rows[1].wouldAutoApply).toBe(false);
    expect(rows[1].guardrailsApplied).toContain('EVENT_LOCK_SUGGEST_ONLY');
  });

  it('a simulation reports a low-confidence SKU as suggest-only', () => {
    const rows = simulate([ctx()], model(1_200_00, { confidence: 0.2 }));
    expect(rows[0].wouldAutoApply).toBe(false);
    expect(rows[0].guardrailsApplied).toContain('LOW_CONFIDENCE_SUGGEST_ONLY');
  });

  it('a simulation respects a tripped category guard', () => {
    const guard = new CategoryGuard();
    guard.trip('CAT-SAREES', 'DEMAND_SHOCK', NOW);
    const rows = simulate([ctx()], model(1_200_00), guard);
    expect(rows[0].wouldAutoApply).toBe(false);
    expect(rows[0].wouldBePaise).toBe(1_000_00);
  });
});

// ================================================= outcome attribution

describe('outcome attribution (OUTPUTS)', () => {
  it('reports realised margin and velocity deltas', () => {
    const a = attributeOutcome('SKU-1',
      { marginPaise: 200_00, unitsPerDay: 10 },
      { marginPaise: 260_00, unitsPerDay: 13 }, true);
    expect(a.marginDeltaPaise).toBe(60_00);
    expect(a.velocityDeltaUnits).toBe(3);
    expect(a.attributableToPricing).toBe(true);
  });

  it('does not attribute an outcome to pricing when no price changed', () => {
    const a = attributeOutcome('SKU-1',
      { marginPaise: 200_00, unitsPerDay: 10 },
      { marginPaise: 400_00, unitsPerDay: 25 }, false);
    expect(a.marginDeltaPaise).toBe(200_00);
    expect(a.attributableToPricing).toBe(false);
  });
});
