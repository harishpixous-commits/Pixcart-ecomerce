/**
 * Platform promotions console — FR-ADM-008.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "create platform-funded coupons and event campaigns (flash sale, festival) with
 *                eligibility rules, budget caps, vendor participation management and live
 *                burn/ROI monitoring — the operator superset of FR-MKT-001/002."
 *   RULES:      "Holdout group (default 5%) auto-maintained for incrementality; price-integrity
 *                checks stop 'fake discount' listings joining events."
 *   VALIDATION: "Budget approval required ≥ ₹1 lakh; rule conflicts (overlapping exclusive
 *                events) detected at save."
 *
 * Pure and deterministic. Two gates matter most: an exclusive event cannot be saved over
 * another exclusive event covering the same window and audience, and a listing whose MRP was
 * inflated shortly before the event cannot join it — the "fake discount" check, which protects
 * the platform's own price-integrity claims. The holdout is maintained by deterministic
 * bucketing rather than a stored flag, so it is stable per user and needs no reconciliation.
 */

export type Paise = number;

export const BUDGET_APPROVAL_THRESHOLD_PAISE = 1_00_000 * 100;   // ₹1 lakh
export const DEFAULT_HOLDOUT_PERCENT = 5;
/** An MRP raised within this window before the event start is treated as inflation. */
export const PRICE_INTEGRITY_LOOKBACK_DAYS = 30;

export type CampaignKind = 'FLASH_SALE' | 'FESTIVAL' | 'COUPON';

export interface Window {
  fromMs: number;
  toMs: number;   // half-open
}

export interface Campaign {
  campaignId: string;
  name: string;
  kind: CampaignKind;
  window: Window;
  /** An exclusive campaign may not overlap another exclusive one for the same audience. */
  exclusive: boolean;
  budgetPaise: Paise;
  /** Audience key (segment or 'ALL'); overlap is judged per audience. */
  audience: string;
  holdoutPercent?: number;
  approvedBy?: string;
}

/** A listing's price history point, used by the price-integrity gate. */
export interface ListingPriceFact {
  listingId: string;
  currentMrpPaise: Paise;
  /** When the MRP last increased, if it did. */
  mrpLastRaisedAtMs?: number;
  /** MRP before that increase. */
  mrpBeforeRaisePaise?: Paise;
}

export type SaveResult =
  | { ok: true; campaignId: string }
  | { ok: false; violations: string[] };

export type JoinResult =
  | { ok: true }
  | { ok: false; reason: string };

function overlaps(a: Window, b: Window): boolean {
  return a.fromMs < b.toMs && b.fromMs < a.toMs;
}

export class PromotionsConsole {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly burn = new Map<string, Paise>();

  /**
   * Save a campaign. VALIDATION: a budget at or above ₹1 lakh requires a named approver, and
   * an exclusive campaign overlapping another exclusive campaign for the same audience is
   * refused at save rather than discovered later.
   */
  save(campaign: Campaign): SaveResult {
    const violations: string[] = [];
    if (campaign.window.toMs <= campaign.window.fromMs) violations.push('WINDOW_INVERTED');
    if (campaign.budgetPaise <= 0) violations.push('BUDGET_MUST_BE_POSITIVE');
    if (campaign.budgetPaise >= BUDGET_APPROVAL_THRESHOLD_PAISE
        && (!campaign.approvedBy || campaign.approvedBy.trim().length === 0)) {
      violations.push('BUDGET_APPROVAL_REQUIRED_AT_OR_ABOVE_1_LAKH');
    }
    const holdout = campaign.holdoutPercent ?? DEFAULT_HOLDOUT_PERCENT;
    if (holdout < 0 || holdout > 50) violations.push('HOLDOUT_PERCENT_OUT_OF_RANGE');

    if (campaign.exclusive) {
      for (const other of this.campaigns.values()) {
        if (other.campaignId === campaign.campaignId) continue;
        if (!other.exclusive) continue;
        if (other.audience !== campaign.audience && other.audience !== 'ALL' && campaign.audience !== 'ALL') continue;
        if (overlaps(campaign.window, other.window)) {
          violations.push(`EXCLUSIVE_EVENT_CONFLICT: overlaps ${other.campaignId} for audience ${other.audience}`);
        }
      }
    }
    if (violations.length > 0) return { ok: false, violations };

    this.campaigns.set(campaign.campaignId, { ...campaign, holdoutPercent: holdout });
    if (!this.burn.has(campaign.campaignId)) this.burn.set(campaign.campaignId, 0);
    return { ok: true, campaignId: campaign.campaignId };
  }

