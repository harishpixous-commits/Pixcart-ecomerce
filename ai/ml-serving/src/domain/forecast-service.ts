/**
 * Demand Forecasting Service (platform) — FR-AI-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "generate probabilistic demand forecasts (P10/P50/P90) per SKU×location×week using
 *                hierarchical time-series models with covariates (price, promo calendar,
 *                seasonality, category trends) and stockout-censoring correction, published to
 *                vendor (FR-VEN-012) and operator planning views."
 *   INPUTS:     "Sales/traffic history, inventory states, promo calendar, holidays, price history."
 *   OUTPUTS:    "Forecast tables with model metadata, accuracy telemetry (MAPE/WAPE by segment),
 *                exception flags (regime change)."
 *   VALIDATION: "Backtest gate: new model version must beat champion WAPE on holdout before
 *                publish."
 *   RULES:      "Weekly full run + event-triggered partials; sparse SKUs use pooled category
 *                models labelled as such."
 *   ERRORS:     "Job failure → last forecast retained with staleness flag (FR-VEN-012); covariate
 *                feed gap → model runs reduced-feature with note."
 *   SECURITY:   "Vendor-visible outputs scoped; raw cross-vendor data never exposed."
 *   ACCEPTANCE: "Given the weekly run, When published, Then segment-level WAPE dashboards update
 *                and any segment regressing > 5 pts vs prior version triggers review before
 *                vendor-facing publish."
 *
 * This is the platform ENGINE that FR-VEN-012 (Slice 57) presents to vendors, and that FR-AI-007
 * declares a dependency on. The two are distinct: this produces probabilistic quantiles per
 * SKU×location×week across a hierarchy; that renders a vendor's own SKUs with a MAPE badge.
 *
 * The stockout-censoring correction is IMPORTED from the Slice-57 module rather than rewritten.
 * The correction is subtle enough that having two implementations would eventually mean having two
 * behaviours, and the one place it lives is already tested against the feedback loop it prevents.
 *
 * TWO PROPERTIES CARRY THE WEIGHT HERE:
 *
 *  1. THE BACKTEST GATE IS A PRECONDITION OF PUBLISHING, not a report published alongside. A
 *     challenger that loses to the champion on holdout WAPE cannot be published at all — and, per
 *     the acceptance criterion, even a challenger that wins overall is BLOCKED PENDING REVIEW if
 *     any segment regresses by more than five points. An aggregate improvement can conceal a
 *     segment getting materially worse, and the vendors in that segment are the ones who would
 *     discover it.
 *
 *  2. HIERARCHICAL FORECASTS ARE COHERENT. SKU-level forecasts sum EXACTLY to their category
 *     total, using the same cumulative-delta reconciliation the credit-note and statutory engines
 *     use. Incoherent forecasts hand a planner two contradictory numbers for the same question and
 *     no way to tell which to trust.
 */
import { correctCensoredWeek, WEEK_MS, type WeeklyHistory } from './demand-forecast.js';

/** RULES: below this many usable observations a SKU is sparse and uses a pooled category model. */
export const SPARSE_MIN_OBSERVATIONS = 8;
/** ACCEPTANCE: a segment regressing by more than this many WAPE points blocks vendor publish. */
export const SEGMENT_REGRESSION_LIMIT_PTS = 5;

/** z-scores for the published quantiles. */
const Z_P10 = -1.2816;
const Z_P90 = 1.2816;

export type ForecastBasis = 'HIERARCHICAL' | 'POOLED_CATEGORY';

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}

/** The covariates the model uses. A missing feed degrades the run rather than failing it. */
export interface Covariates {
  priceIndex?: number;
  promoActive?: boolean;
  seasonalityFactor?: number;
  categoryTrendFactor?: number;
}

export interface SeriesInput {
  sku: string;
  locationId: string;
  categoryId: string;
  vendorId: string;
  history: WeeklyHistory[];
}

export interface ForecastCell {
  sku: string;
  locationId: string;
  categoryId: string;
  vendorId: string;
  weekStartMs: number;
  quantiles: Quantiles;
  basis: ForecastBasis;
  /** RULES: a pooled model is labelled as such wherever it is shown. */
  basisLabel: string;
  /** ERRORS: true when a covariate feed was missing and the run used fewer features. */
  reducedFeature: boolean;
  featureGaps: string[];
  modelVersion: string;
  generatedAtMs: number;
}

/**
 * P10/P50/P90 from a mean and sigma, with monotonicity ENFORCED rather than assumed. A quantile
 * set where p10 exceeds p50 is not a wide forecast, it is a broken one, and clamping here means no
 * consumer has to defend against it.
 */
