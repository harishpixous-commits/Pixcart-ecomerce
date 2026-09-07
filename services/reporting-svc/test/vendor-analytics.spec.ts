/**
 * FR-VEN-009 vendor analytics. Every query test feeds a dataset that CONTAINS a competitor's rows
 * and asserts none come back — that is the only way to test row-level security meaningfully, since
 * a filter that is never exercised against foreign data proves nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  categoryBenchmark,
  EXPORTS_PER_DAY,
  exportFailure,
  freshnessBanner,
  insightCards,
  MAX_EXPORT_ROWS,
  MAX_RANGE_DAYS,
  MIN_BENCHMARK_COHORT,
  requestExport,
  validateRange,
  VendorAnalytics,
  type DateRange,
  type ExportRequest,
  type FunnelRow,
  type FunnelSummary,
  type ReturnReasonRow,
  type SearchTermRow,
} from '../src/domain/vendor-analytics.js';

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);
const range: DateRange = { fromMs: NOW - 30 * DAY, toMs: NOW - 1 };

const analytics = new VendorAnalytics();

/** A dataset deliberately containing BOTH vendors' rows. */
const funnelRows = (): FunnelRow[] => [
  { vendorId: 'V1', listingId: 'L1', dateMs: NOW - 5 * DAY, views: 1000, addToCarts: 100, orders: 10 },
  { vendorId: 'V1', listingId: 'L2', dateMs: NOW - 4 * DAY, views: 500, addToCarts: 20, orders: 4 },
  { vendorId: 'V2', listingId: 'L9', dateMs: NOW - 5 * DAY, views: 9999, addToCarts: 9999, orders: 9999 },
];

const searchRows = (): SearchTermRow[] => [
  { vendorId: 'V1', term: 'kanchipuram saree', dateMs: NOW - 3 * DAY, impressions: 800, clicks: 80, orders: 8 },
  { vendorId: 'V1', term: 'silk saree', dateMs: NOW - 3 * DAY, impressions: 400, clicks: 20, orders: 1 },
  { vendorId: 'V2', term: 'competitor secret term', dateMs: NOW - 3 * DAY, impressions: 5000, clicks: 500, orders: 50 },
];

const returnRows = (): ReturnReasonRow[] => [
  { vendorId: 'V1', reason: 'SIZE_ISSUE', dateMs: NOW - 2 * DAY, count: 6 },
  { vendorId: 'V1', reason: 'COLOUR_MISMATCH', dateMs: NOW - 2 * DAY, count: 2 },
  { vendorId: 'V2', reason: 'DAMAGED', dateMs: NOW - 2 * DAY, count: 999 },
];

// ============================================ row-level security

