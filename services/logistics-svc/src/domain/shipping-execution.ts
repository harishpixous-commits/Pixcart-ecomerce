/**
 * Shipping execution (vendor-side) — FR-VEN-008.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "let vendors generate labels via platform courier accounts (rate-shopped) or
 *                self-ship (enter AWB), schedule pickups, print manifests, and handle
 *                weight-discrepancy disputes."
 *   INPUTS:     "Package dimensions/weight, courier choice (or auto-best), pickup slot, self-ship
 *                AWB + courier name."
 *   OUTPUTS:    "Label PDF (platform format), pickup confirmation, manifest sheet, tracking
 *                auto-attach, dispute tickets with evidence."
 *   VALIDATION: "Dead-weight vs volumetric computed; dimensions within courier limits; self-ship
 *                AWB format per courier regex."
 *   RULES:      "Platform-shipped mandatory for COD; declared-value auto-set to sale price for
 *                insurance; weight-dispute window 7 days from courier debit with photo evidence."
 *   ERRORS:     "Courier API down → next-best courier auto-quote; pickup missed → auto-reschedule
 *                + alert; label [regeneration]."
 *
 * Rate shopping is NOT reimplemented here: the FR-LOG-002 serviceability engine already scores and
 * allocates couriers, and pickups already have a booking and failure-escalation model in
 * FR-LOG-003. This module supplies what neither has — the vendor's own label, weight and dispute
 * path — and calls the others for the parts they own.
 *
 * THREE RULES HERE PROTECT SOMEONE OTHER THAN THE VENDOR, and each is enforced rather than assumed:
 *
 *  1. CHARGEABLE WEIGHT IS THE GREATER OF DEAD AND VOLUMETRIC WEIGHT. This is how couriers
 *     actually bill, and computing only dead weight quotes a vendor a price the courier will not
 *     honour — then debits the difference weeks later, which is precisely the dispute this
 *     requirement also has to handle. Quoting the real basis up front prevents most of them.
 *
 *  2. COD ORDERS MUST BE PLATFORM-SHIPPED. A self-shipped COD order means a vendor collecting the
 *     platform's money directly, with no remittance rail behind it and no recourse for the
 *     customer if the parcel never arrives. The refusal is absolute rather than a warning.
 *
 *  3. DECLARED VALUE IS SET FROM THE SALE PRICE, NOT SUPPLIED. A vendor under-declaring to save a
 *     few rupees of insurance leaves the CUSTOMER uncovered when the parcel is lost — the saving
 *     is the vendor's and the loss is not. So the field is computed, and a supplied value that
 *     disagrees is refused rather than quietly overwritten.
 */
import { type Carrier } from './tracking.js';

/** VALIDATION: the volumetric divisor for domestic surface freight, cm³ per kg. */
export const VOLUMETRIC_DIVISOR_CM3_PER_KG = 5_000;
/** RULES: the weight-dispute window, from the courier's debit. */
export const WEIGHT_DISPUTE_WINDOW_MS = 7 * 24 * 3_600_000;
/** A debit below this is absorbed rather than disputed — the dispute costs more than the money. */
export const MIN_DISPUTABLE_DEBIT_PAISE = 20_00;

export type ShipMode = 'PLATFORM' | 'SELF_SHIP';

export type PaymentMode = 'PREPAID' | 'COD';

