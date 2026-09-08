/**
 * Delivery partner portal — FR-LOG-007.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "provide courier-partner users a portal for pickup schedules, manifest views, NDR
 *                workbench (attempt outcomes with reason + evidence), POD uploads, weight-dispute
 *                responses and a performance scorecard."
 *   INPUTS:     "NDR outcomes (customer-not-available, address-issue, refused…), POD files,
 *                dispute responses, capacity notices."
 *   OUTPUTS:    "Actionable queues, NDR resolution loop with customer (via FR-LOG-004
 *                notifications), scorecard (OTIF, first-attempt, NDR ratio) with monthly
 *                statements."
 *   VALIDATION: "NDR reason mandatory with geo/time stamp; POD file type/size; capacity notices
 *                lead-time ≥ 24 h."
 *   RULES:      "Fake-attempt detection (geo-fence mismatch) flags to scorecard and A review;
 *                scorecard drives allocation weights (FR-LOG-001)."
 *   ERRORS:     "Bulk upload errors row-itemised; portal offline → API parity ensures no data
 *                loss."
 *   SECURITY:   "Partner users see only [their own consignments]."
 *
 * THE FAKE-ATTEMPT CHECK IS THE PART THAT MATTERS MOST, and it is the reason the requirement
 * insists an NDR carry a geo stamp rather than just a reason. A rider marking
 * "customer not available" from three kilometres away did not attempt the delivery — and that
 * single false NDR costs the customer their parcel, the vendor an RTO, and the platform a support
 * ticket, while the rider's own scorecard looks unaffected. So the geo stamp is MANDATORY (an NDR
 * without one cannot be recorded at all, because an unverifiable attempt is not evidence of one),
 * the distance is computed properly with haversine rather than a flat approximation, and a
 * mismatch flags to both the scorecard and an admin review rather than only to a dashboard nobody
 * reads.
 *
 * The scorecard's OTIF feeds CourierQuote.otif, which the FR-LOG-002 allocation engine already
 * weights by its sla term — so "scorecard drives allocation weights" is a real wiring rather than
 * a restated intention, and the tests drive the actual allocationScore to prove it.
 */
import { allocationScore, DEFAULT_WEIGHTS, type AllocationWeights, type CourierQuote }
  from './serviceability.js';

/** RULES: an attempt must be logged within this distance of the delivery address. */
export const GEOFENCE_RADIUS_METRES = 300;
/** VALIDATION: a capacity notice needs at least this much lead time. */
export const CAPACITY_NOTICE_LEAD_TIME_MS = 24 * 3_600_000;
/** VALIDATION: POD file ceiling. */
export const POD_MAX_BYTES = 5 * 1024 * 1024;
export const POD_ALLOWED_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export type NdrReason =
  | 'CUSTOMER_NOT_AVAILABLE'
  | 'ADDRESS_ISSUE'
  | 'REFUSED'
  | 'PAYMENT_NOT_READY'
  | 'PREMISES_CLOSED';

export const NDR_REASONS: ReadonlySet<NdrReason> = new Set<NdrReason>([
  'CUSTOMER_NOT_AVAILABLE', 'ADDRESS_ISSUE', 'REFUSED', 'PAYMENT_NOT_READY', 'PREMISES_CLOSED',
]);

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Consignment {
  awb: string;
  partnerId: string;
  deliveryGeo: GeoPoint;
  attemptCount: number;
}

export interface NdrSubmission {
  awb: string;
  partnerId: string;
  reason: NdrReason;
  /** VALIDATION: mandatory — an attempt with no location is not verifiable. */
  geo?: GeoPoint;
  atMs?: number;
  riderId: string;
  evidenceRef?: string;
}

export interface Violation {
  code: string;
  detail: string;
}

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a flat-earth approximation: at Indian latitudes a degree of longitude is
 * roughly 109 km at the equator and 96 km at Kashmir, so a naive degrees-to-metres constant
 * mis-measures by enough to matter against a 300 m fence.
 */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

