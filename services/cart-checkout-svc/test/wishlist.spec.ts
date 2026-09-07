/**
 * FR-CUS-006 wishlist. The property the suite is built around is that the SAVED price is the
 * comparison base and never moves: that is what lets the feature tell a customer something
 * changed, and what stops a vendor manufacturing an apparent discount by raising the price after
 * the save.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_MIN_INTERVAL_MS,
  MAX_WISHLIST_ITEMS,
  OUT_OF_STOCK_RETENTION_DAYS,
  Wishlist,
  type ListingSnapshot,
} from '../src/domain/wishlist.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);
const DAY = 24 * 3600 * 1000;

const listing = (over: Partial<ListingSnapshot> = {}): ListingSnapshot => ({
  listingId: 'LST-1', state: 'APPROVED', pricePaise: 2_000_00, availableStock: 20, ...over,
});

const saved = (over: Partial<ListingSnapshot> = {}, threshold?: number) => {
  const w = new Wishlist('CUS-1');
  const r = w.add(listing(over), true, NOW, threshold);
  if (r.outcome !== 'ADDED') throw new Error('expected ADDED, got ' + r.outcome);
  return w;
};

// ============================================ the acceptance criterion

describe('the documented acceptance scenario: a drop below the opted threshold alerts', () => {
  it('alerts when the drop meets the customer threshold', () => {
    const w = saved({}, 10);                      // saved at ₹2,000, alert at 10%
    const entry = w.entry('LST-1')!;
    const dropped = listing({ pricePaise: 1_700_00 });   // a 15% drop

    const decision = w.shouldAlert(dropped, entry, NOW + DAY);
    expect(decision.alert).toBe(true);
    if (decision.alert) expect(decision.dropPercent).toBe(15);
  });

  it('does NOT alert when the drop is below the threshold', () => {
    const w = saved({}, 20);
    const decision = w.shouldAlert(listing({ pricePaise: 1_800_00 }), w.entry('LST-1')!, NOW + DAY);
    expect(decision.alert).toBe(false);
    if (!decision.alert) expect(decision.reason).toContain('DROP_BELOW_THRESHOLD');
  });

  it('the threshold boundary is inclusive', () => {
    const w = saved({}, 10);
    // exactly 10% off ₹2,000 is ₹1,800
    expect(w.shouldAlert(listing({ pricePaise: 1_800_00 }), w.entry('LST-1')!, NOW + DAY).alert).toBe(true);
  });

  it('never alerts a customer who did not opt in', () => {
    const w = saved();                            // no threshold given
    const d = w.shouldAlert(listing({ pricePaise: 100_00 }), w.entry('LST-1')!, NOW + DAY);
    expect(d.alert).toBe(false);
    if (!d.alert) expect(d.reason).toBe('NOT_OPTED_IN');
  });

  it('does not alert on a price RISE', () => {
    const w = saved({}, 10);
    const d = w.shouldAlert(listing({ pricePaise: 2_500_00 }), w.entry('LST-1')!, NOW + DAY);
    expect(d.alert).toBe(false);
    if (!d.alert) expect(d.reason).toBe('PRICE_NOT_LOWER_THAN_SAVED');
  });

  it('does not alert about a bargain nobody can buy', () => {
    const w = saved({}, 10);
    const d = w.shouldAlert(listing({ pricePaise: 1_000_00, availableStock: 0 }), w.entry('LST-1')!, NOW + DAY);
    expect(d.alert).toBe(false);
    if (!d.alert) expect(d.reason).toBe('OUT_OF_STOCK');
  });

  it('does not alert on a withdrawn listing', () => {
    const w = saved({}, 10);
    const d = w.shouldAlert(listing({ pricePaise: 1_000_00, state: 'WITHDRAWN' }), w.entry('LST-1')!, NOW + DAY);
    expect(d.alert).toBe(false);
  });
});

describe('alert frequency is capped at one per listing per day (RULES)', () => {
  it('suppresses a second alert inside 24 hours and permits one after', () => {
    const w = saved({}, 10);
    const cheap = listing({ pricePaise: 1_500_00 });

    expect(w.shouldAlert(cheap, w.entry('LST-1')!, NOW + DAY).alert).toBe(true);
    w.recordAlertSent('LST-1', NOW + DAY);

    const tooSoon = w.shouldAlert(cheap, w.entry('LST-1')!, NOW + DAY + ALERT_MIN_INTERVAL_MS - 1);
    expect(tooSoon.alert).toBe(false);
    if (!tooSoon.alert) expect(tooSoon.reason).toBe('ALERT_ALREADY_SENT_TODAY');

    expect(w.shouldAlert(cheap, w.entry('LST-1')!, NOW + DAY + ALERT_MIN_INTERVAL_MS).alert).toBe(true);
    expect(ALERT_MIN_INTERVAL_MS).toBe(86_400_000);
  });
});

// ============================================ saved-price integrity

describe('the saved price is the comparison base and never moves', () => {
  it('badges are computed against the saved price, not the current one', () => {
    const w = saved();
    const view = w.view(listing({ pricePaise: 1_760_00 }), w.entry('LST-1')!);
    expect(view.savedPricePaise).toBe(2_000_00);
    expect(view.currentPricePaise).toBe(1_760_00);
    const drop = view.badges.find((b) => b.kind === 'PRICE_DROP');
    expect(drop).toBeDefined();
    expect(drop!.label).toBe('price ↓ 12%');
  });

  it('re-adding does NOT reset the saved price, so a later rise cannot fake a discount', () => {
    const w = saved();
    // the vendor raises the price, then the customer taps the heart again
    const r = w.add(listing({ pricePaise: 3_000_00 }), true, NOW + DAY);
    expect(r.outcome).toBe('COALESCED');
    expect(w.entry('LST-1')!.savedPricePaise).toBe(2_000_00);

    // a subsequent "drop" back to the original is correctly NOT a discount
    const view = w.view(listing({ pricePaise: 2_000_00 }), w.entry('LST-1')!);
    expect(view.badges.find((b) => b.kind === 'PRICE_DROP')).toBeUndefined();
  });

  it('reports a price rise honestly rather than hiding it', () => {
    const w = saved();
    const rise = w.view(listing({ pricePaise: 2_400_00 }), w.entry('LST-1')!)
      .badges.find((b) => b.kind === 'PRICE_RISE');
    expect(rise).toBeDefined();
    expect(rise!.label).toBe('price ↑ 20%');
  });

  it('a sub-1% movement earns no badge, so the list is not noisy', () => {
    const w = saved();
    const view = w.view(listing({ pricePaise: 1_999_00 }), w.entry('LST-1')!);
    expect(view.badges.filter((b) => b.kind === 'PRICE_DROP' || b.kind === 'PRICE_RISE')).toEqual([]);
  });
});

describe('stock badges (OUTPUTS)', () => {
  it('shows "only N left" at low stock and "out of stock" at zero', () => {
    const w = saved();
    const low = w.view(listing({ availableStock: 2 }), w.entry('LST-1')!);
    const lowBadge = low.badges.find((b) => b.kind === 'LOW_STOCK');
    expect(lowBadge).toBeDefined();
    expect(lowBadge!.label).toBe('only 2 left');

    const none = w.view(listing({ availableStock: 0 }), w.entry('LST-1')!);
    expect(none.badges.some((b) => b.kind === 'OUT_OF_STOCK')).toBe(true);
    expect(none.badges.some((b) => b.kind === 'LOW_STOCK')).toBe(false);
  });

  it('healthy stock earns no stock badge', () => {
    const w = saved();
    const view = w.view(listing({ availableStock: 50 }), w.entry('LST-1')!);
    expect(view.badges.some((b) => b.kind === 'LOW_STOCK' || b.kind === 'OUT_OF_STOCK')).toBe(false);
  });

  it('price and stock badges appear together when both apply', () => {
    const w = saved();
    const view = w.view(listing({ pricePaise: 1_600_00, availableStock: 1 }), w.entry('LST-1')!);
    expect(view.badges.map((b) => b.kind).sort()).toEqual(['LOW_STOCK', 'PRICE_DROP']);
  });
});

// ============================================ validation

describe('only approved listings may be saved, and duplicates coalesce (VALIDATION)', () => {
  it('refuses a listing that is not approved', () => {
    const w = new Wishlist('CUS-1');
    for (const state of ['PENDING', 'REJECTED', 'WITHDRAWN'] as const) {
      const r = w.add(listing({ state }), true, NOW);
      expect(r.outcome).toBe('REJECTED');
      if (r.outcome === 'REJECTED') expect(r.reason).toContain('LISTING_NOT_APPROVED');
    }
    expect(w.size()).toBe(0);
  });

  it('a duplicate coalesces rather than erroring or duplicating', () => {
    const w = saved();
    const again = w.add(listing(), true, NOW + 1000);
    expect(again.outcome).toBe('COALESCED');
    expect(w.size()).toBe(1);
  });

  it('coalescing accepts a newly supplied alert threshold', () => {
    const w = saved();
    expect(w.entry('LST-1')!.alertThresholdPercent).toBeUndefined();
    w.add(listing(), true, NOW + 1000, 15);
    expect(w.entry('LST-1')!.alertThresholdPercent).toBe(15);
  });

  it('an out-of-range alert threshold is refused', () => {
    const w = new Wishlist('CUS-1');
    expect(w.add(listing(), true, NOW, 0).outcome).toBe('REJECTED');
    expect(w.add(listing(), true, NOW, -5).outcome).toBe('REJECTED');
    expect(w.add(listing(), true, NOW, 91).outcome).toBe('REJECTED');
    expect(w.add(listing(), true, NOW, 90).outcome).toBe('ADDED');
  });

  it('enforces the 200-item cap', () => {
    const w = new Wishlist('CUS-1');
    for (let i = 0; i < MAX_WISHLIST_ITEMS; i++) {
      expect(w.add(listing({ listingId: `LST-${i}` }), true, NOW).outcome).toBe('ADDED');
    }
    const full = w.add(listing({ listingId: 'LST-OVER' }), true, NOW);
    expect(full.outcome).toBe('REJECTED');
    if (full.outcome === 'REJECTED') expect(full.reason).toBe('WISHLIST_FULL_MAX_200');
    // but a duplicate of something already saved still coalesces at capacity
    expect(w.add(listing({ listingId: 'LST-5' }), true, NOW).outcome).toBe('COALESCED');
  });

  it('archived entries do not consume capacity', () => {
    const w = new Wishlist('CUS-1');
    for (let i = 0; i < MAX_WISHLIST_ITEMS; i++) w.add(listing({ listingId: `LST-${i}` }), true, NOW);
    // archive one by leaving it out of stock past the retention window
    w.reconcileStock(listing({ listingId: 'LST-0', availableStock: 0 }), NOW);
    w.reconcileStock(listing({ listingId: 'LST-0', availableStock: 0 }),
      NOW + (OUT_OF_STOCK_RETENTION_DAYS + 1) * DAY);
    expect(w.entry('LST-0')!.archived).toBe(true);
    expect(w.add(listing({ listingId: 'LST-NEW' }), true, NOW).outcome).toBe('ADDED');
  });
});

// ============================================ guest intent

describe('a guest attempt preserves intent rather than failing (VALIDATION)', () => {
  it('returns a preserved intent instead of an error', () => {
    const w = new Wishlist('CUS-1');
    const r = w.add(listing(), false, NOW, 12);
    expect(r.outcome).toBe('LOGIN_REQUIRED');
    if (r.outcome !== 'LOGIN_REQUIRED') return;
    expect(r.intent.action).toBe('ADD_TO_WISHLIST');
    expect(r.intent.listingId).toBe('LST-1');
    expect(r.intent.alertThresholdPercent).toBe(12);
    expect(r.intent.capturedAtMs).toBe(NOW);
    expect(w.size()).toBe(0);
  });

  it('replaying the intent after login completes the save with the threshold intact', () => {
    const w = new Wishlist('CUS-1');
    const guest = w.add(listing(), false, NOW, 12);
    if (guest.outcome !== 'LOGIN_REQUIRED') throw new Error('expected LOGIN_REQUIRED');

    const applied = w.applyIntent(guest.intent, listing(), NOW + 60_000);
    expect(applied.outcome).toBe('ADDED');
    expect(w.entry('LST-1')!.alertThresholdPercent).toBe(12);
    // the saved price is the price at the moment the intent was APPLIED, honestly stamped
    expect(w.entry('LST-1')!.savedAtMs).toBe(NOW + 60_000);
  });

  it('an intent for a different listing is refused rather than silently retargeted', () => {
    const w = new Wishlist('CUS-1');
    const guest = w.add(listing(), false, NOW);
    if (guest.outcome !== 'LOGIN_REQUIRED') throw new Error('expected LOGIN_REQUIRED');
    const wrong = w.applyIntent(guest.intent, listing({ listingId: 'LST-OTHER' }), NOW);
    expect(wrong.outcome).toBe('REJECTED');
    if (wrong.outcome === 'REJECTED') expect(wrong.reason).toBe('INTENT_LISTING_MISMATCH');
  });
});

// ============================================ withdrawn listings

describe('a withdrawn listing is marked unavailable with a suggestion (ERRORS)', () => {
  it('flags unavailable and offers similar items', () => {
    const w = saved();
    const view = w.view(listing({ state: 'WITHDRAWN' }), w.entry('LST-1')!);
    expect(view.unavailable).toBe(true);
    expect(view.similarItemsSuggested).toBe(true);
    expect(view.badges.some((b) => b.kind === 'UNAVAILABLE')).toBe(true);
    // the saved price is still shown, so the customer can see what they had
    expect(view.savedPricePaise).toBe(2_000_00);
  });

  it('a listing that has vanished entirely is also unavailable rather than throwing', () => {
    const w = saved();
    const view = w.view(null, w.entry('LST-1')!);
    expect(view.unavailable).toBe(true);
    expect(view.currentPricePaise).toBeNull();
    expect(view.similarItemsSuggested).toBe(true);
  });
});

// ============================================ move to cart

describe('moving an entry to the cart', () => {
  it('returns the intent and removes the entry from the wishlist', () => {
    const w = saved();
    const r = w.moveToCart(listing(), 2);
    expect(r.outcome).toBe('MOVED');
    if (r.outcome === 'MOVED') {
      expect(r.qty).toBe(2);
      expect(r.removedFromWishlist).toBe(true);
    }
    expect(w.entry('LST-1')).toBeUndefined();
  });

  it('refuses when stock is insufficient, and leaves the entry in place', () => {
    const w = saved();
    const r = w.moveToCart(listing({ availableStock: 1 }), 3);
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') expect(r.reason).toContain('INSUFFICIENT_STOCK');
    expect(w.entry('LST-1')).toBeDefined();
  });

  it('refuses a non-approved listing, a zero quantity and an item not on the list', () => {
    const w = saved();
    expect(w.moveToCart(listing({ state: 'WITHDRAWN' }), 1).outcome).toBe('REJECTED');
    expect(w.moveToCart(listing(), 0).outcome).toBe('REJECTED');
    expect(w.moveToCart(listing({ listingId: 'LST-OTHER' }), 1).outcome).toBe('REJECTED');
  });
});

// ============================================ retention

describe('out-of-stock entries are retained 90 days then archived (RULES)', () => {
  it('starts the clock on first going out of stock and archives after 90 days', () => {
    const w = saved();
    const oos = listing({ availableStock: 0 });

    expect(w.reconcileStock(oos, NOW)).toBe('OUT_OF_STOCK');
    expect(w.entry('LST-1')!.outOfStockSinceMs).toBe(NOW);

    expect(w.reconcileStock(oos, NOW + (OUT_OF_STOCK_RETENTION_DAYS - 1) * DAY)).toBe('OUT_OF_STOCK');
    expect(w.entry('LST-1')!.archived).toBe(false);

    expect(w.reconcileStock(oos, NOW + OUT_OF_STOCK_RETENTION_DAYS * DAY)).toBe('ARCHIVED');
    expect(w.entry('LST-1')!.archived).toBe(true);
    expect(OUT_OF_STOCK_RETENTION_DAYS).toBe(90);
  });

  it('restocking clears the clock and un-archives', () => {
    const w = saved();
    const oos = listing({ availableStock: 0 });
    w.reconcileStock(oos, NOW);
    w.reconcileStock(oos, NOW + 100 * DAY);
    expect(w.entry('LST-1')!.archived).toBe(true);

    expect(w.reconcileStock(listing({ availableStock: 5 }), NOW + 101 * DAY)).toBe('IN_STOCK');
    expect(w.entry('LST-1')!.archived).toBe(false);
    expect(w.entry('LST-1')!.outOfStockSinceMs).toBeUndefined();
  });

  it('archiving retains the entry rather than deleting it, so the customer can still see it', () => {
    const w = saved();
    const oos = listing({ availableStock: 0 });
    w.reconcileStock(oos, NOW);
    w.reconcileStock(oos, NOW + 100 * DAY);
    expect(w.entry('LST-1')).toBeDefined();
    expect(w.size()).toBe(1);
    expect(w.activeCount()).toBe(0);
  });

  it('re-adding an archived entry restores it', () => {
    const w = saved();
    const oos = listing({ availableStock: 0 });
    w.reconcileStock(oos, NOW);
    w.reconcileStock(oos, NOW + 100 * DAY);
    const r = w.add(listing({ availableStock: 5 }), true, NOW + 101 * DAY);
    expect(r.outcome).toBe('COALESCED');
    expect(w.entry('LST-1')!.archived).toBe(false);
  });

  it('an item saved while already out of stock starts its clock immediately', () => {
    const w = new Wishlist('CUS-1');
    w.add(listing({ availableStock: 0 }), true, NOW);
    expect(w.entry('LST-1')!.outOfStockSinceMs).toBe(NOW);
  });

  it('reconciling an unknown listing is a no-op', () => {
    expect(new Wishlist('CUS-1').reconcileStock(listing(), NOW)).toBe('IN_STOCK');
  });
});

// ============================================ sharing

describe('a wishlist is private by default and share links are revocable (SECURITY)', () => {
  it('is private until a link is explicitly created', () => {
    const w = saved();
    expect(w.isShared()).toBe(false);
    expect(w.shareLink()).toBeNull();
    const denied = w.resolveShare('anything');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('WISHLIST_IS_PRIVATE');
  });

  it('an explicitly created link grants read-only access', () => {
    const w = saved();
    const link = w.createShareLink('SHARE-abc', NOW);
    expect(link.readOnly).toBe(true);
    expect(w.isShared()).toBe(true);

    const resolved = w.resolveShare('SHARE-abc');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.readOnly).toBe(true);
      expect(resolved.customerId).toBe('CUS-1');
    }
  });

  it('a wrong token is refused even while a link exists', () => {
    const w = saved();
    w.createShareLink('SHARE-abc', NOW);
    const bad = w.resolveShare('SHARE-wrong');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('SHARE_TOKEN_INVALID');
  });

  it('revoking closes access immediately and cannot be repeated', () => {
    const w = saved();
    w.createShareLink('SHARE-abc', NOW);
    expect(w.revokeShareLink(NOW + 1000)).toBe(true);
    expect(w.isShared()).toBe(false);

    const revoked = w.resolveShare('SHARE-abc');
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe('SHARE_LINK_REVOKED');
    expect(w.revokeShareLink(NOW + 2000)).toBe(false);
  });

  it('creating a fresh link after a revocation works, and the old token stays dead', () => {
    const w = saved();
    w.createShareLink('SHARE-old', NOW);
    w.revokeShareLink(NOW + 1000);
    w.createShareLink('SHARE-new', NOW + 2000);
    expect(w.resolveShare('SHARE-new').ok).toBe(true);
    expect(w.resolveShare('SHARE-old').ok).toBe(false);
  });
});
