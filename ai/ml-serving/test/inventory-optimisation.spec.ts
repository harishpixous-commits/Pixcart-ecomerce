/**
 * FR-AI-007 inventory optimisation. The documented acceptance case — target service level 95%
 * with a lead time of 7±2 days — is worked through arithmetically rather than asserted loosely,
 * because a reorder point feeds real purchase orders and an off-by-a-rounding figure is a
 * stockout or a write-off.
 */
import { describe, expect, it } from 'vitest';
import * as InventoryOptimisation from '../src/domain/inventory-optimisation.js';
import {
  adviceQuality,
  assortmentGaps,
  classifyStock,
  DEAD_STOCK_DAYS,
  economicOrderQuantity,
  markdownSuggestion,
  MISSING_LEAD_TIME_BAND_MULTIPLIER,
  reorderProposal,
  resolveLeadTime,
  safetyStockUnits,
  stdDevOverLeadTime,
  SUPPORTED_SERVICE_LEVELS,
  Z_BY_SERVICE_LEVEL,
  type DemandForecast,
  type HoldingCostParams,
  type LeadTime,
  type StockPosition,
} from '../src/domain/inventory-optimisation.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

/** Daily demand of 10 units with a standard deviation of 3. */
const forecast: DemandForecast = { meanDailyUnits: 10, stdDevDailyUnits: 3 };
/** The acceptance case's lead time: 7 days, ±2. */
const leadTime7pm2: LeadTime = { meanDays: 7, stdDevDays: 2, source: 'VENDOR_INPUT' };
const costs: HoldingCostParams = { orderCostPaise: 500_00, annualHoldingCostPerUnitPaise: 120_00 };

const ok = (r: ReturnType<typeof reorderProposal>) => {
  if (!r.ok) throw new Error('expected a proposal: ' + r.violations.join(', '));
  return r.proposal;
};

// ================================================= the acceptance criterion

describe('the documented acceptance case: 95% service level, lead time 7±2 days', () => {
  it('the combined standard deviation accounts for BOTH demand and lead-time variance', () => {
    // sigma_LT = sqrt(LT_mean * sigma_d^2 + d_mean^2 * sigma_LT^2)
    //          = sqrt(7*9 + 100*4) = sqrt(463) = 21.5174...
    const sigma = stdDevOverLeadTime(forecast, leadTime7pm2);
    expect(sigma).toBeCloseTo(Math.sqrt(463), 6);
    expect(sigma).toBeCloseTo(21.5174, 3);

    // using demand variance alone would understate the risk badly
    const demandOnly = Math.sqrt(7 * 9);
    expect(demandOnly).toBeCloseTo(7.937, 3);
    expect(sigma).toBeGreaterThan(demandOnly * 2);
  });

  it('safety stock is z(95%) x sigma, rounded UP', () => {
    expect(Z_BY_SERVICE_LEVEL[0.95]).toBe(1.6449);
    // 1.6449 * 21.5174 = 35.394... -> 36
    const raw = 1.6449 * Math.sqrt(463);
    expect(raw).toBeCloseTo(35.394, 2);
    expect(safetyStockUnits(forecast, leadTime7pm2, 0.95)).toBe(36);
  });

  it('the reorder point is demand-over-lead-time plus safety stock', () => {
    const p = ok(reorderProposal('SKU-1', forecast, 0.95, costs, leadTime7pm2));
    expect(p.demandOverLeadTimeUnits).toBe(70);          // 10/day x 7 days
    expect(p.safetyStockUnits).toBe(36);
    expect(p.reorderPointUnits).toBe(106);               // 70 + 36
    expect(p.stdDevOverLeadTimeUnits).toBeCloseTo(21.5174, 3);
  });

  it('VALIDATION: the assumptions travel with the suggestion, inline', () => {
    const p = ok(reorderProposal('SKU-1', forecast, 0.95, costs, leadTime7pm2));
    expect(p.assumptions.targetServiceLevel).toBe(0.95);
    expect(p.assumptions.zValue).toBe(1.6449);
    expect(p.assumptions.leadTimeMeanDays).toBe(7);
    expect(p.assumptions.leadTimeStdDevDays).toBe(2);
    expect(p.assumptions.leadTimeSource).toBe('VENDOR_INPUT');
    expect(p.assumptions.meanDailyUnits).toBe(10);
    expect(p.assumptions.demandStdDevDailyUnits).toBe(3);
    expect(p.assumptions.wideBandFallback).toBe(false);
  });
});

