/**
 * FR-CUS-014 checkout acceptance criteria as tests. Traceability: FR-CUS-014 (quote,
 * revalidation, capture-to-the-paisa), BRU-03 (vendor split), BRU-05 (COD gate),
 * FR-CUS-007 (qty caps). Money exactness rides on the FR-MKT-010 engine (own suite).
 */
import { describe, expect, it } from 'vitest';
import {
  canCapture,
  COD_MAX_PAISE,
  createQuote,
  hashQuoteId,
  isExpired,
  QUOTE_VALIDITY_MS,
  reconcile,
  type CheckoutLine,
} from '../src/domain/checkout/quote.js';

const NOW = Date.UTC(2026, 7, 15, 10, 0, 0);

const line = (n: number, over: Partial<CheckoutLine> = {}): CheckoutLine => ({
  lineId: `L${n}`,
  listingId: `LST${n}`,
  vendorId: 'V1',
  categoryId: 'CAT1',
  qty: 1,
  unitListPaise: 100_000,
  availableStock: 100,
  serviceablePin: true,
  taxBps: 0,
  ...over,
});

const req = (over: Record<string, unknown> = {}) => ({
  cartId: 'CART1',
  customerId: 'CUS1',
  addressPin: '641012',
  lines: [line(1)],
  coupons: [],
  requestedPaymentMethod: 'PREPAID' as const,
  fraudScore: 0.1,
  codFraudThreshold: 0.7,
  nowMs: NOW,
  ...over,
});

const ok = (r: ReturnType<typeof createQuote>) => {
  if (!r.ok) throw new Error('expected ok quote, got problems: ' + JSON.stringify(r.problems));
  return r.quote;
};

