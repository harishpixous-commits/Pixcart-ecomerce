import { describe, it, expect } from 'vitest';
import {
  createQuote, canCapture, isExpired, reconcile, hashQuoteId,
  QUOTE_VALIDITY_MS, COD_MAX_PAISE,
  type CheckoutRequest, type CheckoutLine,
} from './quote.js';

/**
 * Real test (no mocks): the FR-CUS-014 quote engine is pure, so we assert its
 * actual arithmetic — the BRU-05 COD gate (order value <= Rs.10,000, serviceable
 * PIN, fraud below threshold), the BRU-03 vendor sub-order split, and the
 * capture-time guard that a payment must match the quote to the paisa.
 */
function line(overrides: Partial<CheckoutLine> = {}): CheckoutLine {
  return {
    lineId: 'L1',
    listingId: 'listing-1',
    vendorId: 'vendor-1',
    categoryId: 'cat-1',
    qty: 1,
    unitListPaise: 50_000, // Rs.500
    availableStock: 10,
    taxBps: 0,
    // `serviceablePin` is required; the not-serviceable fixture overrides
    // it to false explicitly.
    serviceablePin: overrides.serviceablePin ?? true,
    ...overrides,
  };
}

function request(overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    cartId: 'cart-1',
    customerId: 'cust-1',
    addressPin: '600001',
    lines: [line()],
    coupons: [],
    requestedPaymentMethod: 'COD',
    fraudScore: 0.1,
    codFraudThreshold: 0.7,
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe('createQuote', () => {
  it('allows COD for a small, serviceable, low-fraud order', () => {
    const result = createQuote(request(), hashQuoteId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.codEligible).toBe(true);
    expect(result.quote.paymentMethod).toBe('COD');
    expect(result.quote.grandTotalPaise).toBe(50_000);
  });

  it('refuses COD when the order exceeds Rs.10,000 and forces prepaid', () => {
    // Rs.12,000 > Rs.10,000 -> BRU-05 gate trips.
    const result = createQuote(
      request({ lines: [line({ unitListPaise: 1_200_000 })] }),
      hashQuoteId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.codEligible).toBe(false);
    expect(result.quote.codReasons.some((r) => r.includes('ORDER_VALUE_OVER_10000'))).toBe(true);
    expect(result.quote.paymentMethod).toBe('PREPAID'); // gate forces prepaid
    expect(COD_MAX_PAISE).toBe(10_000 * 100);
  });

  it('refuses COD when the PIN is not serviceable', () => {
    // An unserviceable PIN is a hard quote blocker: createQuote refuses the
    // whole quote with a PIN_NOT_SERVICEABLE line problem (422 path) before it
    // ever computes COD eligibility. So we assert the refusal, not codEligible.
    const result = createQuote(
      request({ lines: [line({ serviceablePin: false })] }),
      hashQuoteId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { lineId: 'L1', reason: 'PIN_NOT_SERVICEABLE' },
    ]);
  });

  it('refuses COD when the fraud score meets the threshold', () => {
    const result = createQuote(request({ fraudScore: 0.9 }), hashQuoteId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.codEligible).toBe(false);
    expect(result.quote.codReasons).toContain('FRAUD_SCORE_ABOVE_THRESHOLD');
  });

  it('splits two vendors into two BRU-03 sub-orders that reconcile to the grand total', () => {
    const result = createQuote(
      request({
        lines: [
          line({ lineId: 'L1', vendorId: 'vendor-1', unitListPaise: 50_000 }),
          line({ lineId: 'L2', vendorId: 'vendor-2', unitListPaise: 30_000 }),
        ],
      }),
      hashQuoteId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.subOrders).toHaveLength(2);
    expect(result.quote.subOrders.map((s) => s.vendorId)).toEqual(['vendor-1', 'vendor-2']);
    expect(reconcile(result.quote)).toBe(true);
    expect(result.quote.grandTotalPaise).toBe(80_000);
  });

  it('reports OUT_OF_STOCK and produces no quote when a line exceeds stock', () => {
    const result = createQuote(
      request({ lines: [line({ qty: 5, availableStock: 2 })] }),
      hashQuoteId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      { lineId: 'L1', reason: 'OUT_OF_STOCK', available: 2 },
    ]);
  });

  it('sets a 10-minute validity window', () => {
    const result = createQuote(request(), hashQuoteId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.expiresAtMs - result.quote.createdAtMs).toBe(QUOTE_VALIDITY_MS);
  });
});

describe('canCapture', () => {
  const quote = (() => {
    const r = createQuote(request(), hashQuoteId);
    if (!r.ok) throw new Error('fixture quote must build');
    return r.quote;
  })();

  it('accepts a capture that matches the grand total exactly', () => {
    expect(canCapture(quote, quote.grandTotalPaise, quote.createdAtMs + 1000)).toEqual({ ok: true });
  });

  it('rejects a capture that is off by one paisa (FR-CUS-014: match to the paisa)', () => {
    expect(canCapture(quote, quote.grandTotalPaise + 1, quote.createdAtMs + 1000))
      .toEqual({ ok: false, reason: 'AMOUNT_MISMATCH' });
  });

  it('rejects a capture after the quote expires', () => {
    expect(canCapture(quote, quote.grandTotalPaise, quote.expiresAtMs + 1))
      .toEqual({ ok: false, reason: 'QUOTE_EXPIRED' });
    expect(isExpired(quote, quote.expiresAtMs + 1)).toBe(true);
    expect(isExpired(quote, quote.expiresAtMs)).toBe(false); // boundary is inclusive
  });
});
