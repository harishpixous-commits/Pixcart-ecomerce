/**
 * FR-MKT-010 acceptance criteria as executable tests.
 * Traceability: TC-FUN-104 (allocation/claw-back), FR-MKT-001 reason codes,
 * BRU-14 stacking, FR-CUS-011 best-coupon auto-pick, FR-CUS-020 loyalty cap.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateLargestRemainder,
  fromPaise,
  halfEvenDiv,
  toPaise,
  type Coupon,
  type EngineInput,
} from '../src/domain/promotions/core.js';
import { clawbackForLine, evaluateWaterfall } from '../src/domain/promotions/engine.js';

const NOW = Date.UTC(2026, 7, 15, 10, 0, 0); // 2026-08-15T10:00Z

const line = (n: number, over: Partial<EngineInput['lines'][number]> = {}) => ({
  lineId: `L${n}`,
  listingId: `LST${n}`,
  vendorId: 'V1',
  categoryId: 'CAT1',
  qty: 1,
  unitListPaise: 100_000, // ₹1000
  ...over,
});

const coupon = (over: Partial<Coupon> & Pick<Coupon, 'id' | 'code'>): Coupon => ({
  level: 'PLATFORM',
  kind: 'PERCENT',
  value: 1000, // 10%
  minOrderPaise: 0,
  firstOrderOnly: false,
  perUserRemaining: 1,
  autoApply: true,
  stackWithVendorCoupon: true,
  ...over,
});

const baseCtx = { nowMs: NOW, isFirstOrder: false, loyaltyPointsPaise: 0 };

describe('money core', () => {
  it('round-trips edge money strings', () => {
    expect(toPaise('1999.00')).toBe(199_900);
    expect(toPaise('0.05')).toBe(5);
    expect(fromPaise(199_900)).toBe('1999.00');
    expect(fromPaise(5)).toBe('0.05');
  });
  it('half-even rounding: ties go to the even quotient', () => {
    expect(halfEvenDiv(25, 10)).toBe(2); // 2.5 → 2
    expect(halfEvenDiv(35, 10)).toBe(4); // 3.5 → 4
    expect(halfEvenDiv(26, 10)).toBe(3);
  });
  it('largest-remainder allocation sums exactly and is deterministic', () => {
    const parts = allocateLargestRemainder(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]); // tie → lower index
  });
});

describe('FR-MKT-010 waterfall', () => {
  it('is deterministic: 100 evaluations produce byte-identical output', () => {
    const input: EngineInput = {
      lines: [line(1), line(2, { qty: 3, unitSalePaise: 90_000 }), line(3, { vendorId: 'V2' })],
      coupons: [
        coupon({ id: 'c1', code: 'SAVE10' }),
        coupon({ id: 'c2', code: 'SAVE12', value: 1200 }),
        coupon({ id: 'v1', code: 'VEND5', level: 'VENDOR', vendorId: 'V1', value: 500 }),
      ],
      qtyDeals: [{ id: 'd1', vendorId: 'V1', listingIds: ['LST2'], minQty: 2, percentBp: 500 }],
      ctx: { ...baseCtx, loyaltyPointsPaise: 10_000, walletPromo: { requestedPaise: 5_000, balancePaise: 8_000 } },
    };
    const first = JSON.stringify(evaluateWaterfall(input));
    for (let i = 0; i < 99; i++) expect(JSON.stringify(evaluateWaterfall(input))).toBe(first);
  });

  it('emits stages in the normative precedence order', () => {
    const input: EngineInput = {
      lines: [line(1, { unitSalePaise: 90_000, qty: 2 })],
      coupons: [
        coupon({ id: 'p', code: 'PLAT10' }),
        coupon({ id: 'v', code: 'VEND5', level: 'VENDOR', vendorId: 'V1', value: 500 }),
      ],
      qtyDeals: [{ id: 'd', vendorId: 'V1', listingIds: ['LST1'], minQty: 2, percentBp: 300 }],
      ctx: { ...baseCtx, loyaltyPointsPaise: 2_000, walletPromo: { requestedPaise: 1_000, balancePaise: 1_000 } },
    };
    const r = evaluateWaterfall(input);
    expect(r.waterfall.map((w) => w.stage)).toEqual([
      'ITEM_SALE', 'QTY_DEAL', 'VENDOR_COUPON', 'PLATFORM_COUPON', 'LOYALTY', 'WALLET_PROMO',
    ]);
  });

  it('BRU-14: exactly one platform coupon, best-for-customer, tie on id asc', () => {
    const input: EngineInput = {
      lines: [line(1)],
      coupons: [
        coupon({ id: 'b', code: 'TEN_B', value: 1000 }),
        coupon({ id: 'a', code: 'TEN_A', value: 1000 }),  // tie → id 'a' wins
        coupon({ id: 'c', code: 'FIFTEEN', value: 1500 }), // best wins overall
      ],
      qtyDeals: [],
      ctx: baseCtx,
    };
    const r = evaluateWaterfall(input);
    const plats = r.waterfall.filter((w) => w.stage === 'PLATFORM_COUPON');
    expect(plats).toHaveLength(1);
    expect(plats[0].sourceId).toBe('COUPON:FIFTEEN');
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        { sourceId: 'COUPON:TEN_A', reason: 'BETTER_ALTERNATIVE' },
        { sourceId: 'COUPON:TEN_B', reason: 'BETTER_ALTERNATIVE' },
      ]),
    );
  });

  it('an explicit user code owns the platform slot and is never silently swapped', () => {
    const input: EngineInput = {
      lines: [line(1)],
      coupons: [
        coupon({ id: 'auto', code: 'BIG20', value: 2000 }),
        coupon({ id: 'user', code: 'MY5', value: 500, autoApply: false }),
      ],
      qtyDeals: [],
      ctx: { ...baseCtx, explicitPlatformCode: 'MY5' },
    };
    const r = evaluateWaterfall(input);
    const plat = r.waterfall.find((w) => w.stage === 'PLATFORM_COUPON')!;
    expect(plat.sourceId).toBe('COUPON:MY5'); // user intent respected over bigger auto
  });

  it('explicit code failures return the specific reason and apply nothing', () => {
    const mk = (c: Partial<Coupon>, code: string, ctxOver = {}) =>
      evaluateWaterfall({
        lines: [line(1)],
        coupons: [coupon({ id: 'x', code: 'X', autoApply: false, ...c })],
        qtyDeals: [],
        ctx: { ...baseCtx, explicitPlatformCode: code, ...ctxOver },
      });
    expect(mk({}, 'NOPE').rejected).toContainEqual({ sourceId: 'COUPON:NOPE', reason: 'CODE_UNKNOWN' });
    expect(mk({ endsAtMs: NOW - 1 }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'EXPIRED' });
    expect(mk({ startsAtMs: NOW + 1 }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'NOT_STARTED' });
    expect(mk({ minOrderPaise: 200_000 }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'MIN_ORDER' });
    expect(mk({ firstOrderOnly: true }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'USER_INELIGIBLE' });
    expect(mk({ perUserRemaining: 0 }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'PER_USER_CAP' });
    expect(mk({ listingIds: ['OTHER'] }, 'X').rejected).toContainEqual({ sourceId: 'COUPON:X', reason: 'SCOPE_MISMATCH' });
  });

  it('BRU-14 stacking: non-stackable platform coupon is blocked when a vendor coupon applied', () => {
    const input: EngineInput = {
      lines: [line(1)],
      coupons: [
        coupon({ id: 'v', code: 'VEND5', level: 'VENDOR', vendorId: 'V1', value: 500 }),
        coupon({ id: 'p1', code: 'NOSTACK20', value: 2000, stackWithVendorCoupon: false }),
        coupon({ id: 'p2', code: 'STACK8', value: 800 }),
      ],
      qtyDeals: [],
      ctx: baseCtx,
    };
    const r = evaluateWaterfall(input);
    expect(r.rejected).toContainEqual({ sourceId: 'COUPON:NOSTACK20', reason: 'STACKING_BLOCKED' });
    expect(r.waterfall.find((w) => w.stage === 'PLATFORM_COUPON')!.sourceId).toBe('COUPON:STACK8');
  });

  it('one vendor coupon per vendor; vendor min-order measured on that vendor subtotal', () => {
    const input: EngineInput = {
      lines: [line(1, { vendorId: 'V1' }), line(2, { vendorId: 'V2', unitListPaise: 30_000 })],
      coupons: [
        coupon({ id: 'v1a', code: 'V1A', level: 'VENDOR', vendorId: 'V1', value: 500 }),
        coupon({ id: 'v1b', code: 'V1B', level: 'VENDOR', vendorId: 'V1', value: 700 }),
        coupon({ id: 'v2', code: 'V2MIN', level: 'VENDOR', vendorId: 'V2', value: 1000, minOrderPaise: 50_000 }),
      ],
      qtyDeals: [],
      ctx: baseCtx,
    };
    const r = evaluateWaterfall(input);
    const vendors = r.waterfall.filter((w) => w.stage === 'VENDOR_COUPON');
    expect(vendors.map((v) => v.sourceId)).toEqual(['COUPON:V1B']);
    expect(r.rejected).toContainEqual({ sourceId: 'COUPON:V1A', reason: 'BETTER_ALTERNATIVE' });
    expect(r.rejected).toContainEqual({ sourceId: 'COUPON:V2MIN', reason: 'MIN_ORDER' });
  });

  it('flat coupon larger than the cart clamps; payable never goes negative', () => {
    const r = evaluateWaterfall({
      lines: [line(1, { unitListPaise: 5_000 })],
      coupons: [coupon({ id: 'f', code: 'FLAT100', kind: 'FLAT', value: 10_000 })],
      qtyDeals: [],
      ctx: baseCtx,
    });
    expect(r.waterfall[0].amountPaise).toBe(5_000);
    expect(r.finalPayablePaise).toBe(0);
  });

  it('percent cap and budget clamp are honoured (last redemption honoured, FR-VEN-006)', () => {
    const r = evaluateWaterfall({
      lines: [line(1)],
      coupons: [coupon({ id: 'c', code: 'CAP', value: 5000, maxDiscountPaise: 20_000, budgetRemainingPaise: 12_345 })],
      qtyDeals: [],
      ctx: baseCtx,
    });
    expect(r.waterfall[0].amountPaise).toBe(12_345);
  });

  it('quantity deal needs minQty across eligible lines and never double-dips', () => {
    const base: EngineInput = {
      lines: [line(1, { listingId: 'LSTX', qty: 1 }), line(2, { listingId: 'LSTX', qty: 1 })],
      coupons: [],
      qtyDeals: [
        { id: 'd1', vendorId: 'V1', listingIds: ['LSTX'], minQty: 2, percentBp: 1000 },
        { id: 'd2', vendorId: 'V1', listingIds: ['LSTX'], minQty: 2, percentBp: 5000 },
      ],
      ctx: baseCtx,
    };
    const r = evaluateWaterfall(base);
    const deals = r.waterfall.filter((w) => w.stage === 'QTY_DEAL');
    expect(deals.map((d) => d.sourceId)).toEqual(['DEAL:d1']); // consumed lines excluded from d2
    const single = evaluateWaterfall({ ...base, lines: [line(1, { listingId: 'LSTX', qty: 1 })] });
    expect(single.waterfall.filter((w) => w.stage === 'QTY_DEAL')).toHaveLength(0);
  });

  it('loyalty and wallet-promo cap at the remaining payable (FR-CUS-020/019)', () => {
    const r = evaluateWaterfall({
      lines: [line(1, { unitListPaise: 10_000 })],
      coupons: [coupon({ id: 'c', code: 'NINETY', value: 9000 })], // ₹90 off ₹100
      qtyDeals: [],
      ctx: { ...baseCtx, loyaltyPointsPaise: 50_000, walletPromo: { requestedPaise: 50_000, balancePaise: 50_000 } },
    });
    const loyalty = r.waterfall.find((w) => w.stage === 'LOYALTY')!;
    expect(loyalty.amountPaise).toBe(1_000); // only ₹10 left
    expect(r.waterfall.find((w) => w.stage === 'WALLET_PROMO')).toBeUndefined();
    expect(r.finalPayablePaise).toBe(0);
  });

  it('every waterfall line allocation sums exactly to its amount', () => {
    const r = evaluateWaterfall({
      lines: [line(1, { qty: 3 }), line(2, { unitListPaise: 33_333 }), line(3, { unitListPaise: 77 })],
      coupons: [coupon({ id: 'c', code: 'ODD', value: 3333 })],
      qtyDeals: [],
      ctx: { ...baseCtx, loyaltyPointsPaise: 1_111 },
    });
    for (const w of r.waterfall) {
      expect(Object.values(w.allocation).reduce((a, b) => a + b, 0)).toBe(w.amountPaise);
    }
    expect(r.itemTotalPaise - r.savingsPaise).toBe(r.finalPayablePaise);
  });

  it('refund claw-back from the allocation map is exact per line (TC-FUN-104 pattern)', () => {
    const r = evaluateWaterfall({
      lines: [line(1), line(2, { unitListPaise: 60_000 }), line(3, { unitListPaise: 40_000 })],
      coupons: [coupon({ id: 'c', code: 'MIX', kind: 'FLAT', value: 29_999 })],
      qtyDeals: [],
      ctx: { ...baseCtx, loyaltyPointsPaise: 7_777 },
    });
    const totalClaw = ['L1', 'L2', 'L3'].map((id) => clawbackForLine(r, id)).reduce((a, b) => a + b, 0);
    expect(totalClaw).toBe(r.savingsPaise);
    // refunding L2 in full returns its net paid + reverses exactly its allocations
    expect(r.perLineNetPaise['L2'] + clawbackForLine(r, 'L2')).toBe(60_000);
  });

  it('property: 300 seeded random carts hold all invariants', () => {
    let s = 42;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
    for (let t = 0; t < 300; t++) {
      const nLines = 1 + Math.floor(rnd() * 8);
      const lines = Array.from({ length: nLines }, (_, i) =>
        line(i + 1, {
          vendorId: `V${1 + Math.floor(rnd() * 3)}`,
          qty: 1 + Math.floor(rnd() * 4),
          unitListPaise: 100 + Math.floor(rnd() * 200_000),
          ...(rnd() < 0.3 ? { unitSalePaise: 50 + Math.floor(rnd() * 90_000) } : {}),
        }),
      );
      const r = evaluateWaterfall({
        lines,
        coupons: [
          coupon({ id: 'p', code: 'P', value: 500 + Math.floor(rnd() * 3000) }),
          coupon({ id: 'v', code: 'V', level: 'VENDOR', vendorId: 'V1', kind: 'FLAT', value: 1 + Math.floor(rnd() * 50_000) }),
        ],
        qtyDeals: [],
        ctx: { ...baseCtx, loyaltyPointsPaise: Math.floor(rnd() * 30_000) },
      });
      expect(r.finalPayablePaise).toBeGreaterThanOrEqual(0);
      expect(r.itemTotalPaise - r.savingsPaise).toBe(r.finalPayablePaise);
      for (const v of Object.values(r.perLineNetPaise)) expect(v).toBeGreaterThanOrEqual(0);
      for (const w of r.waterfall) {
        expect(Object.values(w.allocation).reduce((a, b) => a + b, 0)).toBe(w.amountPaise);
      }
    }
  });

  it('meets the 80 ms p95 budget on 50-line carts (NFR hook in FR-MKT-010)', () => {
    const input: EngineInput = {
      lines: Array.from({ length: 50 }, (_, i) =>
        line(i + 1, { vendorId: `V${(i % 5) + 1}`, qty: (i % 3) + 1, unitListPaise: 10_000 + i * 137 }),
      ),
      coupons: [
        coupon({ id: 'p1', code: 'P1', value: 1000 }),
        coupon({ id: 'p2', code: 'P2', value: 1200 }),
        ...[1, 2, 3, 4, 5].map((v) =>
          coupon({ id: `v${v}`, code: `VC${v}`, level: 'VENDOR' as const, vendorId: `V${v}`, value: 400 }),
        ),
      ],
      qtyDeals: [{ id: 'd', vendorId: 'V1', listingIds: ['LST1', 'LST6'], minQty: 2, percentBp: 500 }],
      ctx: { ...baseCtx, loyaltyPointsPaise: 5_000, walletPromo: { requestedPaise: 3_000, balancePaise: 3_000 } },
    };
    const times: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now();
      evaluateWaterfall(input);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    // eslint-disable-next-line no-console
    console.info(`waterfall p95 on 50-line cart: ${p95.toFixed(3)} ms (budget 80 ms)`);
    expect(p95).toBeLessThan(80);
  });
});
