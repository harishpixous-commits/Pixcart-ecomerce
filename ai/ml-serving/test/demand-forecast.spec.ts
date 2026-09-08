/**
 * FR-VEN-012 demand forecasting. The censored-demand correction gets the most attention, because
 * omitting it creates a feedback loop that caps a vendor's growth at whatever their first bad week
 * was — and the omission is invisible: every number still looks like a forecast.
 */
import { describe, expect, it } from 'vitest';
import {
  correctCensoredWeek,
  forecast,
  forVendor,
  HORIZON_WEEKS,
  MAPE_WINDOW_WEEKS,
  mapePercent,
  markStale,
  MIN_WEEKS_FOR_MODEL,
  stalenessBanner,
  toCsv,
  toDemandForecast,
  UNUSABLE_STOCKOUT_DAYS,
  WEEK_MS,
  type ForecastOptions,
  type WeeklyHistory,
} from '../src/domain/demand-forecast.js';
import { reorderProposal, safetyStockUnits, type LeadTime } from '../src/domain/inventory-optimisation.js';

const NOW = Date.UTC(2026, 7, 24, 0, 0, 0);   // a Monday

/** Eight clean weeks at a steady 70 units. */
const steadyHistory = (): WeeklyHistory[] =>
  Array.from({ length: 8 }, (_, i) => ({
    weekStartMs: NOW - (8 - i) * WEEK_MS,
    unitsSold: 70,
    stockoutDays: 0,
  }));

const opts = (over: Partial<ForecastOptions> = {}): ForecastOptions => ({
  campaignSignalsOptedIn: false,
  ...over,
});

const ok = (r: ReturnType<typeof forecast>) => {
  if (!r.ok) throw new Error('expected a forecast: ' + JSON.stringify(r.violations));
  return r.forecast;
};

// ============================================ censored demand

describe('censored-demand correction (ERRORS)', () => {
  it('extrapolates sales over the days the SKU was actually available', () => {
    // 40 units over 4 available days is a 70-unit week, not a 40-unit week
    const c = correctCensoredWeek({ weekStartMs: NOW, unitsSold: 40, stockoutDays: 3 });
    expect(c.usable).toBe(true);
    if (!c.usable) return;
    expect(c.correctedUnits).toBe(70);
    expect(c.corrected).toBe(true);
  });

  it('leaves a clean week untouched and marks it uncorrected', () => {
    const c = correctCensoredWeek({ weekStartMs: NOW, unitsSold: 70, stockoutDays: 0 });
    expect(c.usable).toBe(true);
    if (!c.usable) return;
    expect(c.correctedUnits).toBe(70);
    expect(c.corrected).toBe(false);
  });

  it('EXCLUDES a week too censored to extrapolate from', () => {
    // scaling two days of sales up by 7/1 produces a number with no evidential basis
    const c = correctCensoredWeek({ weekStartMs: NOW, unitsSold: 10, stockoutDays: UNUSABLE_STOCKOUT_DAYS });
    expect(c.usable).toBe(false);
    if (!c.usable) expect(c.reason).toContain('WEEK_TOO_CENSORED');
    expect(correctCensoredWeek({ weekStartMs: NOW, unitsSold: 0, stockoutDays: 7 }).usable).toBe(false);
  });

  it('refuses nonsensical input rather than producing a number', () => {
    expect(correctCensoredWeek({ weekStartMs: NOW, unitsSold: 10, stockoutDays: 8 }).usable).toBe(false);
    expect(correctCensoredWeek({ weekStartMs: NOW, unitsSold: 10, stockoutDays: -1 }).usable).toBe(false);
    expect(correctCensoredWeek({ weekStartMs: NOW, unitsSold: -5, stockoutDays: 0 }).usable).toBe(false);
  });

  it('THE STOCKOUT FEEDBACK LOOP: correcting the history forecasts materially higher', () => {
    // six weeks of true 70-unit demand, but three of them were half stocked out
    const censored: WeeklyHistory[] = [
      { weekStartMs: NOW - 6 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 5 * WEEK_MS, unitsSold: 35, stockoutDays: 3 },
      { weekStartMs: NOW - 4 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 3 * WEEK_MS, unitsSold: 30, stockoutDays: 4 },
      { weekStartMs: NOW - 2 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 1 * WEEK_MS, unitsSold: 40, stockoutDays: 3 },
    ];
    const corrected = ok(forecast('SKU-1', 'V1', censored, NOW, opts()));
    expect(corrected.censoredCorrections).toHaveLength(3);

    // the same history with the stockouts NOT declared — what a naive pipeline would see
    const naive = ok(forecast('SKU-1', 'V1',
      censored.map((w) => ({ ...w, stockoutDays: 0 })), NOW, opts()));

    // under-forecasting here would under-order, causing the next stockout: a loop that caps a
    // vendor's growth at whatever their first bad week happened to be
    expect(corrected.buckets[0].expectedUnits).toBeGreaterThan(naive.buckets[0].expectedUnits);
    expect(naive.buckets[0].expectedUnits).toBeLessThan(60);
    expect(corrected.buckets[0].expectedUnits).toBeGreaterThan(65);
  });

  it('discloses each correction rather than applying it silently', () => {
    const f = ok(forecast('SKU-1', 'V1', [
      ...steadyHistory().slice(0, 5),
      { weekStartMs: NOW - WEEK_MS, unitsSold: 35, stockoutDays: 3 },
    ], NOW, opts()));
    expect(f.censoredCorrections).toHaveLength(1);
    const c = f.censoredCorrections[0];
    expect(c.observedUnits).toBe(35);
    expect(c.correctedUnits).toBe(61);
    expect(c.stockoutDays).toBe(3);
  });

  it('records excluded weeks so a vendor can see what was dropped', () => {
    const f = ok(forecast('SKU-1', 'V1', [
      ...steadyHistory(),
      { weekStartMs: NOW - WEEK_MS, unitsSold: 5, stockoutDays: 7 },
    ], NOW, opts()));
    expect(f.excludedWeeks).toEqual([NOW - WEEK_MS]);
  });
});

