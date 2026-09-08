/**
 * FR-LOG-007 delivery partner portal. The fake-attempt check gets the most attention: one false
 * "customer not available" costs the customer their parcel, the vendor an RTO and the platform a
 * support ticket, while the rider's own scorecard looks untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  allocationScoreFor,
  CAPACITY_NOTICE_LEAD_TIME_MS,
  DeliveryPartnerPortal,
  detectFakeAttempt,
  FAKE_ATTEMPT_CAPABILITY_PENALTY,
  GEOFENCE_RADIUS_METRES,
  haversineMetres,
  NDR_REASONS,
  POD_MAX_BYTES,
  quoteFromScorecard,
  type CapacityNotice,
  type Consignment,
  type GeoPoint,
  type NdrReason,
  type NdrSubmission,
  type PodFile,
} from '../src/domain/partner-portal.js';
import { DEFAULT_WEIGHTS } from '../src/domain/serviceability.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const HOUR = 3_600_000;

/** A real address in Coimbatore. */
const DELIVERY: GeoPoint = { latitude: 11.0168, longitude: 76.9558 };
/** Roughly 100 m away — a rider at the door. */
const AT_DOOR: GeoPoint = { latitude: 11.0177, longitude: 76.9558 };
/** Roughly 3 km away — a rider who did not attempt. */
const THREE_KM_AWAY: GeoPoint = { latitude: 11.0438, longitude: 76.9558 };

const consignment = (over: Partial<Consignment> = {}): Consignment => ({
  awb: '12345678901',
  partnerId: 'DP-DELHIVERY',
  deliveryGeo: DELIVERY,
  attemptCount: 0,
  ...over,
});

const ndr = (over: Partial<NdrSubmission> = {}): NdrSubmission => ({
  awb: '12345678901',
  partnerId: 'DP-DELHIVERY',
  reason: 'CUSTOMER_NOT_AVAILABLE',
  geo: AT_DOOR,
  atMs: NOW,
  riderId: 'RIDER-7',
  ...over,
});

const portal = (consignments: Consignment[] = [consignment()]) => {
  const p = new DeliveryPartnerPortal();
  for (const c of consignments) p.registerConsignment(c);
  return p;
};

// ============================================ haversine

