/**
 * Inventory optimisation — FR-AI-007.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "convert forecasts into inventory guidance: reorder points & quantities
 *                (service-level targets, lead-time distributions), overstock/dead-stock detection
 *                with markdown suggestions, and platform-level assortment gap insights."
 *   INPUTS:     "Forecast distributions, lead times (vendor input + observed), holding-cost
 *                params, service-level targets per category."
 *   OUTPUTS:    "Advisory reorder proposals (advisory-only v1), ageing-stock alerts with
 *                suggested markdown ranges (bounded by BRU-10), assortment gap reports."
 *   VALIDATION: "Suggestions must show assumptions (lead time, target SL) inline; markdown ranges
 *                respect floors."
 *   RULES:      "No auto-execution in v1; acceptance tracked to measure advice quality."
 *   ERRORS:     "Missing lead time → prompt vendor input, fallback to observed median with wide
 *                bands."
 *   ACCEPTANCE: "Given target service level 95% and lead time 7±2 d, When ROP computes, Then the
 *                maths [holds]."
 *
 * Two things are enforced structurally rather than by convention:
 *
 *  1. ADVISORY-ONLY IN v1. Every output is a proposal carrying its own assumptions, and this
 *     module exposes no execute, apply or commit surface at all — the test asserts that absence
 *     by reflection, so "no auto-execution in v1" cannot be quietly undone by adding a method.
 *
 *  2. MARKDOWN RANGES REUSE THE PRICING ENGINE'S BRU-10 CLAMP rather than reimplementing it.
 *     The requirement says markdown ranges are "bounded by BRU-10", and BRU-10 is already
 *     enforced in applyHardConstraints; duplicating that logic here would create two places for
 *     the floor/MRP rule to drift apart.
 */
import { applyHardConstraints, type Paise, type PricingContext, type VendorBounds } from './pricing.js';

/**
 * One-tailed normal quantiles for the service levels a category target realistically takes.
 * Tabulated rather than computed because an inverse-normal approximation would introduce error
 * into a figure that feeds purchase orders, and these are the only values the config permits.
 */
export const Z_BY_SERVICE_LEVEL: Readonly<Record<number, number>> = {
  0.80: 0.8416,
  0.85: 1.0364,
  0.90: 1.2816,
  0.95: 1.6449,
  0.975: 1.9600,
  0.99: 2.3263,
};

export const SUPPORTED_SERVICE_LEVELS = Object.keys(Z_BY_SERVICE_LEVEL).map(Number);

/** ERRORS: when lead time is unknown, the fallback band is widened by this factor. */
export const MISSING_LEAD_TIME_BAND_MULTIPLIER = 2;
/** Days without a sale after which stock is considered dead rather than merely slow. */
export const DEAD_STOCK_DAYS = 90;

export interface DemandForecast {
  /** Mean daily demand in units. */
  meanDailyUnits: number;
  /** Standard deviation of daily demand in units. */
  stdDevDailyUnits: number;
}

export interface LeadTime {
  /** Mean lead time in days, from vendor input where given. */
  meanDays: number;
  stdDevDays: number;
  /** Where the figure came from — carried into the assumptions shown inline. */
  source: 'VENDOR_INPUT' | 'OBSERVED_MEDIAN';
}

export interface HoldingCostParams {
  /** Cost of placing one purchase order, in paise. */
  orderCostPaise: Paise;
  /** Annual holding cost per unit, in paise. */
  annualHoldingCostPerUnitPaise: Paise;
}

/** VALIDATION: the assumptions a suggestion must show inline. */
export interface Assumptions {
  targetServiceLevel: number;
  zValue: number;
  leadTimeMeanDays: number;
  leadTimeStdDevDays: number;
  leadTimeSource: LeadTime['source'];
  meanDailyUnits: number;
  demandStdDevDailyUnits: number;
  /** True when the lead time was unknown and a widened observed fallback was used. */
  wideBandFallback: boolean;
  /** ERRORS: set when the vendor should be prompted for a real lead time. */
  promptVendorForLeadTime: boolean;
}

export interface ReorderProposal {
  sku: string;
  /** RULES: v1 output is advice, never an instruction. */
  advisory: true;
  reorderPointUnits: number;
  safetyStockUnits: number;
  /** Economic order quantity, rounded up to a whole unit. */
  reorderQuantityUnits: number;
  demandOverLeadTimeUnits: number;
  stdDevOverLeadTimeUnits: number;
  assumptions: Assumptions;
}

export type ProposalResult =
  | { ok: true; proposal: ReorderProposal }
  | { ok: false; violations: string[] };

/**
 * Combined standard deviation of demand over a stochastic lead time:
 *
 *   sigma_LT = sqrt( LT_mean * sigma_d^2  +  d_mean^2 * sigma_LT^2 )
 *
 * Both terms matter: using only demand variance understates risk whenever the lead time itself
 * varies, which is exactly the case the requirement's "lead-time distributions" refers to.
 */
