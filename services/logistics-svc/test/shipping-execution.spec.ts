/**
 * FR-VEN-008 vendor shipping execution. Three rules here protect someone other than the vendor —
 * the chargeable-weight basis, the COD shipping mandate and the declared value — so those get the
 * most attention.
 */
import { describe, expect, it } from 'vitest';
import {
  AWB_PATTERNS,
  buildManifest,
  disputeWindowRemainingMs,
  generateLabel,
  isValidAwb,
  MIN_DISPUTABLE_DEBIT_PAISE,
  raiseWeightDispute,
  validateAgainstLimits,
  VOLUMETRIC_DIVISOR_CM3_PER_KG,
  weightBasis,
  WEIGHT_DISPUTE_WINDOW_MS,
  type CarrierOption,
  type CourierDebit,
  type CourierLimits,
  type Dimensions,
  type Label,
  type PhotoEvidence,
  type ShipmentRequest,
} from '../src/domain/shipping-execution.js';
import type { Carrier } from '../src/domain/tracking.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const DAY = 24 * 3_600_000;

const limits = (carrier: Carrier, over: Partial<CourierLimits> = {}): CourierLimits => ({
  carrier, maxWeightGrams: 25_000, maxLengthCm: 120, maxSumOfDimensionsCm: 250, ...over,
});

const option = (carrier: Carrier, quotedPaise: number, over: Partial<CarrierOption> = {}): CarrierOption => ({
  carrier, quotedPaise, limits: limits(carrier), apiAvailable: true, ...over,
});

const dims = (over: Partial<Dimensions> = {}): Dimensions => ({
  lengthCm: 30, widthCm: 20, heightCm: 10, ...over,
});

const req = (over: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
  shipmentId: 'SHP-1',
  vendorId: 'V1',
  orderId: 'ORD-1001',
  paymentMode: 'PREPAID',
  saleValuePaise: 2_400_00,
  dims: dims(),
  deadWeightGrams: 800,
  mode: 'PLATFORM',
  ...over,
});

let awbCounter = 0;
const allocator = (carrier: Carrier) => {
  awbCounter++;
  return carrier === 'DELHIVERY' ? `1234567890${awbCounter}0` : `98765432${awbCounter}`;
};

const label = (over: Partial<Label> = {}): Label => ({
  shipmentId: 'SHP-1',
  awb: '12345678901',
  carrier: 'DELHIVERY',
  mode: 'PLATFORM',
  weight: weightBasis(dims(), 800),
  declaredValuePaise: 2_400_00,
  format: 'PIXCART_4X6_PDF',
  generatedAtMs: NOW,
  ...over,
});

// ============================================ chargeable weight

describe('chargeable weight is the GREATER of dead and volumetric (VALIDATION)', () => {
  it('bills a light bulky parcel on its volume', () => {
    // a 60x40x40 cushion is 96,000 cm3 = 19.2 kg volumetric, but weighs 1.5 kg
    const basis = weightBasis({ lengthCm: 60, widthCm: 40, heightCm: 40 }, 1_500);
    expect(basis.volumetricWeightGrams).toBe(19_200);
    expect(basis.deadWeightGrams).toBe(1_500);
    // a vendor shipping a cushion is billed for the space it occupies in the van
    expect(basis.chargeableWeightGrams).toBe(19_200);
    expect(basis.basis).toBe('VOLUMETRIC');
  });

  it('bills a dense parcel on its mass', () => {
    // a 20x15x10 box of 3 kg is only 600 g volumetric
    const basis = weightBasis({ lengthCm: 20, widthCm: 15, heightCm: 10 }, 3_000);
    expect(basis.volumetricWeightGrams).toBe(600);
    expect(basis.chargeableWeightGrams).toBe(3_000);
    expect(basis.basis).toBe('DEAD');
  });

  it('uses the documented volumetric divisor', () => {
    expect(VOLUMETRIC_DIVISOR_CM3_PER_KG).toBe(5_000);
    const basis = weightBasis({ lengthCm: 50, widthCm: 50, heightCm: 20 }, 1);
    expect(basis.volumetricWeightGrams).toBe(10_000);   // 50,000 cm3 / 5,000 = 10 kg
  });

  it('rounds volumetric weight UP, never down', () => {
    // 30x20x10 = 6,000 cm3 = 1.2 kg exactly; a fractional case must not round in the courier's
    // favour by accident
    expect(weightBasis({ lengthCm: 30, widthCm: 20, heightCm: 10 }, 1).volumetricWeightGrams).toBe(1_200);
    expect(weightBasis({ lengthCm: 11, widthCm: 11, heightCm: 11 }, 1).volumetricWeightGrams).toBe(267);
  });

  it('an equal dead and volumetric weight reports DEAD rather than flickering', () => {
    const basis = weightBasis({ lengthCm: 30, widthCm: 20, heightCm: 10 }, 1_200);
    expect(basis.chargeableWeightGrams).toBe(1_200);
    expect(basis.basis).toBe('DEAD');
  });
});