export interface FakeAttemptFlag {
  awb: string;
  riderId: string;
  distanceMetres: number;
  fenceMetres: number;
  /** RULES: flagged to the scorecard AND to admin review, not merely logged. */
  flaggedToScorecard: true;
  flaggedForAdminReview: true;
  atMs: number;
}

/**
 * RULES: fake-attempt detection. A reason logged far from the delivery address describes a place
 * the rider was, not a delivery they attempted.
 */
export function detectFakeAttempt(submission: NdrSubmission, consignment: Consignment,
                                  fenceMetres = GEOFENCE_RADIUS_METRES): FakeAttemptFlag | null {
  if (!submission.geo || submission.atMs === undefined) return null;
  const distance = haversineMetres(submission.geo, consignment.deliveryGeo);
  if (distance <= fenceMetres) return null;
  return {
    awb: submission.awb,
    riderId: submission.riderId,
    distanceMetres: distance,
    fenceMetres,
    flaggedToScorecard: true,
    flaggedForAdminReview: true,
    atMs: submission.atMs,
  };
}

export interface NdrRecord {
  awb: string;
  partnerId: string;
  reason: NdrReason;
  geo: GeoPoint;
  atMs: number;
  riderId: string;
  attemptNumber: number;
  evidenceRef?: string;
  fakeAttemptFlag?: FakeAttemptFlag;
  /** OUTPUTS: the customer notification this NDR owes, via FR-LOG-004. */
  customerNotification: { kind: 'NDR_RAISED'; reason: NdrReason; nextAction: string };
}

export type NdrResult =
  | { ok: true; record: NdrRecord }
  | { ok: false; violations: Violation[] };

/** What the customer is told to do next, which differs by reason. */
function nextActionFor(reason: NdrReason): string {
  switch (reason) {
    case 'CUSTOMER_NOT_AVAILABLE': return 'Confirm a delivery slot for the next attempt';
    case 'ADDRESS_ISSUE': return 'Correct or confirm your delivery address';
    case 'REFUSED': return 'Tell us whether to reattempt or return this parcel';
    case 'PAYMENT_NOT_READY': return 'Have the exact COD amount ready, or switch to prepaid';
    case 'PREMISES_CLOSED': return 'Confirm a time when someone can receive the parcel';
  }
}

// ================================================= the portal

export interface Scorecard {
  partnerId: string;
  monthLabel: string;
  deliveries: number;
  onTimeDeliveries: number;
  firstAttemptDeliveries: number;
  ndrCount: number;
  fakeAttemptFlags: number;
  /** OUTPUTS: 0..1, the rolling figure the allocation engine consumes. */
  otif: number;
  firstAttemptRate: number;
  ndrRatio: number;
}

export interface CapacityNotice {
  partnerId: string;
  zone: string;
  effectiveFromMs: number;
  capacityPerDay: number;
  submittedAtMs: number;
}

export type CapacityResult =
  | { ok: true; notice: CapacityNotice }
  | { ok: false; reason: string; leadTimeMs: number };

export interface PodFile {
  awb: string;
  mediaRef: string;
  contentType: string;
  bytes: number;
}

export interface BulkRowError {
  rowNumber: number;
  awb: string;
  violations: Violation[];
}

export interface BulkResult {
  accepted: NdrRecord[];
  /** ERRORS: row-itemised, so one bad row does not reject the file. */
  rowErrors: BulkRowError[];
  totalRows: number;
}

export class DeliveryPartnerPortal {
  private readonly consignments = new Map<string, Consignment>();
  private readonly ndrs: NdrRecord[] = [];
  private readonly pods = new Map<string, PodFile>();
  private readonly capacityNotices: CapacityNotice[] = [];
  private readonly fakeFlags: FakeAttemptFlag[] = [];

  registerConsignment(c: Consignment): void {
    this.consignments.set(c.awb, c);
  }

  /** SECURITY: partner users see only their own consignments. Filtered here, not in a UI. */
  consignmentsFor(partnerId: string): Consignment[] {
    return [...this.consignments.values()]
      .filter((c) => c.partnerId === partnerId)
      .sort((a, b) => a.awb.localeCompare(b.awb));
  }

