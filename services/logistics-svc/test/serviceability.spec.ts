/**
 * FR-LOG-001 serviceability & rate shopping as tests, plus a cross-slice proof that this
 * module supplies the `serviceablePin` fact the Slice-13 cart and Slice-3 quote engine
 * consume (previously a pre-computed boolean).
 */
import { describe, expect, it } from 'vitest';
import {
  allocationScore,
  DEFAULT_WEIGHTS,
  evaluate,
  isPinServiceable,
  RISK_BUFFER_DAYS,
  type CourierQuote,
  type PinRecord,
  type ShipmentRequest,
} from '../src/domain/serviceability.js';
import { addItem, emptyCart, toCheckoutLines, type LineFacts } from '../../cart-checkout-svc/src/domain/cart/cart.js';
import { createQuote, hashQuoteId } from '../../cart-checkout-svc/src/domain/checkout/quote.js';

const SHIP = Date.UTC(2026, 7, 18, 0, 0, 0);
const DAY = 24 * 3600 * 1000;

const master = new Map<string, PinRecord>([
  ['641012', { pin: '641012', zone: 'SOUTH', riskTier: 'LOW' }],
  ['560001', { pin: '560001', zone: 'SOUTH', riskTier: 'MEDIUM' }],
  ['796001', { pin: '796001', zone: 'NORTHEAST', riskTier: 'HIGH' }],
]);

const q = (over: Partial<CourierQuote> = {}): CourierQuote => ({
  courier: 'DELHIVERY', costPaise: 6_000, transitDays: 3, otif: 0.95,
  supportsCod: true, maxWeightGrams: 10_000, capability: 1, ...over,
});

const req = (over: Partial<ShipmentRequest> = {}): ShipmentRequest => ({
  destinationPin: '641012', weightGrams: 500, codRequested: false,
  orderValuePaise: 50_000, fraudScore: 0.1, shipDateMs: SHIP, ...over,
});

const ok = (r: ReturnType<typeof evaluate>) => {
  if (!r.serviceable) throw new Error('expected serviceable, got ' + r.reason);
  return r;
};

describe('PIN master validation (VALIDATION)', () => {
  it('rejects a malformed PIN and one absent from the master', () => {
    expect(evaluate(req({ destinationPin: '64101' }), master, [q()])).toEqual({ serviceable: false, reason: 'PIN_MALFORMED' });
    expect(evaluate(req({ destinationPin: '999999' }), master, [q()])).toEqual({ serviceable: false, reason: 'PIN_NOT_IN_MASTER' });
  });

  it('reports an uncovered lane rather than guessing', () => {
    expect(evaluate(req(), master, [])).toEqual({ serviceable: false, reason: 'NO_COURIER_COVERS_LANE' });
  });
});

describe('weight cap (VALIDATION)', () => {
  it('excludes couriers over their max weight and fails when none can carry it', () => {
    const light = q({ courier: 'LIGHT', maxWeightGrams: 1_000, costPaise: 4_000 });
    const heavy = q({ courier: 'HEAVY', maxWeightGrams: 30_000, costPaise: 9_000 });
    // 5 kg: LIGHT excluded, HEAVY selected despite being dearer
    expect(ok(evaluate(req({ weightGrams: 5_000 }), master, [light, heavy])).selected.courier).toBe('HEAVY');
    // 50 kg: nobody
    expect(evaluate(req({ weightGrams: 50_000 }), master, [light, heavy]))
      .toEqual({ serviceable: false, reason: 'WEIGHT_OVER_ALL_COURIER_LIMITS' });
  });
});

describe('allocation policy: cost × SLA × capability', () => {
  it('prefers the cheaper courier when SLA and capability match', () => {
    const cheap = q({ courier: 'CHEAP', costPaise: 4_000 });
    const dear = q({ courier: 'DEAR', costPaise: 8_000 });
    expect(ok(evaluate(req(), master, [dear, cheap])).selected.courier).toBe('CHEAP');
  });

  it('a much better OTIF can outweigh a modest cost premium', () => {
    const cheapPoor = q({ courier: 'CHEAP_POOR', costPaise: 5_500, otif: 0.55 });
    const dearGood = q({ courier: 'DEAR_GOOD', costPaise: 6_000, otif: 0.99 });
    const r = ok(evaluate(req(), master, [cheapPoor, dearGood]));
    expect(r.selected.courier).toBe('DEAR_GOOD');
    expect(r.ranked[0].score).toBeGreaterThan(r.ranked[1].score);
  });

  it('zone weights are configurable and change the winner', () => {
    const cheapPoor = q({ courier: 'CHEAP_POOR', costPaise: 4_000, otif: 0.60 });
    const dearGood = q({ courier: 'DEAR_GOOD', costPaise: 6_000, otif: 0.99 });
    // cost-only weighting → the cheap one wins
    const costOnly = new Map([['SOUTH', { cost: 1, sla: 0, capability: 0 }]]);
    expect(ok(evaluate(req(), master, [cheapPoor, dearGood], costOnly)).selected.courier).toBe('CHEAP_POOR');
    // SLA-only weighting → the reliable one wins
    const slaOnly = new Map([['SOUTH', { cost: 0, sla: 1, capability: 0 }]]);
    expect(ok(evaluate(req(), master, [cheapPoor, dearGood], slaOnly)).selected.courier).toBe('DEAR_GOOD');
  });

  it('score formula is deterministic and scale-free', () => {
    const a = q({ costPaise: 5_000, otif: 0.9, capability: 1 });
    expect(allocationScore(a, 5_000, DEFAULT_WEIGHTS)).toBeCloseTo(0.5 * 1 + 0.3 * 0.9 + 0.2 * 1, 10);
    expect(allocationScore(q({ costPaise: 10_000, otif: 0.9, capability: 1 }), 5_000, DEFAULT_WEIGHTS))
      .toBeCloseTo(0.5 * 0.5 + 0.3 * 0.9 + 0.2 * 1, 10);
  });
});