describe('courier limits apply to the CHARGEABLE weight (VALIDATION)', () => {
  it('refuses a parcel whose VOLUMETRIC weight exceeds the limit, though it is light', () => {
    // a courier that will not carry 25 kg will not carry a 25 kg volumetric parcel either
    const v = validateAgainstLimits({ lengthCm: 100, widthCm: 80, heightCm: 60 }, 2_000,
      limits('DELHIVERY', { maxWeightGrams: 25_000, maxSumOfDimensionsCm: 400, maxLengthCm: 150 }));
    expect(v.some((x) => x.code === 'CHARGEABLE_WEIGHT_EXCEEDS_COURIER_LIMIT')).toBe(true);
    expect(v[0].detail).toContain('VOLUMETRIC');
  });

  it('refuses an over-long side and an over-girth parcel separately', () => {
    const long = validateAgainstLimits({ lengthCm: 200, widthCm: 5, heightCm: 5 }, 500, limits('DTDC'));
    expect(long.some((x) => x.code === 'LONGEST_SIDE_EXCEEDS_COURIER_LIMIT')).toBe(true);

    const girthy = validateAgainstLimits({ lengthCm: 100, widthCm: 100, heightCm: 100 }, 500,
      limits('DTDC', { maxWeightGrams: 1_000_000, maxLengthCm: 200 }));
    expect(girthy.some((x) => x.code === 'GIRTH_EXCEEDS_COURIER_LIMIT')).toBe(true);
  });

  it('refuses non-positive dimensions and weight without cascading errors', () => {
    expect(validateAgainstLimits({ lengthCm: 0, widthCm: 10, heightCm: 10 }, 500, limits('DTDC')))
      .toEqual([{ code: 'DIMENSIONS_MUST_BE_POSITIVE', detail: JSON.stringify({ lengthCm: 0, widthCm: 10, heightCm: 10 }) }]);
    expect(validateAgainstLimits(dims(), 0, limits('DTDC')).map((x) => x.code))
      .toEqual(['WEIGHT_MUST_BE_POSITIVE']);
  });

  it('accepts a parcel inside every limit', () => {
    expect(validateAgainstLimits(dims(), 800, limits('DELHIVERY'))).toEqual([]);
  });
});

// ============================================ COD mandate

describe('COD orders MUST be platform-shipped (RULES)', () => {
  it('refuses a self-shipped COD order absolutely', () => {
    const r = generateLabel(
      req({ paymentMode: 'COD', mode: 'SELF_SHIP', selfShipCarrier: 'DELHIVERY', selfShipAwb: '12345678901' }),
      [option('DELHIVERY', 6_000)], allocator, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0].code).toBe('COD_REQUIRES_PLATFORM_SHIPPING');
      // a self-shipped COD order has no remittance rail and no customer recourse
      expect(r.violations[0].detail).toContain('remittance');
      // and it is a categorical refusal: nothing else is even reported
      expect(r.violations).toHaveLength(1);
    }
  });

  it('permits a platform-shipped COD order', () => {
    const r = generateLabel(req({ paymentMode: 'COD', mode: 'PLATFORM' }),
      [option('DELHIVERY', 6_000)], allocator, NOW);
    expect(r.ok).toBe(true);
  });

  it('permits a self-shipped PREPAID order', () => {
    const r = generateLabel(
      req({ mode: 'SELF_SHIP', selfShipCarrier: 'DELHIVERY', selfShipAwb: '12345678901' }),
      [], allocator, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.label.mode).toBe('SELF_SHIP');
  });
});

// ============================================ declared value

