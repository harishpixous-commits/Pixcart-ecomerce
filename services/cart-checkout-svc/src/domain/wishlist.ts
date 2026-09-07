/**
 * Wishlist — FR-CUS-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "allow authenticated customers to save listings to a wishlist (≤ 200 items), see
 *                price/stock changes since save, move items to cart, and opt into drop-price
 *                alerts."
 *   INPUTS:     "Listing id; alert opt-in threshold (%, optional)."
 *   OUTPUTS:    "Wishlist entries with saved-price; badges 'price ↓ 12%', 'only 2 left', 'out of
 *                stock'; alert notifications."
 *   VALIDATION: "Listing must be Approved; duplicates coalesce; guest attempts prompt login with
 *                intent preserved post-auth."
 *   RULES:      "Out-of-stock items retained 90 days then auto-archived; alert frequency
 *                ≤ 1/listing/day."
 *   ERRORS:     "Listing withdrawn → entry marked unavailable with similar-item suggestion
 *                (FR-AI-005)."
 *   SECURITY:   "Wishlist private by default; share-link (read-only, revocable) requires explicit
 *                action."
 *   ACCEPTANCE: "Given a wishlisted item whose price drops below the saved price by ≥ the opted
 *                threshold, When [the alert job runs], Then [the customer is alerted]."
 *
 * The saved price is the point of the feature: a wishlist that only stored listing ids could not
 * tell a customer anything changed. So the price AT THE MOMENT OF SAVING is snapshotted, and every
 * badge and alert is computed against that snapshot rather than against the current price — which
 * also means a vendor cannot make an old wishlist entry look like a discount by raising the price
 * afterwards, because the comparison base never moves.
 *
 * A guest attempt does not fail: it returns a preserved intent the caller replays after login.
 * Losing the customer's intent at the login wall is a real abandonment cause, and "please log in
 * and then find the product again" is the version of this feature that gets no use.
 */

export type Paise = number;

/** VALIDATION: the wishlist capacity. */
export const MAX_WISHLIST_ITEMS = 200;
/** RULES: an out-of-stock entry is retained this long before auto-archiving. */
export const OUT_OF_STOCK_RETENTION_DAYS = 90;
/** RULES: at most one alert per listing per day. */
export const ALERT_MIN_INTERVAL_MS = 24 * 3600 * 1000;

export type ListingState = 'APPROVED' | 'PENDING' | 'REJECTED' | 'WITHDRAWN';

/** The live listing facts, supplied by the catalogue service. */
export interface ListingSnapshot {
  listingId: string;
  state: ListingState;
  pricePaise: Paise;
  availableStock: number;
}

export interface WishlistEntry {
  listingId: string;
  /** The price at the moment of saving — the comparison base that never moves. */
  savedPricePaise: Paise;
  savedAtMs: number;
  /** Optional drop-price alert threshold, as a percentage (e.g. 10 for "10% or more"). */
  alertThresholdPercent?: number;
  lastAlertedAtMs?: number;
  /** Set when the entry first went out of stock, starting the retention clock. */
  outOfStockSinceMs?: number;
  archived: boolean;
}

export type Badge =
  | { kind: 'PRICE_DROP'; percent: number; label: string }
  | { kind: 'PRICE_RISE'; percent: number; label: string }
  | { kind: 'LOW_STOCK'; remaining: number; label: string }
  | { kind: 'OUT_OF_STOCK'; label: string }
  | { kind: 'UNAVAILABLE'; label: string };

export interface EntryView {
  listingId: string;
  savedPricePaise: Paise;
  currentPricePaise: Paise | null;
  badges: Badge[];
  /** ERRORS: a withdrawn listing is unavailable, with a similar-item suggestion offered. */
  unavailable: boolean;
  similarItemsSuggested: boolean;
  archived: boolean;
}

/** VALIDATION: a guest's intent, preserved so it can be replayed after login. */
export interface PreservedIntent {
  action: 'ADD_TO_WISHLIST';
  listingId: string;
  alertThresholdPercent?: number;
  capturedAtMs: number;
}

export type AddResult =
  | { outcome: 'ADDED'; entry: WishlistEntry }
  /** VALIDATION: duplicates coalesce — the existing entry is returned, not an error. */
  | { outcome: 'COALESCED'; entry: WishlistEntry }
  | { outcome: 'LOGIN_REQUIRED'; intent: PreservedIntent }
  | { outcome: 'REJECTED'; reason: string };

export type MoveToCartResult =
  | { outcome: 'MOVED'; listingId: string; qty: number; removedFromWishlist: true }
  | { outcome: 'REJECTED'; reason: string };

/** SECURITY: a read-only, revocable share link. */
export interface ShareLink {
  token: string;
  customerId: string;
  createdAtMs: number;
  revokedAtMs?: number;
  readOnly: true;
}

export class Wishlist {
  private readonly entries = new Map<string, WishlistEntry>();
  private share: ShareLink | null = null;

  constructor(readonly customerId: string) {}

