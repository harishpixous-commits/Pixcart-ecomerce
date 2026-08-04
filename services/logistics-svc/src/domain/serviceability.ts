/**
 * Shipping orchestration, serviceability & rate shopping — FR-LOG-001.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "compute serviceability, EDD and shipping cost per lane by querying
 *                integrated courier aggregators, select couriers via a configurable
 *                allocation policy (cost × SLA-score × capability), and expose EDD at
 *                PDP/cart/checkout."
 *   RULES:      "Allocation weights configurable per zone; SLA-score from rolling 28-day
 *                courier OTIF; EDD promise buffers by lane risk tier."
 *   VALIDATION: "PINs in master; weight ≤ courier max; COD requires courier COD support
 *                + BRU-05."
 *   BRU-05:     COD needs order value ≤ ₹10,000, serviceable PIN, fraud score below threshold.
 *
 * This module is the authoritative source of the `serviceablePin` fact that the cart
 * (Slice 13) and the FR-CUS-014 quote engine (Slice 3) consume — until now that arrived as
 * a pre-computed boolean. Pure and deterministic: courier quotes arrive as facts (the
 * aggregator adapter fetches them); allocation, EDD and the gates are decided here.
 */

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

/** A PIN in the master directory (VALIDATION: "PINs in master"). */
export interface PinRecord {
  pin: string;              // 6 digits
  zone: string;             // allocation weights are per zone (RULES)
  riskTier: RiskTier;       // drives the EDD promise buffer (RULES)
}

export interface CourierQuote {
  courier: string;
  costPaise: number;
  transitDays: number;
  /** Rolling 28-day OTIF, 0..1 — the SLA-score (RULES). */
  otif: number;
  supportsCod: boolean;
  maxWeightGrams: number;
  /** Capability match for the lane/parcel (e.g. fragile, heavy) — 0..1. */
  capability: number;
}

/** Per-zone allocation weights (RULES: configurable per zone). */
export interface AllocationWeights {
  cost: number;
  sla: number;
  capability: number;
}

export const DEFAULT_WEIGHTS: AllocationWeights = { cost: 0.5, sla: 0.3, capability: 0.2 };

/** EDD promise buffer in days by lane risk tier (RULES). */
export const RISK_BUFFER_DAYS: Record<RiskTier, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export interface ShipmentRequest {
  destinationPin: string;
  weightGrams: number;
  codRequested: boolean;
  orderValuePaise: number;
  fraudScore: number;
  codFraudThreshold?: number;
  shipDateMs: number;
}

export type ServiceabilityResult =
  | {
      serviceable: true;
      zone: string;
      selected: CourierQuote;
      /** Ranked alternatives, best first (the selected one is index 0). */
      ranked: Array<{ courier: string; score: number }>;
      eddMs: number;
      transitDaysWithBuffer: number;
      codEligible: boolean;
      codReasons: string[];
    }
  | { serviceable: false; reason: string };

/**
 * Allocation score: higher is better. Cost is inverted (cheaper scores higher) and
 * normalised against the cheapest eligible quote, so the score is scale-free and
 * deterministic. score = w.cost×(minCost/cost) + w.sla×otif + w.capability×capability.
 */
export function allocationScore(q: CourierQuote, minCostPaise: number, w: AllocationWeights): number {
  const costScore = minCostPaise > 0 ? minCostPaise / q.costPaise : 1;
  return w.cost * costScore + w.sla * q.otif + w.capability * q.capability;
}

/**
 * Decide serviceability, pick a courier and compute EDD. Order of checks mirrors the
 * VALIDATION list: PIN in master → eligible couriers (weight cap, COD capability when COD
 * is requested) → allocation → EDD with the risk buffer → BRU-05 COD gate.
 */
export function evaluate(
  req: ShipmentRequest,
  pinMaster: Map<string, PinRecord>,
  quotes: CourierQuote[],
  weightsByZone: Map<string, AllocationWeights> = new Map(),
): ServiceabilityResult {
  if (!/^\d{6}$/.test(req.destinationPin)) {
    return { serviceable: false, reason: 'PIN_MALFORMED' };
  }
  const pin = pinMaster.get(req.destinationPin);
  if (!pin) return { serviceable: false, reason: 'PIN_NOT_IN_MASTER' };
  if (quotes.length === 0) return { serviceable: false, reason: 'NO_COURIER_COVERS_LANE' };

  // VALIDATION: weight ≤ courier max; COD requires courier COD support.
  let eligible = quotes.filter((q) => req.weightGrams <= q.maxWeightGrams);
  if (eligible.length === 0) return { serviceable: false, reason: 'WEIGHT_OVER_ALL_COURIER_LIMITS' };
  if (req.codRequested) {
    const codCapable = eligible.filter((q) => q.supportsCod);
    // A COD request with no COD-capable courier is still serviceable prepaid — the COD gate
    // below reports why COD was refused rather than failing the whole lane.
    if (codCapable.length > 0) eligible = codCapable;
  }

  const w = weightsByZone.get(pin.zone) ?? DEFAULT_WEIGHTS;
  const minCost = Math.min(...eligible.map((q) => q.costPaise));
  const ranked = eligible
    .map((q) => ({ q, score: allocationScore(q, minCost, w) }))
    // deterministic tie-break: higher score, then cheaper, then courier name
    .sort((a, b) => b.score - a.score || a.q.costPaise - b.q.costPaise || a.q.courier.localeCompare(b.q.courier));

  const selected = ranked[0].q;
  const buffer = RISK_BUFFER_DAYS[pin.riskTier];
  const transitDaysWithBuffer = selected.transitDays + buffer;
  const eddMs = req.shipDateMs + transitDaysWithBuffer * 24 * 3600 * 1000;

  // BRU-05 COD gate (the lane is serviceable by construction at this point).
  const codReasons: string[] = [];
  if (req.codRequested) {
    if (!selected.supportsCod) codReasons.push('COURIER_NO_COD_SUPPORT');
    if (req.orderValuePaise > 10_000 * 100) codReasons.push('ORDER_VALUE_OVER_10000');
    if (req.fraudScore >= (req.codFraudThreshold ?? 0.7)) codReasons.push('FRAUD_SCORE_ABOVE_THRESHOLD');
  }

  return {
    serviceable: true,
    zone: pin.zone,
    selected,
    ranked: ranked.map((r) => ({ courier: r.q.courier, score: r.score })),
    eddMs,
    transitDaysWithBuffer,
    codEligible: req.codRequested ? codReasons.length === 0 : false,
    codReasons,
  };
}

/** Convenience for the cart/quote boundary: the boolean they currently take as input. */
export function isPinServiceable(
  pin: string,
  pinMaster: Map<string, PinRecord>,
  quotes: CourierQuote[],
  weightGrams = 500,
): boolean {
  const r = evaluate(
    { destinationPin: pin, weightGrams, codRequested: false, orderValuePaise: 0, fraudScore: 0, shipDateMs: 0 },
    pinMaster,
    quotes,
  );
  return r.serviceable;
}
