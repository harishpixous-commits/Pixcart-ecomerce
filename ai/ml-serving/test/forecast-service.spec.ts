/**
 * FR-AI-006 platform demand forecasting service. Two properties get the most attention: the
 * publish gate, because an aggregate improvement can hide a segment getting materially worse; and
 * hierarchical coherence, because a hierarchy that does not add up gives a planner two
 * contradictory answers to the same question.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCovariates,
  detectRegimeChange,
  forecastSeries,
  isCoherent,
  isMonotone,
  mapePercent,
  publishDecision,
  quantilesFrom,
  reconcileToCategoryTotal,
  scopeToVendor,
  SEGMENT_REGRESSION_LIMIT_PTS,
  segmentAccuracy,
  SPARSE_MIN_OBSERVATIONS,
  vendorCategoryTotal,
  wapePercent,
  type Covariates,
  type RunOptions,
  type SegmentAccuracy,
  type SeriesInput,
} from '../src/domain/forecast-service.js';
import { WEEK_MS, type WeeklyHistory } from '../src/domain/demand-forecast.js';

const NOW = Date.UTC(2026, 7, 24, 0, 0, 0);

const history = (weeks: number, units = 70, stockoutDays = 0): WeeklyHistory[] =>
  Array.from({ length: weeks }, (_, i) => ({
    weekStartMs: NOW - (weeks - i) * WEEK_MS,
    unitsSold: units,
    stockoutDays,
  }));

const series = (over: Partial<SeriesInput> = {}): SeriesInput => ({
  sku: 'SKU-1',
  locationId: 'LOC-CBE',
  categoryId: 'CAT-SAREES',
  vendorId: 'V1',
  history: history(12),
  ...over,
});

const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  modelVersion: 'fc-2026.08.1',
  horizonWeeks: 4,
  covariatesByWeek: Array.from({ length: 4 }, () => ({
    priceIndex: 1, promoActive: false, seasonalityFactor: 1, categoryTrendFactor: 1,
  })),
  ...over,
});

const ok = (r: ReturnType<typeof forecastSeries>) => {
  if (!r.ok) throw new Error('expected cells: ' + JSON.stringify(r.violations));
  return r.cells;
};

// ============================================ quantiles

describe('P10/P50/P90 with monotonicity ENFORCED', () => {
  it('produces an ordered quantile set', () => {
    const q = quantilesFrom(100, 20);
    expect(q.p10).toBeLessThan(q.p50);
    expect(q.p50).toBeLessThan(q.p90);
    expect(q.p50).toBe(100);
    expect(isMonotone(q)).toBe(true);
  });

  it('clamps rather than inverting when the band would go negative near zero', () => {
    // a wide band on a small mean would otherwise produce p10 > p50 after flooring at zero
    const q = quantilesFrom(3, 50);
    expect(q.p10).toBe(0);
    expect(isMonotone(q)).toBe(true);
    // demand cannot be negative
    expect(q.p10).toBeGreaterThanOrEqual(0);
  });

  it('collapses to a point when sigma is zero', () => {
    const q = quantilesFrom(42, 0);
    expect(q).toEqual({ p10: 42, p50: 42, p90: 42 });
    expect(isMonotone(q)).toBe(true);
  });

  it('treats a negative sigma as zero rather than inverting the band', () => {
    expect(isMonotone(quantilesFrom(42, -10))).toBe(true);
  });

  it('every produced cell is monotone', () => {
    const cells = ok(forecastSeries(series(), NOW, opts()));
    expect(cells.every((c) => isMonotone(c.quantiles))).toBe(true);
  });

  it('the band widens with the horizon', () => {
    const cells = ok(forecastSeries(series({
      history: [
        ...history(6, 60), ...history(6, 90),
      ].map((w, i) => ({ ...w, weekStartMs: NOW - (12 - i) * WEEK_MS })),
    }), NOW, opts()));
    const w1 = cells[0].quantiles.p90 - cells[0].quantiles.p10;
    const w4 = cells[3].quantiles.p90 - cells[3].quantiles.p10;
    expect(w4).toBeGreaterThan(w1);
  });
});

// ============================================ sparse SKUs

describe('sparse SKUs use a pooled category model, LABELLED (RULES)', () => {
  it('uses the hierarchical model with enough observations', () => {
    const cells = ok(forecastSeries(series({ history: history(SPARSE_MIN_OBSERVATIONS) }), NOW, opts()));
    expect(cells[0].basis).toBe('HIERARCHICAL');
    expect(cells[0].basisLabel).toContain('Hierarchical model on 8');
    expect(SPARSE_MIN_OBSERVATIONS).toBe(8);
  });

  it('falls back to a pooled model below the threshold, and says so', () => {
    const cells = ok(forecastSeries(series({ history: history(3) }), NOW,
      opts({ pooledCategoryWeeklyUnits: { 'CAT-SAREES': 55 } })));
    expect(cells[0].basis).toBe('POOLED_CATEGORY');
    expect(cells[0].basisLabel).toContain('Pooled category model');
    expect(cells[0].basisLabel).toContain('3 of 8 weeks');
    expect(cells[0].quantiles.p50).toBe(55);
  });

  it('a pooled estimate carries a wider band, because it is less certain about THIS SKU', () => {
    const pooled = ok(forecastSeries(series({ history: history(3) }), NOW,
      opts({ pooledCategoryWeeklyUnits: { 'CAT-SAREES': 70 } })));
    const modelled = ok(forecastSeries(series(), NOW, opts()));
    const pooledWidth = pooled[0].quantiles.p90 - pooled[0].quantiles.p10;
    const modelWidth = modelled[0].quantiles.p90 - modelled[0].quantiles.p10;
    expect(pooledWidth).toBeGreaterThan(modelWidth);
  });

  it('refuses when a SKU is sparse and no pooled model exists for its category', () => {
    const r = forecastSeries(series({ history: history(2) }), NOW, opts());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((v) => v.code === 'SPARSE_SKU_AND_NO_POOLED_CATEGORY_MODEL')).toBe(true);
    }
  });

  it('censored-out weeks count against the sparsity threshold', () => {
    // ten weeks of history, but all heavily stocked out and therefore unusable
    const cells = forecastSeries(series({ history: history(10, 5, 7) }), NOW,
      opts({ pooledCategoryWeeklyUnits: { 'CAT-SAREES': 40 } }));
    expect(cells.ok).toBe(true);
    if (cells.ok) expect(cells.cells[0].basis).toBe('POOLED_CATEGORY');
  });

  it('REUSES the Slice-57 censoring correction rather than a second implementation', () => {
    // three days out of stock: 35 sold becomes ~61, so the forecast is materially higher than 35
    const censored = ok(forecastSeries(series({ history: history(12, 35, 3) }), NOW, opts()));
    const raw = ok(forecastSeries(series({ history: history(12, 35, 0) }), NOW, opts()));
    expect(censored[0].quantiles.p50).toBeGreaterThan(raw[0].quantiles.p50);
    expect(censored[0].quantiles.p50).toBe(61);
  });
});

// ============================================ covariates

describe('covariates, and a reduced-feature run on a feed gap (ERRORS)', () => {
  it('applies every supplied covariate', () => {
    const full: Covariates = { priceIndex: 1, promoActive: true, seasonalityFactor: 1.2, categoryTrendFactor: 1.1 };
    const r = applyCovariates(100, full);
    expect(r.reducedFeature).toBe(false);
    expect(r.featureGaps).toEqual([]);
    expect(r.adjustedUnits).toBeCloseTo(100 * 1.2 * 1.1 * 1.35, 4);
  });

  it('runs reduced-feature and NAMES the gaps rather than failing', () => {
    const r = applyCovariates(100, { seasonalityFactor: 1.2 });
    expect(r.reducedFeature).toBe(true);
    expect(r.featureGaps.sort()).toEqual(['category_trend', 'price_history', 'promo_calendar']);
    // the forecast is still produced, just with fewer features
    expect(r.adjustedUnits).toBeCloseTo(120, 4);
  });

  it('a higher relative price reduces expected demand', () => {
    const cheap = applyCovariates(100, { priceIndex: 0.8, promoActive: false, seasonalityFactor: 1, categoryTrendFactor: 1 });
    const dear = applyCovariates(100, { priceIndex: 1.5, promoActive: false, seasonalityFactor: 1, categoryTrendFactor: 1 });
    expect(dear.adjustedUnits).toBeLessThan(cheap.adjustedUnits);
  });

  it('marks the cell reduced-feature and carries the gaps through', () => {
    const cells = ok(forecastSeries(series(), NOW, opts({
      covariatesByWeek: [{ seasonalityFactor: 1 }, {}, {}, {}],
    })));
    expect(cells[0].reducedFeature).toBe(true);
    expect(cells[0].featureGaps).toContain('promo_calendar');
    expect(cells[1].featureGaps).toContain('seasonality');
  });

  it('a missing covariate week is treated as fully absent rather than throwing', () => {
    const cells = ok(forecastSeries(series(), NOW, opts({ covariatesByWeek: [] })));
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.reducedFeature)).toBe(true);
  });
});

// ============================================ hierarchical coherence

describe('SKU forecasts sum EXACTLY to the category total (DESC)', () => {
  const threeSkus = () => {
    const cells = [];
    for (const [sku, units] of [['SKU-A', 70], ['SKU-B', 30], ['SKU-C', 11]] as const) {
      cells.push(ok(forecastSeries(series({ sku, history: history(12, units) }), NOW, opts()))[0]);
    }
    return cells;
  };

  it('reconciles children to the parent with no residue', () => {
    const cells = threeSkus();
    const reconciled = reconcileToCategoryTotal(cells, 150);
    expect(isCoherent(reconciled, 150)).toBe(true);
    expect(reconciled.reduce((a, c) => a + c.quantiles.p50, 0)).toBe(150);
  });

  it('is exact on a total that does not divide evenly', () => {
    // 111 bottom-up scaled to 100 leaves a residue that naive rounding would drop
    const cells = threeSkus();
    for (const total of [100, 101, 999, 7]) {
      const reconciled = reconcileToCategoryTotal(cells, total);
      expect(isCoherent(reconciled, total)).toBe(true);
    }
  });

  it('preserves relative size, so the biggest SKU stays the biggest', () => {
    const reconciled = reconcileToCategoryTotal(threeSkus(), 300);
    expect(reconciled[0].quantiles.p50).toBeGreaterThan(reconciled[1].quantiles.p50);
    expect(reconciled[1].quantiles.p50).toBeGreaterThan(reconciled[2].quantiles.p50);
  });

  it('keeps every reconciled cell monotone', () => {
    const reconciled = reconcileToCategoryTotal(threeSkus(), 137);
    expect(reconciled.every((c) => isMonotone(c.quantiles))).toBe(true);
  });

  it('distributes evenly and exactly when every child forecasts zero', () => {
    const cells = threeSkus().map((c) => ({ ...c, quantiles: { p10: 0, p50: 0, p90: 0 } }));
    const reconciled = reconcileToCategoryTotal(cells, 100);
    expect(isCoherent(reconciled, 100)).toBe(true);
  });

  it('an empty child set reconciles to nothing rather than throwing', () => {
    expect(reconcileToCategoryTotal([], 100)).toEqual([]);
  });
});

// ============================================ accuracy telemetry

describe('WAPE and MAPE are both reported, and they differ deliberately (OUTPUTS)', () => {
  it('WAPE weights by volume, MAPE averages per-item percentages', () => {
    // one high-volume SKU forecast well, one tiny SKU forecast badly
    const pairs = [
      { actual: 1000, predicted: 1050 },   //  5% error on 1000 units
      { actual: 2, predicted: 6 },         // 200% error on 2 units
    ];
    const wape = wapePercent(pairs)!;
    const mape = mapePercent(pairs)!;
    // MAPE says the model is terrible; WAPE says it is fine about the units that mattered
    expect(wape).toBeLessThan(20);
    expect(mape).toBeGreaterThan(100);
    expect(wape).toBeLessThan(mape);
  });

  it('WAPE is null when there is no actual volume at all', () => {
    expect(wapePercent([])).toBeNull();
    expect(wapePercent([{ actual: 0, predicted: 5 }])).toBeNull();
  });

  it('segment accuracy is ordered by volume, so the biggest segment leads', () => {
    const segments = segmentAccuracy({
      'CAT-SAREES': [{ actual: 1000, predicted: 900 }],
      'CAT-SHOES': [{ actual: 50, predicted: 45 }],
    });
    expect(segments.map((s) => s.segment)).toEqual(['CAT-SAREES', 'CAT-SHOES']);
    expect(segments[0].volumeUnits).toBe(1000);
    expect(segments[0].wapePercent).toBe(10);
  });

  it('a segment with no volume is omitted rather than reported as perfect', () => {
    const segments = segmentAccuracy({ 'CAT-EMPTY': [{ actual: 0, predicted: 5 }] });
    expect(segments).toEqual([]);
  });
});

// ============================================ the publish gate

describe('the backtest gate is a PRECONDITION of publishing (VALIDATION / ACCEPTANCE)', () => {
  const segs = (values: Record<string, number>): SegmentAccuracy[] =>
    Object.entries(values).map(([segment, wapePercent]) => ({
      segment, wapePercent, mapePercent: null, volumeUnits: 1000,
    }));

  it('publishes a challenger that beats the champion overall with no segment regression', () => {
    const d = publishDecision(22.0, 18.5,
      segs({ 'CAT-SAREES': 20, 'CAT-SHOES': 24 }),
      segs({ 'CAT-SAREES': 17, 'CAT-SHOES': 20 }));
    expect(d.publish).toBe(true);
    if (d.publish) expect(d.overallImprovementPts).toBe(3.5);
  });

  it('REFUSES a challenger that loses on holdout WAPE', () => {
    const d = publishDecision(18.0, 21.0, segs({ 'CAT-SAREES': 18 }), segs({ 'CAT-SAREES': 21 }));
    expect(d.publish).toBe(false);
    if (!d.publish) {
      expect(d.reason).toBe('CHALLENGER_LOST_ON_HOLDOUT_WAPE');
      if (d.reason === 'CHALLENGER_LOST_ON_HOLDOUT_WAPE') {
        expect(d.championWapePercent).toBe(18);
        expect(d.challengerWapePercent).toBe(21);
      }
    }
  });

  it('refuses a challenger that merely ties, since a tie is not an improvement', () => {
    const d = publishDecision(18.0, 18.0, segs({ 'A': 18 }), segs({ 'A': 18 }));
    expect(d.publish).toBe(false);
  });

  it('BLOCKS PENDING REVIEW when a segment regresses more than 5 pts, despite an overall WIN', () => {
    // overall improves 22.0 -> 15.0, but sarees goes 12 -> 19
    const d = publishDecision(22.0, 15.0,
      segs({ 'CAT-SAREES': 12, 'CAT-SHOES': 30 }),
      segs({ 'CAT-SAREES': 19, 'CAT-SHOES': 12 }));
    expect(d.publish).toBe(false);
    if (!d.publish && d.reason === 'SEGMENT_REGRESSION_REQUIRES_REVIEW') {
      expect(d.regressions).toHaveLength(1);
      expect(d.regressions[0].segment).toBe('CAT-SAREES');
      expect(d.regressions[0].regressionPts).toBe(7);
      // this is the case an aggregate-only gate would wave through, and the vendors in that
      // segment are the ones who would discover it
    } else {
      throw new Error('expected a segment-regression block');
    }
  });

  it('permits a regression at exactly the 5-point limit', () => {
    const d = publishDecision(22.0, 15.0,
      segs({ 'CAT-SAREES': 12 }), segs({ 'CAT-SAREES': 17 }));
    expect(d.publish).toBe(true);
    expect(SEGMENT_REGRESSION_LIMIT_PTS).toBe(5);
  });

  it('reports EVERY regressing segment, not just the first', () => {
    const d = publishDecision(30.0, 20.0,
      segs({ 'A': 10, 'B': 10, 'C': 60 }),
      segs({ 'A': 20, 'B': 18, 'C': 12 }));
    if (!d.publish && d.reason === 'SEGMENT_REGRESSION_REQUIRES_REVIEW') {
      expect(d.regressions.map((r) => r.segment).sort()).toEqual(['A', 'B']);
    } else {
      throw new Error('expected a segment-regression block');
    }
  });

  it('ignores a segment the champion never covered, since there is nothing to regress from', () => {
    const d = publishDecision(20.0, 15.0, segs({ 'A': 20 }), segs({ 'A': 15, 'B-NEW': 90 }));
    expect(d.publish).toBe(true);
  });

  it('refuses to publish with no holdout result at all', () => {
    expect(publishDecision(null, 15.0, [], []).publish).toBe(false);
    expect(publishDecision(20.0, null, [], []).publish).toBe(false);
    const d = publishDecision(null, null, [], []);
    if (!d.publish) expect(d.reason).toBe('NO_HOLDOUT_RESULT');
  });
});

// ============================================ regime change

describe('regime-change exception flags (OUTPUTS)', () => {
  it('flags a sharp upward level shift', () => {
    const shifted: WeeklyHistory[] = [
      ...history(8, 20).map((w, i) => ({ ...w, weekStartMs: NOW - (12 - i) * WEEK_MS })),
      ...history(4, 90).map((w, i) => ({ ...w, weekStartMs: NOW - (4 - i) * WEEK_MS })),
    ];
    const flag = detectRegimeChange(series({ history: shifted }));
    expect(flag).not.toBeNull();
    expect(flag!.reason).toBe('RECENT_LEVEL_SHIFT_UP');
    expect(flag!.ratio).toBeGreaterThan(2);
  });

  it('flags a sharp downward shift', () => {
    const collapsed: WeeklyHistory[] = [
      ...history(8, 100).map((w, i) => ({ ...w, weekStartMs: NOW - (12 - i) * WEEK_MS })),
      ...history(4, 10).map((w, i) => ({ ...w, weekStartMs: NOW - (4 - i) * WEEK_MS })),
    ];
    const flag = detectRegimeChange(series({ history: collapsed }));
    expect(flag!.reason).toBe('RECENT_LEVEL_SHIFT_DOWN');
  });

  it('does not flag a stable series', () => {
    expect(detectRegimeChange(series())).toBeNull();
  });

  it('needs enough history to judge, rather than flagging on noise', () => {
    expect(detectRegimeChange(series({ history: history(5) }))).toBeNull();
  });
});

// ============================================ vendor scoping

describe('vendor outputs are scoped and cross-vendor data is never exposed (SECURITY)', () => {
  it('filters foreign cells out even when passed in', () => {
    const mine = ok(forecastSeries(series({ vendorId: 'V1' }), NOW, opts()));
    const theirs = ok(forecastSeries(series({ sku: 'SKU-9', vendorId: 'V2' }), NOW, opts()));
    const scoped = scopeToVendor([...mine, ...theirs], 'V1');
    expect(scoped).toHaveLength(mine.length);
    expect(scoped.every((c) => c.vendorId === 'V1')).toBe(true);
    expect(JSON.stringify(scoped)).not.toContain('SKU-9');
  });

  it('a vendor category total is their OWN contribution, not the market', () => {
    const mineA = ok(forecastSeries(series({ sku: 'SKU-A', vendorId: 'V1', history: history(12, 70) }), NOW, opts()));
    const mineB = ok(forecastSeries(series({ sku: 'SKU-B', vendorId: 'V1', history: history(12, 30) }), NOW, opts()));
    const theirs = ok(forecastSeries(series({ sku: 'SKU-Z', vendorId: 'V2', history: history(12, 5000) }), NOW, opts()));

    const total = vendorCategoryTotal([...mineA, ...mineB, ...theirs], 'V1', 'CAT-SAREES', NOW);
    // publishing the true category total to one vendor would tell them what competitors sold
    expect(total).toBe(100);
    expect(total).toBeLessThan(5000);
  });

  it('a vendor with nothing in the category gets zero rather than someone else total', () => {
    const theirs = ok(forecastSeries(series({ vendorId: 'V2' }), NOW, opts()));
    expect(vendorCategoryTotal(theirs, 'V1', 'CAT-SAREES', NOW)).toBe(0);
  });
});

// ============================================ metadata

describe('forecast cells carry their model metadata (OUTPUTS)', () => {
  it('records the model version, generation time and full key', () => {
    const cells = ok(forecastSeries(series(), NOW, opts({ modelVersion: 'fc-2026.09.2' })));
    expect(cells[0].modelVersion).toBe('fc-2026.09.2');
    expect(cells[0].generatedAtMs).toBe(NOW);
    expect(cells[0].sku).toBe('SKU-1');
    expect(cells[0].locationId).toBe('LOC-CBE');
    expect(cells[0].weekStartMs).toBe(NOW);
    expect(cells[3].weekStartMs).toBe(NOW + 3 * WEEK_MS);
  });

  it('refuses a run with no model version or a non-positive horizon', () => {
    expect(forecastSeries(series(), NOW, opts({ modelVersion: '' })).ok).toBe(false);
    expect(forecastSeries(series(), NOW, opts({ horizonWeeks: 0 })).ok).toBe(false);
  });
});