describe('EDD with risk-tier buffers (RULES)', () => {
  it('adds no buffer on a LOW-risk lane and 2 days on HIGH', () => {
    const low = ok(evaluate(req({ destinationPin: '641012' }), master, [q({ transitDays: 3 })]));
    expect(low.transitDaysWithBuffer).toBe(3 + RISK_BUFFER_DAYS.LOW);
    expect(low.eddMs).toBe(SHIP + 3 * DAY);

    const high = ok(evaluate(req({ destinationPin: '796001' }), master, [q({ transitDays: 3 })]));
    expect(high.transitDaysWithBuffer).toBe(5);
    expect(high.eddMs).toBe(SHIP + 5 * DAY);
  });

  it('MEDIUM risk adds one day', () => {
    const med = ok(evaluate(req({ destinationPin: '560001' }), master, [q({ transitDays: 2 })]));
    expect(med.transitDaysWithBuffer).toBe(3);
  });
});

describe('COD gate (BRU-05 + courier capability)', () => {
  it('allows COD when courier supports it, value is within cap and fraud is low', () => {
    const r = ok(evaluate(req({ codRequested: true, orderValuePaise: 500_000 }), master, [q({ supportsCod: true })]));
    expect(r.codEligible).toBe(true);
    expect(r.codReasons).toEqual([]);
  });

  it('refuses COD above ₹10,000 with a reason, lane still serviceable', () => {
    const r = ok(evaluate(req({ codRequested: true, orderValuePaise: 10_000 * 100 + 1 }), master, [q()]));
    expect(r.codEligible).toBe(false);
    expect(r.codReasons).toContain('ORDER_VALUE_OVER_10000');
  });

  it('refuses COD when no courier supports it, but keeps the lane serviceable prepaid', () => {
    const r = ok(evaluate(req({ codRequested: true }), master, [q({ supportsCod: false })]));
    expect(r.serviceable).toBe(true);
    expect(r.codEligible).toBe(false);
    expect(r.codReasons).toContain('COURIER_NO_COD_SUPPORT');
  });

  it('refuses COD on a high fraud score', () => {
    const r = ok(evaluate(req({ codRequested: true, fraudScore: 0.8 }), master, [q()]));
    expect(r.codReasons).toContain('FRAUD_SCORE_ABOVE_THRESHOLD');
  });
});

describe('cross-slice: serviceability supplies the cart/quote serviceablePin fact', () => {
  it('a serviceable PIN lets the cart emit lines the quote engine prices', () => {
    expect(isPinServiceable('641012', master, [q()])).toBe(true);

    let c = emptyCart('CART-1', 'CUS-1', SHIP);
    c = (addItem(c, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 1, unitPriceAtAddPaise: 100_000 }, SHIP) as any).cart;
    const facts = new Map<string, LineFacts>([['L1', { listingId: 'L1', currentPricePaise: 100_000, availableStock: 5 }]]);

    const lines = toCheckoutLines(c, facts, {
      serviceablePin: isPinServiceable('641012', master, [q()]),   // decided, not assumed
      taxBpsFor: () => 0,
    });
    const r = createQuote({
      cartId: c.cartId, customerId: 'CUS-1', addressPin: '641012', lines, coupons: [],
      requestedPaymentMethod: 'PREPAID', fraudScore: 0.1, codFraudThreshold: 0.7, nowMs: SHIP,
    }, hashQuoteId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.quote.grandTotalPaise).toBe(100_000);
  });

  it('an unserviceable PIN makes the quote engine reject the line', () => {
    expect(isPinServiceable('999999', master, [q()])).toBe(false);

    let c = emptyCart('CART-2', 'CUS-1', SHIP);
    c = (addItem(c, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 1, unitPriceAtAddPaise: 100_000 }, SHIP) as any).cart;
    const facts = new Map<string, LineFacts>([['L1', { listingId: 'L1', currentPricePaise: 100_000, availableStock: 5 }]]);
    const lines = toCheckoutLines(c, facts, {
      serviceablePin: isPinServiceable('999999', master, [q()]),
      taxBpsFor: () => 0,
    });
    const r = createQuote({
      cartId: c.cartId, customerId: 'CUS-1', addressPin: '560001', lines, coupons: [],
      requestedPaymentMethod: 'PREPAID', fraudScore: 0.1, codFraudThreshold: 0.7, nowMs: SHIP,
    }, hashQuoteId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.reason)).toContain('PIN_NOT_SERVICEABLE');
  });
});