// ============================================ history threshold

describe('the six-week model threshold with a labelled fallback (VALIDATION)', () => {
  it('uses a MODEL forecast with six or more usable weeks', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory().slice(0, MIN_WEEKS_FOR_MODEL), NOW, opts()));
    expect(f.basis).toBe('MODEL');
    expect(f.basisLabel).toContain('6 weeks of history');
    expect(MIN_WEEKS_FOR_MODEL).toBe(6);
  });

  it('falls back to a category analogue below the threshold, LABELLED as such', () => {
    const f = ok(forecast('SKU-NEW', 'V1', steadyHistory().slice(0, 3), NOW,
      opts({ categoryAnalogueWeeklyUnits: 50 })));
    expect(f.basis).toBe('CATEGORY_ANALOGUE');
    // presenting an analogue as a model forecast would invite trust it has not earned
    expect(f.basisLabel).toContain('Category-analogue baseline');
    expect(f.basisLabel).toContain('3 of 6 weeks');
    expect(f.buckets[0].expectedUnits).toBe(50);
  });

  it('an analogue carries a WIDER band than a model, and says so through the numbers', () => {
    const model = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    const analogue = ok(forecast('SKU-2', 'V1', steadyHistory().slice(0, 2), NOW,
      opts({ categoryAnalogueWeeklyUnits: 70 })));
    const modelWidth = model.buckets[0].upperUnits - model.buckets[0].lowerUnits;
    const analogueWidth = analogue.buckets[0].upperUnits - analogue.buckets[0].lowerUnits;
    expect(analogueWidth).toBeGreaterThan(modelWidth);
  });

  it('refuses when there is neither enough history NOR an analogue', () => {
    const r = forecast('SKU-NEW', 'V1', steadyHistory().slice(0, 2), NOW, opts());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations.some((v) => v.code === 'INSUFFICIENT_HISTORY_AND_NO_CATEGORY_ANALOGUE')).toBe(true);
    }
  });

  it('censored-out weeks count against the threshold, so five usable weeks falls back', () => {
    const history: WeeklyHistory[] = [
      ...steadyHistory().slice(0, 5),
      { weekStartMs: NOW - WEEK_MS, unitsSold: 3, stockoutDays: 7 },
    ];
    const f = ok(forecast('SKU-1', 'V1', history, NOW, opts({ categoryAnalogueWeeklyUnits: 60 })));
    expect(f.basis).toBe('CATEGORY_ANALOGUE');
  });
});