  campaign(campaignId: string): Campaign | undefined {
    return this.campaigns.get(campaignId);
  }

  /**
   * RULES: holdout group, default 5%, auto-maintained. Deterministic per (campaign, user), so
   * the same user is consistently held out and incrementality can be measured without storing
   * assignment state.
   */
  isInHoldout(campaignId: string, userId: string): boolean {
    const c = this.campaigns.get(campaignId);
    if (!c) return false;
    const pct = c.holdoutPercent ?? DEFAULT_HOLDOUT_PERCENT;
    if (pct === 0) return false;
    return bucket100(`${campaignId}|${userId}`) < pct;
  }

  /** A held-out user must not see the promotion — that is the whole point of the holdout. */
  isEligible(campaignId: string, userId: string, nowMs: number): boolean {
    const c = this.campaigns.get(campaignId);
    if (!c) return false;
    if (nowMs < c.window.fromMs || nowMs >= c.window.toMs) return false;
    return !this.isInHoldout(campaignId, userId);
  }

  /**
   * RULES: price-integrity check. A listing whose MRP was raised within the lookback window
   * before the event starts is refused entry, because discounting from a freshly inflated MRP
   * is a fake discount.
   */
  mayJoinEvent(campaignId: string, fact: ListingPriceFact): JoinResult {
    const c = this.campaigns.get(campaignId);
    if (!c) return { ok: false, reason: 'UNKNOWN_CAMPAIGN' };
    if (fact.mrpLastRaisedAtMs === undefined) return { ok: true };
    const lookbackStart = c.window.fromMs - PRICE_INTEGRITY_LOOKBACK_DAYS * 24 * 3600 * 1000;
    if (fact.mrpLastRaisedAtMs >= lookbackStart) {
      const before = fact.mrpBeforeRaisePaise ?? 0;
      return {
        ok: false,
        reason: `PRICE_INTEGRITY_MRP_INFLATED_BEFORE_EVENT: raised from ${before} to ${fact.currentMrpPaise}`,
      };
    }
    return { ok: true };
  }

  // ------------------------------------------------------- burn & ROI

  /** Record spend against the budget. Refuses the portion that would exceed the cap. */
  recordBurn(campaignId: string, amountPaise: Paise):
    { ok: true; spentPaise: Paise } | { ok: false; reason: string } {
    const c = this.campaigns.get(campaignId);
    if (!c) return { ok: false, reason: 'UNKNOWN_CAMPAIGN' };
    if (amountPaise <= 0) return { ok: false, reason: 'AMOUNT_MUST_BE_POSITIVE' };
    const spent = this.burn.get(campaignId) ?? 0;
    if (spent + amountPaise > c.budgetPaise) {
      return { ok: false, reason: `BUDGET_EXCEEDED: ${spent + amountPaise} > ${c.budgetPaise}` };
    }
    this.burn.set(campaignId, spent + amountPaise);
    return { ok: true, spentPaise: spent + amountPaise };
  }

  spentPaise(campaignId: string): Paise {
    return this.burn.get(campaignId) ?? 0;
  }

  /** Burn as a percentage of budget, for the live monitor. */
  burnPercent(campaignId: string): number {
    const c = this.campaigns.get(campaignId);
    if (!c || c.budgetPaise === 0) return 0;
    return Math.round((this.spentPaise(campaignId) / c.budgetPaise) * 10000) / 100;
  }

  /**
   * Incremental ROI measured against the holdout: (treated revenue per user − holdout revenue
   * per user) × treated users ÷ spend. Returns null when spend is zero or either cohort is
   * empty, rather than inventing a figure.
   */
  incrementalRoi(campaignId: string, treated: { users: number; revenuePaise: Paise },
                 holdout: { users: number; revenuePaise: Paise }): number | null {
    const spend = this.spentPaise(campaignId);
    if (spend <= 0 || treated.users === 0 || holdout.users === 0) return null;
    const treatedPerUser = treated.revenuePaise / treated.users;
    const holdoutPerUser = holdout.revenuePaise / holdout.users;
    const incremental = (treatedPerUser - holdoutPerUser) * treated.users;
    return Math.round((incremental / spend) * 100) / 100;
  }
}

/** FNV-1a folded to 0..99 — stable across processes. */
export function bucket100(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}
