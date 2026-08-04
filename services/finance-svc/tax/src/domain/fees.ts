/**
 * Commission & Fee Engine — FR-FIN-001.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:        "compute, per sub-order line, all marketplace fees — category commission
 *                 (%, slabs), payment fee, logistics fee (when platform-shipped),
 *                 storage/fulfilment fees, promo funding shares — from versioned fee
 *                 schedules effective by order date."
 *   RULES:       "Fees recompute on financial events only (refund → proportional fee
 *                 reversal per policy: commission reversible, payment fee non-refundable
 *                 configurable); BRU-08 formula authoritative."
 *   ACCEPTANCE:  "same order event replayed → identical fee lines (idempotent,
 *                 deterministic); a full refund reverses commission while retaining
 *                 payment fee per config."
 *   VALIDATION:  "Schedule completeness per category before activation; overrides bounded
 *                 (±30% of base) with approval."
 *   BRU-08:      "Commission = category rate + payment fee + logistics fee (if
 *                 platform-shipped) − promotions funded by platform."
 *
 * Pure and deterministic (the acceptance criterion is literally determinism). Money is
 * integer paise; commission uses banker's rounding (matching the promotions engine).
 * Schedules are effective-dated and looked up as of the order date, so replaying a past
 * event always yields identical fees.
 */
import { halfEvenDiv, Paise } from './money.js';

/** One commission slab: applies when taxable base is within [minPaise, maxPaise). */
export interface CommissionSlab {
  minPaise: Paise;
  maxPaise?: Paise;   // open-ended if omitted
  rateBps: number;    // basis points of the base
}

/** A versioned, effective-dated fee schedule for one category. */
export interface FeeSchedule {
  categoryId: string;
  version: number;
  effectiveFrom: string;
  effectiveTo?: string;
  commissionSlabs: CommissionSlab[];
  paymentFeeBps: number;       // fee on the paid amount
  logisticsFeePaise: Paise;    // flat, only when platform-shipped
  storageFeePaise?: Paise;     // flat fulfilment/storage fee
}

export interface FeeLineInput {
  lineId: string;
  categoryId: string;
  /** Commission base — the taxable value of the line (net of tax), in paise. */
  basePaise: Paise;
  /** Amount the customer paid on the line (drives payment fee), in paise. */
  paidPaise: Paise;
  platformShipped: boolean;
  /** Portion of this line's discount funded by the PLATFORM (BRU-08 subtracts this). */
  platformFundedPromoPaise: Paise;
}

export interface FeeBreakdown {
  lineId: string;
  commissionPaise: Paise;
  paymentFeePaise: Paise;
  logisticsFeePaise: Paise;
  storageFeePaise: Paise;
  platformFundedPromoPaise: Paise;
  /** BRU-08: commission + payment + logistics − platform-funded promo. */
  netFeePaise: Paise;
}

export type FeeResult =
  | { ok: true; breakdown: FeeBreakdown }
  | { ok: false; reason: string };

/** Look up the single active schedule for a category as of the order date. */
export function resolveSchedule(schedules: FeeSchedule[], categoryId: string, orderDateIso: string):
  { ok: true; schedule: FeeSchedule } | { ok: false; reason: string } {
  const d = Date.parse(orderDateIso);
  const active = schedules.filter(
    (s) =>
      s.categoryId === categoryId &&
      Date.parse(s.effectiveFrom) <= d &&
      (s.effectiveTo === undefined || d < Date.parse(s.effectiveTo)),
  );
  if (active.length === 0) return { ok: false, reason: `NO_ACTIVE_SCHEDULE for ${categoryId} on ${orderDateIso}` };
  if (active.length > 1) return { ok: false, reason: `AMBIGUOUS_SCHEDULE for ${categoryId}: ${active.length} active` };
  return { ok: true, schedule: active[0] };
}

/** Pick the slab whose band contains the base; slabs must cover the base (completeness). */
export function rateForBase(slabs: CommissionSlab[], basePaise: Paise):
  { ok: true; rateBps: number } | { ok: false; reason: string } {
  const hit = slabs.find((s) => basePaise >= s.minPaise && (s.maxPaise === undefined || basePaise < s.maxPaise));
  if (!hit) return { ok: false, reason: `NO_SLAB_COVERS_BASE ${basePaise}` };
  return { ok: true, rateBps: hit.rateBps };
}

export function computeLineFee(input: FeeLineInput, schedules: FeeSchedule[], orderDateIso: string): FeeResult {
  const sched = resolveSchedule(schedules, input.categoryId, orderDateIso);
  if (!sched.ok) return { ok: false, reason: sched.reason };

  const rate = rateForBase(sched.schedule.commissionSlabs, input.basePaise);
  if (!rate.ok) return { ok: false, reason: rate.reason };

  const commission = halfEvenDiv(input.basePaise * rate.rateBps, 10_000);
  const paymentFee = halfEvenDiv(input.paidPaise * sched.schedule.paymentFeeBps, 10_000);
  const logistics = input.platformShipped ? sched.schedule.logisticsFeePaise : 0;
  const storage = sched.schedule.storageFeePaise ?? 0;

  // BRU-08 authoritative formula.
  const netFee = commission + paymentFee + logistics - input.platformFundedPromoPaise;

  return {
    ok: true,
    breakdown: {
      lineId: input.lineId,
      commissionPaise: commission,
      paymentFeePaise: paymentFee,
      logisticsFeePaise: logistics,
      storageFeePaise: storage,
      platformFundedPromoPaise: input.platformFundedPromoPaise,
      netFeePaise: netFee,
    },
  };
}

/**
 * Fee reversal on refund (RULES). Commission and logistics reverse proportionally to the
 * refunded fraction; the payment fee is retained or reversed per config
 * (paymentFeeRefundable). Returns the fee amounts to CLAW BACK (positive = reverse).
 */
export function reverseFeeOnRefund(
  original: FeeBreakdown,
  refundFraction: number,           // 0..1 of the line refunded
  paymentFeeRefundable: boolean,
): { commissionReversalPaise: Paise; paymentFeeReversalPaise: Paise; logisticsReversalPaise: Paise } {
  if (refundFraction < 0 || refundFraction > 1) throw new Error('refundFraction out of range');
  const commissionReversal = Math.round(original.commissionPaise * refundFraction);
  const logisticsReversal = Math.round(original.logisticsFeePaise * refundFraction);
  const paymentFeeReversal = paymentFeeRefundable ? Math.round(original.paymentFeePaise * refundFraction) : 0;
  return { commissionReversalPaise: commissionReversal, paymentFeeReversalPaise: paymentFeeReversal, logisticsReversalPaise: logisticsReversal };
}

/** VALIDATION: an override is only acceptable within ±30% of the base rate. */
export function isOverrideWithinBounds(baseRateBps: number, overrideRateBps: number): boolean {
  const lo = baseRateBps * 0.7;
  const hi = baseRateBps * 1.3;
  return overrideRateBps >= lo && overrideRateBps <= hi;
}
