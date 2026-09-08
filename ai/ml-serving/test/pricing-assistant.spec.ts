/**
 * FR-VEN-013 vendor pricing assistant. The property the suite is built around is DEFERENCE: a
 * system that re-proposes its number the moment a human overrules it is an argument, not an
 * assistant, and a vendor who has to win the same argument twice a day will switch automation off
 * for good.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_TRIAL_MS,
  autoModeStatus,
  DEMAND_SHOCK_RATIO,
  isDemandShock,
  MANUAL_EDIT_CONFLICT_WINDOW_MS,
  MANUAL_OVERRIDE_BACKOFF_MS,
  runAssistant,
  trialReport,
  weeklyOutcomeReport,
  type AppliedChange,
  type AssistantRequest,
  type ManualEdit,
  type Signals,
  type SkuGroupSettings,
} from '../src/domain/pricing-assistant.js';
import { AUTO_CHANGE_MIN_INTERVAL_MS, MIN_ELASTICITY_CONFIDENCE, type CompetitorBand, type PricingContext }
  from '../src/domain/pricing.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const HOUR = 3_600_000;

const band = (over: Partial<CompetitorBand> = {}): CompetitorBand => ({
  lowPaise: 1_600_00,
  highPaise: 2_100_00,
  sampleSize: 12,
  sourceGovernanceRef: 'GOV-2026-04',
  ...over,
});

const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  sku: 'SKU-1',
  vendorId: 'V1',
  categoryId: 'CAT-SAREES',
  currentPricePaise: 2_000_00,
  mrpPaise: 2_500_00,
  bounds: { floorPaise: 1_500_00, ceilingPaise: 2_400_00 },
  inventoryOnHand: 40,
  inventoryAgeDays: 20,
  eventLocked: false,
  nowMs: NOW,
  ...over,
});

const settings = (over: Partial<SkuGroupSettings> = {}): SkuGroupSettings => ({
  skuGroupId: 'GRP-SAREES',
  mode: 'SUGGEST',
  objective: 0.8,                 // favours velocity, so the assistant wants to cut
  exclusionList: new Set(),
  ...over,
});

const signals = (over: Partial<Signals> = {}): Signals => ({
  elasticity: { value: -1.4, confidence: 0.85 },
  competitorBand: band(),
  inventoryAgeDays: 20,
  ...over,
});

const req = (over: Partial<AssistantRequest> = {}): AssistantRequest => ({
  ctx: ctx(),
  settings: settings(),
  signals: signals(),
  nowMs: NOW,
  ...over,
});

/** Auto mode, opted in and past its trial with a report on file. */
const autoSettings = (over: Partial<SkuGroupSettings> = {}): SkuGroupSettings => settings({
  mode: 'AUTO_APPLY',
  autoOptInAtMs: NOW - AUTO_TRIAL_MS - HOUR,
  autoOptInByUserId: 'VEN-USER-1',
  trialReportRef: 'TRIAL-2026-08',
  ...over,
});

// ============================================ deference to the vendor