describe('declared value is derived from the sale price, not supplied (RULES)', () => {
  it('sets the declared value to the sale price', () => {
    const r = generateLabel(req({ saleValuePaise: 3_499_00 }), [option('DELHIVERY', 6_000)], allocator, NOW);
    expect(r.ok).toBe(true);
    // a vendor under-declaring to save insurance leaves the CUSTOMER uncovered when a parcel is
    // lost: the saving is the vendor's and the loss is not
    if (r.ok) expect(r.label.declaredValuePaise).toBe(3_499_00);
  });

  it('refuses a shipment with no sale value to derive from', () => {
    const r = generateLabel(req({ saleValuePaise: 0 }), [option('DELHIVERY', 6_000)], allocator, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.code === 'SALE_VALUE_REQUIRED_FOR_DECLARED_VALUE')).toBe(true);
  });

  it('the label carries no field a vendor could set the declared value through', () => {
    const r = generateLabel(req(), [option('DELHIVERY', 6_000)], allocator, NOW);
    if (!r.ok) throw new Error('expected a label');
    // ShipmentRequest has saleValuePaise but no declaredValuePaise: the value is computed
    expect('declaredValuePaise' in req()).toBe(false);
    expect(r.label.declaredValuePaise).toBe(req().saleValuePaise);
  });
});

// ============================================ AWB validation

describe('a self-ship AWB must match its courier format (VALIDATION)', () => {
  it('accepts a well-formed AWB for each courier', () => {
    expect(isValidAwb('DELHIVERY', '12345678901')).toBe(true);
    expect(isValidAwb('BLUEDART', '123456789')).toBe(true);
    expect(isValidAwb('DTDC', 'D12345678')).toBe(true);
    expect(isValidAwb('INDIA_POST', 'EE123456789IN')).toBe(true);
  });

  it('refuses an AWB in ANOTHER courier format', () => {
    // the commonest self-ship data-entry error: right number, wrong courier selected
    expect(isValidAwb('BLUEDART', 'EE123456789IN')).toBe(false);
    expect(isValidAwb('DTDC', '12345678901')).toBe(false);
    expect(isValidAwb('INDIA_POST', '123456789')).toBe(false);
  });

  it('refuses malformed input and normalises case', () => {
    expect(isValidAwb('DELHIVERY', 'abc')).toBe(false);
    expect(isValidAwb('DELHIVERY', '')).toBe(false);
    expect(isValidAwb('DTDC', ' d12345678 ')).toBe(true);
    expect(Object.keys(AWB_PATTERNS)).toHaveLength(4);
  });

  it('a self-ship label with a mismatched AWB is refused with the courier named', () => {
    const r = generateLabel(
      req({ mode: 'SELF_SHIP', selfShipCarrier: 'BLUEDART', selfShipAwb: 'EE123456789IN' }),
      [], allocator, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations[0].code).toBe('SELF_SHIP_AWB_FORMAT_INVALID_FOR_CARRIER');
      expect(r.violations[0].detail).toContain('BLUEDART');
    }
  });

  it('self-ship requires both a carrier and an AWB', () => {
    expect(generateLabel(req({ mode: 'SELF_SHIP' }), [], allocator, NOW).ok).toBe(false);
    expect(generateLabel(req({ mode: 'SELF_SHIP', selfShipCarrier: 'DTDC' }), [], allocator, NOW).ok).toBe(false);
  });
});

// ============================================ courier selection & fallback

