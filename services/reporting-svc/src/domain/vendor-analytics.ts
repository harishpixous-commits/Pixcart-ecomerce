/**
 * Vendor analytics — FR-VEN-009.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "provide vendor analytics: sales & traffic funnels (views→ATC→orders), search
 *                terms leading to their listings, return-reason breakdowns,
 *                buy-box/competitiveness hints and exportable reports."
 *   INPUTS:     "Date ranges, listing filters, export requests (CSV/XLSX)."
 *   OUTPUTS:    "Dashboards (D-1 freshness for aggregates, near-real-time for orders), export
 *                files ≤ 100k rows, insight cards (e.g., 'images below category benchmark')."
 *   VALIDATION: "Range ≤ 12 months per query; exports rate-limited 5/day."
 *   RULES:      "Cross-vendor data only as anonymised benchmarks (category percentiles); PII never
 *                in exports."
 *   ERRORS:     "Pipeline lag > SLA → freshness banner; export fail → retry link + notification
 *                when ready."
 *   SECURITY:   "Row-level security by vendor id enforced in the semantic layer, not the [UI]."
 *
 * The security requirement is unusually specific about WHERE the check lives, and it is right to
 * be. Enforcing row-level security in a UI or a query template means every new report is a fresh
 * opportunity to forget it. Here every query takes the caller's vendor id and filters inside this
 * module, so a report cannot be written that skips the filter — and the tests feed each query a
 * dataset containing a competitor's rows and assert none of them come back.
 *
 * Cross-vendor comparison is available only as anonymised category percentiles, and only where the
 * cohort is large enough that a percentile is not simply a competitor's figure wearing a
 * statistic's clothing. In a category with three sellers, "the 50th percentile conversion rate" is
 * a named rival's conversion rate.
 */

/** VALIDATION: the maximum query range. */
export const MAX_RANGE_DAYS = 366;
/** VALIDATION: exports per vendor per day. */
export const EXPORTS_PER_DAY = 5;
/** OUTPUTS: the export row ceiling. */
export const MAX_EXPORT_ROWS = 100_000;
/**
 * RULES: the minimum number of vendors in a category before a percentile may be published. Below
 * this, a percentile identifies a competitor rather than describing a market.
 */
export const MIN_BENCHMARK_COHORT = 5;

export interface DateRange {
  fromMs: number;
  toMs: number;
}

/** Funnel facts, one row per listing per day, across all vendors as the warehouse holds them. */
export interface FunnelRow {
  vendorId: string;
  listingId: string;
  dateMs: number;
  views: number;
  addToCarts: number;
  orders: number;
}

export interface SearchTermRow {
  vendorId: string;
  term: string;
  dateMs: number;
  impressions: number;
  clicks: number;
  orders: number;
}

export interface ReturnReasonRow {
  vendorId: string;
  reason: string;
  dateMs: number;
  count: number;
}

export interface FunnelSummary {
  vendorId: string;
  views: number;
  addToCarts: number;
  orders: number;
  /** views → ATC */
  atcRate: number;
  /** ATC → orders */
  conversionRate: number;
  /** views → orders */
  overallRate: number;
}

export interface Violation {
  code: string;
  detail: string;
}

export type QueryResult<T> =
  | { ok: true; data: T }
  | { ok: false; violations: Violation[] };

/** VALIDATION: the range guard, applied to every query. */
export function validateRange(range: DateRange, nowMs: number): Violation[] {
  const v: Violation[] = [];
  if (range.toMs <= range.fromMs) v.push({ code: 'RANGE_INVERTED', detail: '' });
  const days = (range.toMs - range.fromMs) / (24 * 3600 * 1000);
  if (days > MAX_RANGE_DAYS) {
    v.push({ code: `RANGE_EXCEEDS_${MAX_RANGE_DAYS}_DAYS`, detail: `${Math.round(days)} days` });
  }
  if (range.toMs > nowMs) v.push({ code: 'RANGE_END_IN_FUTURE', detail: '' });
  return v;
}

