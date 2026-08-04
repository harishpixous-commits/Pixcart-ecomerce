/**
 * FR-LOG-004 tracking normalisation as tests, plus cross-slice proofs that the emitted
 * canonical event conforms to the Slice-10 shipment.status.v1 schema and feeds the
 * Slice-11 timeline projector.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isStaleFeed,
  normalise,
  recomputeEdd,
  TrackingDeduper,
  POD_REQUIRED_ABOVE_PAISE,
  type Intent,
  type TrackingUpdate,
} from '../src/domain/tracking.js';
import { apply, emptyTimeline, latestBySubOrder } from '../../notification-svc/src/domain/timeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, '..', '..', '..', 'contracts', 'events', 'schemas');

const upd = (over: Partial<TrackingUpdate> = {}): TrackingUpdate => ({
  awb: 'AWB123', subOrderId: 'SUB-1', carrier: 'DELHIVERY', rawStatus: 'In Transit',
  eventTime: '2026-08-18T06:00:00Z', ingestTime: '2026-08-18T06:01:00Z', source: 'WEBHOOK',
  orderValuePaise: 50_000, ...over,
});

const emit = (i: Intent) => {
  if (i.kind !== 'EMIT') throw new Error('expected EMIT, got ' + i.kind);
  return i.event;
};

describe('per-carrier normalisation to the canonical model', () => {
  it('maps each carrier vocabulary to canonical statuses', () => {
    expect(emit(normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Out for Delivery' }))).status).toBe('OUT_FOR_DELIVERY');
    expect(emit(normalise(upd({ carrier: 'BLUEDART', rawStatus: 'DLV', orderValuePaise: 10 }))).status).toBe('DELIVERED');
    expect(emit(normalise(upd({ carrier: 'DTDC', rawStatus: 'NOT_DELIVERED' }))).status).toBe('NDR');
    expect(emit(normalise(upd({ carrier: 'INDIA_POST', rawStatus: 'Returned to Sender' }))).status).toBe('RTO_INITIATED');
  });

  it('unknown status is HELD with a mapping task, never dropped (VALIDATION)', () => {
    const i = normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Weather Delay' }));
    expect(i.kind).toBe('HELD_MAPPING_NEEDED');
    if (i.kind === 'HELD_MAPPING_NEEDED') { expect(i.rawStatus).toBe('Weather Delay'); expect(i.awb).toBe('AWB123'); }
  });
});

describe('POD requirement over ₹2,000 (RULES)', () => {
  it('holds DELIVERED without POD when order value exceeds the threshold', () => {
    const i = normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Delivered', orderValuePaise: POD_REQUIRED_ABOVE_PAISE + 1 }));
    expect(i.kind).toBe('POD_MISSING');
  });

  it('emits DELIVERED with podRef when POD is present', () => {
    const e = emit(normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Delivered', orderValuePaise: 500_000, podArtefact: 'OTP:4821' })));
    expect(e.status).toBe('DELIVERED');
    expect(e.podRef).toBe('OTP:4821');
  });

  it('does not require POD at or below the threshold', () => {
    const e = emit(normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Delivered', orderValuePaise: POD_REQUIRED_ABOVE_PAISE })));
    expect(e.status).toBe('DELIVERED');
  });
});

describe('webhook + polling de-duplication', () => {
  it('ignores a duplicate the same event arriving via polling after webhook', () => {
    const d = new TrackingDeduper();
    const webhook = upd({ source: 'WEBHOOK', rawStatus: 'Out for Delivery' });
    const polling = upd({ source: 'POLLING', rawStatus: 'Out for Delivery' }); // same awb+status+time
    expect(normalise(webhook, d).kind).toBe('EMIT');
    expect(normalise(polling, d).kind).toBe('DUPLICATE_IGNORED');
  });

  it('a provider event id drives dedup when present', () => {
    const d = new TrackingDeduper();
    const a = upd({ providerEventId: 'evt-1', rawStatus: 'Delivered', orderValuePaise: 10 });
    const b = upd({ providerEventId: 'evt-1', rawStatus: 'Delivered', orderValuePaise: 10, eventTime: '2026-08-18T09:00:00Z' });
    expect(normalise(a, d).kind).toBe('EMIT');
    expect(normalise(b, d).kind).toBe('DUPLICATE_IGNORED'); // same id, even though time differs
  });
});

describe('EDD recomputation on exceptions', () => {
  const EDD0 = Date.UTC(2026, 7, 20, 0, 0, 0);
  it('clears EDD on delivery', () => {
    expect(recomputeEdd(EDD0, 'DELIVERED', 0)).toBeNull();
  });
  it('pushes EDD out by one day per NDR attempt, capped at 3', () => {
    const oneDay = 24 * 3600 * 1000;
    expect(recomputeEdd(EDD0, 'NDR', 1)).toBe(EDD0 + oneDay);
    expect(recomputeEdd(EDD0, 'NDR', 3)).toBe(EDD0 + 3 * oneDay);
    expect(recomputeEdd(EDD0, 'NDR', 5)).toBe(EDD0 + 3 * oneDay); // capped
  });
  it('leaves EDD unchanged for in-transit statuses', () => {
    expect(recomputeEdd(EDD0, 'SHIPPED', 0)).toBe(EDD0);
    expect(recomputeEdd(EDD0, 'OUT_FOR_DELIVERY', 0)).toBe(EDD0);
  });
});

describe('stale-feed detection (48 h, RULES)', () => {
  const t0 = Date.UTC(2026, 7, 18, 0, 0, 0);
  it('flags an in-transit shipment with no event for >48 h', () => {
    expect(isStaleFeed(t0, t0 + 48 * 3600 * 1000, 'SHIPPED')).toBe(false);
    expect(isStaleFeed(t0, t0 + 48 * 3600 * 1000 + 1, 'SHIPPED')).toBe(true);
  });
  it('never flags terminal statuses', () => {
    expect(isStaleFeed(t0, t0 + 100 * 3600 * 1000, 'DELIVERED')).toBe(false);
    expect(isStaleFeed(t0, t0 + 100 * 3600 * 1000, 'RTO_RECEIVED')).toBe(false);
  });
});

describe('cross-slice: emitted event conforms to shipment.status.v1 and feeds the timeline', () => {
  let ajv: Ajv2020;
  beforeAll(() => {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(path.join(schemaDir, 'shipment.status.v1.json'), 'utf8')));
  });

  it('the canonical event validates against the Slice-10 schema', () => {
    const e = emit(normalise(upd({ carrier: 'BLUEDART', rawStatus: 'OFD' })));
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/shipment.status.v1.json')!;
    expect(v(e), JSON.stringify(v.errors)).toBe(true);
  });

  it('a normalised delivered event drives the Slice-11 timeline to DELIVERED', () => {
    const e = emit(normalise(upd({ carrier: 'DELHIVERY', rawStatus: 'Delivered', orderValuePaise: 10 })));
    const tl = apply(emptyTimeline('ORD-1'), {
      eventId: '01EVTSHIPDELIVERED0000AAAA', eventType: 'shipment.status.v1', occurredAt: e.eventTime, data: e as unknown as Record<string, unknown>,
    });
    expect(latestBySubOrder(tl)['SUB-1'].status).toBe('DELIVERED');
  });
});