describe('FR-CUS-014 quote engine', () => {
  it('produces a 10-minute quote whose sub-orders and lines reconcile to the paisa', () => {
    const q = ok(createQuote(req({
      lines: [line(1, { taxBps: 500 }), line(2, { vendorId: 'V2', unitListPaise: 60_000, taxBps: 1200 })],
    }), hashQuoteId));
    expect(q.expiresAtMs - q.createdAtMs).toBe(QUOTE_VALIDITY_MS);
    expect(reconcile(q)).toBe(true);
    expect(q.subOrders).toHaveLength(2);                        // BRU-03 split by vendor
    const subSum = q.subOrders.reduce((a, s) => a + s.grandPaise, 0);
    expect(subSum).toBe(q.grandTotalPaise);
  });

  it('revalidation fails the whole quote and reports every bad line (FR-CUS-014 resolution UI)', () => {
    const r = createQuote(req({
      lines: [
        line(1, { qty: 5, availableStock: 2 }),                 // OUT_OF_STOCK
        line(2, { qty: 4, categoryQtyCap: 3 }),                 // QTY_OVER_CATEGORY_CAP
        line(3, { serviceablePin: false }),                     // PIN_NOT_SERVICEABLE
        line(4),                                                // fine
      ],
    }), hashQuoteId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(3);
    expect(r.problems.map((p) => p.reason).sort()).toEqual(
      ['OUT_OF_STOCK', 'PIN_NOT_SERVICEABLE', 'QTY_OVER_CATEGORY_CAP'],
    );
  });

  it('qty over the 1–10 line cap is rejected at the schema boundary (FR-CUS-007)', () => {
    expect(() => createQuote(req({ lines: [line(1, { qty: 11 })] }), hashQuoteId)).toThrow();
  });

  it('applies a platform coupon through the promotions engine and taxes the discounted net', () => {
    const q = ok(createQuote(req({
      lines: [line(1, { unitListPaise: 100_000, taxBps: 1800 })],
      coupons: [{
        id: 'c1', code: 'SAVE10', level: 'PLATFORM', kind: 'PERCENT', value: 1000,
        minOrderPaise: 0, firstOrderOnly: false, perUserRemaining: 1, autoApply: true,
        stackWithVendorCoupon: true,
      }],
    }), hashQuoteId));
    expect(q.discountTotalPaise).toBe(10_000);                  // 10% of ₹1000
    // tax on the discounted ₹900 net at 18% = ₹162
    expect(q.taxTotalPaise).toBe(16_200);
    expect(q.grandTotalPaise).toBe(90_000 + 16_200);
  });

  describe('BRU-05 COD gate', () => {
    it('refuses COD above ₹10,000 and forces prepaid, with reason', () => {
      const q = ok(createQuote(req({
        lines: [line(1, { unitListPaise: COD_MAX_PAISE + 1 })],
        requestedPaymentMethod: 'COD',
      }), hashQuoteId));
      expect(q.codEligible).toBe(false);
      expect(q.codReasons.some((r) => r.startsWith('ORDER_VALUE_OVER_10000'))).toBe(true);
      expect(q.paymentMethod).toBe('PREPAID');
    });

    it('refuses COD when fraud score is at/above threshold', () => {
      const q = ok(createQuote(req({
        lines: [line(1, { unitListPaise: 50_000 })],
        requestedPaymentMethod: 'COD', fraudScore: 0.7,
      }), hashQuoteId));
      expect(q.codEligible).toBe(false);
      expect(q.codReasons).toContain('FRAUD_SCORE_ABOVE_THRESHOLD');
    });

    it('allows COD when value, PIN and fraud score are all within policy', () => {
      const q = ok(createQuote(req({
        lines: [line(1, { unitListPaise: 50_000 })],
        requestedPaymentMethod: 'COD', fraudScore: 0.2,
      }), hashQuoteId));
      expect(q.codEligible).toBe(true);
      expect(q.paymentMethod).toBe('COD');
      expect(q.codReasons).toEqual([]);
    });
  });

  describe('capture guard (FR-CUS-014 acceptance)', () => {
    it('accepts a capture that matches grand total exactly and is within the window', () => {
      const q = ok(createQuote(req({ lines: [line(1, { taxBps: 500 })] }), hashQuoteId));
      expect(canCapture(q, q.grandTotalPaise, NOW + 60_000)).toEqual({ ok: true });
    });

    it('rejects a capture one paisa off (anti-tamper: totals recomputed server-side)', () => {
      const q = ok(createQuote(req(), hashQuoteId));
      expect(canCapture(q, q.grandTotalPaise + 1, NOW)).toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
    });

    it('rejects capture after the 10-minute quote expiry', () => {
      const q = ok(createQuote(req(), hashQuoteId));
      expect(isExpired(q, q.expiresAtMs)).toBe(false);
      expect(isExpired(q, q.expiresAtMs + 1)).toBe(true);
      expect(canCapture(q, q.grandTotalPaise, q.expiresAtMs + 1)).toEqual({ ok: false, reason: 'QUOTE_EXPIRED' });
    });
  });

  it('is deterministic: identical requests yield identical quote ids and totals', () => {
    const a = ok(createQuote(req({ lines: [line(1), line(2, { vendorId: 'V2' })] }), hashQuoteId));
    const b = ok(createQuote(req({ lines: [line(1), line(2, { vendorId: 'V2' })] }), hashQuoteId));
    expect(a.quoteId).toBe(b.quoteId);
    expect(a.grandTotalPaise).toBe(b.grandTotalPaise);
    expect(a.signaturePayload).toBe(b.signaturePayload);
  });

  it('signature payload binds quoteId, grand total, expiry and per-line nets', () => {
    const q = ok(createQuote(req({ lines: [line(1, { taxBps: 500 }), line(2)] }), hashQuoteId));
    const parsed = JSON.parse(q.signaturePayload);
    expect(parsed.quoteId).toBe(q.quoteId);
    expect(parsed.grandTotalPaise).toBe(q.grandTotalPaise);
    expect(parsed.expiresAtMs).toBe(q.expiresAtMs);
    expect(parsed.lines).toEqual(q.lines.map((l) => [l.lineId, l.netPaise]));
  });
});
