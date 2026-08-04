/**
 * FR-CUS-007 cart as tests, plus a cross-slice proof that the cart's emitted checkout
 * lines drive the Slice-3 FR-CUS-014 quote engine end to end.
 */
import { describe, expect, it } from 'vitest';
import {
  addItem,
  emptyCart,
  groupByVendor,
  isExpired,
  MAX_QTY_PER_LINE,
  mergeGuestInto,
  moveToCart,
  quarantineSuspendedVendors,
  revalidate,
  saveForLater,
  toCheckoutLines,
  updateQty,
  type Cart,
  type LineFacts,
} from '../src/domain/cart/cart.js';
import { createQuote, hashQuoteId } from '../src/domain/checkout/quote.js';

const NOW = Date.UTC(2026, 7, 15, 10, 0, 0);

const seed = (): Cart => {
  let c = emptyCart('CART-1', 'CUS-1', NOW);
  c = (addItem(c, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 2, unitPriceAtAddPaise: 100_000 }, NOW) as any).cart;
  c = (addItem(c, { listingId: 'L2', vendorId: 'V2', categoryId: 'CAT2', qty: 1, unitPriceAtAddPaise: 60_000 }, NOW) as any).cart;
  return c;
};

describe('add / update / remove with qty caps', () => {
  it('adding the same listing combines quantities, clamped to the cap', () => {
    let c = emptyCart('C', 'U', NOW);
    c = (addItem(c, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 7, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    c = (addItem(c, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 8, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    expect(c.active).toHaveLength(1);
    expect(c.active[0].qty).toBe(MAX_QTY_PER_LINE); // 7+8 clamped to 10
  });

  it('updateQty to 0 removes the line; above cap is rejected', () => {
    const c = seed();
    const removed = updateQty(c, 'L1', 0, NOW);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.cart.active.find((l) => l.listingId === 'L1')).toBeUndefined();
    const over = updateQty(c, 'L1', 11, NOW);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('QTY_OVER_CAP');
  });

  it('rejects add of qty < 1 and update of a missing line', () => {
    const c = seed();
    expect(addItem(c, { listingId: 'L9', vendorId: 'V', categoryId: 'C', qty: 0, unitPriceAtAddPaise: 1 }, NOW).ok).toBe(false);
    expect(updateQty(c, 'MISSING', 3, NOW).ok).toBe(false);
  });
});

describe('saved-for-later and per-vendor grouping', () => {
  it('moves a line to saved-for-later and back', () => {
    const c = seed();
    const saved = saveForLater(c, 'L1', NOW);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.cart.active.some((l) => l.listingId === 'L1')).toBe(false);
    expect(saved.cart.savedForLater.some((l) => l.listingId === 'L1')).toBe(true);
    const back = moveToCart(saved.cart, 'L1', NOW);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.cart.active.some((l) => l.listingId === 'L1')).toBe(true);
  });

  it('groups active lines by vendor in first-seen order', () => {
    const groups = groupByVendor(seed());
    expect(groups.map((g) => g.vendorId)).toEqual(['V1', 'V2']);
  });
});

describe('suspended-vendor quarantine (RULES)', () => {
  it('auto-moves suspended-vendor lines to saved-for-later and reports them', () => {
    const { cart, movedListingIds } = quarantineSuspendedVendors(seed(), new Set(['V2']), NOW);
    expect(movedListingIds).toEqual(['L2']);
    expect(cart.active.some((l) => l.listingId === 'L2')).toBe(false);
    expect(cart.savedForLater.some((l) => l.listingId === 'L2')).toBe(true);
  });
});

describe('guest-cart merge on login (RULES)', () => {
  it('unions active lines, summing and clamping quantities', () => {
    let user = emptyCart('U', 'CUS-1', NOW);
    user = (addItem(user, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 4, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    let guest = emptyCart('G', null, NOW);
    guest = (addItem(guest, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 8, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    guest = (addItem(guest, { listingId: 'L3', vendorId: 'V3', categoryId: 'CAT3', qty: 1, unitPriceAtAddPaise: 500 }, NOW) as any).cart;
    const merged = mergeGuestInto(user, guest, NOW);
    expect(merged.active).toHaveLength(2);
    expect(merged.active.find((l) => l.listingId === 'L1')!.qty).toBe(MAX_QTY_PER_LINE); // 4+8 → 10
    expect(merged.active.find((l) => l.listingId === 'L3')).toBeTruthy();
  });

  it('does not duplicate a guest saved-for-later item that is active after merge', () => {
    let user = emptyCart('U', 'CUS-1', NOW);
    user = (addItem(user, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 2, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    let guest = emptyCart('G', null, NOW);
    guest = (addItem(guest, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 1, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    guest = (saveForLater(guest, 'L1', NOW) as any).cart; // guest saved L1 for later
    // re-add L1 active in guest too
    guest = (addItem(guest, { listingId: 'L1', vendorId: 'V1', categoryId: 'CAT1', qty: 1, unitPriceAtAddPaise: 100 }, NOW) as any).cart;
    const merged = mergeGuestInto(user, guest, NOW);
    expect(merged.active.some((l) => l.listingId === 'L1')).toBe(true);
    expect(merged.savedForLater.some((l) => l.listingId === 'L1')).toBe(false);
  });
});

describe('revalidation preview (read-only, BRU-04 deltas)', () => {
  const facts = (over: Partial<Record<string, LineFacts>> = {}): Map<string, LineFacts> => new Map<string, LineFacts>([
    ['L1', { listingId: 'L1', currentPricePaise: 100_000, availableStock: 10 }],
    ['L2', { listingId: 'L2', currentPricePaise: 60_000, availableStock: 5 }],
    ...Object.entries(over) as any,
  ]);

  it('flags price changes without mutating the cart', () => {
    const c = seed();
    const pv = revalidate(c, facts({ L1: { listingId: 'L1', currentPricePaise: 90_000, availableStock: 10 } }));
    const l1 = pv.find((p) => p.listingId === 'L1')!;
    expect(l1.status).toBe('PRICE_CHANGED');
    if (l1.status === 'PRICE_CHANGED') { expect(l1.fromPaise).toBe(100_000); expect(l1.toPaise).toBe(90_000); }
    expect(c.active.find((l) => l.listingId === 'L1')!.unitPriceAtAddPaise).toBe(100_000); // unchanged
  });

  it('flags out-of-stock, qty-over-stock, and suspended vendor', () => {
    const c = seed();
    const pv = revalidate(c, facts({
      L1: { listingId: 'L1', currentPricePaise: 100_000, availableStock: 0 },
      L2: { listingId: 'L2', currentPricePaise: 60_000, availableStock: 5, vendorSuspended: true },
    }));
    expect(pv.find((p) => p.listingId === 'L1')!.status).toBe('OUT_OF_STOCK');
    expect(pv.find((p) => p.listingId === 'L2')!.status).toBe('VENDOR_SUSPENDED');
  });

  it('90-day TTL expiry', () => {
    const c = seed();
    expect(isExpired(c, NOW + 90 * 24 * 3600 * 1000)).toBe(false);
    expect(isExpired(c, NOW + 90 * 24 * 3600 * 1000 + 1)).toBe(true);
  });
});

describe('cross-slice: cart → FR-CUS-014 quote engine', () => {
  it('cart emits checkout lines that the quote engine prices and splits per vendor', () => {
    const c = seed(); // L1 (V1, ₹1000 ×2), L2 (V2, ₹600 ×1)
    const facts = new Map<string, LineFacts>([
      ['L1', { listingId: 'L1', currentPricePaise: 100_000, availableStock: 10 }],
      ['L2', { listingId: 'L2', currentPricePaise: 60_000, availableStock: 5 }],
    ]);
    const lines = toCheckoutLines(c, facts, { serviceablePin: true, taxBpsFor: () => 0 });
    expect(lines).toHaveLength(2);

    const r = createQuote({
      cartId: c.cartId, customerId: 'CUS-1', addressPin: '641012',
      lines, coupons: [], requestedPaymentMethod: 'PREPAID', fraudScore: 0.1, codFraudThreshold: 0.7, nowMs: NOW,
    }, hashQuoteId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // grand total = 2×₹1000 + 1×₹600 = ₹2600
    expect(r.quote.grandTotalPaise).toBe(2_60_000);
    expect(r.quote.subOrders).toHaveLength(2); // BRU-03 split preserved from cart vendors
  });

  it('excludes suspended-vendor lines from what is sent to checkout', () => {
    const c = seed();
    const facts = new Map<string, LineFacts>([
      ['L1', { listingId: 'L1', currentPricePaise: 100_000, availableStock: 10 }],
      ['L2', { listingId: 'L2', currentPricePaise: 60_000, availableStock: 5, vendorSuspended: true }],
    ]);
    const lines = toCheckoutLines(c, facts, { serviceablePin: true, taxBpsFor: () => 0 });
    expect(lines.map((l) => l.listingId)).toEqual(['L1']); // L2 excluded
  });
});
