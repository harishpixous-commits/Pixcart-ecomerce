import { describe, it, expect } from 'vitest';
import { evaluateWaterfall } from './promotions-engine.js';
import type { EngineInput, Coupon, CartLine } from './promotions-core.js';

/**
 * Real test (no mocks): the FR-MKT-010 discount waterfall is deterministic and
 * pure, so we assert its actual output. A FLAT platform coupon of Rs.100
 * (10000 paise) over a single line must allocate exactly 10000 paise to that
 * line, and the allocation map must sum to the coupon amount to the paisa —
 * the invariant that drives refund claw-back (FR-MKT-010).
 */
function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    lineId: 'L1',
    listingId: 'listing-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    qty: 2,
    unitListPaise: 50_000, // Rs.500 each -> Rs.1000 gross
    ...overrides,
  };
}

function platformCoupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    id: 'coupon-1',
    code: 'FLAT100',
    level: 'PLATFORM',
    kind: 'FLAT',
    value: 10_000, // FLAT: value is paise -> Rs.100 off
    minOrderPaise: 0,
    firstOrderOnly: false,
    perUserRemaining: 1,
    autoApply: true,
    stackWithVendorCoupon: true,
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    lines: [line()],
    coupons: [],
    qtyDeals: [],
    ctx: {
      nowMs: 1_700_000_000_000,
      isFirstOrder: true,
      loyaltyPointsPaise: 0,
    },
    ...overrides,
  };
}

describe('evaluateWaterfall', () => {
  it('allocates a flat platform coupon exactly and keeps the allocation sum to the paisa', () => {
    const result = evaluateWaterfall(input({ coupons: [platformCoupon()] }));

    const stage = result.waterfall.find((w) => w.stage === 'PLATFORM_COUPON');
    expect(stage, 'a PLATFORM_COUPON waterfall stage must be produced').toBeDefined();
    expect(stage!.amountPaise).toBe(10_000);

    const allocated = Object.values(stage!.allocation).reduce((a, b) => a + b, 0);
    expect(allocated).toBe(stage!.amountPaise);
    expect(stage!.allocation['L1']).toBe(10_000);
  });

  it('is deterministic: identical input yields an identical allocation map', () => {
    const a = evaluateWaterfall(input({ coupons: [platformCoupon()] }));
    const b = evaluateWaterfall(input({ coupons: [platformCoupon()] }));
    expect(a.perLineNetPaise).toEqual(b.perLineNetPaise);
    expect(a.finalPayablePaise).toBe(b.finalPayablePaise);
  });

  it('reports the correct final payable and savings for a single-line flat discount', () => {
    const result = evaluateWaterfall(input({ coupons: [platformCoupon()] }));
    expect(result.itemTotalPaise).toBe(100_000); // Rs.1000
    expect(result.finalPayablePaise).toBe(90_000); // Rs.900
    expect(result.savingsPaise).toBe(10_000);
  });
});