function inRange(dateMs: number, range: DateRange): boolean {
  return dateMs >= range.fromMs && dateMs <= range.toMs;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

// ================================================= the semantic layer

/**
 * The semantic layer. Every method takes the caller's vendor id as its first argument and applies
 * the row-level filter itself, so no report can be written that forgets it.
 */
export class VendorAnalytics {
  /**
   * SECURITY: funnel for ONE vendor. Rows belonging to other vendors are filtered here, in the
   * semantic layer, whatever the caller passed in.
   */
  funnel(vendorId: string, rows: FunnelRow[], range: DateRange, nowMs: number): QueryResult<FunnelSummary> {
    const violations = validateRange(range, nowMs);
    if (violations.length > 0) return { ok: false, violations };

    const mine = rows.filter((r) => r.vendorId === vendorId && inRange(r.dateMs, range));
    const views = mine.reduce((a, r) => a + r.views, 0);
    const addToCarts = mine.reduce((a, r) => a + r.addToCarts, 0);
    const orders = mine.reduce((a, r) => a + r.orders, 0);

    return {
      ok: true,
      data: {
        vendorId,
        views,
        addToCarts,
        orders,
        atcRate: rate(addToCarts, views),
        conversionRate: rate(orders, addToCarts),
        overallRate: rate(orders, views),
      },
    };
  }

  /** Per-listing funnel breakdown, still vendor-scoped. */
  funnelByListing(vendorId: string, rows: FunnelRow[], range: DateRange, nowMs: number):
    QueryResult<Array<{ listingId: string; views: number; addToCarts: number; orders: number }>> {
    const violations = validateRange(range, nowMs);
    if (violations.length > 0) return { ok: false, violations };

    const byListing = new Map<string, { views: number; addToCarts: number; orders: number }>();
    for (const r of rows) {
      if (r.vendorId !== vendorId || !inRange(r.dateMs, range)) continue;
      const b = byListing.get(r.listingId) ?? { views: 0, addToCarts: 0, orders: 0 };
      b.views += r.views;
      b.addToCarts += r.addToCarts;
      b.orders += r.orders;
      byListing.set(r.listingId, b);
    }
    return {
      ok: true,
      data: [...byListing.entries()]
        .map(([listingId, b]) => ({ listingId, ...b }))
        .sort((a, b) => b.views - a.views || a.listingId.localeCompare(b.listingId)),
    };
  }

  /** SECURITY: search terms leading to THIS vendor's listings only. */
  searchTerms(vendorId: string, rows: SearchTermRow[], range: DateRange, nowMs: number, limit = 50):
    QueryResult<Array<{ term: string; impressions: number; clicks: number; orders: number; ctr: number }>> {
    const violations = validateRange(range, nowMs);
    if (violations.length > 0) return { ok: false, violations };

    const byTerm = new Map<string, { impressions: number; clicks: number; orders: number }>();
    for (const r of rows) {
      if (r.vendorId !== vendorId || !inRange(r.dateMs, range)) continue;
      const b = byTerm.get(r.term) ?? { impressions: 0, clicks: 0, orders: 0 };
      b.impressions += r.impressions;
      b.clicks += r.clicks;
      b.orders += r.orders;
      byTerm.set(r.term, b);
    }
    return {
      ok: true,
      data: [...byTerm.entries()]
        .map(([term, b]) => ({ term, ...b, ctr: rate(b.clicks, b.impressions) }))
        .sort((a, b) => b.impressions - a.impressions || a.term.localeCompare(b.term))
        .slice(0, limit),
    };
  }

  /** SECURITY: return reasons for THIS vendor only. */
  returnReasons(vendorId: string, rows: ReturnReasonRow[], range: DateRange, nowMs: number):
    QueryResult<Array<{ reason: string; count: number; share: number }>> {
    const violations = validateRange(range, nowMs);
    if (violations.length > 0) return { ok: false, violations };

    const byReason = new Map<string, number>();
    for (const r of rows) {
      if (r.vendorId !== vendorId || !inRange(r.dateMs, range)) continue;
      byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + r.count);
    }
    const total = [...byReason.values()].reduce((a, b) => a + b, 0);
    return {
      ok: true,
      data: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count, share: rate(count, total) }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
  }
}