describe('safety stock rises monotonically with the service level', () => {
  it('a higher target never yields a smaller buffer', () => {
    const buffers = SUPPORTED_SERVICE_LEVELS
      .slice()
      .sort((a, b) => a - b)
      .map((sl) => safetyStockUnits(forecast, leadTime7pm2, sl));
    for (let i = 1; i < buffers.length; i++) {
      expect(buffers[i]).toBeGreaterThanOrEqual(buffers[i - 1]);
    }
    // 99% demands materially more cover than 80%
    expect(safetyStockUnits(forecast, leadTime7pm2, 0.99))
      .toBeGreaterThan(safetyStockUnits(forecast, leadTime7pm2, 0.80));
  });

  it('a deterministic lead time and demand needs no safety stock', () => {
    const certain: DemandForecast = { meanDailyUnits: 10, stdDevDailyUnits: 0 };
    const fixed: LeadTime = { meanDays: 7, stdDevDays: 0, source: 'VENDOR_INPUT' };
    expect(stdDevOverLeadTime(certain, fixed)).toBe(0);
    expect(safetyStockUnits(certain, fixed, 0.95)).toBe(0);
    const p = ok(reorderProposal('SKU-1', certain, 0.95, costs, fixed));
    expect(p.reorderPointUnits).toBe(70);
  });
});

// ================================================= validation guards

describe('input validation', () => {
  it('an unsupported service level is refused rather than approximated', () => {
    const r = reorderProposal('SKU-1', forecast, 0.93, costs, leadTime7pm2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.startsWith('UNSUPPORTED_SERVICE_LEVEL'))).toBe(true);
  });

  it('negative forecasts and costs are refused', () => {
    const bad = reorderProposal('SKU-1', { meanDailyUnits: -1, stdDevDailyUnits: 3 },
      0.95, { orderCostPaise: -1, annualHoldingCostPerUnitPaise: 100 }, leadTime7pm2);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.violations).toContain('NEGATIVE_FORECAST');
      expect(bad.violations).toContain('NEGATIVE_ORDER_COST');
    }
  });

  it('a negative lead time is refused', () => {
    const r = reorderProposal('SKU-1', forecast, 0.95, costs,
      { meanDays: -1, stdDevDays: 2, source: 'VENDOR_INPUT' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('NEGATIVE_LEAD_TIME');
  });
});

// ================================================= missing lead time (ERRORS)

