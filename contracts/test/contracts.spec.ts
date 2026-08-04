/**
 * Contract validation harness (Slice 10).
 *
 * Proves the contracts are LIVE, not paper:
 *   1. every event JSON Schema compiles under Ajv (draft 2020-12);
 *   2. a representative payload — shaped exactly as the corresponding domain object emits
 *      it in the Slice-9 end-to-end journey — validates against its schema, and a
 *      deliberately-wrong payload is rejected;
 *   3. every event validates against the shared envelope;
 *   4. the OpenAPI 3.1 document parses and resolves;
 *   5. enum consistency: the shipment/order sub-order states in the events are a subset of
 *      the OpenAPI Order state enum (which mirrors SubOrderLifecycle).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, '..', 'events', 'schemas');
const openapiPath = path.join(here, '..', 'openapi', 'money-spine.v1.yaml');

const loadSchema = (f: string) => JSON.parse(readFileSync(path.join(schemaDir, f), 'utf8'));

let ajv: Ajv2020;
beforeAll(() => {
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // register every schema so $id cross-refs resolve
  for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
    ajv.addSchema(loadSchema(f));
  }
});

const envelope = (eventType: string, producer: string, data: unknown) => ({
  eventId: '01J8Z3K7QP01ABCDEFGHJKMNPT', // 26-char Crockford base32 ULID
  eventType,
  occurredAt: '2026-08-19T09:30:00Z',
  producer,
  partitionKey: 'ORD-1',
  schemaVersion: 1,
  data,
});

describe('event schemas compile and accept real domain payloads', () => {
  it('every schema is a valid draft-2020-12 schema', () => {
    for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
      const id = loadSchema(f).$id;
      expect(ajv.getSchema(id), `${f} compiled`).toBeTruthy();
    }
  });

  it('payment.captured.v1 — payload matching the Payment aggregate (Slice 4) validates', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/payment.captured.v1.json')!;
    const good = {
      paymentId: '01PAY0000000000000000000AA',
      quoteId: 'QTE-1',
      captureRef: 'cap-1',
      authRef: 'auth-1',
      idempotencyKey: 'idem-cap-1',
      instrument: 'UPI',
      amountPaise: 1_18_000,
    };
    expect(v(good), JSON.stringify(v.errors)).toBe(true);
    // wrong: zero amount, unknown instrument
    expect(v({ ...good, amountPaise: 0, instrument: 'CRYPTO' })).toBe(false);
  });

  it('order.confirmed.v1 — payload matching Order.create output (Slice 5, BRU-03) validates', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/order.confirmed.v1.json')!;
    const good = {
      orderId: '01QRD0000000000000000000AA',
      quoteId: 'QTE-1',
      paymentRef: 'cap-1',
      grandTotalPaise: 1_18_000,
      subOrders: [
        { subOrderId: 'SUB-V1', vendorId: 'V1', lineIds: ['L1'], amountPaise: 59_000, state: 'CONFIRMED' },
        { subOrderId: 'SUB-V2', vendorId: 'V2', lineIds: ['L2'], amountPaise: 59_000, state: 'CONFIRMED' },
      ],
    };
    expect(v(good), JSON.stringify(v.errors)).toBe(true);
    // wrong: a sub-order not in CONFIRMED violates the const
    expect(v({ ...good, subOrders: [{ ...good.subOrders[0], state: 'DELIVERED' }] })).toBe(false);
  });

  it('settlement.batch.executed.v1 — payload matching SettlementBatch.execute (Slice 6) validates', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/settlement.batch.executed.v1.json')!;
    const good = {
      batchId: 'BATCH-1',
      batchDate: '2026-08-19',
      checksumPaise: 1_08_000,
      payouts: [
        { vendorId: 'V1', amountPaise: 54_000, paid: true, utr: 'UTR-V1', attempts: 1, lineIds: ['L1'] },
        { vendorId: 'V2', amountPaise: 54_000, paid: false, heldReason: 'PAYOUT_FAILED_HELD: bank timeout', attempts: 2, lineIds: ['L2'] },
      ],
    };
    expect(v(good), JSON.stringify(v.errors)).toBe(true);
    expect(v({ ...good, payouts: [{ vendorId: 'V1', amountPaise: 0, paid: true }] })).toBe(false);
  });

  it('rma.qc.completed.v1 and payment.refunded.v1 (Slice 7) validate', () => {
    const qc = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/rma.qc.completed.v1.json')!;
    expect(qc({ returnId: 'RET-1', subOrderId: 'SUB-V1', lineId: 'L1', result: 'PASS', disposition: 'SCRAP', evidenceRefs: ['evidence://x'] })).toBe(true);
    expect(qc({ returnId: 'RET-1', subOrderId: 'SUB-V1', lineId: 'L1', result: 'MAYBE', disposition: 'SCRAP' })).toBe(false);

    const rf = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/payment.refunded.v1.json')!;
    expect(rf({ paymentId: '01PAY0000000000000000000AA', refundId: 'RET-1', subOrderId: 'SUB-V1', amountPaise: 59_000, destination: 'ORIGINAL_INSTRUMENT', resultingState: 'REFUNDED' })).toBe(true);
    expect(rf({ paymentId: '01PAY0000000000000000000AA', refundId: 'RET-1', amountPaise: 59_000, destination: 'CRYPTO', resultingState: 'REFUNDED' })).toBe(false);
  });

  it('shipment.status.v1 validates and rejects a non-canonical status', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/shipment.status.v1.json')!;
    expect(v({ subOrderId: 'SUB-V1', status: 'DELIVERED', courier: 'Bluedart', podRef: 'POD-1', eventTime: '2026-08-18T12:00:00Z' })).toBe(true);
    expect(v({ subOrderId: 'SUB-V1', status: 'TELEPORTED', courier: 'X', eventTime: '2026-08-18T12:00:00Z' })).toBe(false);
  });
});

describe('envelope wraps every event', () => {
  it('a well-formed envelope validates and a bad topic/eventId is rejected', () => {
    const v = ajv.getSchema('https://pixcart.pixoustech.com/contracts/events/envelope.v1.json')!;
    const good = envelope('payment.captured.v1', 'payment', { paymentId: 'x' });
    expect(v(good), JSON.stringify(v.errors)).toBe(true);
    expect(v({ ...good, eventType: 'PaymentCaptured' })).toBe(false); // not <domain>.<event>.vN
    expect(v({ ...good, eventId: 'not-a-ulid' })).toBe(false);
    expect(v({ ...good, producer: 'martians' })).toBe(false);
  });
});

describe('OpenAPI document', () => {
  it('parses and fully resolves as OpenAPI 3.1', async () => {
    const api: any = await SwaggerParser.validate(openapiPath);
    expect(api.openapi).toBe('3.1.0');
    expect(Object.keys(api.paths)).toContain('/checkout/quotes');
    expect(Object.keys(api.paths)).toContain('/orders');
  });

  it('the event sub-order states are a subset of the OpenAPI Order state enum', () => {
    const doc: any = YAML.parse(readFileSync(openapiPath, 'utf8'));
    const orderStates: string[] =
      doc.components.schemas.Order.properties.subOrders.items.properties.state.enum;
    const shipmentStates: string[] = loadSchema('shipment.status.v1.json').properties.status.enum;
    for (const s of shipmentStates) expect(orderStates, s).toContain(s);
    // order.confirmed sub-order state const is also in the enum
    const confirmedConst = loadSchema('order.confirmed.v1.json')
      .properties.subOrders.items.properties.state.const;
    expect(orderStates).toContain(confirmedConst);
  });
});