export function stdDevOverLeadTime(forecast: DemandForecast, leadTime: LeadTime): number {
  const demandTerm = leadTime.meanDays * forecast.stdDevDailyUnits ** 2;
  const leadTimeTerm = forecast.meanDailyUnits ** 2 * leadTime.stdDevDays ** 2;
  return Math.sqrt(demandTerm + leadTimeTerm);
}

/**
 * Safety stock for a service level. Rounded UP, never down: rounding a safety buffer down
 * silently lowers the achieved service level below the target the category asked for.
 */
export function safetyStockUnits(forecast: DemandForecast, leadTime: LeadTime, serviceLevel: number): number {
  const z = Z_BY_SERVICE_LEVEL[serviceLevel];
  return Math.ceil(z * stdDevOverLeadTime(forecast, leadTime));
}

/** Economic order quantity, rounded up to a whole unit. */
export function economicOrderQuantity(forecast: DemandForecast, costs: HoldingCostParams): number {
  const annualDemand = forecast.meanDailyUnits * 365;
  if (costs.annualHoldingCostPerUnitPaise <= 0) return Math.ceil(annualDemand / 12);
  return Math.ceil(Math.sqrt((2 * annualDemand * costs.orderCostPaise) / costs.annualHoldingCostPerUnitPaise));
}

/**
 * ERRORS: a missing lead time falls back to the observed median with a widened band, and flags
 * that the vendor should be prompted — the guidance is still produced, but it declares its own
 * weaker footing rather than presenting a fabricated confidence.
 */
export function resolveLeadTime(
  vendorLeadTime: LeadTime | undefined,
  observedMedianDays: number | undefined,
  observedStdDevDays: number | undefined,
): { leadTime: LeadTime; wideBandFallback: boolean; promptVendor: boolean } | { error: string } {
  if (vendorLeadTime) {
    return { leadTime: vendorLeadTime, wideBandFallback: false, promptVendor: false };
  }
  if (observedMedianDays === undefined || observedStdDevDays === undefined) {
    return { error: 'NO_LEAD_TIME_AND_NO_OBSERVATIONS_PROMPT_VENDOR' };
  }
  return {
    leadTime: {
      meanDays: observedMedianDays,
      stdDevDays: observedStdDevDays * MISSING_LEAD_TIME_BAND_MULTIPLIER,
      source: 'OBSERVED_MEDIAN',
    },
    wideBandFallback: true,
    promptVendor: true,
  };
}

/**
 * Compute an advisory reorder proposal.
 *
 *   ROP = d_mean * LT_mean + safety stock
 */
export function reorderProposal(
  sku: string,
  forecast: DemandForecast,
  serviceLevel: number,
  costs: HoldingCostParams,
  vendorLeadTime?: LeadTime,
  observedMedianDays?: number,
  observedStdDevDays?: number,
): ProposalResult {
  const violations: string[] = [];
  if (!SUPPORTED_SERVICE_LEVELS.includes(serviceLevel)) {
    violations.push(`UNSUPPORTED_SERVICE_LEVEL: ${serviceLevel}`);
  }
  if (forecast.meanDailyUnits < 0 || forecast.stdDevDailyUnits < 0) violations.push('NEGATIVE_FORECAST');
  if (costs.orderCostPaise < 0) violations.push('NEGATIVE_ORDER_COST');

  const resolved = resolveLeadTime(vendorLeadTime, observedMedianDays, observedStdDevDays);
  if ('error' in resolved) violations.push(resolved.error);
  if (violations.length > 0) return { ok: false, violations };
  if ('error' in resolved) return { ok: false, violations: [resolved.error] };

  const { leadTime, wideBandFallback, promptVendor } = resolved;
  if (leadTime.meanDays < 0 || leadTime.stdDevDays < 0) {
    return { ok: false, violations: ['NEGATIVE_LEAD_TIME'] };
  }

  const sigma = stdDevOverLeadTime(forecast, leadTime);
  const ss = safetyStockUnits(forecast, leadTime, serviceLevel);
  const demandOverLt = forecast.meanDailyUnits * leadTime.meanDays;

  return {
    ok: true,
    proposal: {
      sku,
      advisory: true,
      reorderPointUnits: Math.ceil(demandOverLt) + ss,
      safetyStockUnits: ss,
      reorderQuantityUnits: economicOrderQuantity(forecast, costs),
      demandOverLeadTimeUnits: demandOverLt,
      stdDevOverLeadTimeUnits: sigma,
      // VALIDATION: the assumptions travel with the suggestion, inline
      assumptions: {
        targetServiceLevel: serviceLevel,
        zValue: Z_BY_SERVICE_LEVEL[serviceLevel],
        leadTimeMeanDays: leadTime.meanDays,
        leadTimeStdDevDays: leadTime.stdDevDays,
        leadTimeSource: leadTime.source,
        meanDailyUnits: forecast.meanDailyUnits,
        demandStdDevDailyUnits: forecast.stdDevDailyUnits,
        wideBandFallback,
        promptVendorForLeadTime: promptVendor,
      },
    },
  };
}

// ================================================= ageing & markdown

