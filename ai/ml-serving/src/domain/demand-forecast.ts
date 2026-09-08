/**
 * AI demand forecasting (vendor) — FR-VEN-012.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "provide per-SKU demand forecasts (4-week horizon, weekly buckets) with
 *                confidence bands, reorder-point suggestions and event-aware adjustments
 *                (platform campaigns, seasonality), presented as advisory with accuracy history."
 *   INPUTS:     "Sales history (system-held), vendor lead-time input, opt-in to campaign signals."
 *   OUTPUTS:    "Forecast charts + table, suggested reorder qty & date, MAPE badge per SKU (last
 *                8 weeks), CSV export."
 *   VALIDATION: "SKUs need ≥ 6 weeks history for model forecast; else category-analogue baseline
 *                labelled as such."
 *   RULES:      "Advisory-only v1 (no auto-PO); campaign uplift factors disclosed; forecasts
 *                refresh weekly + on major campaign publish."
 *   ERRORS:     "Model job miss → last forecast shown with staleness banner; anomalous history
 *                (stockout-censored) flagged, censored-demand correction applied."
 *   SECURITY:   "Vendor sees own SKUs only; aggregate signals anonymised."
 *
 * This closes a dangling reference: the FR-AI-007 inventory optimiser has accepted a
 * `DemandForecast` as a given since Slice 42, but nothing produced one. The type is IMPORTED from
 * that module rather than redeclared here, so what this produces is literally what that consumes —
 * a parallel type would let the two drift while both looked correct.
 *
 * THE CENSORED-DEMAND CORRECTION IS THE MOST CONSEQUENTIAL PIECE HERE, and it is easy to omit
 * without noticing. If a SKU was out of stock for three days of a week, the units it sold
 * UNDERSTATE what customers wanted. Forecasting from that raw figure under-forecasts, which
 * under-orders, which causes the next stockout — a feedback loop that quietly caps a vendor's
 * growth at whatever their first bad week happened to be. So observed sales in a stockout week are
 * scaled by the fraction of the week the SKU was actually available, and the correction is
 * disclosed rather than applied silently.
 */
import type { DemandForecast } from './inventory-optimisation.js';

/** VALIDATION: weeks of history required before a model forecast is permitted. */
export const MIN_WEEKS_FOR_MODEL = 6;
/** DESC: the forecast horizon, in weekly buckets. */
export const HORIZON_WEEKS = 4;
/** OUTPUTS: the MAPE badge window. */
export const MAPE_WINDOW_WEEKS = 8;
export const WEEK_MS = 7 * 24 * 3_600_000;
/** A week with at least this many stockout days cannot be corrected reliably. */
export const UNUSABLE_STOCKOUT_DAYS = 6;

export interface WeeklyHistory {
  weekStartMs: number;
  unitsSold: number;
  /** Days in the week the SKU was unavailable, 0–7. */
  stockoutDays: number;
}

export type ForecastBasis = 'MODEL' | 'CATEGORY_ANALOGUE';

export interface WeeklyBucket {
  weekStartMs: number;
  expectedUnits: number;
  lowerUnits: number;
  upperUnits: number;
}

/** RULES: a campaign uplift must be disclosed, never folded silently into the number. */
export interface CampaignUplift {
  campaignId: string;
  factor: number;
  disclosed: true;
  note: string;
}

export interface CensoredWeekCorrection {
  weekStartMs: number;
  observedUnits: number;
  correctedUnits: number;
  stockoutDays: number;
}

