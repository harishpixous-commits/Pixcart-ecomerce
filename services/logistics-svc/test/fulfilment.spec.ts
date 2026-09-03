/**
 * FR-LOG-002 pickup management and FR-LOG-003 manifest/handover as tests, with the documented
 * acceptance scenario — 10 manifested shipments and 9 scans — encoded verbatim.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSECUTIVE_FAILURES_TO_ESCALATE,
  HANDOVER_EVIDENCE_RETENTION_DAYS,
  Manifest,
  manifestChecksum,
  PickupFailureTracker,
  PickupRequest,
  SAME_DAY_CUTOFF_MINUTE,
  type HandoverEvidence,
  type LocationHours,
  type PickupSlot,
  type Shipment,
} from '../src/domain/fulfilment.js';

const HOURS: LocationHours = { openMinute: 9 * 60, closeMinute: 20 * 60 };   // 09:00–20:00
const TODAY = 20_680;                                                        // arbitrary epoch-day
const T0 = Date.UTC(2026, 7, 20, 6, 0, 0);
const DAY_MS = 24 * 3600 * 1000;

const shipment = (n: number, over: Partial<Shipment> = {}): Shipment => ({
  awb: `AWB${String(n).padStart(3, '0')}`,
  subOrderId: `SUB-${n}`,
  labelled: true,
  weightGrams: 800,
  ...over,
});

const slot = (over: Partial<PickupSlot> = {}): PickupSlot =>
  ({ startMinute: 15 * 60, endMinute: 17 * 60, epochDay: TODAY, ...over });

const bookOk = (r: ReturnType<typeof PickupRequest.book>) => {
  if (!r.ok) throw new Error('expected booking to succeed: ' + r.violations.join(', '));
  return r.request;
};

// ==================================================== FR-LOG-002

describe('pickup booking validation', () => {
  it('books a valid same-day pickup before the cut-off', () => {
    const r = PickupRequest.book('PU-1', 'DELHIVERY', 'LOC-1', slot(), [shipment(1), shipment(2)],
      HOURS, SAME_DAY_CUTOFF_MINUTE, 13 * 60, TODAY);
    const req = bookOk(r);
    expect(req.currentState()).toBe('SCHEDULED');
    expect(req.awbs()).toEqual(['AWB001', 'AWB002']);
  });

  it('refuses a same-day booking after the 14:00 cut-off', () => {
    const r = PickupRequest.book('PU-1', 'DELHIVERY', 'LOC-1', slot(), [shipment(1)],
      HOURS, SAME_DAY_CUTOFF_MINUTE, 14 * 60 + 1, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.startsWith('SAME_DAY_CUTOFF_PASSED'))).toBe(true);
  });

  it('allows a next-day slot booked after the cut-off', () => {
    const r = PickupRequest.book('PU-1', 'DELHIVERY', 'LOC-1', slot({ epochDay: TODAY + 1 }), [shipment(1)],
      HOURS, SAME_DAY_CUTOFF_MINUTE, 18 * 60, TODAY);
    expect(r.ok).toBe(true);
  });

  it('refuses a slot outside location hours, an inverted slot and a past day', () => {
    const early = PickupRequest.book('PU-1', 'D', 'LOC-1', slot({ startMinute: 7 * 60, endMinute: 8 * 60 }),
      [shipment(1)], HOURS, SAME_DAY_CUTOFF_MINUTE, 6 * 60, TODAY);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.violations.some((v) => v.startsWith('SLOT_OUTSIDE_LOCATION_HOURS'))).toBe(true);

    const late = PickupRequest.book('PU-2', 'D', 'LOC-1', slot({ startMinute: 19 * 60, endMinute: 21 * 60 }),
      [shipment(1)], HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY);
    expect(late.ok).toBe(false);

    const inverted = PickupRequest.book('PU-3', 'D', 'LOC-1', slot({ startMinute: 17 * 60, endMinute: 15 * 60 }),
      [shipment(1)], HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY);
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.violations).toContain('SLOT_INVERTED');

    const past = PickupRequest.book('PU-4', 'D', 'LOC-1', slot({ epochDay: TODAY - 1 }),
      [shipment(1)], HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY);
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.violations).toContain('SLOT_IN_THE_PAST');
  });

  it('refuses an unlabelled shipment and names it', () => {
    const r = PickupRequest.book('PU-1', 'D', 'LOC-1', slot(),
      [shipment(1), shipment(2, { labelled: false })], HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.some((v) => v.includes('AWB002'))).toBe(true);
  });

  it('refuses an empty pickup', () => {
    const r = PickupRequest.book('PU-1', 'D', 'LOC-1', slot(), [], HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('NO_SHIPMENTS');
  });
});

describe('pickup state machine and auto-reschedule', () => {
  it('walks Scheduled → Attempted → Completed', () => {
    const req = bookOk(PickupRequest.book('PU-1', 'D', 'LOC-1', slot(), [shipment(1)],
      HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY));
    expect(req.attempt()).toBe('ATTEMPTED');
    expect(req.complete()).toEqual({ ok: true });
    expect(req.currentState()).toBe('COMPLETED');
    expect(req.complete().ok).toBe(false);
  });

  it('a failure at 18:00 auto-books the next slot (acceptance scenario)', () => {
    // "Given a Failed pickup at 18:00, When the EOD sweep runs, Then ... auto next-slot booking"
    const req = bookOk(PickupRequest.book('PU-1', 'DELHIVERY', 'LOC-1', slot(), [shipment(1)],
      HOURS, SAME_DAY_CUTOFF_MINUTE, 10 * 60, TODAY));
    req.attempt();
    const nextSlot = slot({ epochDay: TODAY + 1, startMinute: 10 * 60, endMinute: 12 * 60 });
    const outcome = req.fail('COURIER_NO_SHOW_AT_18:00', nextSlot);
    expect(outcome.state).toBe('FAILED');
    expect(outcome.rescheduledTo).toEqual(nextSlot);
    expect(req.reschedule()!.epochDay).toBe(TODAY + 1);
    expect(req.failures()).toEqual(['COURIER_NO_SHOW_AT_18:00']);
  });
});

describe('two consecutive failures escalate (RULES)', () => {
  it('escalates on the second consecutive failure with the courier named', () => {
    const t = new PickupFailureTracker();
    expect(t.recordFailure('DELHIVERY', 'LOC-1')).toBeNull();
    const esc = t.recordFailure('DELHIVERY', 'LOC-1');
    expect(esc).not.toBeNull();
    expect(esc!.reason).toBe('CONSECUTIVE_PICKUP_FAILURES');
    expect(esc!.courier).toBe('DELHIVERY');
    expect(esc!.consecutiveFailures).toBe(CONSECUTIVE_FAILURES_TO_ESCALATE);
  });

  it('a success clears the streak, because the rule is about CONSECUTIVE failures', () => {
    const t = new PickupFailureTracker();
    t.recordFailure('DELHIVERY', 'LOC-1');
    t.recordSuccess('DELHIVERY', 'LOC-1');
    expect(t.consecutiveFailures('DELHIVERY', 'LOC-1')).toBe(0);
    expect(t.recordFailure('DELHIVERY', 'LOC-1')).toBeNull();
  });

  it('tracks couriers and locations independently', () => {
    const t = new PickupFailureTracker();
    t.recordFailure('DELHIVERY', 'LOC-1');
    expect(t.recordFailure('BLUEDART', 'LOC-1')).toBeNull();
    expect(t.recordFailure('DELHIVERY', 'LOC-2')).toBeNull();
    expect(t.recordFailure('DELHIVERY', 'LOC-1')).not.toBeNull();
  });
});

// ==================================================== FR-LOG-003

const booked = (n: number) => new Set(Array.from({ length: n }, (_, i) => shipment(i + 1).awb));

const manifestOk = (r: ReturnType<typeof Manifest.create>) => {
  if (!r.ok) throw new Error('expected manifest: ' + r.violations.join(', '));
  return r.manifest;
};

const evidence = (awb: string, over: Partial<HandoverEvidence> = {}): HandoverEvidence => ({
  awb, method: 'RIDER_SCAN', riderIdentityToken: 'rider-token-abc', atMs: T0, ...over,
});

describe('manifest creation validation', () => {
  it('only labelled, pickup-booked shipments are manifestable', () => {
    const unbooked = Manifest.create('MF-1', 'DELHIVERY', 'LOC-1',
      [shipment(1), shipment(2)], new Set(['AWB001']), T0);
    expect(unbooked.ok).toBe(false);
    if (!unbooked.ok) expect(unbooked.violations.some((v) => v.includes('AWB002'))).toBe(true);

    const unlabelled = Manifest.create('MF-2', 'DELHIVERY', 'LOC-1',
      [shipment(1, { labelled: false })], booked(1), T0);
    expect(unlabelled.ok).toBe(false);

    expect(Manifest.create('MF-3', 'DELHIVERY', 'LOC-1', [shipment(1)], booked(1), T0).ok).toBe(true);
  });

  it('refuses duplicate AWBs and an empty manifest', () => {
    const dup = Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1), shipment(1)], booked(1), T0);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.violations.some((v) => v.startsWith('DUPLICATE_AWB_ON_MANIFEST'))).toBe(true);
    expect(Manifest.create('MF-2', 'D', 'LOC-1', [], new Set(), T0).ok).toBe(false);
  });

  it('carries a tamper-proof checksum that changes with content', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1), shipment(2)], booked(2), T0));
    expect(m.checksum).toMatch(/^[0-9a-f]{8}$/);
    const same = manifestChecksum('MF-1', 'D', [shipment(1), shipment(2)], T0);
    expect(m.checksum).toBe(same);
    // order of the lines must not matter, but content must
    expect(manifestChecksum('MF-1', 'D', [shipment(2), shipment(1)], T0)).toBe(same);
    expect(manifestChecksum('MF-1', 'D', [shipment(1), shipment(3)], T0)).not.toBe(same);
  });
});

describe('handover scanning', () => {
  it('a duplicate scan is idempotent and keeps the first evidence', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1)], booked(1), T0));
    expect(m.scan(evidence('AWB001'))).toEqual({ ok: true, duplicate: false });
    const again = m.scan(evidence('AWB001', { riderIdentityToken: 'rider-token-xyz', atMs: T0 + 60_000 }));
    expect(again).toEqual({ ok: true, duplicate: true });
    expect(m.scannedCount()).toBe(1);
    expect(m.evidenceFor('AWB001')!.riderIdentityToken).toBe("rider-token-abc");
  });

  it('refuses an AWB that is not on the manifest, and requires rider identity', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1)], booked(1), T0));
    const off = m.scan(evidence('AWB999'));
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.reason).toContain('AWB_NOT_ON_MANIFEST');

    const noRider = m.scan(evidence('AWB001', { riderIdentityToken: '  ' }));
    expect(noRider.ok).toBe(false);
    if (!noRider.ok) expect(noRider.reason).toBe('RIDER_IDENTITY_REQUIRED');
  });

  it('the offline OTP fallback requires a photo (ERRORS)', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1)], booked(1), T0));
    const noPhoto = m.scan(evidence('AWB001', { method: 'RIDER_OTP' }));
    expect(noPhoto.ok).toBe(false);
    if (!noPhoto.ok) expect(noPhoto.reason).toBe('OTP_FALLBACK_REQUIRES_PHOTO');

    expect(m.scan(evidence('AWB001', { method: 'RIDER_OTP', photoRef: 'photo://handover/1' })).ok).toBe(true);
  });

  it('liability transfers only on a recorded handover', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1), shipment(2)], booked(2), T0));
    expect(m.isUnderCarrierLiability('AWB001')).toBe(false);
    expect(m.canonicalStatusFor('AWB001')).toBe('PACKED');

    m.scan(evidence('AWB001'));
    expect(m.isUnderCarrierLiability('AWB001')).toBe(true);
    expect(m.canonicalStatusFor('AWB001')).toBe('SHIPPED');
    // the unscanned one is untouched — a manifest existing is not a handover
    expect(m.isUnderCarrierLiability('AWB002')).toBe(false);
    expect(m.canonicalStatusFor('AWB002')).toBe('PACKED');
  });

  it('handover evidence is retained for 180 days', () => {
    const m = manifestOk(Manifest.create('MF-1', 'D', 'LOC-1', [shipment(1)], booked(1), T0));
    m.scan(evidence('AWB001'));
    expect(m.isEvidenceRetained('AWB001', T0 + HANDOVER_EVIDENCE_RETENTION_DAYS * DAY_MS)).toBe(true);
    expect(m.isEvidenceRetained('AWB001', T0 + (HANDOVER_EVIDENCE_RETENTION_DAYS + 1) * DAY_MS)).toBe(false);
    expect(m.isEvidenceRetained('AWB002', T0)).toBe(false);
  });
});

describe('the documented acceptance scenario: 10 manifested, 9 scanned', () => {
  const tenShipments = Array.from({ length: 10 }, (_, i) => shipment(i + 1));

  const nineScanned = () => {
    const m = manifestOk(Manifest.create('MF-1', 'DELHIVERY', 'LOC-1', tenShipments, booked(10), T0));
    for (let i = 1; i <= 9; i++) m.scan(evidence(shipment(i).awb));
    return m;
  };

  it('closure is BLOCKED while a discrepancy stands', () => {
    const m = nineScanned();
    expect(m.manifestedCount()).toBe(10);
    expect(m.scannedCount()).toBe(9);

    const d = m.discrepancies();
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({ awb: 'AWB010', reason: 'MANIFESTED_NOT_SCANNED' });

    const blocked = m.close('01OPS');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.reason).toContain('DISCREPANCY_BLOCKS_CLOSURE');
      expect(blocked.discrepancies).toHaveLength(1);
    }
    expect(m.isClosed()).toBe(false);
  });

  it('a late scan resolves the discrepancy and closure then succeeds cleanly', () => {
    const m = nineScanned();
    expect(m.scan(evidence('AWB010', { atMs: T0 + 300_000 })).ok).toBe(true);
    expect(m.discrepancies()).toHaveLength(0);
    const closed = m.close('01OPS');
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.shipped).toHaveLength(10);
      expect(closed.discrepancies).toHaveLength(0);
    }
    expect(m.closureException()).toBeNull();
  });

  it('or an exception note by a named operator permits closure, and is recorded', () => {
    const m = nineScanned();
    const short = m.close('01OPS', 'lost');
    expect(short.ok).toBe(false);

    const closed = m.close('01OPS', 'AWB010 not presented by rider; investigation task INV-4471 raised');
    expect(closed.ok).toBe(true);
    if (closed.ok) {
      expect(closed.shipped).toHaveLength(9);              // only the 9 actually handed over ship
      expect(closed.discrepancies).toHaveLength(1);        // and the gap is recorded, not erased
    }
    expect(m.closureException()!.by).toBe('01OPS');
    expect(m.closureException()!.note).toContain('INV-4471');
    // the unscanned shipment never gained carrier liability
    expect(m.isUnderCarrierLiability('AWB010')).toBe(false);
    expect(m.canonicalStatusFor('AWB010')).toBe('PACKED');
  });

  it('an exception note without a named operator is refused', () => {
    const m = nineScanned();
    const r = m.close('', 'AWB010 not presented by rider; investigation raised');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('EXCEPTION_NOTE_REQUIRES_NAMED_OPERATOR');
  });

  it('a closed manifest accepts no further scans and cannot be closed twice', () => {
    const m = nineScanned();
    m.close('01OPS', 'AWB010 missing; investigation task INV-4471 raised');
    const late = m.scan(evidence('AWB010'));
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe('MANIFEST_ALREADY_CLOSED');
    expect(m.close('01OPS').ok).toBe(false);
  });
});
