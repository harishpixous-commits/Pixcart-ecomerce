/**
 * Pickup management and manifest/handover — FR-LOG-002 and FR-LOG-003.
 *
 * Normative source (Documentation Suite v1.0):
 *
 *   FR-LOG-002 DESC:       "book courier pickups against vendor/warehouse locations, aggregate
 *                           shipments into pickup requests, track pickup states
 *                           (Scheduled→Attempted→Completed/Failed) and auto-reschedule failures."
 *   FR-LOG-002 VALIDATION: "Slot within location hours; shipment must have label; cut-off times
 *                           per courier respected."
 *   FR-LOG-002 RULES:      "Same-day cut-off default 14:00; two consecutive failed pickups
 *                           escalate to A ops queue and courier scorecard."
 *
 *   FR-LOG-003 DESC:       "generate courier-wise manifests (barcoded), capture handover
 *                           confirmation (courier rider OTP/signature or scan), and reconcile
 *                           handed-over vs manifested shipments, flagging discrepancies."
 *   FR-LOG-003 VALIDATION: "Only labelled, pickup-booked shipments manifestable; duplicate scan
 *                           idempotent."
 *   FR-LOG-003 RULES:      "Shipment enters carrier liability at handover scan — settlement risk
 *                           flag flips (FR-FIN-004); discrepancy > 0 blocks manifest closure
 *                           until resolved or exception-noted."
 *   FR-LOG-003 ERRORS:     "Scanner offline → manual OTP handover fallback with photo."
 *   FR-LOG-003 SECURITY:   "Handover evidence retained 180 days; manifest tamper-proof numbering."
 *
 * Pure and deterministic. The property this module exists to guarantee is that liability never
 * transfers silently: a shipment moves PACKED → SHIPPED, and its settlement risk flips to the
 * carrier, ONLY on a recorded handover event carrying evidence. A manifest with unscanned lines
 * cannot be closed and quietly forgotten — closure is refused until each discrepancy is either
 * resolved by a late scan or explicitly exception-noted by a named operator.
 */

/** Minutes from local midnight, e.g. 14:00 → 840. */
export type LocalMinute = number;

export const SAME_DAY_CUTOFF_MINUTE: LocalMinute = 14 * 60;   // RULES: default 14:00
export const CONSECUTIVE_FAILURES_TO_ESCALATE = 2;
export const HANDOVER_EVIDENCE_RETENTION_DAYS = 180;

export type PickupState = 'SCHEDULED' | 'ATTEMPTED' | 'COMPLETED' | 'FAILED';

export interface LocationHours {
  openMinute: LocalMinute;
  closeMinute: LocalMinute;
}

export interface Shipment {
  awb: string;
  subOrderId: string;
  /** VALIDATION: a shipment must carry a label before it can be picked up or manifested. */
  labelled: boolean;
  weightGrams: number;
}

export interface PickupSlot {
  /** Slot start, minutes from local midnight. */
  startMinute: LocalMinute;
  endMinute: LocalMinute;
  /** Calendar day the slot belongs to, as an epoch-day number. */
  epochDay: number;
}

export type BookResult =
  | { ok: true; request: PickupRequest }
  | { ok: false; violations: string[] };

export interface Escalation {
  reason: string;
  courier: string;
  locationId: string;
  consecutiveFailures: number;
}

/** One pickup request aggregating shipments for a courier at a location. */
export class PickupRequest {
  private state: PickupState = 'SCHEDULED';
  private failureReasons: string[] = [];
  private rescheduledTo: PickupSlot | null = null;

  private constructor(
    readonly requestId: string,
    readonly courier: string,
    readonly locationId: string,
    readonly slot: PickupSlot,
    readonly shipments: Shipment[],
  ) {}

  /**
   * Book a pickup. Every validation runs before the request exists, so a rejected booking
   * leaves no half-formed pickup for the courier to attempt.
   */
  static book(
    requestId: string,
    courier: string,
    locationId: string,
    slot: PickupSlot,
    shipments: Shipment[],
    hours: LocationHours,
    courierCutoffMinute: LocalMinute,
    bookedAtMinute: LocalMinute,
    bookedOnEpochDay: number,
  ): BookResult {
    const violations: string[] = [];

    if (shipments.length === 0) violations.push('NO_SHIPMENTS');
    const unlabelled = shipments.filter((s) => !s.labelled).map((s) => s.awb);
    if (unlabelled.length > 0) violations.push(`SHIPMENT_NOT_LABELLED: ${unlabelled.join(',')}`);

    if (slot.endMinute <= slot.startMinute) violations.push('SLOT_INVERTED');
    if (slot.startMinute < hours.openMinute || slot.endMinute > hours.closeMinute) {
      violations.push(`SLOT_OUTSIDE_LOCATION_HOURS: slot ${slot.startMinute}-${slot.endMinute}, `
        + `location ${hours.openMinute}-${hours.closeMinute}`);
    }

    // RULES/VALIDATION: a same-day pickup must be booked before the courier's cut-off.
    if (slot.epochDay === bookedOnEpochDay && bookedAtMinute > courierCutoffMinute) {
      violations.push(`SAME_DAY_CUTOFF_PASSED: booked at ${bookedAtMinute}, cut-off ${courierCutoffMinute}`);
    }
    if (slot.epochDay < bookedOnEpochDay) violations.push('SLOT_IN_THE_PAST');

    if (violations.length > 0) return { ok: false, violations };
    return { ok: true, request: new PickupRequest(requestId, courier, locationId, slot, shipments) };
  }