  /**
   * Add a listing. VALIDATION: only an APPROVED listing may be saved, duplicates coalesce rather
   * than erroring, and an unauthenticated attempt returns a preserved intent instead of failing.
   */
  add(listing: ListingSnapshot, authenticated: boolean, nowMs: number,
      alertThresholdPercent?: number): AddResult {
    if (!authenticated) {
      return {
        outcome: 'LOGIN_REQUIRED',
        intent: {
          action: 'ADD_TO_WISHLIST',
          listingId: listing.listingId,
          alertThresholdPercent,
          capturedAtMs: nowMs,
        },
      };
    }
    if (listing.state !== 'APPROVED') {
      return { outcome: 'REJECTED', reason: `LISTING_NOT_APPROVED: ${listing.state}` };
    }
    if (alertThresholdPercent !== undefined
        && (alertThresholdPercent <= 0 || alertThresholdPercent > 90)) {
      return { outcome: 'REJECTED', reason: 'ALERT_THRESHOLD_OUT_OF_RANGE' };
    }

    const existing = this.entries.get(listing.listingId);
    if (existing) {
      // coalesce: keep the ORIGINAL saved price so the customer's reference point survives, but
      // let a newly supplied threshold take effect
      if (alertThresholdPercent !== undefined) existing.alertThresholdPercent = alertThresholdPercent;
      if (existing.archived) {
        existing.archived = false;
        existing.outOfStockSinceMs = undefined;
      }
      return { outcome: 'COALESCED', entry: existing };
    }

    if (this.activeCount() >= MAX_WISHLIST_ITEMS) {
      return { outcome: 'REJECTED', reason: `WISHLIST_FULL_MAX_${MAX_WISHLIST_ITEMS}` };
    }

    const entry: WishlistEntry = {
      listingId: listing.listingId,
      savedPricePaise: listing.pricePaise,
      savedAtMs: nowMs,
      alertThresholdPercent,
      outOfStockSinceMs: listing.availableStock <= 0 ? nowMs : undefined,
      archived: false,
    };
    this.entries.set(listing.listingId, entry);
    return { outcome: 'ADDED', entry };
  }

  /** Replay a preserved intent once the customer has authenticated. */
  applyIntent(intent: PreservedIntent, listing: ListingSnapshot, nowMs: number): AddResult {
    if (intent.listingId !== listing.listingId) {
      return { outcome: 'REJECTED', reason: 'INTENT_LISTING_MISMATCH' };
    }
    return this.add(listing, true, nowMs, intent.alertThresholdPercent);
  }

  remove(listingId: string): boolean {
    return this.entries.delete(listingId);
  }

  entry(listingId: string): WishlistEntry | undefined {
    return this.entries.get(listingId);
  }