export type StockAge = 'HEALTHY' | 'SLOW_MOVING' | 'OVERSTOCK' | 'DEAD_STOCK';

export interface StockPosition {
  sku: string;
  onHandUnits: number;
  daysSinceLastSale: number;
  /** Cover in days at the current forecast run-rate. */
  coverDays: number;
}

export function classifyStock(pos: StockPosition): StockAge {
  if (pos.daysSinceLastSale >= DEAD_STOCK_DAYS) return 'DEAD_STOCK';
  if (pos.coverDays > 180) return 'OVERSTOCK';
  if (pos.coverDays > 90 || pos.daysSinceLastSale >= 45) return 'SLOW_MOVING';
  return 'HEALTHY';
}

export interface MarkdownSuggestion {
  sku: string;
  advisory: true;
  classification: StockAge;
  /** The suggested range, already clamped by BRU-10. */
  fromPaise: Paise;
  toPaise: Paise;
  /** Guardrails that bit while clamping, carried through for transparency. */
  guardrailsApplied: string[];
  assumptionsNote: string;
}

/**
 * OUTPUTS: an ageing-stock alert with a suggested markdown range "bounded by BRU-10". The bounds
 * are applied by the pricing engine's own clamp, so the floor/MRP rule lives in exactly one place.
 */
export function markdownSuggestion(
  pos: StockPosition,
  currentPricePaise: Paise,
  mrpPaise: Paise,
  bounds: VendorBounds,
  nowMs: number,
): MarkdownSuggestion | null {
  const classification = classifyStock(pos);
  if (classification === 'HEALTHY') return null;

  // deeper discount for older stock, but the clamp decides what is actually permissible
  const depth = classification === 'DEAD_STOCK' ? 0.40
    : classification === 'OVERSTOCK' ? 0.25
      : 0.15;
  const ctx: PricingContext = {
    sku: pos.sku, vendorId: '', categoryId: '',
    currentPricePaise, mrpPaise, bounds,
    inventoryOnHand: pos.onHandUnits, inventoryAgeDays: pos.daysSinceLastSale,
    eventLocked: false, nowMs,
  };

  const deepest = applyHardConstraints(Math.round(currentPricePaise * (1 - depth)), ctx);
  const shallowest = applyHardConstraints(Math.round(currentPricePaise * (1 - depth / 2)), ctx);

  return {
    sku: pos.sku,
    advisory: true,
    classification,
    fromPaise: deepest.pricePaise,
    toPaise: shallowest.pricePaise,
    guardrailsApplied: [...new Set([...deepest.applied, ...shallowest.applied])],
    assumptionsNote: `classification=${classification}; coverDays=${pos.coverDays}; `
      + `daysSinceLastSale=${pos.daysSinceLastSale}; suggestedDepth=${Math.round(depth * 100)}%`,
  };
}

// ================================================= assortment gaps

export interface AssortmentGap {
  categoryId: string;
  attribute: string;
  missingValue: string;
  demandSignalStrength: number;
  liveListingCount: number;
}

/**
 * OUTPUTS: platform-level assortment gap insights — attribute values customers search for in a
 * category where few or no live listings carry them.
 */
export function assortmentGaps(
  categoryId: string,
  searchDemandByValue: Map<string, number>,
  liveListingsByValue: Map<string, number>,
  attribute: string,
  minDemand = 100,
  maxListings = 3,
): AssortmentGap[] {
  const gaps: AssortmentGap[] = [];
  for (const [value, demand] of searchDemandByValue) {
    const listings = liveListingsByValue.get(value) ?? 0;
    if (demand >= minDemand && listings <= maxListings) {
      gaps.push({
        categoryId, attribute, missingValue: value,
        demandSignalStrength: demand, liveListingCount: listings,
      });
    }
  }
  return gaps.sort((a, b) => b.demandSignalStrength - a.demandSignalStrength
    || a.missingValue.localeCompare(b.missingValue));
}

// ================================================= advice quality

/** RULES: acceptance is tracked to measure advice quality. */
export interface AdviceOutcome {
  sku: string;
  accepted: boolean;
  /** Stockout days observed in the period after the advice. */
  stockoutDaysAfter: number;
  stockoutDaysBefore: number;
}

export function adviceQuality(outcomes: AdviceOutcome[]):
  { acceptedCount: number; acceptanceRate: number; meanStockoutDeltaForAccepted: number | null } {
  const accepted = outcomes.filter((o) => o.accepted);
  const rate = outcomes.length === 0 ? 0 : Math.round((accepted.length / outcomes.length) * 100) / 100;
  if (accepted.length === 0) {
    return { acceptedCount: 0, acceptanceRate: rate, meanStockoutDeltaForAccepted: null };
  }
  const delta = accepted.reduce((a, o) => a + (o.stockoutDaysAfter - o.stockoutDaysBefore), 0) / accepted.length;
  return {
    acceptedCount: accepted.length,
    acceptanceRate: rate,
    meanStockoutDeltaForAccepted: Math.round(delta * 100) / 100,
  };
}