  /** SECURITY: a partner may act only on their own consignment. */
  private ownedBy(awb: string, partnerId: string): Consignment | undefined {
    const c = this.consignments.get(awb);
    return c && c.partnerId === partnerId ? c : undefined;
  }

  /**
   * Record an NDR.
   *
   * VALIDATION: reason, geo and time stamp are all mandatory. An NDR without a location cannot be
   * checked against the delivery address, which makes the fake-attempt rule unenforceable — so an
   * unverifiable attempt is refused rather than accepted and quietly trusted.
   */
  recordNdr(submission: NdrSubmission): NdrResult {
    const violations: Violation[] = [];

    const consignment = this.ownedBy(submission.awb, submission.partnerId);
    if (!consignment) {
      return {
        ok: false,
        violations: [{ code: 'CONSIGNMENT_NOT_FOUND_FOR_PARTNER', detail: submission.awb }],
      };
    }
    if (!submission.reason || !NDR_REASONS.has(submission.reason)) {
      violations.push({ code: 'NDR_REASON_MANDATORY', detail: String(submission.reason) });
    }
    if (!submission.geo) {
      violations.push({ code: 'NDR_GEO_STAMP_MANDATORY', detail: 'an unverifiable attempt is not evidence of one' });
    } else if (Math.abs(submission.geo.latitude) > 90 || Math.abs(submission.geo.longitude) > 180) {
      violations.push({ code: 'NDR_GEO_OUT_OF_RANGE', detail: JSON.stringify(submission.geo) });
    }
    if (submission.atMs === undefined) {
      violations.push({ code: 'NDR_TIME_STAMP_MANDATORY', detail: '' });
    }
    if (!submission.riderId || submission.riderId.trim().length === 0) {
      violations.push({ code: 'RIDER_ID_MANDATORY', detail: '' });
    }
    if (violations.length > 0) return { ok: false, violations };

    const flag = detectFakeAttempt(submission, consignment);
    if (flag) this.fakeFlags.push(flag);

    consignment.attemptCount++;
    const record: NdrRecord = {
      awb: submission.awb,
      partnerId: submission.partnerId,
      reason: submission.reason,
      geo: submission.geo!,
      atMs: submission.atMs!,
      riderId: submission.riderId,
      attemptNumber: consignment.attemptCount,
      evidenceRef: submission.evidenceRef,
      fakeAttemptFlag: flag ?? undefined,
      customerNotification: {
        kind: 'NDR_RAISED',
        reason: submission.reason,
        nextAction: nextActionFor(submission.reason),
      },
    };
    this.ndrs.push(record);
    return { ok: true, record };
  }

  /**
   * ERRORS: bulk NDR upload with ROW-ITEMISED errors. A courier uploading four hundred outcomes at
   * end of shift must not lose the three hundred and ninety valid ones because ten rows were
   * malformed.
   */
  bulkRecordNdr(submissions: NdrSubmission[]): BulkResult {
    const accepted: NdrRecord[] = [];
    const rowErrors: BulkRowError[] = [];
    submissions.forEach((s, i) => {
      const r = this.recordNdr(s);
      if (r.ok) accepted.push(r.record);
      else rowErrors.push({ rowNumber: i + 1, awb: s.awb, violations: r.violations });
    });
    return { accepted, rowErrors, totalRows: submissions.length };
  }

  /** VALIDATION: POD file type and size. */
  uploadPod(pod: PodFile, partnerId: string): { ok: true } | { ok: false; violations: Violation[] } {
    const violations: Violation[] = [];
    if (!this.ownedBy(pod.awb, partnerId)) {
      return { ok: false, violations: [{ code: 'CONSIGNMENT_NOT_FOUND_FOR_PARTNER', detail: pod.awb }] };
    }
    if (!POD_ALLOWED_TYPES.has(pod.contentType)) {
      violations.push({ code: 'POD_TYPE_NOT_ALLOWED', detail: pod.contentType });
    }
    if (pod.bytes <= 0) violations.push({ code: 'POD_EMPTY', detail: '' });
    if (pod.bytes > POD_MAX_BYTES) {
      violations.push({ code: 'POD_EXCEEDS_5MB', detail: `${pod.bytes} bytes` });
    }
    if (violations.length > 0) return { ok: false, violations };
    this.pods.set(pod.awb, pod);
    return { ok: true };
  }