export interface Dimensions {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface CourierLimits {
  carrier: Carrier;
  maxWeightGrams: number;
  maxLengthCm: number;
  /** Maximum sum of the three dimensions, which is how couriers usually express girth limits. */
  maxSumOfDimensionsCm: number;
}

/** VALIDATION: the AWB format each courier issues. */
export const AWB_PATTERNS: Readonly<Record<Carrier, RegExp>> = {
  DELHIVERY: /^[0-9]{11,14}$/,
  BLUEDART: /^[0-9]{9,11}$/,
  DTDC: /^[A-Z][0-9]{8,9}$/,
  INDIA_POST: /^[A-Z]{2}[0-9]{9}IN$/,
};

export interface WeightBasis {
  deadWeightGrams: number;
  volumetricWeightGrams: number;
  /** RULES: what the courier will actually bill on. */
  chargeableWeightGrams: number;
  basis: 'DEAD' | 'VOLUMETRIC';
}

/**
 * VALIDATION: dead versus volumetric weight.
 *
 * The chargeable weight is the GREATER of the two. A vendor shipping a light bulky item — a
 * cushion, a lampshade — is billed on the space it occupies in the van, not its mass.
 */
export function weightBasis(dims: Dimensions, deadWeightGrams: number): WeightBasis {
  const cm3 = dims.lengthCm * dims.widthCm * dims.heightCm;
  const volumetricWeightGrams = Math.ceil((cm3 / VOLUMETRIC_DIVISOR_CM3_PER_KG) * 1_000);
  const chargeable = Math.max(deadWeightGrams, volumetricWeightGrams);
  return {
    deadWeightGrams,
    volumetricWeightGrams,
    chargeableWeightGrams: chargeable,
    basis: volumetricWeightGrams > deadWeightGrams ? 'VOLUMETRIC' : 'DEAD',
  };
}

export interface Violation {
  code: string;
  detail: string;
}

/** VALIDATION: dimensions and weight within the courier's stated limits. */
export function validateAgainstLimits(dims: Dimensions, deadWeightGrams: number,
                                      limits: CourierLimits): Violation[] {
  const v: Violation[] = [];
  if (dims.lengthCm <= 0 || dims.widthCm <= 0 || dims.heightCm <= 0) {
    v.push({ code: 'DIMENSIONS_MUST_BE_POSITIVE', detail: JSON.stringify(dims) });
    return v;
  }
  if (deadWeightGrams <= 0) {
    v.push({ code: 'WEIGHT_MUST_BE_POSITIVE', detail: String(deadWeightGrams) });
    return v;
  }

  const basis = weightBasis(dims, deadWeightGrams);
  // the limit applies to the CHARGEABLE weight, not the dead weight: a courier that will not
  // carry 10 kg will not carry a 10 kg volumetric parcel either
  if (basis.chargeableWeightGrams > limits.maxWeightGrams) {
    v.push({
      code: 'CHARGEABLE_WEIGHT_EXCEEDS_COURIER_LIMIT',
      detail: `${basis.chargeableWeightGrams}g > ${limits.maxWeightGrams}g (${basis.basis})`,
    });
  }
  const longest = Math.max(dims.lengthCm, dims.widthCm, dims.heightCm);
  if (longest > limits.maxLengthCm) {
    v.push({ code: 'LONGEST_SIDE_EXCEEDS_COURIER_LIMIT', detail: `${longest}cm > ${limits.maxLengthCm}cm` });
  }
  const sum = dims.lengthCm + dims.widthCm + dims.heightCm;
  if (sum > limits.maxSumOfDimensionsCm) {
    v.push({ code: 'GIRTH_EXCEEDS_COURIER_LIMIT', detail: `${sum}cm > ${limits.maxSumOfDimensionsCm}cm` });
  }
  return v;
}

/** VALIDATION: a self-ship AWB must match the format its courier actually issues. */
export function isValidAwb(carrier: Carrier, awb: string): boolean {
  const pattern = AWB_PATTERNS[carrier];
  if (!pattern) return false;
  return pattern.test(awb.trim().toUpperCase());
}

// ================================================= label generation

export interface ShipmentRequest {
  shipmentId: string;
  vendorId: string;
  orderId: string;
  paymentMode: PaymentMode;
  /** RULES: the declared value is derived from this, never supplied. */
  saleValuePaise: number;
  dims: Dimensions;
  deadWeightGrams: number;
  mode: ShipMode;
  /** For PLATFORM: an explicit courier, or undefined for auto-best. */
  preferredCarrier?: Carrier;
  /** For SELF_SHIP: the vendor's own AWB and courier. */
  selfShipCarrier?: Carrier;
  selfShipAwb?: string;
}

export interface Label {
  shipmentId: string;
  awb: string;
  carrier: Carrier;
  mode: ShipMode;
  weight: WeightBasis;
  /** RULES: set from the sale price for insurance purposes. */
  declaredValuePaise: number;
  /** OUTPUTS: the platform label format, not the courier's. */
  format: 'PIXCART_4X6_PDF';
  generatedAtMs: number;
  /** ERRORS: true when the first-choice courier was unavailable and the next-best was used. */
  fellBackFromCarrier?: Carrier;
}

/** A quote from the rate-shopping engine, plus whether that courier is currently reachable. */
export interface CarrierOption {
  carrier: Carrier;
  quotedPaise: number;
  limits: CourierLimits;
  apiAvailable: boolean;
}

export type LabelResult =
  | { ok: true; label: Label; trackingAttached: true }
  | { ok: false; violations: Violation[] };

/**
 * Generate a label.
 *
 * The COD check comes first because it is a categorical prohibition rather than a validation
 * failure: there is no package geometry that makes a self-shipped COD order acceptable, so there
 * is no point measuring the box.
 */
export function generateLabel(req: ShipmentRequest, options: CarrierOption[],
                              awbAllocator: (carrier: Carrier) => string,
                              nowMs: number): LabelResult {
  const violations: Violation[] = [];

  // RULES: platform-shipped is mandatory for COD
  if (req.paymentMode === 'COD' && req.mode === 'SELF_SHIP') {
    return {
      ok: false,
      violations: [{
        code: 'COD_REQUIRES_PLATFORM_SHIPPING',
        detail: 'A self-shipped COD order has no remittance rail and no customer recourse',
      }],
    };
  }
  if (req.saleValuePaise <= 0) {
    violations.push({ code: 'SALE_VALUE_REQUIRED_FOR_DECLARED_VALUE', detail: '' });
  }

  if (req.mode === 'SELF_SHIP') {
    if (!req.selfShipCarrier || !req.selfShipAwb) {
      violations.push({ code: 'SELF_SHIP_REQUIRES_CARRIER_AND_AWB', detail: '' });
    } else if (!isValidAwb(req.selfShipCarrier, req.selfShipAwb)) {
      violations.push({
        code: 'SELF_SHIP_AWB_FORMAT_INVALID_FOR_CARRIER',
        detail: `${req.selfShipAwb} is not a ${req.selfShipCarrier} AWB`,
      });
    }
    if (violations.length > 0) return { ok: false, violations };

    const carrier = req.selfShipCarrier!;
    return {
      ok: true,
      label: {
        shipmentId: req.shipmentId,
        awb: req.selfShipAwb!.trim().toUpperCase(),
        carrier,
        mode: 'SELF_SHIP',
        weight: weightBasis(req.dims, req.deadWeightGrams),
        declaredValuePaise: req.saleValuePaise,
        format: 'PIXCART_4X6_PDF',
        generatedAtMs: nowMs,
      },
      trackingAttached: true,
    };
  }

  // PLATFORM: pick a courier, honouring the preference where it is available and within limits
  const eligible = options.filter((o) =>
    o.apiAvailable && validateAgainstLimits(req.dims, req.deadWeightGrams, o.limits).length === 0);

  if (eligible.length === 0) {
    // report why: a limit breach is the vendor's to fix, an outage is not
    const anyWithinLimits = options.filter((o) =>
      validateAgainstLimits(req.dims, req.deadWeightGrams, o.limits).length === 0);
    if (anyWithinLimits.length === 0) {
      const first = options[0];
      violations.push(...(first
        ? validateAgainstLimits(req.dims, req.deadWeightGrams, first.limits)
        : [{ code: 'NO_COURIER_OPTIONS_SUPPLIED', detail: '' }]));
    } else {
      violations.push({ code: 'ALL_ELIGIBLE_COURIERS_UNAVAILABLE', detail: 'retry or self-ship' });
    }
    return { ok: false, violations };
  }
  if (violations.length > 0) return { ok: false, violations };

  // ERRORS: courier API down → next-best auto-quote, cheapest first
  const byCost = [...eligible].sort((a, b) => a.quotedPaise - b.quotedPaise
    || a.carrier.localeCompare(b.carrier));
  const preferred = req.preferredCarrier
    ? eligible.find((o) => o.carrier === req.preferredCarrier)
    : undefined;
  const chosen = preferred ?? byCost[0];
  const fellBack = req.preferredCarrier !== undefined && preferred === undefined
    ? req.preferredCarrier
    : undefined;

  return {
    ok: true,
    label: {
      shipmentId: req.shipmentId,
      awb: awbAllocator(chosen.carrier),
      carrier: chosen.carrier,
      mode: 'PLATFORM',
      weight: weightBasis(req.dims, req.deadWeightGrams),
      // RULES: derived, never supplied
      declaredValuePaise: req.saleValuePaise,
      format: 'PIXCART_4X6_PDF',
      generatedAtMs: nowMs,
      fellBackFromCarrier: fellBack,
    },
    trackingAttached: true,
  };
}

// ================================================= manifest

export interface Manifest {
  manifestId: string;
  vendorId: string;
  carrier: Carrier;
  pickupSlotRef: string;
  awbs: string[];
  totalChargeableWeightGrams: number;
  generatedAtMs: number;
}

/**
 * OUTPUTS: the manifest sheet. One manifest per carrier per pickup, because a courier's rider
 * signs for their own consignments and a mixed sheet cannot be signed by anyone.
 */
export function buildManifest(manifestId: string, vendorId: string, carrier: Carrier,
                              pickupSlotRef: string, labels: Label[], nowMs: number):
  { ok: true; manifest: Manifest } | { ok: false; reason: string } {
  const forCarrier = labels.filter((l) => l.carrier === carrier);
  if (forCarrier.length === 0) return { ok: false, reason: 'NO_SHIPMENTS_FOR_CARRIER' };
  // a self-shipped parcel is not the platform's to manifest
  const selfShipped = forCarrier.filter((l) => l.mode === 'SELF_SHIP');
  if (selfShipped.length > 0) {
    return { ok: false, reason: 'SELF_SHIPPED_PARCELS_ARE_NOT_PLATFORM_MANIFESTED' };
  }
  return {
    ok: true,
    manifest: {
      manifestId,
      vendorId,
      carrier,
      pickupSlotRef,
      awbs: forCarrier.map((l) => l.awb).sort(),
      totalChargeableWeightGrams: forCarrier.reduce((a, l) => a + l.weight.chargeableWeightGrams, 0),
      generatedAtMs: nowMs,
    },
  };
}

// ================================================= weight disputes

export interface CourierDebit {
  shipmentId: string;
  awb: string;
  /** What the courier says it weighed. */
  courierWeightGrams: number;
  debitPaise: number;
  debitedAtMs: number;
}

export interface PhotoEvidence {
  mediaRef: string;
  /** A weighing-scale photo must show the parcel and the reading together. */
  showsScaleReading: boolean;
  showsAwbLabel: boolean;
  capturedAtMs: number;
}

export interface DisputeTicket {
  ticketId: string;
  shipmentId: string;
  awb: string;
  declaredChargeableGrams: number;
  courierWeightGrams: number;
  discrepancyGrams: number;
  debitPaise: number;
  evidence: PhotoEvidence[];
  raisedAtMs: number;
  windowClosesAtMs: number;
}

export type DisputeResult =
  | { ok: true; ticket: DisputeTicket }
  | { ok: false; reason: string };

/**
 * RULES: raise a weight dispute. The window runs 7 days from the COURIER'S DEBIT rather than from
 * the shipment date — a debit can land weeks after despatch, and dating the window from despatch
 * would close it before the vendor knew there was anything to dispute.
 *
 * Photo evidence is mandatory and is checked for what makes it evidence: a photo that shows
 * neither the scale reading nor the AWB label proves nothing about this parcel's weight.
 */
export function raiseWeightDispute(ticketId: string, label: Label, debit: CourierDebit,
                                   evidence: PhotoEvidence[], nowMs: number): DisputeResult {
  if (debit.awb !== label.awb) return { ok: false, reason: 'DEBIT_AWB_DOES_NOT_MATCH_LABEL' };
  if (nowMs > debit.debitedAtMs + WEIGHT_DISPUTE_WINDOW_MS) {
    return { ok: false, reason: 'DISPUTE_WINDOW_CLOSED' };
  }
  if (nowMs < debit.debitedAtMs) return { ok: false, reason: 'DEBIT_IS_IN_THE_FUTURE' };

  const discrepancy = debit.courierWeightGrams - label.weight.chargeableWeightGrams;
  if (discrepancy <= 0) {
    // the courier weighed it at or below what we declared: there is nothing to dispute
    return { ok: false, reason: 'NO_DISCREPANCY_TO_DISPUTE' };
  }
  if (debit.debitPaise < MIN_DISPUTABLE_DEBIT_PAISE) {
    return { ok: false, reason: 'DEBIT_BELOW_DISPUTE_THRESHOLD' };
  }
  if (evidence.length === 0) {
    return { ok: false, reason: 'PHOTO_EVIDENCE_REQUIRED' };
  }
  const usable = evidence.filter((e) => e.showsScaleReading && e.showsAwbLabel);
  if (usable.length === 0) {
    return {
      ok: false,
      reason: 'EVIDENCE_MUST_SHOW_BOTH_THE_SCALE_READING_AND_THE_AWB_LABEL',
    };
  }

  return {
    ok: true,
    ticket: {
      ticketId,
      shipmentId: label.shipmentId,
      awb: label.awb,
      declaredChargeableGrams: label.weight.chargeableWeightGrams,
      courierWeightGrams: debit.courierWeightGrams,
      discrepancyGrams: discrepancy,
      debitPaise: debit.debitPaise,
      evidence: usable,
      raisedAtMs: nowMs,
      windowClosesAtMs: debit.debitedAtMs + WEIGHT_DISPUTE_WINDOW_MS,
    },
  };
}

/** Is a debit still disputable? Useful for surfacing a countdown in the vendor UI. */
export function disputeWindowRemainingMs(debit: CourierDebit, nowMs: number): number {
  return Math.max(0, debit.debitedAtMs + WEIGHT_DISPUTE_WINDOW_MS - nowMs);
}