describe('courier selection, and next-best on an outage (ERRORS)', () => {
  it('picks the cheapest eligible courier when none is preferred', () => {
    const r = generateLabel(req(), [
      option('BLUEDART', 9_000), option('DELHIVERY', 6_000), option('DTDC', 7_500),
    ], allocator, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.label.carrier).toBe('DELHIVERY');
  });

  it('honours an available preferred courier over the cheapest', () => {
    const r = generateLabel(req({ preferredCarrier: 'BLUEDART' }), [
      option('BLUEDART', 9_000), option('DELHIVERY', 6_000),
    ], allocator, NOW);
    if (r.ok) {
      expect(r.label.carrier).toBe('BLUEDART');
      expect(r.label.fellBackFromCarrier).toBeUndefined();
    }
  });

  it('falls back to the next best when the preferred courier API is DOWN, and records it', () => {
    const r = generateLabel(req({ preferredCarrier: 'BLUEDART' }), [
      option('BLUEDART', 9_000, { apiAvailable: false }),
      option('DELHIVERY', 6_000),
      option('DTDC', 7_500),
    ], allocator, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.label.carrier).toBe('DELHIVERY');
      // the vendor is told their choice was unavailable rather than silently switched
      expect(r.label.fellBackFromCarrier).toBe('BLUEDART');
    }
  });

  it('skips a courier whose limits the parcel breaches, even when it is cheapest', () => {
    const r = generateLabel(req({ deadWeightGrams: 20_000 }), [
      option('BLUEDART', 5_000, { limits: limits('BLUEDART', { maxWeightGrams: 10_000 }) }),
      option('DELHIVERY', 9_000),
    ], allocator, NOW);
    if (r.ok) expect(r.label.carrier).toBe('DELHIVERY');
  });

  it('distinguishes an outage from a parcel the vendor must fix', () => {
    const allDown = generateLabel(req(), [option('DELHIVERY', 6_000, { apiAvailable: false })], allocator, NOW);
    expect(allDown.ok).toBe(false);
    if (!allDown.ok) expect(allDown.violations[0].code).toBe('ALL_ELIGIBLE_COURIERS_UNAVAILABLE');

    const tooHeavy = generateLabel(req({ deadWeightGrams: 40_000 }),
      [option('DELHIVERY', 6_000)], allocator, NOW);
    expect(tooHeavy.ok).toBe(false);
    if (!tooHeavy.ok) {
      expect(tooHeavy.violations.some((v) => v.code === 'CHARGEABLE_WEIGHT_EXCEEDS_COURIER_LIMIT')).toBe(true);
    }
  });

  it('reports honestly when no options were supplied at all', () => {
    const r = generateLabel(req(), [], allocator, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].code).toBe('NO_COURIER_OPTIONS_SUPPLIED');
  });

  it('attaches tracking on every successful label', () => {
    const r = generateLabel(req(), [option('DELHIVERY', 6_000)], allocator, NOW);
    if (r.ok) expect(r.trackingAttached).toBe(true);
  });
});

// ============================================ manifest