  pod(awb: string): PodFile | undefined {
    return this.pods.get(awb);
  }

  /**
   * VALIDATION: a capacity notice needs 24 hours' lead time. A courier telling the platform at
   * 9 a.m. that they cannot collect today has not given notice, they have given an apology — and
   * the orders already promised on that capacity are already late.
   */
  submitCapacityNotice(notice: CapacityNotice): CapacityResult {
    const leadTimeMs = notice.effectiveFromMs - notice.submittedAtMs;
    if (leadTimeMs < CAPACITY_NOTICE_LEAD_TIME_MS) {
      return { ok: false, reason: 'CAPACITY_NOTICE_LEAD_TIME_BELOW_24H', leadTimeMs };
    }
    if (notice.capacityPerDay < 0) {
      return { ok: false, reason: 'CAPACITY_CANNOT_BE_NEGATIVE', leadTimeMs };
    }
    this.capacityNotices.push(notice);
    return { ok: true, notice };
  }

  capacityNoticesFor(partnerId: string): CapacityNotice[] {
    return this.capacityNotices.filter((n) => n.partnerId === partnerId);
  }

  ndrsFor(partnerId: string): NdrRecord[] {
    return this.ndrs.filter((n) => n.partnerId === partnerId);
  }

  fakeAttemptFlagsFor(partnerId: string): FakeAttemptFlag[] {
    const mine = new Set(this.consignmentsFor(partnerId).map((c) => c.awb));
    return this.fakeFlags.filter((f) => mine.has(f.awb));
  }

  /**
   * OUTPUTS: the monthly scorecard. Note the fake-attempt flags are reported alongside OTIF rather
   * than folded into it — a partner with good OTIF and twelve fake attempts has a different
   * problem from one who is simply slow, and averaging them together hides both.
   */
  scorecard(partnerId: string, monthLabel: string,
            outcomes: { deliveries: number; onTime: number; firstAttempt: number }): Scorecard {
    const ndrCount = this.ndrsFor(partnerId).length;
    const deliveries = Math.max(0, outcomes.deliveries);
    const rate = (n: number) => (deliveries === 0 ? 0 : Math.round((n / deliveries) * 10_000) / 10_000);
    return {
      partnerId,
      monthLabel,
      deliveries,
      onTimeDeliveries: outcomes.onTime,
      firstAttemptDeliveries: outcomes.firstAttempt,
      ndrCount,
      fakeAttemptFlags: this.fakeAttemptFlagsFor(partnerId).length,
      otif: rate(outcomes.onTime),
      firstAttemptRate: rate(outcomes.firstAttempt),
      ndrRatio: rate(ndrCount),
    };
  }
}

// ================================================= allocation wiring

/**
 * RULES: the scorecard drives allocation.
 *
 * The scorecard's OTIF becomes CourierQuote.otif, which the FR-LOG-002 allocation engine already
 * weights by its sla term. A fake-attempt flag additionally DEGRADES the capability score, because
 * a partner who fabricates attempts is not merely slower — they are less capable of doing the job
 * at all, and their nominal OTIF understates that.
 */
export const FAKE_ATTEMPT_CAPABILITY_PENALTY = 0.05;

export function quoteFromScorecard(base: Omit<CourierQuote, 'otif' | 'capability'>,
                                   scorecard: Scorecard,
                                   baseCapability: number): CourierQuote {
  const penalty = Math.min(baseCapability, scorecard.fakeAttemptFlags * FAKE_ATTEMPT_CAPABILITY_PENALTY);
  return {
    ...base,
    otif: scorecard.otif,
    capability: Math.max(0, Math.round((baseCapability - penalty) * 10_000) / 10_000),
  };
}

/** Convenience: score a partner through the real allocation function. */
export function allocationScoreFor(quote: CourierQuote, minCostPaise: number,
                                   weights: AllocationWeights = DEFAULT_WEIGHTS): number {
  return Math.round(allocationScore(quote, minCostPaise, weights) * 10_000) / 10_000;
}