  attempt(): PickupState {
    if (this.state === 'SCHEDULED') this.state = 'ATTEMPTED';
    return this.state;
  }

  complete(): { ok: true } | { ok: false; reason: string } {
    if (this.state !== 'SCHEDULED' && this.state !== 'ATTEMPTED') {
      return { ok: false, reason: `CANNOT_COMPLETE_FROM_${this.state}` };
    }
    this.state = 'COMPLETED';
    return { ok: true };
  }

  /**
   * Record a failure and auto-book the next slot (ERRORS: "courier no-show webhook/EOD sweep
   * marks Failed with auto next-slot booking").
   */
  fail(reason: string, nextSlot: PickupSlot): { state: PickupState; rescheduledTo: PickupSlot } {
    this.state = 'FAILED';
    this.failureReasons.push(reason);
    this.rescheduledTo = nextSlot;
    return { state: this.state, rescheduledTo: nextSlot };
  }

  currentState(): PickupState { return this.state; }
  reschedule(): PickupSlot | null { return this.rescheduledTo; }
  failures(): string[] { return [...this.failureReasons]; }
  awbs(): string[] { return this.shipments.map((s) => s.awb); }
}

/**
 * Tracks consecutive pickup failures per (courier, location) so the escalation rule can fire.
 * RULES: two consecutive failures escalate to the ops queue and dent the courier scorecard.
 */
export class PickupFailureTracker {
  private readonly counts = new Map<string, number>();

  private key(courier: string, locationId: string): string {
    return `${courier}|${locationId}`;
  }

  recordFailure(courier: string, locationId: string): Escalation | null {
    const k = this.key(courier, locationId);
    const n = (this.counts.get(k) ?? 0) + 1;
    this.counts.set(k, n);
    if (n >= CONSECUTIVE_FAILURES_TO_ESCALATE) {
      return {
        reason: 'CONSECUTIVE_PICKUP_FAILURES',
        courier,
        locationId,
        consecutiveFailures: n,
      };
    }
    return null;
  }

  /** A successful pickup clears the streak — the rule is about CONSECUTIVE failures. */
  recordSuccess(courier: string, locationId: string): void {
    this.counts.delete(this.key(courier, locationId));
  }

  consecutiveFailures(courier: string, locationId: string): number {
    return this.counts.get(this.key(courier, locationId)) ?? 0;
  }
}

// ============================================================ manifest

export type HandoverMethod = 'RIDER_SCAN' | 'RIDER_OTP' | 'SIGNATURE';

export interface HandoverEvidence {
  awb: string;
  method: HandoverMethod;
  riderIdentityToken: string;
  /** Required when the scanner is offline and the OTP fallback is used. */
  photoRef?: string;
  atMs: number;
}

export interface Discrepancy {
  awb: string;
  reason: 'MANIFESTED_NOT_SCANNED';
}

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; violations: string[] };

export type CloseResult =
  | { ok: true; shipped: string[]; discrepancies: Discrepancy[] }
  | { ok: false; reason: string; discrepancies: Discrepancy[] };

/** A courier-wise manifest with tamper-proof numbering. */
export class Manifest {
  private readonly scanned = new Map<string, HandoverEvidence>();
  private closed = false;
  private exceptionNote: string | null = null;
  private exceptionBy: string | null = null;

  private constructor(
    readonly manifestNumber: string,
    readonly courier: string,
    readonly locationId: string,
    readonly shipments: Shipment[],
    readonly createdAtMs: number,
    readonly checksum: string,
  ) {}

  /**
   * Create a manifest. VALIDATION: only labelled, pickup-booked shipments are manifestable —
   * the set of booked AWBs is supplied by the pickup layer, and anything outside it is refused
   * with the offending AWBs named.
   */
  static create(
    manifestNumber: string,
    courier: string,
    locationId: string,
    shipments: Shipment[],
    pickupBookedAwbs: Set<string>,
    createdAtMs: number,
  ): ManifestResult {
    const violations: string[] = [];
    if (shipments.length === 0) violations.push('NO_SHIPMENTS');

    const unlabelled = shipments.filter((s) => !s.labelled).map((s) => s.awb);
    if (unlabelled.length > 0) violations.push(`SHIPMENT_NOT_LABELLED: ${unlabelled.join(',')}`);

    const notBooked = shipments.filter((s) => !pickupBookedAwbs.has(s.awb)).map((s) => s.awb);
    if (notBooked.length > 0) violations.push(`SHIPMENT_HAS_NO_PICKUP_BOOKING: ${notBooked.join(',')}`);

    const seen = new Set<string>();
    for (const s of shipments) {
      if (seen.has(s.awb)) violations.push(`DUPLICATE_AWB_ON_MANIFEST: ${s.awb}`);
      seen.add(s.awb);
    }

    if (violations.length > 0) return { ok: false, violations };

    const checksum = manifestChecksum(manifestNumber, courier, shipments, createdAtMs);
    return {
      ok: true,
      manifest: new Manifest(manifestNumber, courier, locationId, shipments, createdAtMs, checksum),
    };
  }