// ================================================= benchmarks

export interface BenchmarkResult {
  categoryId: string;
  metric: string;
  cohortSize: number;
  p25: number;
  p50: number;
  p75: number;
  /** Where this vendor sits, as a percentile — never another vendor's raw figure. */
  yourValue: number;
  yourPercentile: number;
}

export type BenchmarkOutcome =
  | { ok: true; benchmark: BenchmarkResult }
  | { ok: false; reason: string; cohortSize: number };

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const value = lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  return Math.round(value * 10_000) / 10_000;
}

/**
 * RULES: cross-vendor data only as anonymised category percentiles, and only above the cohort
 * floor. Below it a percentile is a named competitor's number, so the benchmark is refused rather
 * than published with a caveat nobody reads.
 */
export function categoryBenchmark(
  categoryId: string,
  metric: string,
  vendorValues: Array<{ vendorId: string; value: number }>,
  forVendorId: string,
): BenchmarkOutcome {
  const cohortSize = vendorValues.length;
  if (cohortSize < MIN_BENCHMARK_COHORT) {
    return {
      ok: false,
      reason: `BENCHMARK_COHORT_TOO_SMALL: ${cohortSize} < ${MIN_BENCHMARK_COHORT}`,
      cohortSize,
    };
  }
  const mine = vendorValues.find((v) => v.vendorId === forVendorId);
  if (!mine) return { ok: false, reason: 'VENDOR_NOT_IN_COHORT', cohortSize };

  const sorted = vendorValues.map((v) => v.value).sort((a, b) => a - b);
  const below = sorted.filter((v) => v < mine.value).length;

  return {
    ok: true,
    benchmark: {
      categoryId,
      metric,
      cohortSize,
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.50),
      p75: percentile(sorted, 0.75),
      yourValue: mine.value,
      yourPercentile: Math.round((below / cohortSize) * 100),
    },
  };
}

// ================================================= insight cards

export interface InsightCard {
  code: string;
  message: string;
  severity: 'INFO' | 'ACTION';
}

/**
 * OUTPUTS: insight cards. Each is phrased against an anonymised benchmark rather than a named
 * competitor, and only produced where the benchmark itself was publishable.
 */
export function insightCards(funnel: FunnelSummary, benchmark: BenchmarkOutcome | null,
                             imageCountVsBenchmark: number | null): InsightCard[] {
  const cards: InsightCard[] = [];

  if (benchmark && benchmark.ok) {
    const b = benchmark.benchmark;
    if (b.yourValue < b.p25) {
      cards.push({
        code: 'BELOW_CATEGORY_P25',
        message: `Your ${b.metric} is in the bottom quarter for this category`,
        severity: 'ACTION',
      });
    } else if (b.yourValue > b.p75) {
      cards.push({
        code: 'ABOVE_CATEGORY_P75',
        message: `Your ${b.metric} is in the top quarter for this category`,
        severity: 'INFO',
      });
    }
  }

  if (imageCountVsBenchmark !== null && imageCountVsBenchmark < 0) {
    cards.push({
      code: 'IMAGES_BELOW_CATEGORY_BENCHMARK',
      message: 'Your listings carry fewer images than the category norm',
      severity: 'ACTION',
    });
  }

  if (funnel.views > 500 && funnel.atcRate > 0 && funnel.conversionRate < 0.02) {
    cards.push({
      code: 'HIGH_ATC_LOW_CONVERSION',
      message: 'Shoppers add to cart but rarely complete — check price, delivery promise and stock',
      severity: 'ACTION',
    });
  }
  return cards;
}