export interface Forecast {
  sku: string;
  vendorId: string;
  basis: ForecastBasis;
  /** VALIDATION: set when the basis is a category analogue, so the UI can label it. */
  basisLabel: string;
  buckets: WeeklyBucket[];
  confidenceLevel: number;
  /** ERRORS: the weeks whose observed demand was stockout-censored and corrected. */
  censoredCorrections: CensoredWeekCorrection[];
  /** ERRORS: weeks too censored to use at all. */
  excludedWeeks: number[];
  campaignUplift?: CampaignUplift;
  /** OUTPUTS: MAPE over the last 8 weeks, where enough history exists to compute one. */
  mapePercent: number | null;
  generatedAtMs: number;
  /** ERRORS: true when a model job was missed and this is the previous forecast. */
  stale: boolean;
  staleSinceMs?: number;
  /** RULES: advisory-only in v1. */
  advisory: true;
}

export interface Violation {
  code: string;
  detail: string;
}

export type ForecastResult =
  | { ok: true; forecast: Forecast }
  | { ok: false; violations: Violation[] };

// ================================================= censored demand

/**
 * ERRORS: correct a stockout-censored week. Units sold over the days the SKU was AVAILABLE are
 * extrapolated to the full week — the standard treatment for right-censored demand.
 *
 * A week with almost no availability is excluded rather than extrapolated: scaling two days of
 * sales up by 7/1 produces a number with no evidential basis, and one such week can dominate a
 * six-week mean.
 */