  /**
   * Record a handover. VALIDATION: a duplicate scan is idempotent — the first evidence stands
   * and a repeat neither errors nor overwrites it, because riders re-scan routinely.
   */
  scan(evidence: HandoverEvidence): { ok: true; duplicate: boolean } | { ok: false; reason: string } {
    if (this.closed) return { ok: false, reason: 'MANIFEST_ALREADY_CLOSED' };
    if (!this.shipments.some((s) => s.awb === evidence.awb)) {
      return { ok: false, reason: `AWB_NOT_ON_MANIFEST: ${evidence.awb}` };
    }
    if (!evidence.riderIdentityToken || evidence.riderIdentityToken.trim().length === 0) {
      return { ok: false, reason: 'RIDER_IDENTITY_REQUIRED' };
    }
    // ERRORS: the OTP fallback exists for an offline scanner, and it requires a photo.
    if (evidence.method === 'RIDER_OTP' && !evidence.photoRef) {
      return { ok: false, reason: 'OTP_FALLBACK_REQUIRES_PHOTO' };
    }
    if (this.scanned.has(evidence.awb)) return { ok: true, duplicate: true };
    this.scanned.set(evidence.awb, evidence);
    return { ok: true, duplicate: false };
  }

  /** Reconcile handed-over against manifested (FR-LOG-003 DESC). */
  discrepancies(): Discrepancy[] {
    return this.shipments
      .filter((s) => !this.scanned.has(s.awb))
      .map((s) => ({ awb: s.awb, reason: 'MANIFESTED_NOT_SCANNED' as const }));
  }

  /**
   * Close the manifest. RULES: a discrepancy blocks closure until it is resolved by a late scan
   * or explicitly exception-noted by a named operator. On successful closure the scanned
   * shipments move PACKED → SHIPPED and carrier liability transfers.
   */
  close(operatorId: string, exceptionNote?: string): CloseResult {
    const d = this.discrepancies();
    if (this.closed) return { ok: false, reason: 'ALREADY_CLOSED', discrepancies: d };
    if (d.length > 0) {
      if (!exceptionNote || exceptionNote.trim().length < 10) {
        return {
          ok: false,
          reason: `DISCREPANCY_BLOCKS_CLOSURE: ${d.length} manifested shipment(s) not scanned`,
          discrepancies: d,
        };
      }
      if (!operatorId || operatorId.trim().length === 0) {
        return { ok: false, reason: 'EXCEPTION_NOTE_REQUIRES_NAMED_OPERATOR', discrepancies: d };
      }
      this.exceptionNote = exceptionNote;
      this.exceptionBy = operatorId;
    }
    this.closed = true;
    return { ok: true, shipped: [...this.scanned.keys()], discrepancies: d };
  }

  /**
   * RULES: a shipment enters carrier liability at the handover scan, which is what flips the
   * settlement risk flag consumed by FR-FIN-004. Liability is a function of evidence, never of
   * the manifest merely existing.
   */
  isUnderCarrierLiability(awb: string): boolean {
    return this.scanned.has(awb);
  }

  /** The canonical status this shipment should now report (matches tracking.ts vocabulary). */
  canonicalStatusFor(awb: string): 'SHIPPED' | 'PACKED' {
    return this.scanned.has(awb) ? 'SHIPPED' : 'PACKED';
  }

  evidenceFor(awb: string): HandoverEvidence | undefined {
    return this.scanned.get(awb);
  }

  /** SECURITY: handover evidence is retained for 180 days. */
  isEvidenceRetained(awb: string, nowMs: number): boolean {
    const e = this.scanned.get(awb);
    if (!e) return false;
    return nowMs - e.atMs <= HANDOVER_EVIDENCE_RETENTION_DAYS * 24 * 3600 * 1000;
  }

  isClosed(): boolean { return this.closed; }
  scannedCount(): number { return this.scanned.size; }
  manifestedCount(): number { return this.shipments.length; }
  closureException(): { note: string; by: string } | null {
    return this.exceptionNote ? { note: this.exceptionNote, by: this.exceptionBy! } : null;
  }
}

/** SECURITY: tamper-proof numbering — a content checksum over the manifest's identity and lines. */
export function manifestChecksum(
  manifestNumber: string,
  courier: string,
  shipments: Shipment[],
  createdAtMs: number,
): string {
  const canonical = [
    manifestNumber,
    courier,
    String(createdAtMs),
    ...shipments.map((s) => `${s.awb}:${s.subOrderId}:${s.weightGrams}`).sort(),
  ].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