  activeCount(): number {
    return [...this.entries.values()].filter((e) => !e.archived).length;
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * OUTPUTS: badges computed against the SAVED price, not against the current one. Comparing
   * against the current price would make every entry look unchanged.
   */
  view(listing: ListingSnapshot | null, entry: WishlistEntry): EntryView {
    const badges: Badge[] = [];

    // ERRORS: a withdrawn or missing listing is unavailable, with similar items offered.
    if (listing === null || listing.state === 'WITHDRAWN' || listing.state === 'REJECTED') {
      badges.push({ kind: 'UNAVAILABLE', label: 'No longer available' });
      return {
        listingId: entry.listingId,
        savedPricePaise: entry.savedPricePaise,
        currentPricePaise: listing?.pricePaise ?? null,
        badges,
        unavailable: true,
        similarItemsSuggested: true,
        archived: entry.archived,
      };
    }

    const delta = listing.pricePaise - entry.savedPricePaise;
    if (delta !== 0 && entry.savedPricePaise > 0) {
      const percent = Math.round((Math.abs(delta) / entry.savedPricePaise) * 100);
      if (percent >= 1) {
        badges.push(delta < 0
          ? { kind: 'PRICE_DROP', percent, label: `price ↓ ${percent}%` }
          : { kind: 'PRICE_RISE', percent, label: `price ↑ ${percent}%` });
      }
    }

    if (listing.availableStock <= 0) {
      badges.push({ kind: 'OUT_OF_STOCK', label: 'out of stock' });
    } else if (listing.availableStock <= 5) {
      badges.push({ kind: 'LOW_STOCK', remaining: listing.availableStock, label: `only ${listing.availableStock} left` });
    }

    return {
      listingId: entry.listingId,
      savedPricePaise: entry.savedPricePaise,
      currentPricePaise: listing.pricePaise,
      badges,
      unavailable: false,
      similarItemsSuggested: false,
      archived: entry.archived,
    };
  }

  /**
   * Move an entry to the cart. Returns the intent for the cart service to act on — this module
   * does not mutate a cart, matching the boundary discipline used elsewhere.
   */
  moveToCart(listing: ListingSnapshot, qty: number): MoveToCartResult {
    const entry = this.entries.get(listing.listingId);
    if (!entry) return { outcome: 'REJECTED', reason: 'NOT_ON_WISHLIST' };
    if (listing.state !== 'APPROVED') return { outcome: 'REJECTED', reason: `LISTING_NOT_APPROVED: ${listing.state}` };
    if (qty <= 0) return { outcome: 'REJECTED', reason: 'QTY_MUST_BE_POSITIVE' };
    if (listing.availableStock < qty) {
      return { outcome: 'REJECTED', reason: `INSUFFICIENT_STOCK: ${listing.availableStock} < ${qty}` };
    }
    this.entries.delete(listing.listingId);
    return { outcome: 'MOVED', listingId: listing.listingId, qty, removedFromWishlist: true };
  }

  // ------------------------------------------------------------- alerts

  /**
   * ACCEPTANCE: should a drop-price alert fire? The drop is measured against the SAVED price and
   * must meet the customer's own opted threshold. RULES: at most one alert per listing per day.
   */
  shouldAlert(listing: ListingSnapshot, entry: WishlistEntry, nowMs: number):
    { alert: true; dropPercent: number } | { alert: false; reason: string } {
    if (entry.alertThresholdPercent === undefined) {
      return { alert: false, reason: 'NOT_OPTED_IN' };
    }
    if (entry.archived) return { alert: false, reason: 'ENTRY_ARCHIVED' };
    if (listing.state !== 'APPROVED') return { alert: false, reason: 'LISTING_NOT_AVAILABLE' };
    if (listing.availableStock <= 0) {
      // alerting about a price drop on something nobody can buy is a wasted notification
      return { alert: false, reason: 'OUT_OF_STOCK' };
    }
    if (listing.pricePaise >= entry.savedPricePaise) {
      return { alert: false, reason: 'PRICE_NOT_LOWER_THAN_SAVED' };
    }
    const dropPercent = Math.round(
      ((entry.savedPricePaise - listing.pricePaise) / entry.savedPricePaise) * 100);
    if (dropPercent < entry.alertThresholdPercent) {
      return { alert: false, reason: `DROP_BELOW_THRESHOLD: ${dropPercent}% < ${entry.alertThresholdPercent}%` };
    }
    if (entry.lastAlertedAtMs !== undefined
        && nowMs - entry.lastAlertedAtMs < ALERT_MIN_INTERVAL_MS) {
      return { alert: false, reason: 'ALERT_ALREADY_SENT_TODAY' };
    }
    return { alert: true, dropPercent };
  }

  recordAlertSent(listingId: string, nowMs: number): void {
    const e = this.entries.get(listingId);
    if (e) e.lastAlertedAtMs = nowMs;
  }

  // ------------------------------------------------------------- retention

  /**
   * RULES: an out-of-stock entry is retained 90 days then auto-archived. Archiving rather than
   * deleting means the customer can still see what they had saved, and re-adding restores it.
   */
  reconcileStock(listing: ListingSnapshot, nowMs: number): 'IN_STOCK' | 'OUT_OF_STOCK' | 'ARCHIVED' {
    const entry = this.entries.get(listing.listingId);
    if (!entry) return 'IN_STOCK';

    if (listing.availableStock > 0) {
      entry.outOfStockSinceMs = undefined;
      entry.archived = false;
      return 'IN_STOCK';
    }
    if (entry.outOfStockSinceMs === undefined) {
      entry.outOfStockSinceMs = nowMs;
      return 'OUT_OF_STOCK';
    }
    const elapsedDays = (nowMs - entry.outOfStockSinceMs) / (24 * 3600 * 1000);
    if (elapsedDays >= OUT_OF_STOCK_RETENTION_DAYS) {
      entry.archived = true;
      return 'ARCHIVED';
    }
    return 'OUT_OF_STOCK';
  }

  // ------------------------------------------------------------- sharing

  /** SECURITY: private by default — there is no share link until one is explicitly created. */
  isShared(): boolean {
    return this.share !== null && this.share.revokedAtMs === undefined;
  }

  createShareLink(token: string, nowMs: number): ShareLink {
    this.share = { token, customerId: this.customerId, createdAtMs: nowMs, readOnly: true };
    return this.share;
  }

  revokeShareLink(nowMs: number): boolean {
    if (this.share === null || this.share.revokedAtMs !== undefined) return false;
    this.share = { ...this.share, revokedAtMs: nowMs };
    return true;
  }

  /** A share link grants read-only access, and only while it stands. */
  resolveShare(token: string): { ok: true; readOnly: true; customerId: string } | { ok: false; reason: string } {
    if (this.share === null) return { ok: false, reason: 'WISHLIST_IS_PRIVATE' };
    if (this.share.revokedAtMs !== undefined) return { ok: false, reason: 'SHARE_LINK_REVOKED' };
    if (this.share.token !== token) return { ok: false, reason: 'SHARE_TOKEN_INVALID' };
    return { ok: true, readOnly: true, customerId: this.customerId };
  }

  shareLink(): ShareLink | null {
    return this.share;
  }
}