export function correctCensoredWeek(week: WeeklyHistory):
  { usable: true; correctedUnits: number; corrected: boolean } | { usable: false; reason: string } {
  if (week.stockoutDays < 0 || week.stockoutDays > 7) {
    return { usable: false, reason: 'STOCKOUT_DAYS_OUT_OF_RANGE' };
  }
  if (week.unitsSold < 0) return { usable: false, reason: 'NEGATIVE_UNITS' };
  if (week.stockoutDays >= UNUSABLE_STOCKOUT_DAYS) {
    return { usable: false, reason: `WEEK_TOO_CENSORED: ${week.stockoutDays} stockout days` };
  }
  if (week.stockoutDays === 0) {
    return { usable: true, correctedUnits: week.unitsSold, corrected: false };
  }
  const availableDays = 7 - week.stockoutDays;
  return {
    usable: true,
    correctedUnits: Math.round((week.unitsSold * 7) / availableDays),
    corrected: true,
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** OUTPUTS: mean absolute percentage error over paired actuals and predictions. */
export function mapePercent(pairs: Array<{ actual: number; predicted: number }>): number | null {
  // a zero actual makes the percentage undefined, so those weeks are excluded rather than
  // silently treated as 100% error
  const usable = pairs.filter((p) => p.actual > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((a, p) => a + Math.abs(p.actual - p.predicted) / p.actual, 0);
  return Math.round((total / usable.length) * 1000) / 10;
}

export interface ForecastOptions {
  /** Weekly seasonality multipliers by bucket index, if the category has them. */
  seasonalityByWeek?: number[];
  /** INPUTS: the vendor opted into campaign signals. */
  campaignSignalsOptedIn: boolean;
  campaign?: { campaignId: string; upliftFactor: number };
  /** For the analogue fallback: the category's mean weekly units per SKU. */
  categoryAnalogueWeeklyUnits?: number;
  confidenceLevel?: number;
  /** Predictions previously made for the last 8 weeks, for the MAPE badge. */
  priorPredictions?: Array<{ weekStartMs: number; predictedUnits: number }>;
}

/**
 * Produce a forecast. VALIDATION: fewer than six usable weeks of history falls back to a category
 * analogue, LABELLED as such — presenting an analogue as a model forecast would invite a vendor to
 * trust a number that is really a category average.
 */
export function forecast(
  sku: string,
  vendorId: string,
  history: WeeklyHistory[],
  nowMs: number,
  opts: ForecastOptions,
): ForecastResult {
  const violations: Violation[] = [];
  if (!sku || sku.trim().length === 0) violations.push({ code: 'SKU_REQUIRED', detail: '' });
  if (!vendorId || vendorId.trim().length === 0) violations.push({ code: 'VENDOR_REQUIRED', detail: '' });
  const confidenceLevel = opts.confidenceLevel ?? 0.80;
  if (confidenceLevel <= 0 || confidenceLevel >= 1) {
    violations.push({ code: 'CONFIDENCE_LEVEL_OUT_OF_RANGE', detail: String(confidenceLevel) });
  }
  if (violations.length > 0) return { ok: false, violations };

  // correct or exclude each week
  const corrections: CensoredWeekCorrection[] = [];
  const excludedWeeks: number[] = [];
  const usableUnits: number[] = [];

  for (const week of [...history].sort((a, b) => a.weekStartMs - b.weekStartMs)) {
    const c = correctCensoredWeek(week);
    if (!c.usable) {
      excludedWeeks.push(week.weekStartMs);
      continue;
    }
    if (c.corrected) {
      corrections.push({
        weekStartMs: week.weekStartMs,
        observedUnits: week.unitsSold,
        correctedUnits: c.correctedUnits,
        stockoutDays: week.stockoutDays,
      });
    }
    usableUnits.push(c.correctedUnits);
  }

  const hasModelHistory = usableUnits.length >= MIN_WEEKS_FOR_MODEL;

  let baseWeekly: number;
  let weeklyStdDev: number;
  let basis: ForecastBasis;
  let basisLabel: string;

  if (hasModelHistory) {
    basis = 'MODEL';
    basisLabel = `Model forecast from ${usableUnits.length} weeks of history`;
    baseWeekly = mean(usableUnits);
    weeklyStdDev = stdDev(usableUnits);
  } else {
    if (opts.categoryAnalogueWeeklyUnits === undefined) {
      return {
        ok: false,
        violations: [{
          code: 'INSUFFICIENT_HISTORY_AND_NO_CATEGORY_ANALOGUE',
          detail: `${usableUnits.length} usable weeks, need ${MIN_WEEKS_FOR_MODEL}`,
        }],
      };
    }
    basis = 'CATEGORY_ANALOGUE';
    basisLabel = `Category-analogue baseline: only ${usableUnits.length} of `
      + `${MIN_WEEKS_FOR_MODEL} weeks of history available`;
    baseWeekly = opts.categoryAnalogueWeeklyUnits;
    // an analogue carries wider uncertainty than a model, and saying so is the point
    weeklyStdDev = baseWeekly * 0.5;
  }

  // RULES: a campaign uplift is applied only if the vendor opted into campaign signals, and it is
  // always disclosed.
  let campaignUplift: CampaignUplift | undefined;
  let upliftFactor = 1;
  if (opts.campaign && opts.campaignSignalsOptedIn) {
    upliftFactor = opts.campaign.upliftFactor;
    campaignUplift = {
      campaignId: opts.campaign.campaignId,
      factor: upliftFactor,
      disclosed: true,
      note: `Includes a ${Math.round((upliftFactor - 1) * 100)}% uplift for campaign `
        + `${opts.campaign.campaignId}`,
    };
  }

  // z for the requested band, from the same table the optimiser uses conceptually
  const z = confidenceLevel >= 0.95 ? 1.6449 : confidenceLevel >= 0.90 ? 1.2816 : 1.2816 * 0.65;

  const buckets: WeeklyBucket[] = [];
  for (let i = 0; i < HORIZON_WEEKS; i++) {
    const seasonal = opts.seasonalityByWeek?.[i] ?? 1;
    const expected = baseWeekly * seasonal * upliftFactor;
    // uncertainty widens with horizon: week four is a longer bet than week one
    const spread = z * weeklyStdDev * Math.sqrt(i + 1);
    buckets.push({
      weekStartMs: nowMs + i * WEEK_MS,
      expectedUnits: Math.round(expected),
      lowerUnits: Math.max(0, Math.round(expected - spread)),
      upperUnits: Math.round(expected + spread),
    });
  }

  // OUTPUTS: the MAPE badge, computed against corrected actuals rather than censored ones
  let mape: number | null = null;
  if (opts.priorPredictions && opts.priorPredictions.length > 0) {
    const correctedByWeek = new Map<number, number>();
    for (const week of history) {
      const c = correctCensoredWeek(week);
      if (c.usable) correctedByWeek.set(week.weekStartMs, c.correctedUnits);
    }
    const window = nowMs - MAPE_WINDOW_WEEKS * WEEK_MS;
    const pairs = opts.priorPredictions
      .filter((p) => p.weekStartMs >= window && correctedByWeek.has(p.weekStartMs))
      .map((p) => ({ actual: correctedByWeek.get(p.weekStartMs)!, predicted: p.predictedUnits }));
    mape = mapePercent(pairs);
  }

  return {
    ok: true,
    forecast: {
      sku,
      vendorId,
      basis,
      basisLabel,
      buckets,
      confidenceLevel,
      censoredCorrections: corrections,
      excludedWeeks,
      campaignUplift,
      mapePercent: mape,
      generatedAtMs: nowMs,
      stale: false,
      advisory: true,
    },
  };
}

/** ERRORS: a missed model job shows the last forecast with a staleness banner. */
export function markStale(previous: Forecast, nowMs: number): Forecast {
  return { ...previous, stale: true, staleSinceMs: nowMs };
}

export function stalenessBanner(f: Forecast, nowMs: number): string {
  if (!f.stale) return '';
  const days = Math.floor((nowMs - (f.staleSinceMs ?? nowMs)) / (24 * 3_600_000));
  return `This forecast was generated ${new Date(f.generatedAtMs).toISOString().slice(0, 10)} `
    + `and has not refreshed for ${days} day(s). Treat it as indicative.`;
}

/**
 * THE BRIDGE TO FR-AI-007: convert a weekly forecast into the daily DemandForecast the inventory
 * optimiser consumes. The type is imported from that module, so this is the same contract rather
 * than a lookalike.
 */
export function toDemandForecast(f: Forecast): DemandForecast {
  const weekly = f.buckets.map((b) => b.expectedUnits);
  const meanWeekly = mean(weekly);
  // the band already encodes the uncertainty, so derive the daily sigma from it rather than from
  // the point forecasts, which are smooth by construction and would understate it
  const halfWidths = f.buckets.map((b) => (b.upperUnits - b.lowerUnits) / 2);
  const z = f.confidenceLevel >= 0.95 ? 1.6449 : 1.2816;
  const weeklySigma = mean(halfWidths) / z;

  return {
    meanDailyUnits: Math.round((meanWeekly / 7) * 100) / 100,
    // weekly variance divided across 7 independent days
    stdDevDailyUnits: Math.round((weeklySigma / Math.sqrt(7)) * 100) / 100,
  };
}

// ================================================= vendor scoping & export

/** SECURITY: a vendor sees only their own SKUs. Filtered here, not in a UI. */
export function forVendor(forecasts: Forecast[], vendorId: string): Forecast[] {
  return forecasts.filter((f) => f.vendorId === vendorId);
}

/** OUTPUTS: the CSV export. Discloses the basis and any campaign uplift on every row. */
export function toCsv(forecasts: Forecast[], vendorId: string): string {
  const header = 'sku,week_start,expected_units,lower_units,upper_units,basis,campaign_uplift,mape_percent';
  const rows: string[] = [header];
  for (const f of forVendor(forecasts, vendorId)) {
    for (const b of f.buckets) {
      rows.push([
        f.sku,
        new Date(b.weekStartMs).toISOString().slice(0, 10),
        String(b.expectedUnits),
        String(b.lowerUnits),
        String(b.upperUnits),
        f.basis,
        f.campaignUplift ? String(f.campaignUplift.factor) : '1',
        f.mapePercent === null ? '' : String(f.mapePercent),
      ].join(','));
    }
  }
  return rows.join('\n');
}
