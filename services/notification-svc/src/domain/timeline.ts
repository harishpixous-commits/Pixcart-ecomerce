/**
 * Order timeline projector — FR-CUS-016 ("per-item status timelines across vendor
 * sub-orders") and FR-LOG-004 ("normalise statuses to a canonical event model, update
 * customer/vendor timelines").
 *
 * A pure fold over the Slice-10 domain events: given the current timeline and the next
 * event, produce the next timeline. Idempotent by (eventType, eventId) — replaying an
 * event (routine per Vol.5 §5.5: backfills, DR) does not double-append. This is the read
 * model the customer's order-tracking screen renders.
 *
 * The projector consumes the SAME event shapes defined in contracts/events (Slice 10);
 * the notification tests validate those payloads against the JSON Schemas, so this
 * projector and the published contracts cannot drift.
 */

export interface TimelineEntry {
  subOrderId: string;
  status: string;          // canonical status (SubOrderLifecycle vocabulary) or money milestone
  at: string;              // ISO event time
  detail?: string;
  eventId: string;         // provenance + idempotency
}

export interface OrderTimeline {
  orderId: string;
  entries: TimelineEntry[];
  seenEventIds: string[];  // dedup set (kept as array for JSON-friendliness)
}

export function emptyTimeline(orderId: string): OrderTimeline {
  return { orderId, entries: [], seenEventIds: [] };
}

/** A minimal envelope view the projector needs (matches contracts/events/envelope.v1). */
export interface EventEnvelope {
  eventId: string;
  eventType: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

function append(tl: OrderTimeline, entry: TimelineEntry): OrderTimeline {
  return { ...tl, entries: [...tl.entries, entry], seenEventIds: [...tl.seenEventIds, entry.eventId] };
}

/**
 * Fold one event into the timeline. Unknown event types are ignored (forward-compatible).
 * Replays (eventId already seen) are no-ops — the exactly-once effect Vol.5 §5.5 requires.
 */
export function apply(tl: OrderTimeline, env: EventEnvelope): OrderTimeline {
  if (tl.seenEventIds.includes(env.eventId)) return tl; // idempotent replay

  switch (env.eventType) {
    case 'order.confirmed.v1': {
      const subs = (env.data.subOrders as Array<{ subOrderId: string }>) ?? [];
      let next = tl;
      for (const s of subs) {
        next = append(next, { subOrderId: s.subOrderId, status: 'CONFIRMED', at: env.occurredAt, eventId: env.eventId });
      }
      return next;
    }
    case 'shipment.status.v1': {
      return append(tl, {
        subOrderId: String(env.data.subOrderId),
        status: String(env.data.status),
        at: String(env.data.eventTime ?? env.occurredAt),
        detail: env.data.courier ? `via ${env.data.courier}` : undefined,
        eventId: env.eventId,
      });
    }
    case 'rma.qc.completed.v1': {
      return append(tl, {
        subOrderId: String(env.data.subOrderId),
        status: env.data.result === 'PASS' ? 'RETURN_QC_PASS' : 'RETURN_QC_FAIL',
        at: env.occurredAt,
        eventId: env.eventId,
      });
    }
    case 'payment.refunded.v1': {
      const sub = env.data.subOrderId ? String(env.data.subOrderId) : tl.orderId;
      return append(tl, {
        subOrderId: sub,
        status: env.data.resultingState === 'REFUNDED' ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        at: env.occurredAt,
        detail: `refund ${env.data.amountPaise} paise`,
        eventId: env.eventId,
      });
    }
    default:
      return tl; // forward-compatible: ignore events we do not project
  }
}

/** Convenience: fold a stream of events in arrival order. */
export function project(orderId: string, events: EventEnvelope[]): OrderTimeline {
  return events.reduce(apply, emptyTimeline(orderId));
}

/** The latest status per sub-order (what the tracking screen headlines). */
export function latestBySubOrder(tl: OrderTimeline): Record<string, TimelineEntry> {
  const out: Record<string, TimelineEntry> = {};
  for (const e of tl.entries) out[e.subOrderId] = e; // entries are in arrival order
  return out;
}