describe('manifests are per carrier and platform-only (OUTPUTS)', () => {
  it('lists the AWBs for one carrier and totals the chargeable weight', () => {
    const labels = [
      label({ awb: '11111111111', carrier: 'DELHIVERY' }),
      label({ awb: '22222222222', carrier: 'DELHIVERY' }),
      label({ awb: '333333333', carrier: 'BLUEDART' }),
    ];
    const r = buildManifest('MF-1', 'V1', 'DELHIVERY', 'SLOT-1', labels, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a rider signs for their own consignments; a mixed sheet cannot be signed by anyone
    expect(r.manifest.awbs).toEqual(['11111111111', '22222222222']);
    expect(r.manifest.totalChargeableWeightGrams).toBe(2 * weightBasis(dims(), 800).chargeableWeightGrams);
  });

  it('refuses a manifest with no shipments for that carrier', () => {
    const r = buildManifest('MF-1', 'V1', 'INDIA_POST', 'SLOT-1', [label()], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_SHIPMENTS_FOR_CARRIER');
  });

  it('refuses to manifest a SELF-SHIPPED parcel, which is not the platform to hand over', () => {
    const r = buildManifest('MF-1', 'V1', 'DELHIVERY', 'SLOT-1',
      [label({ mode: 'SELF_SHIP' })], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SELF_SHIPPED_PARCELS_ARE_NOT_PLATFORM_MANIFESTED');
  });
});

// ============================================ weight disputes

describe('the weight-dispute window runs from the COURIER DEBIT (RULES)', () => {
  const debit = (over: Partial<CourierDebit> = {}): CourierDebit => ({
    shipmentId: 'SHP-1',
    awb: '12345678901',
    courierWeightGrams: 2_500,
    debitPaise: 120_00,
    debitedAtMs: NOW,
    ...over,
  });

  const evidence = (over: Partial<PhotoEvidence> = {}): PhotoEvidence => ({
    mediaRef: 'media://scale-1.jpg',
    showsScaleReading: true,
    showsAwbLabel: true,
    capturedAtMs: NOW,
    ...over,
  });

  it('raises a ticket with the discrepancy computed against the DECLARED chargeable weight', () => {
    const r = raiseWeightDispute('TKT-1', label(), debit(), [evidence()], NOW + DAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ticket.declaredChargeableGrams).toBe(1_200);
    expect(r.ticket.courierWeightGrams).toBe(2_500);
    expect(r.ticket.discrepancyGrams).toBe(1_300);
    expect(r.ticket.windowClosesAtMs).toBe(NOW + WEIGHT_DISPUTE_WINDOW_MS);
  });

  it('runs the window from the debit, not the despatch', () => {
    // a debit can land weeks after despatch; dating the window from despatch would close it
    // before the vendor knew there was anything to dispute
    const lateDebit = debit({ debitedAtMs: NOW + 30 * DAY });
    const r = raiseWeightDispute('TKT-1', label(), lateDebit, [evidence()], NOW + 31 * DAY);
    expect(r.ok).toBe(true);
    expect(WEIGHT_DISPUTE_WINDOW_MS).toBe(7 * DAY);
  });

  it('refuses once the seven days have passed', () => {
    const r = raiseWeightDispute('TKT-1', label(), debit(), [evidence()],
      NOW + WEIGHT_DISPUTE_WINDOW_MS + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DISPUTE_WINDOW_CLOSED');

    const atBoundary = raiseWeightDispute('TKT-1', label(), debit(), [evidence()],
      NOW + WEIGHT_DISPUTE_WINDOW_MS);
    expect(atBoundary.ok).toBe(true);
  });

  it('requires photo evidence, and requires it to actually be evidence', () => {
    const none = raiseWeightDispute('TKT-1', label(), debit(), [], NOW);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe('PHOTO_EVIDENCE_REQUIRED');

    // a photo showing neither the reading nor the label proves nothing about THIS parcel
    const useless = raiseWeightDispute('TKT-1', label(), debit(),
      [evidence({ showsScaleReading: false, showsAwbLabel: false })], NOW);
    expect(useless.ok).toBe(false);
    if (!useless.ok) {
      expect(useless.reason).toBe('EVIDENCE_MUST_SHOW_BOTH_THE_SCALE_READING_AND_THE_AWB_LABEL');
    }

    const halfUseful = raiseWeightDispute('TKT-1', label(), debit(),
      [evidence({ showsAwbLabel: false })], NOW);
    expect(halfUseful.ok).toBe(false);
  });

  it('keeps only the usable evidence on the ticket', () => {
    const r = raiseWeightDispute('TKT-1', label(), debit(), [
      evidence({ mediaRef: 'good.jpg' }),
      evidence({ mediaRef: 'blurry.jpg', showsScaleReading: false }),
    ], NOW);
    if (!r.ok) throw new Error('expected a ticket');
    expect(r.ticket.evidence.map((e) => e.mediaRef)).toEqual(['good.jpg']);
  });

  it('refuses when there is no discrepancy to dispute', () => {
    const fair = raiseWeightDispute('TKT-1', label(), debit({ courierWeightGrams: 1_200 }),
      [evidence()], NOW);
    expect(fair.ok).toBe(false);
    if (!fair.ok) expect(fair.reason).toBe('NO_DISCREPANCY_TO_DISPUTE');

    // the courier weighing it LIGHTER than declared is also nothing to dispute
    const lighter = raiseWeightDispute('TKT-1', label(), debit({ courierWeightGrams: 900 }),
      [evidence()], NOW);
    expect(lighter.ok).toBe(false);
  });

  it('refuses a trivial debit, where the dispute costs more than the money', () => {
    const r = raiseWeightDispute('TKT-1', label(),
      debit({ debitPaise: MIN_DISPUTABLE_DEBIT_PAISE - 1 }), [evidence()], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DEBIT_BELOW_DISPUTE_THRESHOLD');
  });

  it('refuses a debit for a different AWB and one dated in the future', () => {
    expect(raiseWeightDispute('TKT-1', label(), debit({ awb: '99999999999' }), [evidence()], NOW).ok)
      .toBe(false);
    const future = raiseWeightDispute('TKT-1', label(), debit({ debitedAtMs: NOW + DAY }),
      [evidence()], NOW);
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.reason).toBe('DEBIT_IS_IN_THE_FUTURE');
  });

  it('reports the remaining window so a countdown can be shown', () => {
    expect(disputeWindowRemainingMs(debit(), NOW)).toBe(WEIGHT_DISPUTE_WINDOW_MS);
    expect(disputeWindowRemainingMs(debit(), NOW + 3 * DAY)).toBe(4 * DAY);
    expect(disputeWindowRemainingMs(debit(), NOW + 30 * DAY)).toBe(0);
  });
});