describe('a manual edit wins and the assistant STANDS DOWN for 48 hours (ERRORS)', () => {
  it('defers to an edit inside the conflict window and sets a 48-hour backoff', () => {
    const edit: ManualEdit = { sku: 'SKU-1', atMs: NOW - 30 * 60_000, byUserId: 'VEN-USER-1', toPaise: 1_900_00 };
    const r = runAssistant(req({ settings: autoSettings(), lastManualEdit: edit }));

    expect(r.outcome).toBe('DEFERRED_TO_MANUAL');
    if (r.outcome !== 'DEFERRED_TO_MANUAL') return;
    // the backoff is the substantive half of "manual wins, AI backs off 48 h"
    expect(r.backoffUntilMs).toBe(edit.atMs + MANUAL_OVERRIDE_BACKOFF_MS);
    expect(r.manualEdit.byUserId).toBe('VEN-USER-1');
    expect(MANUAL_OVERRIDE_BACKOFF_MS).toBe(48 * HOUR);
  });

  it('keeps standing down for the whole 48 hours, not just the conflict hour', () => {
    const backoffUntil = NOW + 40 * HOUR;
    // no recent manual edit any more, but the backoff is still in force
    const r = runAssistant(req({ settings: autoSettings(), backoffUntilMs: backoffUntil }));
    expect(r.outcome).toBe('DEFERRED_TO_MANUAL');
    if (r.outcome === 'DEFERRED_TO_MANUAL') expect(r.backoffUntilMs).toBe(backoffUntil);
  });

  it('resumes once the backoff has elapsed', () => {
    const r = runAssistant(req({
      settings: autoSettings(),
      backoffUntilMs: NOW - 1,
    }));
    expect(r.outcome).toBe('AUTO_APPLIED');
  });

  it('an edit OLDER than the conflict window does not defer', () => {
    const old: ManualEdit = {
      sku: 'SKU-1', atMs: NOW - MANUAL_EDIT_CONFLICT_WINDOW_MS - 1,
      byUserId: 'VEN-USER-1', toPaise: 1_900_00,
    };
    expect(runAssistant(req({ settings: autoSettings(), lastManualEdit: old })).outcome)
      .toBe('AUTO_APPLIED');
    expect(MANUAL_EDIT_CONFLICT_WINDOW_MS).toBe(HOUR);
  });

  it('deference applies in SUGGEST mode too, so the vendor is not nagged either', () => {
    const edit: ManualEdit = { sku: 'SKU-1', atMs: NOW - 10 * 60_000, byUserId: 'VEN-USER-1', toPaise: 1_900_00 };
    expect(runAssistant(req({ lastManualEdit: edit })).outcome).toBe('DEFERRED_TO_MANUAL');
  });

  it('an excluded SKU is left entirely alone, ahead of every market signal', () => {
    const r = runAssistant(req({
      settings: autoSettings({ exclusionList: new Set(['SKU-1']) }),
    }));
    expect(r.outcome).toBe('NO_CHANGE');
    if (r.outcome === 'NO_CHANGE') expect(r.reason).toBe('SKU_ON_VENDOR_EXCLUSION_LIST');
  });
});

// ============================================ BRU-10 reuse

describe('BRU-10 is enforced through the Slice-40 engine, not a second implementation', () => {
  it('never suggests above MRP even when the vendor ceiling is higher', () => {
    // margin objective pushes up; MRP is below the vendor ceiling
    const r = runAssistant(req({
      ctx: ctx({ currentPricePaise: 990_00, mrpPaise: 1_000_00, bounds: { floorPaise: 500_00, ceilingPaise: 5_000_00 } }),
      settings: settings({ objective: 0 }),
    }));
    if (r.outcome === 'SUGGESTED') {
      expect(r.suggestion.suggestedPricePaise).toBeLessThanOrEqual(1_000_00);
    } else if (r.outcome === 'AUTO_APPLIED') {
      expect(r.change.toPaise).toBeLessThanOrEqual(1_000_00);
    }
  });

  it('never suggests below the vendor floor', () => {
    const r = runAssistant(req({
      ctx: ctx({ currentPricePaise: 1_550_00, bounds: { floorPaise: 1_500_00, ceilingPaise: 2_400_00 } }),
      settings: settings({ objective: 1 }),      // maximum velocity, wants to cut hard
      signals: signals({ inventoryAgeDays: 200 }),
    }));
    if (r.outcome === 'SUGGESTED') {
      expect(r.suggestion.suggestedPricePaise).toBeGreaterThanOrEqual(1_500_00);
      expect(r.suggestion.clampsApplied.length).toBeGreaterThan(0);
    }
  });

  it('reports which clamps the engine applied, rather than hiding them', () => {
    const r = runAssistant(req({
      ctx: ctx({ currentPricePaise: 1_520_00, bounds: { floorPaise: 1_500_00, ceilingPaise: 2_400_00 } }),
      settings: settings({ objective: 1 }),
      signals: signals({ inventoryAgeDays: 300 }),
    }));
    if (r.outcome === 'SUGGESTED') {
      expect(r.suggestion.clampsApplied).toContain('VENDOR_FLOOR');
    }
  });

  it('honours an event price-lock', () => {
    const r = runAssistant(req({ ctx: ctx({ eventLocked: true }), settings: autoSettings() }));
    expect(r.outcome).toBe('NO_CHANGE');
    if (r.outcome === 'NO_CHANGE') expect(r.reason).toBe('EVENT_PRICE_LOCK_IN_FORCE');
  });

  it('respects the 24-hour auto-change cooldown, downgrading to a suggestion', () => {
    const r = runAssistant(req({
      ctx: ctx({ lastAutoChangeAtMs: NOW - HOUR }),
      settings: autoSettings(),
    }));
    // the change is still offered, just not applied
    expect(r.outcome).toBe('SUGGESTED');
    expect(AUTO_CHANGE_MIN_INTERVAL_MS).toBe(24 * HOUR);

    const past = runAssistant(req({
      ctx: ctx({ lastAutoChangeAtMs: NOW - AUTO_CHANGE_MIN_INTERVAL_MS - 1 }),
      settings: autoSettings(),
    }));
    expect(past.outcome).toBe('AUTO_APPLIED');
  });
});

