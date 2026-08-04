/**
 * Timeline projector (FR-CUS-016 / FR-LOG-004) tests, and a CROSS-SLICE proof that the
 * events this projector consumes conform to the Slice-10 contracts/events JSON Schemas —
 * so the read model and the published contracts cannot drift.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { apply, emptyTimeline, latestBySubOrder, project, type EventEnvelope } from '../src/domain/timeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, '..', '..', '..', 'contracts', 'events', 'schemas');
const loadSchema = (f: string) => JSON.parse(readFileSync(path.join(schemaDir, f), 'utf8'));

const env = (eventType: string, occurredAt: string, eventId: string, data: Record<string, unknown>): EventEnvelope =>
  ({ eventType, occurredAt, eventId, data });

// ULID-valid ids (Crockford: no I/L/O/U).
const E = {
  confirmed: '01EVTCNFRMD0000000000AAAA',
  ship1: '01EVTSHIP1000000000000AAA',
  ship2: '01EVTSHIP2000000000000AAA',
  qc: '01EVTQC00000000000000AAAA',
  refund: '01EVTREFUND00000000000AAA',
};

describe('order timeline projector', () => {
  it('folds order.confirmed → shipment.status → delivered into an ordered timeline', () => {
    const events: EventEnvelope[] = [
      env('order.confirmed.v1', '2026-08-17T04:30:00Z', E.confirmed, {
        orderId: 'ORD-1', subOrders: [{ subOrderId: 'SUB-V1' }, { subOrderId: 'SUB-V2' }],
      }),
      env('shipment.status.v1', '2026-08-18T06:00:00Z', E.ship1, { subOrderId: 'SUB-V1', status: 'SHIPPED', courier: 'Bluedart', eventTime: '2026-08-18T06:00:00Z' }),
      env('shipment.status.v1', '2026-08-18T12:00:00Z', E.ship2, { subOrderId: 'SUB-V1', status: 'DELIVERED', courier: 'Bluedart', eventTime: '2026-08-18T12:00:00Z' }),
    ];
    const tl = project('ORD-1', events);
    expect(tl.entries).toHaveLength(4); // 2 confirmed + 2 shipment
    const latest = latestBySubOrder(tl);
    expect(latest['SUB-V1'].status).toBe('DELIVERED');
    expect(latest['SUB-V2'].status).toBe('CONFIRMED');
  });

  it('is idempotent: replaying the same eventId does not double-append', () => {
    const e = env('shipment.status.v1', '2026-08-18T12:00:00Z', E.ship1, { subOrderId: 'SUB-V1', status: 'DELIVERED', courier: 'X', eventTime: '2026-08-18T12:00:00Z' });
    let tl = emptyTimeline('ORD-1');
    tl = apply(tl, e);
    tl = apply(tl, e); // replay
    expect(tl.entries).toHaveLength(1);
  });

  it('projects refund and QC events onto the timeline', () => {
    const tl = project('ORD-1', [
      env('rma.qc.completed.v1', '2026-08-20T09:00:00Z', E.qc, { subOrderId: 'SUB-V1', result: 'PASS' }),
      env('payment.refunded.v1', '2026-08-20T09:05:00Z', E.refund, { subOrderId: 'SUB-V1', amountPaise: 59000, resultingState: 'REFUNDED' }),
    ]);
    expect(tl.entries.map((e) => e.status)).toEqual(['RETURN_QC_PASS', 'REFUNDED']);
  });

  it('ignores unknown event types (forward-compatible)', () => {
    const tl = apply(emptyTimeline('ORD-1'), env('some.future.event.v1', '2026-08-20T00:00:00Z', '01EVTFUTURE0000000000AAAA', {}));
    expect(tl.entries).toHaveLength(0);
  });
});

describe('cross-slice: projector inputs conform to contracts/events (Slice 10)', () => {
  let ajv: Ajv2020;
  beforeAll(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const f of ['envelope.v1.json', 'order.confirmed.v1.json', 'shipment.status.v1.json', 'rma.qc.completed.v1.json', 'payment.refunded.v1.json']) {
      ajv.addSchema(loadSchema(f));
    }
  });

  it('the order.confirmed payload the projector consumes validates against its schema', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/order.confirmed.v1.json')!;
    const data = {
      orderId: '01QRDCNFRMD000000000000AAA', quoteId: 'QTE-1', paymentRef: 'cap-1', grandTotalPaise: 118000,
      subOrders: [
        { subOrderId: 'SUB-V1', vendorId: 'V1', lineIds: ['L1'], amountPaise: 59000, state: 'CONFIRMED' },
        { subOrderId: 'SUB-V2', vendorId: 'V2', lineIds: ['L2'], amountPaise: 59000, state: 'CONFIRMED' },
      ],
    };
    expect(v(data), JSON.stringify(v.errors)).toBe(true);
    // and the projector actually consumes it
    const tl = apply(emptyTimeline('01QRDCNFRMD000000000000AAA'), env('order.confirmed.v1', '2026-08-17T04:30:00Z', E.confirmed, data));
    expect(tl.entries).toHaveLength(2);
  });

  it('the shipment.status payload validates and is projected', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/shipment.status.v1.json')!;
    const data = { subOrderId: 'SUB-V1', status: 'DELIVERED', courier: 'Bluedart', podRef: 'POD-1', eventTime: '2026-08-18T12:00:00Z' };
    expect(v(data), JSON.stringify(v.errors)).toBe(true);
    const tl = apply(emptyTimeline('ORD-1'), env('shipment.status.v1', data.eventTime, E.ship2, data));
    expect(latestBySubOrder(tl)['SUB-V1'].status).toBe('DELIVERED');
  });
});
