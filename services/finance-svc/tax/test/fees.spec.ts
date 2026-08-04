/**
 * FR-FIN-001 commission & fee engine acceptance & validation as tests. Traceability:
 * FR-FIN-001 (versioned schedules, determinism, refund reversal), BRU-08 formula.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLineFee,
  isOverrideWithinBounds,
  rateForBase,
  resolveSchedule,
  reverseFeeOnRefund,
  type FeeLineInput,
  type FeeSchedule,
} from '../src/domain/fees.js';

const schedules: FeeSchedule[] = [
  {
    categoryId: 'FASHION',
    version: 3,
    effectiveFrom: '2026-01-01',
    commissionSlabs: [
      { minPaise: 0, maxPaise: 50_000, rateBps: 500 },        // <₹500 → 5%
      { minPaise: 50_000, maxPaise: 2_00_000, rateBps: 1000 }, // ₹500–2000 → 10%
      { minPaise: 2_00_000, rateBps: 1500 },                   // ≥₹2000 → 15%
    ],
    paymentFeeBps: 200,        // 2% payment fee
    logisticsFeePaise: 5_000,  // ₹50 flat when platform-shipped
    storageFeePaise: 1_000,
  },
  {
    categoryId: 'FASHION',
    version: 2,
    effectiveFrom: '2025-01-01',
    effectiveTo: '2026-01-01',
    commissionSlabs: [{ minPaise: 0, rateBps: 800 }],
    paymentFeeBps: 250,
    logisticsFeePaise: 4_000,
  },
];

const line = (over: Partial<FeeLineInput> = {}): FeeLineInput => ({
  lineId: 'L1',
  categoryId: 'FASHION',
  basePaise: 1_00_000,   // ₹1000 taxable base → 10% slab
  paidPaise: 1_00_000,
  platformShipped: true,
  platformFundedPromoPaise: 0,
  ...over,
});

const okFee = (r: ReturnType<typeof computeLineFee>) => {
  if (!r.ok) throw new Error('expected ok fee, got ' + r.reason);
  return r.breakdown;
};

describe('FR-FIN-001 commission & fee engine', () => {
  it('BRU-08: net = commission + payment + logistics − platform-funded promo', () => {
    const b = okFee(computeLineFee(line({ platformFundedPromoPaise: 3_000 }), schedules, '2026-06-15'));
    expect(b.commissionPaise).toBe(10_000); // 10% of ₹1000
    expect(b.paymentFeePaise).toBe(2_000);  // 2% of ₹1000
    expect(b.logisticsFeePaise).toBe(5_000);
    expect(b.netFeePaise).toBe(10_000 + 2_000 + 5_000 - 3_000);
  });

  it('logistics fee applies only when platform-shipped', () => {
    const self = okFee(computeLineFee(line({ platformShipped: false }), schedules, '2026-06-15'));
    expect(self.logisticsFeePaise).toBe(0);
    expect(self.netFeePaise).toBe(10_000 + 2_000);
  });

  it('slab boundaries pick the right commission rate', () => {
    expect(rateForBase(schedules[0].commissionSlabs, 49_999)).toEqual({ ok: true, rateBps: 500 });
    expect(rateForBase(schedules[0].commissionSlabs, 50_000)).toEqual({ ok: true, rateBps: 1000 });
    expect(rateForBase(schedules[0].commissionSlabs, 2_00_000)).toEqual({ ok: true, rateBps: 1500 });
  });

  it('acceptance: replaying the same event yields identical fee lines (deterministic)', () => {
    const a = okFee(computeLineFee(line(), schedules, '2026-06-15'));
    const b = okFee(computeLineFee(line(), schedules, '2026-06-15'));
    expect(a).toEqual(b);
  });

  it('effective-dating: an order in 2025 uses the older schedule version', () => {
    const older = okFee(computeLineFee(line(), schedules, '2025-06-15'));
    expect(older.commissionPaise).toBe(8_000); // v2: flat 8%
    expect(older.logisticsFeePaise).toBe(4_000);
  });

  it('acceptance: a full refund reverses commission but retains payment fee when configured', () => {
    const b = okFee(computeLineFee(line(), schedules, '2026-06-15'));
    const rev = reverseFeeOnRefund(b, 1.0, false); // payment fee non-refundable
    expect(rev.commissionReversalPaise).toBe(10_000); // full commission clawed back
    expect(rev.logisticsReversalPaise).toBe(5_000);
    expect(rev.paymentFeeReversalPaise).toBe(0);      // retained
  });

  it('partial refund reverses fees proportionally', () => {
    const b = okFee(computeLineFee(line(), schedules, '2026-06-15'));
    const rev = reverseFeeOnRefund(b, 0.5, true);
    expect(rev.commissionReversalPaise).toBe(5_000);
    expect(rev.paymentFeeReversalPaise).toBe(1_000);
    expect(rev.logisticsReversalPaise).toBe(2_500);
  });

  it('VALIDATION: overrides are bounded to ±30% of the base rate', () => {
    expect(isOverrideWithinBounds(1000, 1000)).toBe(true);
    expect(isOverrideWithinBounds(1000, 1300)).toBe(true);  // +30%
    expect(isOverrideWithinBounds(1000, 700)).toBe(true);   // −30%
    expect(isOverrideWithinBounds(1000, 1301)).toBe(false);
    expect(isOverrideWithinBounds(1000, 699)).toBe(false);
  });

  it('a missing schedule or uncovered base is rejected, not defaulted', () => {
    const noSched = computeLineFee(line({ categoryId: 'UNKNOWN' }), schedules, '2026-06-15');
    expect(noSched.ok).toBe(false);
    if (!noSched.ok) expect(noSched.reason).toContain('NO_ACTIVE_SCHEDULE');

    const gapSchedule: FeeSchedule[] = [{
      categoryId: 'GAP', version: 1, effectiveFrom: '2026-01-01',
      commissionSlabs: [{ minPaise: 0, maxPaise: 10_000, rateBps: 500 }], // covers only <₹100
      paymentFeeBps: 200, logisticsFeePaise: 0,
    }];
    const uncovered = computeLineFee(line({ categoryId: 'GAP', basePaise: 50_000 }), gapSchedule, '2026-06-15');
    expect(uncovered.ok).toBe(false);
    if (!uncovered.ok) expect(uncovered.reason).toContain('NO_SLAB_COVERS_BASE');
  });

  it('ambiguous overlapping schedules are rejected', () => {
    const overlap: FeeSchedule[] = [
      { categoryId: 'X', version: 1, effectiveFrom: '2025-01-01', commissionSlabs: [{ minPaise: 0, rateBps: 500 }], paymentFeeBps: 0, logisticsFeePaise: 0 },
      { categoryId: 'X', version: 2, effectiveFrom: '2025-06-01', commissionSlabs: [{ minPaise: 0, rateBps: 600 }], paymentFeeBps: 0, logisticsFeePaise: 0 },
    ];
    expect(resolveSchedule(overlap, 'X', '2026-06-15').ok).toBe(false);
  });
});