describe('a missing lead time falls back to the observed median with wide bands (ERRORS)', () => {
  it('widens the observed band and flags that the vendor should be prompted', () => {
    const resolved = resolveLeadTime(undefined, 6, 1.5);
    expect('error' in resolved).toBe(false);
    if ('error' in resolved) return;
    expect(resolved.leadTime.meanDays).toBe(6);
    expect(resolved.leadTime.stdDevDays).toBe(1.5 * MISSING_LEAD_TIME_BAND_MULTIPLIER);
    expect(resolved.leadTime.source).toBe('OBSERVED_MEDIAN');
    expect(resolved.wideBandFallback).toBe(true);
    expect(resolved.promptVendor).toBe(true);
  });

  it('the wider band produces a LARGER safety buffer, so the weaker footing costs cover', () => {
    const withVendor = ok(reorderProposal('SKU-1', forecast, 0.95, costs,
      { meanDays: 7, stdDevDays: 1.5, source: 'VENDOR_INPUT' }));
    const fallback = ok(reorderProposal('SKU-1', forecast, 0.95, costs, undefined, 7, 1.5));
    expect(fallback.safetyStockUnits).toBeGreaterThan(withVendor.safetyStockUnits);
    expect(fallback.assumptions.wideBandFallback).toBe(true);
    expect(fallback.assumptions.promptVendorForLeadTime).toBe(true);
    expect(fallback.assumptions.leadTimeSource).toBe('OBSERVED_MEDIAN');
  });

  it('with neither vendor input nor observations, guidance is refused rather than invented', () => {
    const resolved = resolveLeadTime(undefined, undefined, undefined);
    expect('error' in resolved).toBe(true);
    const r = reorderProposal('SKU-1', forecast, 0.95, costs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('NO_LEAD_TIME_AND_NO_OBSERVATIONS_PROMPT_VENDOR');
  });
});

// ================================================= EOQ

describe('economic order quantity', () => {
  it('follows the EOQ formula and rounds up to a whole unit', () => {
    // sqrt(2 * 3650 * 50000 / 12000) = sqrt(30416.66) = 174.4 -> 175
    const q = economicOrderQuantity(forecast, costs);
    expect(q).toBe(Math.ceil(Math.sqrt((2 * 3650 * 500_00) / 120_00)));
    expect(q).toBe(175);
  });

  it('falls back to a month of demand when holding cost is unknown', () => {
    const q = economicOrderQuantity(forecast, { orderCostPaise: 500_00, annualHoldingCostPerUnitPaise: 0 });
    expect(q).toBe(Math.ceil(3650 / 12));
  });

  it('a higher order cost justifies a larger batch', () => {
    const cheap = economicOrderQuantity(forecast, { orderCostPaise: 100_00, annualHoldingCostPerUnitPaise: 120_00 });
    const dear = economicOrderQuantity(forecast, { orderCostPaise: 900_00, annualHoldingCostPerUnitPaise: 120_00 });
    expect(dear).toBeGreaterThan(cheap);
  });
});

// ================================================= ageing classification

describe('overstock and dead-stock detection', () => {
  const pos = (over: Partial<StockPosition> = {}): StockPosition => ({
    sku: 'SKU-1', onHandUnits: 100, daysSinceLastSale: 5, coverDays: 30, ...over,
  });

  it('classifies by cover days and days since last sale', () => {
    expect(classifyStock(pos())).toBe('HEALTHY');
    expect(classifyStock(pos({ coverDays: 120 }))).toBe('SLOW_MOVING');
    expect(classifyStock(pos({ daysSinceLastSale: 45 }))).toBe('SLOW_MOVING');
    expect(classifyStock(pos({ coverDays: 200 }))).toBe('OVERSTOCK');
    expect(classifyStock(pos({ daysSinceLastSale: DEAD_STOCK_DAYS }))).toBe('DEAD_STOCK');
  });

  it('dead stock takes precedence over overstock', () => {
    expect(classifyStock(pos({ daysSinceLastSale: 120, coverDays: 400 }))).toBe('DEAD_STOCK');
  });

  it('the boundaries are exact', () => {
    expect(classifyStock(pos({ coverDays: 90 }))).toBe('HEALTHY');
    expect(classifyStock(pos({ coverDays: 91 }))).toBe('SLOW_MOVING');
    expect(classifyStock(pos({ coverDays: 180 }))).toBe('SLOW_MOVING');
    expect(classifyStock(pos({ coverDays: 181 }))).toBe('OVERSTOCK');
    expect(classifyStock(pos({ daysSinceLastSale: DEAD_STOCK_DAYS - 1, coverDays: 30 }))).toBe('SLOW_MOVING');
  });
});

// ================================================= markdown bounded by BRU-10

describe('markdown suggestions are bounded by BRU-10 (OUTPUTS)', () => {
  const bounds = { floorPaise: 900_00, ceilingPaise: 1_400_00 };

  it('healthy stock gets no markdown suggestion at all', () => {
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 3, coverDays: 20 },
      1_000_00, 1_500_00, bounds, NOW);
    expect(s).toBeNull();
  });

  it('a dead-stock markdown is clamped up to the vendor floor, never below it', () => {
    // 40% off Rs 1,000 would be Rs 600, but the vendor floor is Rs 900
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 120, coverDays: 400 },
      1_000_00, 1_500_00, bounds, NOW)!;
    expect(s.classification).toBe('DEAD_STOCK');
    expect(s.fromPaise).toBe(900_00);
    expect(s.fromPaise).toBeGreaterThanOrEqual(bounds.floorPaise);
    expect(s.guardrailsApplied).toContain('VENDOR_FLOOR');
    expect(s.advisory).toBe(true);
  });

  it('a markdown within the bounds is passed through unclamped', () => {
    const wide = { floorPaise: 100_00, ceilingPaise: 1_400_00 };
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 120, coverDays: 400 },
      1_000_00, 1_500_00, wide, NOW)!;
    expect(s.fromPaise).toBe(600_00);         // 40% off
    expect(s.toPaise).toBe(800_00);           // 20% off
    expect(s.guardrailsApplied).toEqual([]);
  });

  it('a deeper classification suggests a deeper discount', () => {
    const wide = { floorPaise: 1_00, ceilingPaise: 1_400_00 };
    const slow = markdownSuggestion(
      { sku: 'S', onHandUnits: 10, daysSinceLastSale: 50, coverDays: 100 }, 1_000_00, 1_500_00, wide, NOW)!;
    const dead = markdownSuggestion(
      { sku: 'S', onHandUnits: 10, daysSinceLastSale: 120, coverDays: 100 }, 1_000_00, 1_500_00, wide, NOW)!;
    expect(dead.fromPaise).toBeLessThan(slow.fromPaise);
  });

  it('the suggestion carries its assumptions as a note', () => {
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 120, coverDays: 400 },
      1_000_00, 1_500_00, bounds, NOW)!;
    expect(s.assumptionsNote).toContain('classification=DEAD_STOCK');
    expect(s.assumptionsNote).toContain('coverDays=400');
    expect(s.assumptionsNote).toContain('daysSinceLastSale=120');
    expect(s.assumptionsNote).toContain('suggestedDepth=40%');
  });

  it('a markdown can never exceed MRP even if the current price already does', () => {
    // a mispriced listing above its MRP must not have that carried forward
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 120, coverDays: 400 },
      2_000_00, 900_00, { floorPaise: 100_00, ceilingPaise: 3_000_00 }, NOW)!;
    expect(s.fromPaise).toBeLessThanOrEqual(900_00);
    expect(s.toPaise).toBeLessThanOrEqual(900_00);
  });
});