// ============================================ horizon and bands

describe('the four-week horizon and confidence bands', () => {
  it('produces four weekly buckets starting from now', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    expect(f.buckets).toHaveLength(HORIZON_WEEKS);
    expect(HORIZON_WEEKS).toBe(4);
    expect(f.buckets[0].weekStartMs).toBe(NOW);
    expect(f.buckets[3].weekStartMs).toBe(NOW + 3 * WEEK_MS);
  });

  it('widens the band with the horizon, because week four is a longer bet', () => {
    const f = ok(forecast('SKU-1', 'V1', [
      { weekStartMs: NOW - 6 * WEEK_MS, unitsSold: 60, stockoutDays: 0 },
      { weekStartMs: NOW - 5 * WEEK_MS, unitsSold: 80, stockoutDays: 0 },
      { weekStartMs: NOW - 4 * WEEK_MS, unitsSold: 65, stockoutDays: 0 },
      { weekStartMs: NOW - 3 * WEEK_MS, unitsSold: 75, stockoutDays: 0 },
      { weekStartMs: NOW - 2 * WEEK_MS, unitsSold: 55, stockoutDays: 0 },
      { weekStartMs: NOW - 1 * WEEK_MS, unitsSold: 85, stockoutDays: 0 },
    ], NOW, opts()));
    const w1 = f.buckets[0].upperUnits - f.buckets[0].lowerUnits;
    const w4 = f.buckets[3].upperUnits - f.buckets[3].lowerUnits;
    expect(w4).toBeGreaterThan(w1);
  });

  it('never produces a negative lower bound', () => {
    const f = ok(forecast('SKU-1', 'V1', [
      { weekStartMs: NOW - 6 * WEEK_MS, unitsSold: 1, stockoutDays: 0 },
      { weekStartMs: NOW - 5 * WEEK_MS, unitsSold: 40, stockoutDays: 0 },
      { weekStartMs: NOW - 4 * WEEK_MS, unitsSold: 2, stockoutDays: 0 },
      { weekStartMs: NOW - 3 * WEEK_MS, unitsSold: 38, stockoutDays: 0 },
      { weekStartMs: NOW - 2 * WEEK_MS, unitsSold: 1, stockoutDays: 0 },
      { weekStartMs: NOW - 1 * WEEK_MS, unitsSold: 45, stockoutDays: 0 },
    ], NOW, opts()));
    expect(f.buckets.every((b) => b.lowerUnits >= 0)).toBe(true);
  });

  it('applies seasonality per bucket where the category has it', () => {
    const flat = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    const seasonal = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW,
      opts({ seasonalityByWeek: [1, 1, 2, 1] })));
    expect(seasonal.buckets[2].expectedUnits).toBe(flat.buckets[2].expectedUnits * 2);
    expect(seasonal.buckets[0].expectedUnits).toBe(flat.buckets[0].expectedUnits);
  });

  it('rejects an out-of-range confidence level', () => {
    expect(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({ confidenceLevel: 0 })).ok).toBe(false);
    expect(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({ confidenceLevel: 1 })).ok).toBe(false);
  });
});

// ============================================ campaign uplift

describe('campaign uplift factors are DISCLOSED (RULES)', () => {
  it('applies and discloses an uplift when the vendor opted in', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({
      campaignSignalsOptedIn: true,
      campaign: { campaignId: 'CMP-DIWALI', upliftFactor: 1.6 },
    })));
    expect(f.campaignUplift).toBeDefined();
    expect(f.campaignUplift!.factor).toBe(1.6);
    expect(f.campaignUplift!.disclosed).toBe(true);
    expect(f.campaignUplift!.note).toContain('60% uplift');
    expect(f.campaignUplift!.note).toContain('CMP-DIWALI');
    expect(f.buckets[0].expectedUnits).toBe(Math.round(70 * 1.6));
  });

  it('does NOT apply an uplift when the vendor has not opted into campaign signals', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({
      campaignSignalsOptedIn: false,
      campaign: { campaignId: 'CMP-DIWALI', upliftFactor: 1.6 },
    })));
    expect(f.campaignUplift).toBeUndefined();
    expect(f.buckets[0].expectedUnits).toBe(70);
  });

  it('an opted-in vendor with no live campaign gets no uplift', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({ campaignSignalsOptedIn: true })));
    expect(f.campaignUplift).toBeUndefined();
  });
});