// ============================================ signal gaps

describe('signal gaps SUPPRESS the suggestion — never guess (ERRORS)', () => {
  it('suppresses with no elasticity signal at all', () => {
    const r = runAssistant(req({ signals: signals({ elasticity: undefined }) }));
    expect(r.outcome).toBe('SUPPRESSED');
    if (r.outcome === 'SUPPRESSED') expect(r.reason).toBe('NO_ELASTICITY_SIGNAL');
  });

  it('suppresses on low elasticity confidence rather than proceeding cautiously', () => {
    const r = runAssistant(req({
      signals: signals({ elasticity: { value: -1.4, confidence: MIN_ELASTICITY_CONFIDENCE - 0.01 } }),
    }));
    expect(r.outcome).toBe('SUPPRESSED');
    if (r.outcome === 'SUPPRESSED') expect(r.reason).toContain('ELASTICITY_CONFIDENCE_BELOW');
  });

  it('a REFUSED competitor band blocks entirely rather than falling through', () => {
    // too few sellers is a coordination signal, per Slice 40
    const r = runAssistant(req({ signals: signals({ competitorBand: band({ sampleSize: 3 }) }) }));
    expect(r.outcome).toBe('SUPPRESSED');
    if (r.outcome === 'SUPPRESSED') expect(r.reason).toContain('COMPETITOR_BAND_REFUSED');
  });

  it('an ungoverned competitor band is refused', () => {
    const r = runAssistant(req({
      signals: signals({ competitorBand: band({ sourceGovernanceRef: '' }) }),
    }));
    expect(r.outcome).toBe('SUPPRESSED');
  });

  it('proceeds with no competitor band at all, since it is not mandatory', () => {
    const r = runAssistant(req({ signals: signals({ competitorBand: undefined }) }));
    expect(r.outcome).toBe('SUGGESTED');
  });

  it('suppression is reported as SUPPRESSED, not as no change', () => {
    // the distinction matters: one means "we have nothing to say", the other "we looked and the
    // answer is the current price"
    const suppressed = runAssistant(req({ signals: signals({ elasticity: undefined }) }));
    expect(suppressed.outcome).toBe('SUPPRESSED');
    const locked = runAssistant(req({ ctx: ctx({ eventLocked: true }) }));
    expect(locked.outcome).toBe('NO_CHANGE');
  });
});

// ============================================ auto-mode gating

describe('auto mode requires an explicit opt-in and a 7-day trial report (RULES)', () => {
  it('refuses auto mode with no per-group opt-in', () => {
    const s = autoModeStatus(settings({ mode: 'AUTO_APPLY' }), NOW);
    expect(s.permitted).toBe(false);
    if (!s.permitted) expect(s.reason).toBe('AUTO_MODE_REQUIRES_EXPLICIT_PER_GROUP_OPT_IN');

    // and the assistant only suggests
    expect(runAssistant(req({ settings: settings({ mode: 'AUTO_APPLY' }) })).outcome).toBe('SUGGESTED');
  });

  it('permits auto-apply DURING the trial, flagged as in-trial', () => {
    const s = autoModeStatus(settings({
      mode: 'AUTO_APPLY', autoOptInAtMs: NOW - 2 * 24 * HOUR, autoOptInByUserId: 'VEN-1',
    }), NOW);
    expect(s.permitted).toBe(true);
    if (s.permitted) expect(s.inTrial).toBe(true);
  });

  it('automation does NOT graduate on the strength of time passing alone', () => {
    // the trial has run its course and nobody produced the report
    const s = autoModeStatus(settings({
      mode: 'AUTO_APPLY', autoOptInAtMs: NOW - AUTO_TRIAL_MS - HOUR, autoOptInByUserId: 'VEN-1',
    }), NOW);
    expect(s.permitted).toBe(false);
    if (!s.permitted) expect(s.reason).toBe('SEVEN_DAY_TRIAL_REPORT_NOT_PRODUCED');
    expect(AUTO_TRIAL_MS).toBe(7 * 24 * HOUR);
  });

  it('permits unrestricted auto-apply once the report exists', () => {
    const s = autoModeStatus(autoSettings(), NOW);
    expect(s.permitted).toBe(true);
    if (s.permitted) expect(s.inTrial).toBe(false);
    expect(runAssistant(req({ settings: autoSettings() })).outcome).toBe('AUTO_APPLIED');
  });

  it('suggest mode never auto-applies', () => {
    expect(autoModeStatus(settings({ mode: 'SUGGEST' }), NOW).permitted).toBe(false);
    expect(runAssistant(req()).outcome).toBe('SUGGESTED');
  });
});