export function quantilesFrom(meanUnits: number, sigmaUnits: number): Quantiles {
  const sigma = Math.max(0, sigmaUnits);
  const p50 = Math.max(0, Math.round(meanUnits));
  const p10 = Math.max(0, Math.round(meanUnits + Z_P10 * sigma));
  const p90 = Math.max(0, Math.round(meanUnits + Z_P90 * sigma));
  // clamp into order: demand cannot be negative, so a wide band near zero would otherwise invert
  return {
    p10: Math.min(p10, p50),
    p50,
    p90: Math.max(p90, p50),
  };
}

export function isMonotone(q: Quantiles): boolean {
  return q.p10 <= q.p50 && q.p50 <= q.p90;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** Apply the covariates, noting any whose feed was missing (ERRORS). */
export function applyCovariates(baseUnits: number, cov: Covariates):
  { adjustedUnits: number; reducedFeature: boolean; featureGaps: string[] } {
  const gaps: string[] = [];
  let factor = 1;

  if (cov.seasonalityFactor === undefined) gaps.push('seasonality');
  else factor *= cov.seasonalityFactor;

  if (cov.categoryTrendFactor === undefined) gaps.push('category_trend');
  else factor *= cov.categoryTrendFactor;

  if (cov.priceIndex === undefined) gaps.push('price_history');
  else factor *= 1 / Math.max(0.2, cov.priceIndex);   // higher relative price, lower demand

  if (cov.promoActive === undefined) gaps.push('promo_calendar');
  else if (cov.promoActive) factor *= 1.35;

  return {
    adjustedUnits: baseUnits * factor,
    reducedFeature: gaps.length > 0,
    featureGaps: gaps,
  };
}

export interface RunOptions {
  modelVersion: string;
  horizonWeeks: number;
  covariatesByWeek: Covariates[];
  /** RULES: the pooled category baseline for sparse SKUs, in weekly units. */
  pooledCategoryWeeklyUnits?: Record<string, number>;
}

export interface Violation {
  code: string;
  detail: string;
}

export type RunResult =
  | { ok: true; cells: ForecastCell[] }
  | { ok: false; violations: Violation[] };

/**
 * Run the forecast for one series. Censored weeks are corrected via the Slice-57 primitive, and a
 * SKU with too few usable observations falls back to a pooled category model, LABELLED.
 */
export function forecastSeries(series: SeriesInput, nowMs: number, opts: RunOptions): RunResult {
  const violations: Violation[] = [];
  if (opts.horizonWeeks < 1) violations.push({ code: 'HORIZON_MUST_BE_POSITIVE', detail: '' });
  if (!opts.modelVersion) violations.push({ code: 'MODEL_VERSION_REQUIRED', detail: '' });
  if (violations.length > 0) return { ok: false, violations };

  const usable: number[] = [];
  for (const week of [...series.history].sort((a, b) => a.weekStartMs - b.weekStartMs)) {
    const c = correctCensoredWeek(week);
    if (c.usable) usable.push(c.correctedUnits);
  }

  let baseWeekly: number;
  let sigmaWeekly: number;
  let basis: ForecastBasis;
  let basisLabel: string;

  if (usable.length >= SPARSE_MIN_OBSERVATIONS) {
    basis = 'HIERARCHICAL';
    basisLabel = `Hierarchical model on ${usable.length} usable weeks`;
    baseWeekly = mean(usable);
    sigmaWeekly = stdDev(usable);
  } else {
    const pooled = opts.pooledCategoryWeeklyUnits?.[series.categoryId];
    if (pooled === undefined) {
      return {
        ok: false,
        violations: [{
          code: 'SPARSE_SKU_AND_NO_POOLED_CATEGORY_MODEL',
          detail: `${usable.length} usable weeks, need ${SPARSE_MIN_OBSERVATIONS}`,
        }],
      };
    }
    basis = 'POOLED_CATEGORY';
    basisLabel = `Pooled category model: only ${usable.length} of `
      + `${SPARSE_MIN_OBSERVATIONS} weeks available for this SKU`;
    baseWeekly = pooled;
    // a pooled estimate is less certain about this particular SKU, and the band should say so
    sigmaWeekly = pooled * 0.6;
  }

  const cells: ForecastCell[] = [];
  for (let i = 0; i < opts.horizonWeeks; i++) {
    const cov = opts.covariatesByWeek[i] ?? {};
    const applied = applyCovariates(baseWeekly, cov);
    // uncertainty grows with horizon
    const sigma = sigmaWeekly * Math.sqrt(i + 1);
    cells.push({
      sku: series.sku,
      locationId: series.locationId,
      categoryId: series.categoryId,
      vendorId: series.vendorId,
      weekStartMs: nowMs + i * WEEK_MS,
      quantiles: quantilesFrom(applied.adjustedUnits, sigma),
      basis,
      basisLabel,
      reducedFeature: applied.reducedFeature,
      featureGaps: applied.featureGaps,
      modelVersion: opts.modelVersion,
      generatedAtMs: nowMs,
    });
  }
  return { ok: true, cells };
}

// ================================================= hierarchical reconciliation

/** round-half-up of total × n / denominator in integer arithmetic. */
function proportion(total: number, denominator: number, n: number): number {
  if (denominator <= 0 || n <= 0) return 0;
  if (n >= denominator) return total;
  return Math.floor((total * n * 2 + denominator) / (2 * denominator));
}

/**
 * Reconcile SKU-level P50s so they sum EXACTLY to the category total for that week.
 *
 * The cumulative-delta technique is the same one the credit-note and statutory-deduction engines
 * use, and for the same reason: allocating each child independently leaves a residue, and a
 * hierarchy that does not add up hands a planner two contradictory answers to one question.
 */
export function reconcileToCategoryTotal(cells: ForecastCell[], categoryTotalP50: number): ForecastCell[] {
  if (cells.length === 0) return [];
  const bottomUp = cells.reduce((a, c) => a + c.quantiles.p50, 0);
  if (bottomUp === 0) {
    // nothing to scale by; distribute the parent evenly using the same exact technique
    let allocated = 0;
    return cells.map((c, i) => {
      const cumulative = proportion(categoryTotalP50, cells.length, i + 1);
      const share = cumulative - allocated;
      allocated = cumulative;
      return { ...c, quantiles: scaleQuantiles(c.quantiles, share) };
    });
  }

  let allocated = 0;
  let cumulativeWeight = 0;
  return cells.map((c) => {
    cumulativeWeight += c.quantiles.p50;
    const cumulative = proportion(categoryTotalP50, bottomUp, cumulativeWeight);
    const share = cumulative - allocated;
    allocated = cumulative;
    return { ...c, quantiles: scaleQuantiles(c.quantiles, share) };
  });
}

/** Rescale a quantile set to a new p50, preserving the band's relative width and monotonicity. */
function scaleQuantiles(q: Quantiles, newP50: number): Quantiles {
  if (q.p50 === 0) {
    return { p10: newP50, p50: newP50, p90: newP50 };
  }
  const ratio = newP50 / q.p50;
  return {
    p10: Math.max(0, Math.min(Math.round(q.p10 * ratio), newP50)),
    p50: newP50,
    p90: Math.max(Math.round(q.p90 * ratio), newP50),
  };
}

export function isCoherent(cells: ForecastCell[], categoryTotalP50: number): boolean {
  return cells.reduce((a, c) => a + c.quantiles.p50, 0) === categoryTotalP50;
}

// ================================================= accuracy telemetry

export interface AccuracyPair {
  actual: number;
  predicted: number;
}

/**
 * OUTPUTS: WAPE — weighted absolute percentage error. Distinct from MAPE and reported alongside it
 * deliberately: MAPE averages per-item percentages and so explodes on low-volume SKUs, while WAPE
 * weights by volume and answers "how wrong were we about the units that mattered". Gating on MAPE
 * would let a model win by being right about the tail and wrong about the head.
 */
export function wapePercent(pairs: AccuracyPair[]): number | null {
  const totalActual = pairs.reduce((a, p) => a + p.actual, 0);
  if (totalActual === 0) return null;
  const totalError = pairs.reduce((a, p) => a + Math.abs(p.actual - p.predicted), 0);
  return Math.round((totalError / totalActual) * 1000) / 10;
}

export function mapePercent(pairs: AccuracyPair[]): number | null {
  const usable = pairs.filter((p) => p.actual > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((a, p) => a + Math.abs(p.actual - p.predicted) / p.actual, 0);
  return Math.round((total / usable.length) * 1000) / 10;
}

export interface SegmentAccuracy {
  segment: string;
  wapePercent: number;
  mapePercent: number | null;
  volumeUnits: number;
}

export function segmentAccuracy(bySegment: Record<string, AccuracyPair[]>): SegmentAccuracy[] {
  const out: SegmentAccuracy[] = [];
  for (const [segment, pairs] of Object.entries(bySegment)) {
    const w = wapePercent(pairs);
    if (w === null) continue;
    out.push({
      segment,
      wapePercent: w,
      mapePercent: mapePercent(pairs),
      volumeUnits: pairs.reduce((a, p) => a + p.actual, 0),
    });
  }
  return out.sort((a, b) => b.volumeUnits - a.volumeUnits || a.segment.localeCompare(b.segment));
}

// ================================================= the publish gate

export interface SegmentRegression {
  segment: string;
  championWapePercent: number;
  challengerWapePercent: number;
  regressionPts: number;
}

export type PublishDecision =
  | { publish: true; overallImprovementPts: number }
  /** VALIDATION: a challenger that loses on holdout WAPE cannot publish at all. */
  | { publish: false; reason: 'CHALLENGER_LOST_ON_HOLDOUT_WAPE'; championWapePercent: number; challengerWapePercent: number }
  /** ACCEPTANCE: a segment regression blocks vendor-facing publish pending review. */
  | { publish: false; reason: 'SEGMENT_REGRESSION_REQUIRES_REVIEW'; regressions: SegmentRegression[] }
  | { publish: false; reason: 'NO_HOLDOUT_RESULT' };

/**
 * VALIDATION and ACCEPTANCE together. The gate is a PRECONDITION of publishing rather than a
 * report published alongside, and it has two independent halves:
 *
 *  - the challenger must beat the champion on overall holdout WAPE;
 *  - AND no segment may regress by more than five points, even when the overall figure improves.
 *
 * The second half is the one that earns its keep: an aggregate improvement can conceal a segment
 * getting materially worse, and the vendors in that segment are the ones who would discover it.
 */
export function publishDecision(
  championOverallWape: number | null,
  challengerOverallWape: number | null,
  championBySegment: SegmentAccuracy[],
  challengerBySegment: SegmentAccuracy[],
): PublishDecision {
  if (championOverallWape === null || challengerOverallWape === null) {
    return { publish: false, reason: 'NO_HOLDOUT_RESULT' };
  }
  if (challengerOverallWape >= championOverallWape) {
    return {
      publish: false,
      reason: 'CHALLENGER_LOST_ON_HOLDOUT_WAPE',
      championWapePercent: championOverallWape,
      challengerWapePercent: challengerOverallWape,
    };
  }

  const championBy = new Map(championBySegment.map((s) => [s.segment, s.wapePercent]));
  const regressions: SegmentRegression[] = [];
  for (const seg of challengerBySegment) {
    const champ = championBy.get(seg.segment);
    if (champ === undefined) continue;
    const regressionPts = Math.round((seg.wapePercent - champ) * 10) / 10;
    if (regressionPts > SEGMENT_REGRESSION_LIMIT_PTS) {
      regressions.push({
        segment: seg.segment,
        championWapePercent: champ,
        challengerWapePercent: seg.wapePercent,
        regressionPts,
      });
    }
  }
  if (regressions.length > 0) {
    return { publish: false, reason: 'SEGMENT_REGRESSION_REQUIRES_REVIEW', regressions };
  }
  return {
    publish: true,
    overallImprovementPts: Math.round((championOverallWape - challengerOverallWape) * 10) / 10,
  };
}

// ================================================= exception flags

export interface RegimeChangeFlag {
  sku: string;
  locationId: string;
  reason: string;
  recentMean: number;
  priorMean: number;
  ratio: number;
}

/**
 * OUTPUTS: exception flags for regime change. A series whose recent level departs sharply from its
 * history is flagged rather than quietly forecast from a mean that no longer describes it.
 */
export function detectRegimeChange(series: SeriesInput, recentWeeks = 4, ratioThreshold = 2):
  RegimeChangeFlag | null {
  const usable: number[] = [];
  for (const week of [...series.history].sort((a, b) => a.weekStartMs - b.weekStartMs)) {
    const c = correctCensoredWeek(week);
    if (c.usable) usable.push(c.correctedUnits);
  }
  if (usable.length < recentWeeks * 2) return null;

  const recent = usable.slice(-recentWeeks);
  const prior = usable.slice(0, usable.length - recentWeeks);
  const recentMean = mean(recent);
  const priorMean = mean(prior);
  if (priorMean === 0) return null;

  const ratio = recentMean / priorMean;
  if (ratio >= ratioThreshold || ratio <= 1 / ratioThreshold) {
    return {
      sku: series.sku,
      locationId: series.locationId,
      reason: ratio >= ratioThreshold ? 'RECENT_LEVEL_SHIFT_UP' : 'RECENT_LEVEL_SHIFT_DOWN',
      recentMean: Math.round(recentMean * 10) / 10,
      priorMean: Math.round(priorMean * 10) / 10,
      ratio: Math.round(ratio * 100) / 100,
    };
  }
  return null;
}

// ================================================= vendor scoping

/**
 * SECURITY: vendor-visible outputs are scoped here, and raw cross-vendor data is never exposed.
 * The category total a vendor may see is their OWN contribution, not the market's — publishing the
 * category total to one vendor tells them what every competitor sold.
 */
export function scopeToVendor(cells: ForecastCell[], vendorId: string): ForecastCell[] {
  return cells.filter((c) => c.vendorId === vendorId);
}

export function vendorCategoryTotal(cells: ForecastCell[], vendorId: string, categoryId: string,
                                     weekStartMs: number): number {
  return cells
    .filter((c) => c.vendorId === vendorId && c.categoryId === categoryId && c.weekStartMs === weekStartMs)
    .reduce((a, c) => a + c.quantiles.p50, 0);
}