describe('distance is computed with haversine, not a flat approximation', () => {
  it('measures a short hop accurately', () => {
    // 0.0009 degrees of latitude is about 100 m
    expect(haversineMetres(DELIVERY, AT_DOOR)).toBeGreaterThan(80);
    expect(haversineMetres(DELIVERY, AT_DOOR)).toBeLessThan(120);
  });

  it('measures a three-kilometre gap accurately', () => {
    const d = haversineMetres(DELIVERY, THREE_KM_AWAY);
    expect(d).toBeGreaterThan(2_900);
    expect(d).toBeLessThan(3_100);
  });

  it('is zero for the same point and symmetric', () => {
    expect(haversineMetres(DELIVERY, DELIVERY)).toBe(0);
    expect(haversineMetres(DELIVERY, THREE_KM_AWAY)).toBe(haversineMetres(THREE_KM_AWAY, DELIVERY));
  });

  it('accounts for latitude in longitude spacing, which a constant would get wrong', () => {
    // one degree of longitude near the equator is much wider than near the pole
    const equator = haversineMetres({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const north = haversineMetres({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 });
    expect(equator).toBeGreaterThan(110_000);
    expect(north).toBeLessThan(60_000);
  });
});

// ============================================ fake-attempt detection

describe('fake-attempt detection by geo-fence mismatch (RULES)', () => {
  it('does not flag a rider at the door', () => {
    expect(detectFakeAttempt(ndr(), consignment())).toBeNull();
  });

  it('FLAGS an attempt logged three kilometres from the address', () => {
    const flag = detectFakeAttempt(ndr({ geo: THREE_KM_AWAY }), consignment());
    expect(flag).not.toBeNull();
    // a reason logged far from the address describes a place the rider was, not a delivery
    // they attempted
    expect(flag!.distanceMetres).toBeGreaterThan(2_900);
    expect(flag!.fenceMetres).toBe(GEOFENCE_RADIUS_METRES);
    expect(flag!.riderId).toBe('RIDER-7');
  });

  it('flags to the scorecard AND to admin review, not merely to a log', () => {
    const flag = detectFakeAttempt(ndr({ geo: THREE_KM_AWAY }), consignment())!;
    expect(flag.flaggedToScorecard).toBe(true);
    expect(flag.flaggedForAdminReview).toBe(true);
  });

  it('the fence boundary behaves at its edge', () => {
    expect(GEOFENCE_RADIUS_METRES).toBe(300);
    // ~200 m: inside
    const inside = { latitude: 11.0186, longitude: 76.9558 };
    expect(detectFakeAttempt(ndr({ geo: inside }), consignment())).toBeNull();
    // ~450 m: outside
    const outside = { latitude: 11.0208, longitude: 76.9558 };
    expect(detectFakeAttempt(ndr({ geo: outside }), consignment())).not.toBeNull();
  });

  it('honours a configured fence over the default', () => {
    expect(detectFakeAttempt(ndr({ geo: THREE_KM_AWAY }), consignment(), 5_000)).toBeNull();
    expect(detectFakeAttempt(ndr({ geo: AT_DOOR }), consignment(), 50)).not.toBeNull();
  });

  it('cannot flag without a geo stamp, which is why the stamp is mandatory', () => {
    expect(detectFakeAttempt(ndr({ geo: undefined }), consignment())).toBeNull();
    expect(detectFakeAttempt(ndr({ atMs: undefined }), consignment())).toBeNull();
  });
});

// ============================================ NDR validation

describe('an NDR needs a reason, a geo stamp and a time stamp (VALIDATION)', () => {
  it('records a well-formed NDR with its attempt number and customer notification', () => {
    const p = portal();
    const r = p.recordNdr(ndr());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.attemptNumber).toBe(1);
    expect(r.record.reason).toBe('CUSTOMER_NOT_AVAILABLE');
    expect(r.record.customerNotification.kind).toBe('NDR_RAISED');
    expect(r.record.customerNotification.nextAction).toContain('delivery slot');
    expect(r.record.fakeAttemptFlag).toBeUndefined();
  });

  it('REFUSES an NDR with no geo stamp, because an unverifiable attempt is not evidence of one', () => {
    const p = portal();
    const r = p.recordNdr(ndr({ geo: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const v = r.violations.find((x) => x.code === 'NDR_GEO_STAMP_MANDATORY')!;
      expect(v.detail).toContain('unverifiable');
    }
  });

  it('refuses a missing time stamp, reason, or rider id', () => {
    const p = portal();
    expect(p.recordNdr(ndr({ atMs: undefined })).ok).toBe(false);
    expect(p.recordNdr(ndr({ reason: 'MADE_UP' as unknown as NdrReason })).ok).toBe(false);
    expect(p.recordNdr(ndr({ riderId: '  ' })).ok).toBe(false);
    expect(NDR_REASONS.size).toBe(5);
  });

  it('refuses an out-of-range coordinate rather than computing a nonsense distance', () => {
    const p = portal();
    const r = p.recordNdr(ndr({ geo: { latitude: 200, longitude: 500 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((x) => x.code === 'NDR_GEO_OUT_OF_RANGE')).toBe(true);
  });

  it('reports every violation at once rather than one per submission', () => {
    const p = portal();
    const r = p.recordNdr(ndr({ geo: undefined, atMs: undefined, riderId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('attaches the fake-attempt flag to the record when one fires', () => {
    const p = portal();
    const r = p.recordNdr(ndr({ geo: THREE_KM_AWAY }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.fakeAttemptFlag).toBeDefined();
    expect(p.fakeAttemptFlagsFor('DP-DELHIVERY')).toHaveLength(1);
  });

  it('increments the attempt number across successive NDRs', () => {
    const p = portal();
    p.recordNdr(ndr());
    const second = p.recordNdr(ndr({ reason: 'PREMISES_CLOSED' }));
    if (second.ok) expect(second.record.attemptNumber).toBe(2);
  });

  it('gives each reason its own customer next-action', () => {
    const p = portal([
      consignment({ awb: 'A1' }), consignment({ awb: 'A2' }),
      consignment({ awb: 'A3' }), consignment({ awb: 'A4' }), consignment({ awb: 'A5' }),
    ]);
    const actions = new Set<string>();
    const reasons: NdrReason[] = ['CUSTOMER_NOT_AVAILABLE', 'ADDRESS_ISSUE', 'REFUSED',
      'PAYMENT_NOT_READY', 'PREMISES_CLOSED'];
    reasons.forEach((reason, i) => {
      const r = p.recordNdr(ndr({ awb: `A${i + 1}`, reason }));
      if (r.ok) actions.add(r.record.customerNotification.nextAction);
    });
    // a generic "we will try again" tells the customer nothing they can act on
    expect(actions.size).toBe(5);
  });
});

// ============================================ partner scoping

describe('a partner sees and acts on only their own consignments (SECURITY)', () => {
  it('lists only their own', () => {
    const p = portal([
      consignment({ awb: 'MINE-1', partnerId: 'DP-A' }),
      consignment({ awb: 'MINE-2', partnerId: 'DP-A' }),
      consignment({ awb: 'THEIRS', partnerId: 'DP-B' }),
    ]);
    expect(p.consignmentsFor('DP-A').map((c) => c.awb)).toEqual(['MINE-1', 'MINE-2']);
    expect(JSON.stringify(p.consignmentsFor('DP-A'))).not.toContain('THEIRS');
  });

  it('refuses an NDR against ANOTHER partner consignment', () => {
    const p = portal([consignment({ awb: 'THEIRS', partnerId: 'DP-B' })]);
    const r = p.recordNdr(ndr({ awb: 'THEIRS', partnerId: 'DP-A' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0].code).toBe('CONSIGNMENT_NOT_FOUND_FOR_PARTNER');
  });

  it('refuses a POD upload against another partner consignment', () => {
    const p = portal([consignment({ awb: 'THEIRS', partnerId: 'DP-B' })]);
    const pod: PodFile = { awb: 'THEIRS', mediaRef: 'm://1', contentType: 'image/jpeg', bytes: 1_000 };
    expect(p.uploadPod(pod, 'DP-A').ok).toBe(false);
  });

  it('scopes NDRs and fake-attempt flags per partner', () => {
    const p = portal([
      consignment({ awb: 'A1', partnerId: 'DP-A' }),
      consignment({ awb: 'B1', partnerId: 'DP-B' }),
    ]);
    p.recordNdr(ndr({ awb: 'A1', partnerId: 'DP-A', geo: THREE_KM_AWAY }));
    p.recordNdr(ndr({ awb: 'B1', partnerId: 'DP-B' }));
    expect(p.ndrsFor('DP-A')).toHaveLength(1);
    expect(p.fakeAttemptFlagsFor('DP-A')).toHaveLength(1);
    expect(p.fakeAttemptFlagsFor('DP-B')).toHaveLength(0);
  });
});

// ============================================ bulk upload

describe('bulk upload errors are ROW-ITEMISED (ERRORS)', () => {
  it('accepts the good rows and itemises the bad ones by row number', () => {
    const p = portal([
      consignment({ awb: 'A1' }), consignment({ awb: 'A2' }), consignment({ awb: 'A3' }),
    ]);
    const result = p.bulkRecordNdr([
      ndr({ awb: 'A1' }),
      ndr({ awb: 'A2', geo: undefined }),          // bad
      ndr({ awb: 'A3' }),
      ndr({ awb: 'UNKNOWN' }),                     // bad
    ]);

    // a courier uploading 400 outcomes must not lose 390 valid ones over 10 malformed rows
    expect(result.totalRows).toBe(4);
    expect(result.accepted).toHaveLength(2);
    expect(result.rowErrors.map((e) => e.rowNumber)).toEqual([2, 4]);
    expect(result.rowErrors[0].awb).toBe('A2');
    expect(result.rowErrors[0].violations.some((v) => v.code === 'NDR_GEO_STAMP_MANDATORY')).toBe(true);
  });

  it('an all-good file has no row errors, and an all-bad file accepts nothing', () => {
    const p = portal([consignment({ awb: 'A1' }), consignment({ awb: 'A2' })]);
    expect(p.bulkRecordNdr([ndr({ awb: 'A1' }), ndr({ awb: 'A2' })]).rowErrors).toEqual([]);

    const p2 = portal();
    const bad = p2.bulkRecordNdr([ndr({ geo: undefined }), ndr({ atMs: undefined })]);
    expect(bad.accepted).toEqual([]);
    expect(bad.rowErrors).toHaveLength(2);
  });

  it('an empty file is not an error', () => {
    const r = portal().bulkRecordNdr([]);
    expect(r.totalRows).toBe(0);
    expect(r.accepted).toEqual([]);
    expect(r.rowErrors).toEqual([]);
  });
});

// ============================================ POD

describe('POD file validation (VALIDATION)', () => {
  const pod = (over: Partial<PodFile> = {}): PodFile => ({
    awb: '12345678901', mediaRef: 'm://pod-1', contentType: 'image/jpeg', bytes: 250_000, ...over,
  });

  it('accepts an allowed type within the size ceiling', () => {
    const p = portal();
    expect(p.uploadPod(pod(), 'DP-DELHIVERY').ok).toBe(true);
    expect(p.pod('12345678901')!.mediaRef).toBe('m://pod-1');
    expect(p.uploadPod(pod({ contentType: 'application/pdf' }), 'DP-DELHIVERY').ok).toBe(true);
  });

  it('refuses a disallowed type, an empty file and one over 5 MB', () => {
    const p = portal();
    const bad = p.uploadPod(pod({ contentType: 'video/mp4' }), 'DP-DELHIVERY');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.violations.some((v) => v.code === 'POD_TYPE_NOT_ALLOWED')).toBe(true);

    expect(p.uploadPod(pod({ bytes: 0 }), 'DP-DELHIVERY').ok).toBe(false);
    const big = p.uploadPod(pod({ bytes: POD_MAX_BYTES + 1 }), 'DP-DELHIVERY');
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.violations.some((v) => v.code === 'POD_EXCEEDS_5MB')).toBe(true);
    expect(p.uploadPod(pod({ bytes: POD_MAX_BYTES }), 'DP-DELHIVERY').ok).toBe(true);
  });
});

// ============================================ capacity notices

describe('capacity notices need 24 hours of lead time (VALIDATION)', () => {
  const notice = (over: Partial<CapacityNotice> = {}): CapacityNotice => ({
    partnerId: 'DP-DELHIVERY',
    zone: 'TN-CBE',
    effectiveFromMs: NOW + 48 * HOUR,
    capacityPerDay: 400,
    submittedAtMs: NOW,
    ...over,
  });

  it('accepts a notice with ample lead time', () => {
    const p = portal();
    expect(p.submitCapacityNotice(notice()).ok).toBe(true);
    expect(p.capacityNoticesFor('DP-DELHIVERY')).toHaveLength(1);
  });

  it('REFUSES a same-day notice, which is an apology rather than notice', () => {
    const p = portal();
    // a courier saying at 9 a.m. that they cannot collect today has not given notice — the orders
    // promised on that capacity are already late
    const r = p.submitCapacityNotice(notice({ effectiveFromMs: NOW + 4 * HOUR }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('CAPACITY_NOTICE_LEAD_TIME_BELOW_24H');
      expect(r.leadTimeMs).toBe(4 * HOUR);
    }
    expect(p.capacityNoticesFor('DP-DELHIVERY')).toEqual([]);
  });

  it('the boundary is exact', () => {
    const p = portal();
    expect(p.submitCapacityNotice(notice({ effectiveFromMs: NOW + CAPACITY_NOTICE_LEAD_TIME_MS })).ok)
      .toBe(true);
    expect(p.submitCapacityNotice(notice({ effectiveFromMs: NOW + CAPACITY_NOTICE_LEAD_TIME_MS - 1 })).ok)
      .toBe(false);
    expect(CAPACITY_NOTICE_LEAD_TIME_MS).toBe(24 * HOUR);
  });

  it('refuses a negative capacity', () => {
    expect(portal().submitCapacityNotice(notice({ capacityPerDay: -5 })).ok).toBe(false);
  });
});

// ============================================ scorecard

describe('the monthly scorecard (OUTPUTS)', () => {
  it('computes OTIF, first-attempt rate and NDR ratio', () => {
    const p = portal([consignment({ awb: 'A1' }), consignment({ awb: 'A2' })]);
    p.recordNdr(ndr({ awb: 'A1' }));
    p.recordNdr(ndr({ awb: 'A2' }));

    const s = p.scorecard('DP-DELHIVERY', '2026-08',
      { deliveries: 100, onTime: 92, firstAttempt: 78 });
    expect(s.otif).toBe(0.92);
    expect(s.firstAttemptRate).toBe(0.78);
    expect(s.ndrCount).toBe(2);
    expect(s.ndrRatio).toBe(0.02);
  });

  it('reports fake-attempt flags SEPARATELY rather than folding them into OTIF', () => {
    const p = portal([consignment({ awb: 'A1' }), consignment({ awb: 'A2' })]);
    p.recordNdr(ndr({ awb: 'A1', geo: THREE_KM_AWAY }));
    p.recordNdr(ndr({ awb: 'A2', geo: THREE_KM_AWAY }));

    const s = p.scorecard('DP-DELHIVERY', '2026-08', { deliveries: 100, onTime: 95, firstAttempt: 90 });
    // a partner with good OTIF and twelve fake attempts has a different problem from one who is
    // simply slow, and averaging them together hides both
    expect(s.otif).toBe(0.95);
    expect(s.fakeAttemptFlags).toBe(2);
  });

  it('does not divide by zero with no deliveries', () => {
    const s = portal().scorecard('DP-DELHIVERY', '2026-08', { deliveries: 0, onTime: 0, firstAttempt: 0 });
    expect(s.otif).toBe(0);
    expect(s.ndrRatio).toBe(0);
  });
});

// ============================================ allocation wiring

describe('CROSS-SLICE: the scorecard drives the REAL allocation score (RULES)', () => {
  const base = { courier: 'DP-DELHIVERY', costPaise: 6_000, transitDays: 3, supportsCod: true, maxWeightGrams: 25_000 };

  it('a better OTIF scores higher through the actual allocationScore', () => {
    const p = portal();
    const good = p.scorecard('DP-A', '2026-08', { deliveries: 100, onTime: 96, firstAttempt: 90 });
    const poor = p.scorecard('DP-B', '2026-08', { deliveries: 100, onTime: 70, firstAttempt: 60 });

    const goodQuote = quoteFromScorecard(base, good, 0.9);
    const poorQuote = quoteFromScorecard(base, poor, 0.9);

    expect(goodQuote.otif).toBe(0.96);
    expect(poorQuote.otif).toBe(0.70);
    expect(allocationScoreFor(goodQuote, 6_000)).toBeGreaterThan(allocationScoreFor(poorQuote, 6_000));
  });

  it('fake-attempt flags DEGRADE capability, not just OTIF', () => {
    const p = portal([consignment({ awb: 'A1' }), consignment({ awb: 'A2' })]);
    p.recordNdr(ndr({ awb: 'A1', geo: THREE_KM_AWAY }));
    p.recordNdr(ndr({ awb: 'A2', geo: THREE_KM_AWAY }));

    const flagged = p.scorecard('DP-DELHIVERY', '2026-08', { deliveries: 100, onTime: 96, firstAttempt: 90 });
    const clean = portal().scorecard('DP-CLEAN', '2026-08', { deliveries: 100, onTime: 96, firstAttempt: 90 });

    const flaggedQuote = quoteFromScorecard(base, flagged, 0.9);
    const cleanQuote = quoteFromScorecard(base, clean, 0.9);

    // identical OTIF, but a partner who fabricates attempts is not merely slower — they are less
    // capable of doing the job, and their nominal OTIF understates that
    expect(flaggedQuote.otif).toBe(cleanQuote.otif);
    expect(flaggedQuote.capability).toBeLessThan(cleanQuote.capability);
    expect(flaggedQuote.capability).toBeCloseTo(0.9 - 2 * FAKE_ATTEMPT_CAPABILITY_PENALTY, 4);
    expect(allocationScoreFor(flaggedQuote, 6_000)).toBeLessThan(allocationScoreFor(cleanQuote, 6_000));
  });

  it('the capability penalty cannot drive the score negative', () => {
    const p = new DeliveryPartnerPortal();
    for (let i = 0; i < 50; i++) {
      p.registerConsignment(consignment({ awb: `A${i}` }));
      p.recordNdr(ndr({ awb: `A${i}`, geo: THREE_KM_AWAY }));
    }
    const s = p.scorecard('DP-DELHIVERY', '2026-08', { deliveries: 100, onTime: 96, firstAttempt: 90 });
    expect(s.fakeAttemptFlags).toBe(50);
    const quote = quoteFromScorecard(base, s, 0.9);
    expect(quote.capability).toBe(0);
    expect(allocationScoreFor(quote, 6_000)).toBeGreaterThan(0);
  });

  it('uses the platform default weights unless told otherwise', () => {
    const s = portal().scorecard('DP-A', '2026-08', { deliveries: 100, onTime: 90, firstAttempt: 80 });
    const quote = quoteFromScorecard(base, s, 1);
    // cost 0.5 * 1 + sla 0.3 * 0.9 + capability 0.2 * 1 = 0.97
    expect(allocationScoreFor(quote, 6_000)).toBeCloseTo(0.97, 4);
    expect(allocationScoreFor(quote, 6_000, DEFAULT_WEIGHTS)).toBeCloseTo(0.97, 4);
  });
});