// ============================================ MAPE

describe('the MAPE accuracy badge (OUTPUTS)', () => {
  it('computes mean absolute percentage error', () => {
    expect(mapePercent([
      { actual: 100, predicted: 90 },
      { actual: 100, predicted: 110 },
    ])).toBe(10);
    expect(mapePercent([{ actual: 50, predicted: 50 }])).toBe(0);
  });

  it('EXCLUDES zero-actual weeks rather than scoring them as 100% error', () => {
    // a week with no sales makes the percentage undefined, not maximally wrong
    expect(mapePercent([{ actual: 0, predicted: 10 }])).toBeNull();
    expect(mapePercent([{ actual: 0, predicted: 10 }, { actual: 100, predicted: 90 }])).toBe(10);
    expect(mapePercent([])).toBeNull();
  });

  it('scores predictions against CORRECTED actuals, not censored ones', () => {
    const history: WeeklyHistory[] = [
      ...steadyHistory().slice(0, 5),
      { weekStartMs: NOW - WEEK_MS, unitsSold: 35, stockoutDays: 3 },  // corrects to 61
    ];
    // the model predicted 70; against the censored 35 that looks like 100% error, against the
    // corrected 61 it is about 15% — scoring on censored actuals would punish a correct forecast
    const f = ok(forecast('SKU-1', 'V1', history, NOW, opts({
      priorPredictions: [{ weekStartMs: NOW - WEEK_MS, predictedUnits: 70 }],
    })));
    expect(f.mapePercent).not.toBeNull();
    expect(f.mapePercent!).toBeLessThan(20);
  });

  it('is null when no prior predictions exist', () => {
    expect(ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts())).mapePercent).toBeNull();
  });

  it('only considers predictions inside the eight-week window', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({
      priorPredictions: [{ weekStartMs: NOW - (MAPE_WINDOW_WEEKS + 2) * WEEK_MS, predictedUnits: 999 }],
    })));
    expect(f.mapePercent).toBeNull();
    expect(MAPE_WINDOW_WEEKS).toBe(8);
  });
});

// ============================================ staleness

describe('a missed model job shows the last forecast with a banner (ERRORS)', () => {
  it('marks stale without discarding the forecast', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    const stale = markStale(f, NOW + 3 * 24 * 3_600_000);
    expect(stale.stale).toBe(true);
    expect(stale.buckets).toEqual(f.buckets);

    const banner = stalenessBanner(stale, NOW + 5 * 24 * 3_600_000);
    expect(banner).toContain('has not refreshed');
    expect(banner).toContain('indicative');
    expect(banner).toContain('2 day(s)');
  });

  it('a fresh forecast shows no banner', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    expect(f.stale).toBe(false);
    expect(stalenessBanner(f, NOW)).toBe('');
  });
});

// ============================================ advisory-only

describe('advisory-only in v1 (RULES)', () => {
  it('every forecast is marked advisory', () => {
    expect(ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts())).advisory).toBe(true);
  });

  it('the module exposes no auto-purchase-order surface', async () => {
    const mod = await import('../src/domain/demand-forecast.js');
    const suspicious = Object.keys(mod).filter((n) => {
      const l = n.toLowerCase();
      return l.includes('purchaseorder') || l.startsWith('raisepo') || l.startsWith('autoorder')
        || l.startsWith('placeorder') || l.startsWith('commit');
    });
    expect(suspicious).toEqual([]);
  });
});

// ============================================ vendor scoping and export

describe('a vendor sees only their own SKUs (SECURITY)', () => {
  it('filters foreign forecasts out, even when passed in', () => {
    const mine = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    const theirs = ok(forecast('SKU-9', 'V2', steadyHistory(), NOW, opts()));
    const visible = forVendor([mine, theirs], 'V1');
    expect(visible.map((f) => f.sku)).toEqual(['SKU-1']);
  });

  it('the CSV export is vendor-scoped and discloses basis and uplift on every row', () => {
    const mine = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts({
      campaignSignalsOptedIn: true,
      campaign: { campaignId: 'CMP-1', upliftFactor: 1.5 },
    })));
    const theirs = ok(forecast('SKU-9', 'V2', steadyHistory(), NOW, opts()));

    const csv = toCsv([mine, theirs], 'V1');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('sku,week_start,expected_units,lower_units,upper_units,basis,campaign_uplift,mape_percent');
    expect(lines).toHaveLength(1 + HORIZON_WEEKS);
    expect(csv).not.toContain('SKU-9');
    expect(lines[1]).toContain('MODEL');
    expect(lines[1]).toContain('1.5');
  });
});