// ================================================= advisory-only (RULES)

describe('no auto-execution in v1 (RULES)', () => {
  it('the module exposes no execute, apply or commit surface', () => {
    const suspicious = Object.keys(InventoryOptimisation).filter((name) => {
      const n = name.toLowerCase();
      return n.startsWith('execute') || n.startsWith('apply') || n.startsWith('commit')
        || n.startsWith('placeorder') || n.startsWith('raisepo');
    });
    expect(suspicious).toEqual([]);
  });

  it('every proposal and markdown is marked advisory', () => {
    const p = ok(reorderProposal('SKU-1', forecast, 0.95, costs, leadTime7pm2));
    expect(p.advisory).toBe(true);
    const s = markdownSuggestion(
      { sku: 'SKU-1', onHandUnits: 50, daysSinceLastSale: 120, coverDays: 400 },
      1_000_00, 1_500_00, { floorPaise: 100_00, ceilingPaise: 1_400_00 }, NOW)!;
    expect(s.advisory).toBe(true);
  });
});

// ================================================= assortment gaps

describe('assortment gap insights (OUTPUTS)', () => {
  it('surfaces high-demand attribute values with few live listings, strongest first', () => {
    const demand = new Map([['kanjivaram', 950], ['tussar', 400], ['banarasi', 120], ['chiffon', 50]]);
    const listings = new Map([['kanjivaram', 1], ['tussar', 0], ['banarasi', 30], ['chiffon', 0]]);
    const gaps = assortmentGaps('CAT-SAREES', demand, listings, 'fabric');

    expect(gaps.map((g) => g.missingValue)).toEqual(['kanjivaram', 'tussar']);
    expect(gaps[0].demandSignalStrength).toBe(950);
    expect(gaps[0].liveListingCount).toBe(1);
    expect(gaps[0].attribute).toBe('fabric');
    expect(gaps[0].categoryId).toBe('CAT-SAREES');
    // banarasi has demand but plenty of listings; chiffon has no listings but too little demand
    expect(gaps.map((g) => g.missingValue)).not.toContain('banarasi');
    expect(gaps.map((g) => g.missingValue)).not.toContain('chiffon');
  });

  it('thresholds are configurable and an empty demand map yields no gaps', () => {
    const demand = new Map([['linen', 60]]);
    const listings = new Map([['linen', 0]]);
    expect(assortmentGaps('C', demand, listings, 'fabric')).toHaveLength(0);
    expect(assortmentGaps('C', demand, listings, 'fabric', 50)).toHaveLength(1);
    expect(assortmentGaps('C', new Map(), new Map(), 'fabric')).toEqual([]);
  });
});

// ================================================= advice quality

describe('advice quality tracking (RULES)', () => {
  it('reports acceptance rate and the stockout delta for accepted advice only', () => {
    const q = adviceQuality([
      { sku: 'A', accepted: true, stockoutDaysBefore: 6, stockoutDaysAfter: 1 },
      { sku: 'B', accepted: true, stockoutDaysBefore: 4, stockoutDaysAfter: 2 },
      { sku: 'C', accepted: false, stockoutDaysBefore: 5, stockoutDaysAfter: 9 },
      { sku: 'D', accepted: false, stockoutDaysBefore: 3, stockoutDaysAfter: 3 },
    ]);
    expect(q.acceptedCount).toBe(2);
    expect(q.acceptanceRate).toBe(0.5);
    // accepted: (1-6) and (2-4) -> mean of -5 and -2 = -3.5 (fewer stockout days)
    expect(q.meanStockoutDeltaForAccepted).toBeCloseTo(-3.5, 2);
  });

  it('reports null rather than zero when nothing was accepted', () => {
    const q = adviceQuality([{ sku: 'A', accepted: false, stockoutDaysBefore: 1, stockoutDaysAfter: 1 }]);
    expect(q.acceptedCount).toBe(0);
    expect(q.acceptanceRate).toBe(0);
    expect(q.meanStockoutDeltaForAccepted).toBeNull();
  });

  it('handles an empty outcome set without dividing by zero', () => {
    expect(adviceQuality([])).toEqual({
      acceptedCount: 0, acceptanceRate: 0, meanStockoutDeltaForAccepted: null,
    });
  });
});
