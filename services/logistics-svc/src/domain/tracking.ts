/**
 * Courier tracking normalisation — FR-LOG-004.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "ingest courier tracking webhooks (with polling fallback), normalise
 *                statuses to a canonical event model, update customer/vendor timelines,
 *                recompute EDD on exceptions and trigger proactive notifications."
 *   RULES:      "Delivered requires POD artefact (OTP/signature/photo) for orders > ₹2,000;
 *                stale-feed rule: no event 48 h in-transit → auto courier ticket + customer
 *                notice."
 *   VALIDATION: "Signature + replay checks; unknown courier status → 'mapping needed' ops
 *                task, event held not dropped."
 *
 * Pure and deterministic. The canonical status vocabulary is exactly the fulfilment subset
 * of SubOrderLifecycle (Slice 5), so a normalised event maps 1:1 onto a legal state, and
 * the emitted shipment.status.v1 payload conforms to the Slice-10 contract (the tests
 * validate this against the JSON Schema). No I/O here: webhooks/polling arrive as records;
 * "trigger notification" and "raise ops task" are returned as intents for the edge to act on.
 */

/** Canonical statuses = the shipment subset of SubOrderLifecycle.State. */
export type CanonicalStatus =
  | 'SHIPPED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'NDR' | 'RTO_INITIATED' | 'RTO_RECEIVED';

export type Carrier = 'DELHIVERY' | 'BLUEDART' | 'DTDC' | 'INDIA_POST';

/**
 * Per-carrier raw→canonical maps. Real couriers report different vocabularies; these are
 * representative mappings. Anything not listed is UNKNOWN → held, not dropped (VALIDATION).
 */
const CARRIER_MAPS: Record<Carrier, Record<string, CanonicalStatus>> = {
  DELHIVERY: {
    'Manifested': 'SHIPPED', 'In Transit': 'SHIPPED', 'Dispatched': 'OUT_FOR_DELIVERY',
    'Out for Delivery': 'OUT_FOR_DELIVERY', 'Delivered': 'DELIVERED',
    'Undelivered': 'NDR', 'RTO Initiated': 'RTO_INITIATED', 'RTO Delivered': 'RTO_RECEIVED',
  },
  BLUEDART: {
    'SHP': 'SHIPPED', 'INT': 'SHIPPED', 'OFD': 'OUT_FOR_DELIVERY', 'DLV': 'DELIVERED',
    'UD': 'NDR', 'RTO': 'RTO_INITIATED', 'RTO-DLV': 'RTO_RECEIVED',
  },
  DTDC: {
    'BOOKED': 'SHIPPED', 'INTRANSIT': 'SHIPPED', 'OUTFORDELIVERY': 'OUT_FOR_DELIVERY',
    'DELIVERED': 'DELIVERED', 'NOT_DELIVERED': 'NDR', 'RTO_IN': 'RTO_INITIATED', 'RTO_DEL': 'RTO_RECEIVED',
  },
  INDIA_POST: {
    'Booked': 'SHIPPED', 'In Transit': 'SHIPPED', 'Out for Delivery': 'OUT_FOR_DELIVERY',
    'Item Delivered': 'DELIVERED', 'Unable to Deliver': 'NDR', 'Returned to Sender': 'RTO_INITIATED',
  },
};

export interface TrackingUpdate {
  awb: string;                 // airway bill / tracking number
  subOrderId: string;
  carrier: Carrier;
  rawStatus: string;
  eventTime: string;           // courier-reported time (ISO)
  ingestTime: string;          // platform ingest time (ISO)
  source: 'WEBHOOK' | 'POLLING';
  podArtefact?: string;        // OTP/signature/photo ref, if provided
  orderValuePaise: number;     // to apply the POD-required-over-₹2000 rule
  /** Provided event id if the courier supplies one; else we derive a dedup key. */
  providerEventId?: string;
}

export const POD_REQUIRED_ABOVE_PAISE = 2_000 * 100;   // RULES: POD for orders > ₹2,000
export const STALE_FEED_HOURS = 48;                     // RULES: 48 h in-transit → ticket