// ============================================ the bridge to FR-AI-007

describe('CROSS-SLICE: the forecast feeds the real inventory optimiser', () => {
  it('produces the DemandForecast shape the Slice-42 optimiser consumes', () => {
    const f = ok(forecast('SKU-1', 'V1', steadyHistory(), NOW, opts()));
    const demand = toDemandForecast(f);
    // 70 units a week is 10 a day
    expect(demand.meanDailyUnits).toBeCloseTo(10, 1);
    expect(demand.stdDevDailyUnits).toBeGreaterThanOrEqual(0);
  });

  it('drives a real reorder proposal end to end', () => {
    const f = ok(forecast('SKU-1', 'V1', [
      { weekStartMs: NOW - 6 * WEEK_MS, unitsSold: 60, stockoutDays: 0 },
      { weekStartMs: NOW - 5 * WEEK_MS, unitsSold: 80, stockoutDays: 0 },
      { weekStartMs: NOW - 4 * WEEK_MS, unitsSold: 65, stockoutDays: 0 },
      { weekStartMs: NOW - 3 * WEEK_MS, unitsSold: 75, stockoutDays: 0 },
      { weekStartMs: NOW - 2 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 1 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
    ], NOW, opts()));

    const demand = toDemandForecast(f);
    const leadTime: LeadTime = { meanDays: 7, stdDevDays: 2, source: 'VENDOR_INPUT' };
    const proposal = reorderProposal('SKU-1', demand, 0.95,
      { orderCostPaise: 500_00, annualHoldingCostPerUnitPaise: 120_00 }, leadTime);

    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    // the optimiser's assumptions now carry the forecast's own figures
    expect(proposal.proposal.assumptions.meanDailyUnits).toBe(demand.meanDailyUnits);
    expect(proposal.proposal.assumptions.demandStdDevDailyUnits).toBe(demand.stdDevDailyUnits);
    expect(proposal.proposal.reorderPointUnits).toBeGreaterThan(0);
    expect(proposal.proposal.advisory).toBe(true);
  });

  it('a censored history yields a HIGHER reorder point once corrected', () => {
    const censored: WeeklyHistory[] = [
      { weekStartMs: NOW - 6 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 5 * WEEK_MS, unitsSold: 35, stockoutDays: 3 },
      { weekStartMs: NOW - 4 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 3 * WEEK_MS, unitsSold: 30, stockoutDays: 4 },
      { weekStartMs: NOW - 2 * WEEK_MS, unitsSold: 70, stockoutDays: 0 },
      { weekStartMs: NOW - 1 * WEEK_MS, unitsSold: 40, stockoutDays: 3 },
    ];
    const leadTime: LeadTime = { meanDays: 7, stdDevDays: 2, source: 'VENDOR_INPUT' };
    const costs = { orderCostPaise: 500_00, annualHoldingCostPerUnitPaise: 120_00 };

    const correctedRop = (() => {
      const f = ok(forecast('SKU-1', 'V1', censored, NOW, opts()));
      const p = reorderProposal('SKU-1', toDemandForecast(f), 0.95, costs, leadTime);
      return p.ok ? p.proposal.reorderPointUnits : 0;
    })();

    const naiveRop = (() => {
      const f = ok(forecast('SKU-1', 'V1', censored.map((w) => ({ ...w, stockoutDays: 0 })), NOW, opts()));
      const p = reorderProposal('SKU-1', toDemandForecast(f), 0.95, costs, leadTime);
      return p.ok ? p.proposal.reorderPointUnits : 0;
    })();

    // this is the whole point of the correction: the uncorrected pipeline orders too little and
    // reproduces the stockout it was supposed to prevent
    expect(correctedRop).toBeGreaterThan(naiveRop);
    expect(safetyStockUnits(toDemandForecast(ok(forecast('SKU-1', 'V1', censored, NOW, opts()))),
      leadTime, 0.95)).toBeGreaterThan(0);
  });
});