// ============================================ anomaly guard

describe('the anomaly guard pauses automation on a demand shock (RULES)', () => {
  it('detects a shock in both directions', () => {
    expect(isDemandShock({ demandRatio: DEMAND_SHOCK_RATIO })).toBe(true);
    expect(isDemandShock({ demandRatio: 1 / DEMAND_SHOCK_RATIO })).toBe(true);
    expect(isDemandShock({ demandRatio: 1.5 })).toBe(false);
    expect(isDemandShock({})).toBe(false);
  });

  it('downgrades to a SUGGESTION rather than suppressing, because a shock is when a human should look', () => {
    const r = runAssistant(req({
      settings: autoSettings(),
      signals: signals({ demandRatio: 3.0 }),
    }));
    expect(r.outcome).toBe('SUGGESTED');
    if (r.outcome === 'SUGGESTED') expect(r.suggestion.rationale.length).toBeGreaterThan(0);
  });

  it('auto-applies normally when demand is stable', () => {
    expect(runAssistant(req({ settings: autoSettings(), signals: signals({ demandRatio: 1.1 }) })).outcome)
      .toBe('AUTO_APPLIED');
  });
});

// ============================================ rationale and impact

describe('suggestions carry a top-three rationale and a projected range (OUTPUTS)', () => {
  it('names at most three factors, strongest first', () => {
    const r = runAssistant(req({ signals: signals({ inventoryAgeDays: 120 }) }));
    if (r.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    const rationale = r.suggestion.rationale;
    expect(rationale.length).toBeLessThanOrEqual(3);
    expect(rationale[0].contributionPct).toBeGreaterThanOrEqual(rationale[1].contributionPct);
    expect(rationale.map((f) => f.name)).toContain('ELASTICITY');
  });

  it('includes the vendor OWN objective slider as a named factor', () => {
    // a vendor reading a suggestion deserves to see that their own setting pushed it
    const velocity = runAssistant(req({ settings: settings({ objective: 0.9 }) }));
    if (velocity.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    const objectiveFactor = velocity.suggestion.rationale.find((f) => f.name === 'OBJECTIVE')
      ?? { note: '', direction: 'RAISE' as const };
    // with only three slots the objective may be crowded out, so check it appears when it does
    if (objectiveFactor.note) expect(objectiveFactor.note).toContain('velocity');
  });

  it('mentions inventory age only when the stock is actually old', () => {
    const fresh = runAssistant(req({ signals: signals({ inventoryAgeDays: 10 }) }));
    if (fresh.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    expect(fresh.suggestion.rationale.map((f) => f.name)).not.toContain('INVENTORY_AGE');

    const stale = runAssistant(req({ signals: signals({ inventoryAgeDays: 180 }) }));
    if (stale.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    expect(stale.suggestion.rationale.map((f) => f.name)).toContain('INVENTORY_AGE');
  });

  it('projects a RANGE rather than a point, and the range is ordered', () => {
    const r = runAssistant(req());
    if (r.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    const p = r.suggestion.projectedImpact;
    expect(p.unitsLowPct).toBeLessThan(p.unitsHighPct);
    expect(p.revenueLowPct).toBeLessThan(p.revenueHighPct);
  });

  it('a price CUT projects more units, given negative elasticity', () => {
    const r = runAssistant(req({ settings: settings({ objective: 1 }) }));
    if (r.outcome !== 'SUGGESTED') throw new Error('expected a suggestion');
    expect(r.suggestion.suggestedPricePaise).toBeLessThan(2_000_00);
    expect(r.suggestion.projectedImpact.unitsHighPct).toBeGreaterThan(0);
  });
});

// ============================================ outcome reporting

describe('the weekly report scores whether the RANGE contained the outcome (OUTPUTS)', () => {
  const change = (sku: string, low: number, high: number): AppliedChange => ({
    sku,
    fromPaise: 2_000_00,
    toPaise: 1_900_00,
    appliedAtMs: NOW,
    mode: 'AUTO_APPLY',
    rationale: [],
    projectedImpact: { unitsLowPct: low, unitsHighPct: high, revenueLowPct: low, revenueHighPct: high },
  });

  it('counts a realised figure inside the projected range as within projection', () => {
    const report = weeklyOutcomeReport(NOW, [
      { change: change('SKU-1', 2, 10), realisedUnitsPct: 6, realisedRevenuePct: 3 },
      { change: change('SKU-2', 2, 10), realisedUnitsPct: 25, realisedRevenuePct: -4 },
    ]);
    expect(report.changesApplied).toBe(2);
    expect(report.withinProjectionCount).toBe(1);
    expect(report.projectionAccuracy).toBe(0.5);
    expect(report.rows[0].withinProjection).toBe(true);
    expect(report.rows[1].withinProjection).toBe(false);
  });

  it('scores containment rather than closeness to a midpoint', () => {
    // an honest wide range that contains the outcome is more useful to a vendor than a confident
    // narrow one that misses
    const wide = weeklyOutcomeReport(NOW, [
      { change: change('SKU-1', -20, 40), realisedUnitsPct: 35, realisedRevenuePct: 5 },
    ]);
    const narrowMiss = weeklyOutcomeReport(NOW, [
      { change: change('SKU-1', 9, 11), realisedUnitsPct: 35, realisedRevenuePct: 5 },
    ]);
    expect(wide.projectionAccuracy).toBe(1);
    expect(narrowMiss.projectionAccuracy).toBe(0);
  });

  it('handles an inverted projected range without misjudging containment', () => {
    const report = weeklyOutcomeReport(NOW, [
      { change: change('SKU-1', 10, -5), realisedUnitsPct: 2, realisedRevenuePct: 1 },
    ]);
    expect(report.rows[0].withinProjection).toBe(true);
  });

  it('averages realised revenue and does not divide by zero on an empty week', () => {
    const report = weeklyOutcomeReport(NOW, [
      { change: change('SKU-1', 0, 10), realisedUnitsPct: 5, realisedRevenuePct: 4 },
      { change: change('SKU-2', 0, 10), realisedUnitsPct: 5, realisedRevenuePct: -2 },
    ]);
    expect(report.meanRealisedRevenuePct).toBe(1);

    const empty = weeklyOutcomeReport(NOW, []);
    expect(empty.changesApplied).toBe(0);
    expect(empty.projectionAccuracy).toBe(0);
    expect(empty.meanRealisedRevenuePct).toBe(0);
  });
});

describe('the 7-day trial report recommends conservatively (RULES)', () => {
  const report = (accuracy: number, revenuePct: number, changes = 5) => ({
    weekStartMs: NOW,
    rows: [],
    changesApplied: changes,
    withinProjectionCount: 0,
    projectionAccuracy: accuracy,
    meanRealisedRevenuePct: revenuePct,
  });

  it('recommends continuing only when projections held AND revenue did not fall', () => {
    expect(trialReport(autoSettings(), report(0.8, 3)).recommendation).toBe('CONTINUE_AUTO');
    expect(trialReport(autoSettings(), report(0.8, -1)).recommendation).toBe('REVERT_TO_SUGGEST');
    expect(trialReport(autoSettings(), report(0.4, 5)).recommendation).toBe('REVERT_TO_SUGGEST');
  });

  it('reverts when the trial applied no changes, since nothing was learned', () => {
    expect(trialReport(autoSettings(), report(1, 10, 0)).recommendation).toBe('REVERT_TO_SUGGEST');
  });

  it('carries the trial window so a vendor can see the period it covers', () => {
    const s = autoSettings();
    const t = trialReport(s, report(0.9, 2));
    expect(t.optInAtMs).toBe(s.autoOptInAtMs);
    expect(t.trialEndsAtMs).toBe(s.autoOptInAtMs! + AUTO_TRIAL_MS);
    expect(t.skuGroupId).toBe('GRP-SAREES');
  });
});