/** A normalised, canonical shipment event (shape of shipment.status.v1 data). */
export interface CanonicalEvent {
  subOrderId: string;
  status: CanonicalStatus;
  courier: Carrier;
  eventTime: string;
  ingestTime: string;
  podRef?: string;
}

export type Intent =
  | { kind: 'EMIT'; event: CanonicalEvent }
  | { kind: 'HELD_MAPPING_NEEDED'; carrier: Carrier; rawStatus: string; awb: string }
  | { kind: 'POD_MISSING'; subOrderId: string; awb: string }
  | { kind: 'DUPLICATE_IGNORED'; dedupKey: string };

function dedupKey(u: TrackingUpdate): string {
  return u.providerEventId ?? `${u.awb}|${u.rawStatus}|${u.eventTime}`;
}

/**
 * Stateful de-duplicator across webhook + polling (both deliver the same events). Idempotent
 * by dedup key. Kept minimal and explicit; the service backs this with Redis/DB in prod.
 */
export class TrackingDeduper {
  private readonly seen = new Set<string>();
  has(u: TrackingUpdate): boolean { return this.seen.has(dedupKey(u)); }
  record(u: TrackingUpdate): void { this.seen.add(dedupKey(u)); }
}

/**
 * Normalise one tracking update into an intent. Order of checks:
 *   1. duplicate (webhook already saw this, or polling re-reports) → ignore;
 *   2. unknown carrier status → HOLD with a mapping-needed ops task (never dropped);
 *   3. DELIVERED on an order > ₹2,000 without a POD artefact → POD_MISSING (do not emit
 *      delivered yet);
 *   4. otherwise EMIT the canonical event.
 */
export function normalise(u: TrackingUpdate, deduper?: TrackingDeduper): Intent {
  if (deduper?.has(u)) return { kind: 'DUPLICATE_IGNORED', dedupKey: dedupKey(u) };

  const canonical = CARRIER_MAPS[u.carrier]?.[u.rawStatus];
  if (!canonical) {
    return { kind: 'HELD_MAPPING_NEEDED', carrier: u.carrier, rawStatus: u.rawStatus, awb: u.awb };
  }

  if (canonical === 'DELIVERED' && u.orderValuePaise > POD_REQUIRED_ABOVE_PAISE && !u.podArtefact) {
    return { kind: 'POD_MISSING', subOrderId: u.subOrderId, awb: u.awb };
  }

  deduper?.record(u);
  return {
    kind: 'EMIT',
    event: {
      subOrderId: u.subOrderId, status: canonical, courier: u.carrier,
      eventTime: u.eventTime, ingestTime: u.ingestTime,
      podRef: canonical === 'DELIVERED' ? u.podArtefact : undefined,
    },
  };
}

// --------------------------------------------------------------- EDD

/**
 * Recompute the estimated delivery date on exceptions (DESC). On NDR, push EDD out by a
 * reattempt window (default 1 day per NDR, capped at 3 attempts — matches SubOrderLifecycle
 * MAX_NDR_REATTEMPTS); on DELIVERED, EDD is cleared. Other statuses leave EDD unchanged.
 */
export function recomputeEdd(
  currentEddMs: number | null,
  status: CanonicalStatus,
  ndrAttempt: number,
  reattemptWindowDays = 1,
): number | null {
  if (status === 'DELIVERED') return null;
  if (status === 'NDR') {
    const base = currentEddMs ?? Date.now();
    const bump = Math.min(ndrAttempt, 3) * reattemptWindowDays * 24 * 3600 * 1000;
    return base + bump;
  }
  return currentEddMs;
}

/**
 * Stale-feed detection (RULES): an in-transit shipment with no new event for 48 h needs an
 * auto courier ticket + customer notice. Terminal statuses are never stale.
 */
export function isStaleFeed(lastEventTimeMs: number, nowMs: number, status: CanonicalStatus): boolean {
  if (status === 'DELIVERED' || status === 'RTO_RECEIVED') return false;
  return nowMs - lastEventTimeMs > STALE_FEED_HOURS * 3600 * 1000;
}