describe('row-level security is enforced in the semantic layer (SECURITY)', () => {
  it('a funnel query returns only the calling vendor rows, even with a competitor in the data', () => {
    const r = analytics.funnel('V1', funnelRows(), range, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // V1: 1500 views, 120 ATC, 14 orders. V2's 9999s must not appear anywhere.
    expect(r.data.views).toBe(1500);
    expect(r.data.addToCarts).toBe(120);
    expect(r.data.orders).toBe(14);
    expect(r.data.vendorId).toBe('V1');
  });

  it('the competitor sees only their own figures from the identical dataset', () => {
    const r = analytics.funnel('V2', funnelRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.views).toBe(9999);
    expect(r.data.orders).toBe(9999);
  });

  it('a per-listing breakdown never leaks a competitor listing id', () => {
    const r = analytics.funnelByListing('V1', funnelRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.map((x) => x.listingId).sort()).toEqual(['L1', 'L2']);
    expect(r.data.some((x) => x.listingId === 'L9')).toBe(false);
  });

  it('search terms never leak a competitor term', () => {
    const r = analytics.searchTerms('V1', searchRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.map((x) => x.term)).toEqual(['kanchipuram saree', 'silk saree']);
    expect(JSON.stringify(r.data)).not.toContain('competitor secret term');
  });

  it('return reasons never leak a competitor reason breakdown', () => {
    const r = analytics.returnReasons('V1', returnRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.map((x) => x.reason)).toEqual(['SIZE_ISSUE', 'COLOUR_MISMATCH']);
    expect(r.data.some((x) => x.reason === 'DAMAGED')).toBe(false);
  });

  it('a vendor with no rows gets honest zeroes rather than another vendor total', () => {
    const r = analytics.funnel('V-NEW', funnelRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.views).toBe(0);
    expect(r.data.orders).toBe(0);
    expect(r.data.atcRate).toBe(0);
    expect(r.data.conversionRate).toBe(0);
  });
});

// ============================================ funnel maths

describe('funnel rates', () => {
  it('computes the three documented rates', () => {
    const r = analytics.funnel('V1', funnelRows(), range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.atcRate).toBeCloseTo(120 / 1500, 4);
    expect(r.data.conversionRate).toBeCloseTo(14 / 120, 4);
    expect(r.data.overallRate).toBeCloseTo(14 / 1500, 4);
  });

  it('never divides by zero', () => {
    const r = analytics.funnel('V1',
      [{ vendorId: 'V1', listingId: 'L1', dateMs: NOW - DAY, views: 0, addToCarts: 0, orders: 0 }],
      range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.atcRate).toBe(0);
    expect(r.data.conversionRate).toBe(0);
  });

  it('excludes rows outside the range', () => {
    const rows: FunnelRow[] = [
      { vendorId: 'V1', listingId: 'L1', dateMs: NOW - 5 * DAY, views: 100, addToCarts: 10, orders: 1 },
      { vendorId: 'V1', listingId: 'L1', dateMs: NOW - 400 * DAY, views: 9999, addToCarts: 0, orders: 0 },
    ];
    const r = analytics.funnel('V1', rows, range, NOW);
    if (!r.ok) throw new Error('expected ok');
    expect(r.data.views).toBe(100);
  });

  it('orders listings by volume, and terms by impressions', () => {
    const l = analytics.funnelByListing('V1', funnelRows(), range, NOW);
    if (l.ok) expect(l.data[0].listingId).toBe('L1');
    const t = analytics.searchTerms('V1', searchRows(), range, NOW);
    if (t.ok) expect(t.data[0].term).toBe('kanchipuram saree');
  });

  it('search term CTR is computed and return-reason shares sum to 1', () => {
    const t = analytics.searchTerms('V1', searchRows(), range, NOW);
    if (t.ok) expect(t.data[0].ctr).toBeCloseTo(0.1, 4);
    const rr = analytics.returnReasons('V1', returnRows(), range, NOW);
    if (rr.ok) {
      expect(rr.data.reduce((a, x) => a + x.share, 0)).toBeCloseTo(1, 3);
      expect(rr.data[0].share).toBeCloseTo(0.75, 3);
    }
  });
});

// ============================================ range validation

describe('the 12-month range cap (VALIDATION)', () => {
  it('refuses a range beyond 366 days', () => {
    const wide = { fromMs: NOW - 400 * DAY, toMs: NOW - 1 };
    const r = analytics.funnel('V1', funnelRows(), wide, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code.startsWith('RANGE_EXCEEDS'))).toBe(true);
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it('accepts a range at exactly the cap', () => {
    expect(analytics.funnel('V1', funnelRows(), { fromMs: NOW - 366 * DAY, toMs: NOW - 1 }, NOW).ok).toBe(true);
  });

  it('refuses an inverted range and one ending in the future', () => {
    expect(validateRange({ fromMs: NOW, toMs: NOW - DAY }, NOW).some((v) => v.code === 'RANGE_INVERTED')).toBe(true);
    expect(validateRange({ fromMs: NOW - DAY, toMs: NOW + DAY }, NOW)
      .some((v) => v.code === 'RANGE_END_IN_FUTURE')).toBe(true);
  });

  it('the range guard applies to every query, not just the funnel', () => {
    const wide = { fromMs: NOW - 400 * DAY, toMs: NOW - 1 };
    expect(analytics.searchTerms('V1', searchRows(), wide, NOW).ok).toBe(false);
    expect(analytics.returnReasons('V1', returnRows(), wide, NOW).ok).toBe(false);
    expect(analytics.funnelByListing('V1', funnelRows(), wide, NOW).ok).toBe(false);
  });
});

// ============================================ anonymised benchmarks

describe('cross-vendor data is available only as anonymised percentiles (RULES)', () => {
  const cohort = (n: number) => Array.from({ length: n }, (_, i) =>
    ({ vendorId: i === 0 ? 'V1' : `V${i + 1}`, value: (i + 1) / 100 }));

  it('refuses a benchmark when the cohort is too small to anonymise', () => {
    for (let n = 1; n < MIN_BENCHMARK_COHORT; n++) {
      const r = categoryBenchmark('CAT-SAREES', 'conversion', cohort(n), 'V1');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('BENCHMARK_COHORT_TOO_SMALL');
        expect(r.cohortSize).toBe(n);
      }
    }
    // in a three-seller category, "the median" IS a named rival's number
    expect(MIN_BENCHMARK_COHORT).toBe(5);
  });

  it('publishes percentiles once the cohort is large enough', () => {
    const r = categoryBenchmark('CAT-SAREES', 'conversion', cohort(10), 'V1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.benchmark.cohortSize).toBe(10);
    expect(r.benchmark.p25).toBeLessThanOrEqual(r.benchmark.p50);
    expect(r.benchmark.p50).toBeLessThanOrEqual(r.benchmark.p75);
    expect(r.benchmark.yourValue).toBeCloseTo(0.01, 4);
    expect(r.benchmark.yourPercentile).toBe(0);
  });

  it('exposes no other vendor identity or raw value', () => {
    const r = categoryBenchmark('CAT-SAREES', 'conversion', cohort(10), 'V1');
    if (!r.ok) throw new Error('expected ok');
    const serialised = JSON.stringify(r.benchmark);
    for (let i = 2; i <= 10; i++) {
      expect(serialised).not.toContain(`V${i}`);
    }
    expect(Object.keys(r.benchmark).sort()).toEqual([
      'categoryId', 'cohortSize', 'metric', 'p25', 'p50', 'p75', 'yourPercentile', 'yourValue',
    ]);
  });

  it('places the vendor correctly at the top of the cohort', () => {
    const r = categoryBenchmark('CAT', 'conversion',
      [...cohort(9).slice(1), { vendorId: 'V1', value: 1.0 }], 'V1');
    if (!r.ok) throw new Error('expected ok');
    expect(r.benchmark.yourPercentile).toBeGreaterThanOrEqual(88);
  });

  it('refuses when the requesting vendor is not in the cohort', () => {
    const r = categoryBenchmark('CAT', 'conversion', cohort(10), 'V-OUTSIDER');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VENDOR_NOT_IN_COHORT');
  });
});

// ============================================ insight cards

describe('insight cards are phrased against benchmarks, never competitors (OUTPUTS)', () => {
  const funnel = (over: Partial<FunnelSummary> = {}): FunnelSummary => ({
    vendorId: 'V1', views: 1000, addToCarts: 100, orders: 10,
    atcRate: 0.1, conversionRate: 0.1, overallRate: 0.01, ...over,
  });

  it('flags a bottom-quartile metric as an action', () => {
    const b = categoryBenchmark('CAT', 'conversion',
      [{ vendorId: 'V1', value: 0.001 }, ...Array.from({ length: 9 }, (_, i) =>
        ({ vendorId: `V${i + 2}`, value: 0.05 + i / 100 }))], 'V1');
    const cards = insightCards(funnel(), b, null);
    const card = cards.find((c) => c.code === 'BELOW_CATEGORY_P25');
    expect(card).toBeDefined();
    expect(card!.severity).toBe('ACTION');
    // the message must not name anyone
    expect(card!.message).not.toMatch(/V\d/);
  });

  it('congratulates a top-quartile metric as info only', () => {
    const b = categoryBenchmark('CAT', 'conversion',
      [{ vendorId: 'V1', value: 0.9 }, ...Array.from({ length: 9 }, (_, i) =>
        ({ vendorId: `V${i + 2}`, value: 0.01 + i / 1000 }))], 'V1');
    const card = insightCards(funnel(), b, null).find((c) => c.code === 'ABOVE_CATEGORY_P75');
    expect(card).toBeDefined();
    expect(card!.severity).toBe('INFO');
  });

  it('produces no benchmark card when the benchmark was refused', () => {
    const refused = categoryBenchmark('CAT', 'conversion',
      [{ vendorId: 'V1', value: 0.5 }, { vendorId: 'V2', value: 0.1 }], 'V1');
    const cards = insightCards(funnel(), refused, null);
    expect(cards.some((c) => c.code.includes('CATEGORY_P'))).toBe(false);
  });

  it('flags the documented images-below-benchmark card', () => {
    const cards = insightCards(funnel(), null, -2);
    expect(cards.some((c) => c.code === 'IMAGES_BELOW_CATEGORY_BENCHMARK')).toBe(true);
    expect(insightCards(funnel(), null, 1).some((c) => c.code === 'IMAGES_BELOW_CATEGORY_BENCHMARK'))
      .toBe(false);
  });

  it('flags high add-to-cart with low conversion, which points at price or delivery', () => {
    const cards = insightCards(funnel({ views: 1000, atcRate: 0.2, conversionRate: 0.01 }), null, null);
    const card = cards.find((c) => c.code === 'HIGH_ATC_LOW_CONVERSION');
    expect(card).toBeDefined();
    expect(card!.message).toContain('delivery promise');
  });

  it('a healthy vendor with no benchmark gets no cards at all', () => {
    expect(insightCards(funnel({ views: 100 }), null, null)).toEqual([]);
  });
});

// ============================================ exports

describe('exports are PII-free, rate-limited and row-capped (VALIDATION / RULES)', () => {
  const req = (over: Partial<ExportRequest> = {}): ExportRequest => ({
    vendorId: 'V1',
    kind: 'FUNNEL',
    columns: ['listing_id', 'views', 'add_to_carts', 'orders'],
    range,
    rowCount: 5_000,
    format: 'CSV',
    ...over,
  });

  it('accepts a clean request and names the file', () => {
    const r = requestExport(req(), 0, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fileRef).toContain('exports/V1/funnel');
      expect(r.fileRef.endsWith('.csv')).toBe(true);
      expect(r.rowCount).toBe(5_000);
    }
  });

  it('refuses a PII column BEFORE any rows are read', () => {
    for (const col of ['customer_email', 'mobile', 'address_line1', 'pincode', 'card_last4']) {
      const r = requestExport(req({ columns: ['views', col] }), 0, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok && 'violations' in r) {
        expect(r.violations.some((v) => v.code === 'PII_COLUMN_NOT_PERMITTED_IN_VENDOR_EXPORT')).toBe(true);
      }
    }
  });

  it('the PII check is case-insensitive', () => {
    const r = requestExport(req({ columns: ['Customer_Email'] }), 0, NOW);
    expect(r.ok).toBe(false);
  });

  it('enforces the five-per-day rate limit', () => {
    expect(requestExport(req(), EXPORTS_PER_DAY - 1, NOW).ok).toBe(true);
    const capped = requestExport(req(), EXPORTS_PER_DAY, NOW);
    expect(capped.ok).toBe(false);
    if (!capped.ok && 'violations' in capped) {
      expect(capped.violations.some((v) => v.code.startsWith('EXPORT_RATE_LIMIT'))).toBe(true);
    }
  });

  it('enforces the 100k row ceiling at the boundary', () => {
    expect(requestExport(req({ rowCount: MAX_EXPORT_ROWS }), 0, NOW).ok).toBe(true);
    const over = requestExport(req({ rowCount: MAX_EXPORT_ROWS + 1 }), 0, NOW);
    expect(over.ok).toBe(false);
  });

  it('refuses an empty column list and an out-of-range request', () => {
    expect(requestExport(req({ columns: [] }), 0, NOW).ok).toBe(false);
    expect(requestExport(req({ range: { fromMs: NOW - 400 * DAY, toMs: NOW - 1 } }), 0, NOW).ok).toBe(false);
  });

  it('reports every violation at once rather than one per attempt', () => {
    const r = requestExport(
      req({ columns: ['mobile'], rowCount: MAX_EXPORT_ROWS + 1 }), EXPORTS_PER_DAY, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok && 'violations' in r) expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('a failed export offers a retry token and a notification rather than a dead end', () => {
    const f = exportFailure(req(), NOW);
    expect(f.ok).toBe(false);
    if (!f.ok && 'failed' in f) {
      expect(f.failed).toBe(true);
      expect(f.retryToken).toContain('retry-V1-FUNNEL');
      expect(f.notifyWhenReady).toBe(true);
    }
  });
});

// ============================================ freshness

describe('pipeline lag beyond SLA shows a freshness banner (ERRORS)', () => {
  it('shows nothing while inside the SLA', () => {
    const b = freshnessBanner('D_MINUS_1', 30 * 60_000, 60 * 60_000);
    expect(b.show).toBe(false);
    expect(b.message).toBe('');
  });

  it('shows a banner naming the delay once beyond the SLA', () => {
    const b = freshnessBanner('D_MINUS_1', 150 * 60_000, 60 * 60_000);
    expect(b.show).toBe(true);
    expect(b.message).toContain('Aggregate figures');
    expect(b.message).toContain('150 minutes');
    expect(b.message).toContain('incomplete');
  });

  it('distinguishes order figures from aggregates', () => {
    const b = freshnessBanner('NEAR_REAL_TIME', 10 * 60_000, 60_000);
    expect(b.message).toContain('Order figures');
  });

  it('the boundary is exact', () => {
    expect(freshnessBanner('D_MINUS_1', 60_000, 60_000).show).toBe(false);
    expect(freshnessBanner('D_MINUS_1', 60_001, 60_000).show).toBe(true);
  });
});
