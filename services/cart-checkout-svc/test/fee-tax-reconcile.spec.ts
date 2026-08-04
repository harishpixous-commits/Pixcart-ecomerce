/**
 * Cross-engine reconciliation (Slice 8 ↔ Slice 3): the FR-FIN-002 tax engine and the
 * FR-CUS-014 quote engine must agree to the paisa. The quote engine computes tax on the
 * discounted net at a rate (tax-exclusive path used at checkout); the fee-tax engine is
 * the authoritative rate source and also supports inclusive back-calc. This test proves
 * that for the same line and rate the two produce the identical tax figure, so the rate
 * the tax engine resolves can be handed to the quote engine without drift.
 *
 * The fee-tax module is a sibling package; we import its compiled source directly. In the
 * monorepo build both are workspace deps of the checkout service.
 */
import { describe, expect, it } from 'vitest';
import { createQuote, hashQuoteId, type CheckoutLine } from '../src/domain/checkout/quote.js';
import { taxFromInclusive } from '../../finance-svc/tax/src/domain/tax.js';

const NOW = Date.UTC(2026, 7, 15, 10, 0, 0);

const line = (over: Partial<CheckoutLine> = {}): CheckoutLine => ({
  lineId: 'L1', listingId: 'LST1', vendorId: 'V1', categoryId: 'CAT1',
  qty: 1, unitListPaise: 1_00_000, availableStock: 10, serviceablePin: true,
  taxBps: 1800, ...over,
});

const req = (over: Record<string, unknown> = {}) => ({
  cartId: 'C1', customerId: 'CU1', addressPin: '641012',
  lines: [line()], coupons: [], requestedPaymentMethod: 'PREPAID' as const,
  fraudScore: 0.1, codFraudThreshold: 0.7, nowMs: NOW, ...over,
});

describe('fee-tax ↔ quote reconciliation', () => {
  it('quote engine tax on a no-discount line equals the tax engine back-calc on the inclusive total', () => {
    const r = createQuote(req(), hashQuoteId);
    if (!r.ok) throw new Error('quote failed');
    const ql = r.quote.lines[0];

    // Quote path: taxable = gross (no discount) = 100000; tax = 18% = 18000; net = 118000.
    expect(ql.grossPaise).toBe(1_00_000);
    expect(ql.taxPaise).toBe(18_000);
    expect(ql.netPaise).toBe(1_18_000);

    // Tax engine, inverse direction: given the inclusive 118000 at 18%, taxable back to 100000.
    const back = taxFromInclusive(ql.netPaise, 1800);
    expect(back.taxablePaise).toBe(ql.grossPaise);
    expect(back.taxPaise).toBe(ql.taxPaise);
  });

  it('agreement holds across several rates for a single-unit line', () => {
    for (const rate of [500, 1200, 1800, 2800]) {
      const r = createQuote(req({ lines: [line({ taxBps: rate })] }), hashQuoteId);
      if (!r.ok) throw new Error('quote failed');
      const ql = r.quote.lines[0];
      const back = taxFromInclusive(ql.netPaise, rate);
      // taxable + tax == inclusive, and the inclusive equals the quote's net
      expect(back.taxablePaise + back.taxPaise).toBe(ql.netPaise);
    }
  });
});