// ================================================= exports

/** Columns that must never appear in a vendor export. */
const FORBIDDEN_EXPORT_COLUMNS: ReadonlySet<string> = new Set([
  'customer_id', 'customer_name', 'customer_email', 'email', 'mobile', 'phone',
  'address_line1', 'address_line2', 'pincode', 'aadhaar', 'pan', 'card_last4',
]);

export interface ExportRequest {
  vendorId: string;
  kind: 'FUNNEL' | 'SEARCH_TERMS' | 'RETURN_REASONS';
  columns: string[];
  range: DateRange;
  rowCount: number;
  format: 'CSV' | 'XLSX';
}

export type ExportOutcome =
  | { ok: true; fileRef: string; rowCount: number }
  | { ok: false; violations: Violation[] }
  /** ERRORS: a failed export offers a retry link and a notification when ready. */
  | { ok: false; failed: true; retryToken: string; notifyWhenReady: true };

/**
 * VALIDATION: exports are rate-limited, row-capped and PII-free. The PII check is on the requested
 * COLUMNS rather than on the data, so a request for a forbidden column is refused before any rows
 * are read — the cheapest place to stop it, and the only place where refusing is guaranteed.
 */
export function requestExport(req: ExportRequest, exportsUsedToday: number, nowMs: number): ExportOutcome {
  const violations = validateRange(req.range, nowMs);

  if (exportsUsedToday >= EXPORTS_PER_DAY) {
    violations.push({ code: `EXPORT_RATE_LIMIT_${EXPORTS_PER_DAY}_PER_DAY`, detail: String(exportsUsedToday) });
  }
  if (req.rowCount > MAX_EXPORT_ROWS) {
    violations.push({ code: `EXPORT_EXCEEDS_${MAX_EXPORT_ROWS}_ROWS`, detail: String(req.rowCount) });
  }
  if (req.columns.length === 0) {
    violations.push({ code: 'AT_LEAST_ONE_COLUMN_REQUIRED', detail: '' });
  }
  for (const c of req.columns) {
    if (FORBIDDEN_EXPORT_COLUMNS.has(c.toLowerCase())) {
      violations.push({ code: 'PII_COLUMN_NOT_PERMITTED_IN_VENDOR_EXPORT', detail: c });
    }
  }
  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    fileRef: `exports/${req.vendorId}/${req.kind.toLowerCase()}-${nowMs}.${req.format.toLowerCase()}`,
    rowCount: req.rowCount,
  };
}

/** ERRORS: a failed export produces a retry token rather than a dead end. */
export function exportFailure(req: ExportRequest, nowMs: number): ExportOutcome {
  return {
    ok: false,
    failed: true,
    retryToken: `retry-${req.vendorId}-${req.kind}-${nowMs}`,
    notifyWhenReady: true,
  };
}

// ================================================= freshness

export type Freshness = 'NEAR_REAL_TIME' | 'D_MINUS_1';

export interface FreshnessBanner {
  show: boolean;
  message: string;
  lagMs: number;
  slaMs: number;
}

/**
 * ERRORS: pipeline lag beyond SLA shows a freshness banner. The dashboard still renders — a vendor
 * with slightly stale numbers is better served than one staring at an empty page — but it says so.
 */
export function freshnessBanner(freshness: Freshness, lagMs: number, slaMs: number): FreshnessBanner {
  const show = lagMs > slaMs;
  const label = freshness === 'NEAR_REAL_TIME' ? 'Order figures' : 'Aggregate figures';
  return {
    show,
    message: show
      ? `${label} are delayed by about ${Math.round(lagMs / 60_000)} minutes and may be incomplete`
      : '',
    lagMs,
    slaMs,
  };
}
