/**
 * Affiliate programme — FR-MKT-006.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "run an affiliate programme: partner onboarding (KYC-light + payout details),
 *                tracked links/codes with last-click attribution windows, category-wise
 *                commission plans, validation holds until return-window lapse, and monthly
 *                payouts with statements."
 *   INPUTS:     "Affiliate applications, link generation requests, plan configs, traffic events."
 *   OUTPUTS:    "Attribution records, pending→validated→paid commission lifecycle, dashboards
 *                (clicks, conversions, EPC), payout batches via FR-FIN-004 rails."
 *   VALIDATION: "Self-purchase excluded; cookie window default 24 h (config); fraud filters
 *                (click-flooding, coupon-leak sites list)."
 *   RULES:      "Returns claw back commissions; brand-bidding policy violations → hold + notice;
 *                NDA/terms e-signed at onboarding."
 *
 * This is a different programme from the FR-CUS-025 referral scheme built in Slice 36, and the
 * distinction is deliberate rather than incidental: a referral is a customer introducing a friend
 * for a two-sided reward, while an affiliate is an external commercial partner earning commission
 * on tracked traffic and paid through the settlement rails. They share vocabulary and almost no
 * rules, so they are kept apart rather than forced into one abstraction that would fit neither.
 *
 * LAST-CLICK ATTRIBUTION IS THE HEART OF IT, and the ordering matters commercially: the affiliate
 * whose link the customer used LAST before converting is credited, provided that click falls
 * inside the cookie window. An implementation that credits the FIRST click, or that ignores the
 * window, systematically pays the wrong partner — and affiliates notice, because they reconcile.
 */

export type Paise = number;

/** VALIDATION: the default cookie window; per-programme configurable. */
export const DEFAULT_COOKIE_WINDOW_MS = 24 * 3_600_000;
/** VALIDATION: clicks from one source above this in an hour are treated as flooding. */
export const CLICK_FLOOD_PER_HOUR = 200;
/** RULES: commission validates only after the referee's return window lapses. */
export const DEFAULT_RETURN_WINDOW_MS = 7 * 24 * 3_600_000;

export type AffiliateState = 'APPLIED' | 'ACTIVE' | 'HELD' | 'TERMINATED';

export interface PayoutDetails {
  beneficiaryName: string;
  accountRef: string;
  ifsc: string;
}

export interface AffiliateApplication {
  affiliateId: string;
  displayName: string;
  /** KYC-light: an identity reference, not a full vendor KYC pack. */
  identityRef: string;
  payout: PayoutDetails;
  /** RULES: NDA and terms must be e-signed at onboarding. */
  ndaSignatureRef?: string;
  termsSignatureRef?: string;
  primaryDomain: string;
}

export interface Affiliate {
  affiliateId: string;
  displayName: string;
  state: AffiliateState;
  payout: PayoutDetails;
  primaryDomain: string;
  onboardedAtMs?: number;
  heldReason?: string;
}

/** Category-wise commission plan, in basis points of net sale value. */
export interface CommissionPlan {
  planId: string;
  /** categoryId → commission in bps. */
  rateBpsByCategory: Record<string, number>;
  defaultRateBps: number;
  cookieWindowMs?: number;
}

export interface TrackedLink {
  linkId: string;
  affiliateId: string;
  targetUrl: string;
  code: string;
}

export interface ClickEvent {
  clickId: string;
  affiliateId: string;
  linkId: string;
  /** The visitor, cookie or device identifier the click was recorded against. */
  visitorId: string;
  sourceDomain: string;
  atMs: number;
}

export interface Conversion {
  orderId: string;
  visitorId: string;
  /** The purchasing customer — used to exclude a self-purchase. */
  customerId: string;
  categoryId: string;
  netSaleValuePaise: Paise;
  atMs: number;
  returnWindowEndsAtMs: number;
}

export type CommissionState = 'PENDING' | 'VALIDATED' | 'PAID' | 'CLAWED_BACK' | 'REJECTED';

export interface Commission {
  commissionId: string;
  affiliateId: string;
  orderId: string;
  clickId: string;
  categoryId: string;
  rateBps: number;
  netSaleValuePaise: Paise;
  amountPaise: Paise;
  state: CommissionState;
  attributedAtMs: number;
  returnWindowEndsAtMs: number;
  validatedAtMs?: number;
  paidAtMs?: number;
  clawedBackReason?: string;
}

export type OnboardResult =
  | { ok: true; affiliate: Affiliate }
  | { ok: false; violations: string[] };

export type AttributionResult =
  | { ok: true; commission: Commission }
  | { ok: false; reason: string };

/**
 * VALIDATION: the fraud filters. Held separately from attribution so each can be reasoned about
 * and audited on its own.
 */
export interface FraudFilters {
  /** Domains known to scrape and republish coupon codes, taking credit for intent they did not create. */
  couponLeakDomains: ReadonlySet<string>;
}

export interface FraudVerdict {
  blocked: boolean;
  reason?: string;
}

/**
 * VALIDATION: click-flooding detection. A source producing an implausible click volume in an hour
 * is generating clicks rather than referrals, and each of those clicks would otherwise sit in the
 * attribution pool waiting to claim a conversion it had nothing to do with.
 */
export function detectClickFlooding(clicks: ClickEvent[], sourceDomain: string, nowMs: number): FraudVerdict {
  const hourAgo = nowMs - 3_600_000;
  const recent = clicks.filter((c) => c.sourceDomain === sourceDomain && c.atMs >= hourAgo && c.atMs <= nowMs);
  if (recent.length > CLICK_FLOOD_PER_HOUR) {
    return {
      blocked: true,
      reason: `CLICK_FLOODING: ${recent.length} clicks from ${sourceDomain} in one hour`,
    };
  }
  return { blocked: false };
}

export function isCouponLeakDomain(sourceDomain: string, filters: FraudFilters): boolean {
  return filters.couponLeakDomains.has(sourceDomain.toLowerCase());
}

/** Commission rate for a category, falling back to the plan default. */
export function rateBpsFor(plan: CommissionPlan, categoryId: string): number {
  return plan.rateBpsByCategory[categoryId] ?? plan.defaultRateBps;
}

export function commissionAmountPaise(netSaleValuePaise: Paise, rateBps: number): Paise {
  // round half up in integer arithmetic, so a commission never gains or loses a paisa to floats
  return Math.floor((netSaleValuePaise * rateBps + 5_000) / 10_000);
}

/** OUTPUTS: a monthly payout batch, settled through the FR-FIN-004 rails. */
export interface PayoutBatch {
  batchId: string;
  periodLabel: string;
  lines: Array<{ affiliateId: string; commissionIds: string[]; amountPaise: Paise; payout: PayoutDetails }>;
  totalPaise: Paise;
}

export class AffiliateProgramme {
  private readonly affiliates = new Map<string, Affiliate>();
  private readonly links = new Map<string, TrackedLink>();
  private readonly clicks: ClickEvent[] = [];
  private readonly commissions = new Map<string, Commission>();

  constructor(
    private readonly plan: CommissionPlan,
    private readonly filters: FraudFilters,
  ) {}

  /** RULES: NDA and terms must be e-signed before an affiliate becomes active. */
  onboard(application: AffiliateApplication, nowMs: number): OnboardResult {
    const violations: string[] = [];

    if (!application.identityRef || application.identityRef.trim().length === 0) {
      violations.push('KYC_IDENTITY_REFERENCE_REQUIRED');
    }
    if (!application.payout.accountRef || !application.payout.ifsc) {
      violations.push('PAYOUT_DETAILS_REQUIRED');
    }
    if (!application.ndaSignatureRef || application.ndaSignatureRef.trim().length === 0) {
      violations.push('NDA_MUST_BE_E_SIGNED_AT_ONBOARDING');
    }
    if (!application.termsSignatureRef || application.termsSignatureRef.trim().length === 0) {
      violations.push('TERMS_MUST_BE_E_SIGNED_AT_ONBOARDING');
    }
    if (!application.primaryDomain || !application.primaryDomain.includes('.')) {
      violations.push('PRIMARY_DOMAIN_REQUIRED');
    }
    if (this.affiliates.has(application.affiliateId)) {
      violations.push('AFFILIATE_ALREADY_ONBOARDED');
    }
    if (violations.length > 0) return { ok: false, violations };

    const affiliate: Affiliate = {
      affiliateId: application.affiliateId,
      displayName: application.displayName,
      state: 'ACTIVE',
      payout: application.payout,
      primaryDomain: application.primaryDomain.toLowerCase(),
      onboardedAtMs: nowMs,
    };
    this.affiliates.set(affiliate.affiliateId, affiliate);
    return { ok: true, affiliate };
  }

  /** RULES: a brand-bidding policy violation holds the affiliate and issues a notice. */
  holdForPolicyViolation(affiliateId: string, reason: string):
    { ok: true; notice: string } | { ok: false; reason: string } {
    const a = this.affiliates.get(affiliateId);
    if (!a) return { ok: false, reason: 'UNKNOWN_AFFILIATE' };
    if (!reason || reason.trim().length < 5) return { ok: false, reason: 'HOLD_REASON_REQUIRED' };
    a.state = 'HELD';
    a.heldReason = reason;
    return {
      ok: true,
      notice: `Your affiliate account is on hold: ${reason}. `
        + 'Pending commissions are retained and will be released if the hold is lifted.',
    };
  }

  releaseHold(affiliateId: string): boolean {
    const a = this.affiliates.get(affiliateId);
    if (!a || a.state !== 'HELD') return false;
    a.state = 'ACTIVE';
    a.heldReason = undefined;
    return true;
  }

  createLink(link: TrackedLink): { ok: true } | { ok: false; reason: string } {
    const a = this.affiliates.get(link.affiliateId);
    if (!a) return { ok: false, reason: 'UNKNOWN_AFFILIATE' };
    if (a.state !== 'ACTIVE') return { ok: false, reason: `AFFILIATE_NOT_ACTIVE: ${a.state}` };
    if (this.links.has(link.linkId)) return { ok: false, reason: 'LINK_ALREADY_EXISTS' };
    this.links.set(link.linkId, link);
    return { ok: true };
  }

  /** Record a click, applying the fraud filters at ingestion rather than at attribution. */
  recordClick(click: ClickEvent): { recorded: boolean; reason?: string } {
    const link = this.links.get(click.linkId);
    if (!link) return { recorded: false, reason: 'UNKNOWN_LINK' };
    if (link.affiliateId !== click.affiliateId) return { recorded: false, reason: 'LINK_AFFILIATE_MISMATCH' };

    if (isCouponLeakDomain(click.sourceDomain, this.filters)) {
      return { recorded: false, reason: `COUPON_LEAK_DOMAIN: ${click.sourceDomain}` };
    }
    const flood = detectClickFlooding(this.clicks, click.sourceDomain, click.atMs);
    if (flood.blocked) return { recorded: false, reason: flood.reason };

    this.clicks.push(click);
    return { recorded: true };
  }

  /**
   * OUTPUTS: attribute a conversion. LAST-CLICK within the cookie window wins.
   *
   * VALIDATION: a self-purchase earns nothing — an affiliate buying through their own link is
   * discounting their own order at the platform's expense, not introducing a customer.
   */
  attribute(commissionId: string, conversion: Conversion,
            affiliateCustomerIds: Map<string, string>): AttributionResult {
    const windowMs = this.plan.cookieWindowMs ?? DEFAULT_COOKIE_WINDOW_MS;
    const windowStart = conversion.atMs - windowMs;

    const eligible = this.clicks
      .filter((c) => c.visitorId === conversion.visitorId)
      .filter((c) => c.atMs <= conversion.atMs && c.atMs >= windowStart);

    if (eligible.length === 0) {
      return { ok: false, reason: 'NO_CLICK_WITHIN_COOKIE_WINDOW' };
    }

    // LAST click wins: the most recent click before the conversion
    const lastClick = eligible.reduce((latest, c) => (c.atMs >= latest.atMs ? c : latest), eligible[0]);

    const affiliate = this.affiliates.get(lastClick.affiliateId);
    if (!affiliate) return { ok: false, reason: 'UNKNOWN_AFFILIATE' };
    if (affiliate.state === 'TERMINATED') return { ok: false, reason: 'AFFILIATE_TERMINATED' };

    // VALIDATION: self-purchase excluded
    if (affiliateCustomerIds.get(lastClick.affiliateId) === conversion.customerId) {
      return { ok: false, reason: 'SELF_PURCHASE_EXCLUDED' };
    }

    const rateBps = rateBpsFor(this.plan, conversion.categoryId);
    const commission: Commission = {
      commissionId,
      affiliateId: affiliate.affiliateId,
      orderId: conversion.orderId,
      clickId: lastClick.clickId,
      categoryId: conversion.categoryId,
      rateBps,
      netSaleValuePaise: conversion.netSaleValuePaise,
      amountPaise: commissionAmountPaise(conversion.netSaleValuePaise, rateBps),
      state: 'PENDING',
      attributedAtMs: conversion.atMs,
      returnWindowEndsAtMs: conversion.returnWindowEndsAtMs,
    };
    this.commissions.set(commissionId, commission);
    return { ok: true, commission };
  }

  /**
   * RULES: a commission validates only once the return window has lapsed. Paying before then means
   * clawing money back from a partner who has already spent it, which is both awkward and, once it
   * happens twice, a reason for a good affiliate to leave.
   */
  validate(commissionId: string, nowMs: number):
    { ok: true } | { ok: false; reason: string } {
    const c = this.commissions.get(commissionId);
    if (!c) return { ok: false, reason: 'UNKNOWN_COMMISSION' };
    if (c.state !== 'PENDING') return { ok: false, reason: `NOT_PENDING: ${c.state}` };
    if (nowMs < c.returnWindowEndsAtMs) return { ok: false, reason: 'RETURN_WINDOW_NOT_LAPSED' };
    const affiliate = this.affiliates.get(c.affiliateId);
    if (affiliate?.state === 'HELD') return { ok: false, reason: 'AFFILIATE_ON_HOLD' };
    c.state = 'VALIDATED';
    c.validatedAtMs = nowMs;
    return { ok: true };
  }

  /** RULES: a return claws the commission back, whether or not it has been paid. */
  clawback(commissionId: string, reason: string, nowMs: number):
    { ok: true; reclaimedPaise: Paise; wasPaid: boolean } | { ok: false; reason: string } {
    const c = this.commissions.get(commissionId);
    if (!c) return { ok: false, reason: 'UNKNOWN_COMMISSION' };
    if (c.state === 'CLAWED_BACK') return { ok: false, reason: 'ALREADY_CLAWED_BACK' };
    if (c.state === 'REJECTED') return { ok: false, reason: 'COMMISSION_WAS_REJECTED' };
    const wasPaid = c.state === 'PAID';
    c.state = 'CLAWED_BACK';
    c.clawedBackReason = reason;
    return { ok: true, reclaimedPaise: c.amountPaise, wasPaid };
  }

  // ------------------------------------------------------------- payouts

  /**
   * Build a monthly payout batch from VALIDATED commissions only. A pending commission is not a
   * debt yet, and a held affiliate is not paid — their commissions stay validated and wait.
   */
  buildPayoutBatch(batchId: string, periodLabel: string, nowMs: number): PayoutBatch {
    const byAffiliate = new Map<string, { commissionIds: string[]; amountPaise: Paise }>();

    for (const c of this.commissions.values()) {
      if (c.state !== 'VALIDATED') continue;
      const affiliate = this.affiliates.get(c.affiliateId);
      if (!affiliate || affiliate.state !== 'ACTIVE') continue;
      const bucket = byAffiliate.get(c.affiliateId) ?? { commissionIds: [], amountPaise: 0 };
      bucket.commissionIds.push(c.commissionId);
      bucket.amountPaise += c.amountPaise;
      byAffiliate.set(c.affiliateId, bucket);
    }

    const lines = [...byAffiliate.entries()]
      .map(([affiliateId, b]) => ({
        affiliateId,
        commissionIds: [...b.commissionIds].sort(),
        amountPaise: b.amountPaise,
        payout: this.affiliates.get(affiliateId)!.payout,
      }))
      .sort((a, b) => a.affiliateId.localeCompare(b.affiliateId));

    return {
      batchId,
      periodLabel,
      lines,
      totalPaise: lines.reduce((a, l) => a + l.amountPaise, 0),
    };
  }

  /** Mark a batch's commissions paid once the settlement rails confirm. */
  markBatchPaid(batch: PayoutBatch, nowMs: number): number {
    let paid = 0;
    for (const line of batch.lines) {
      for (const id of line.commissionIds) {
        const c = this.commissions.get(id);
        if (c && c.state === 'VALIDATED') {
          c.state = 'PAID';
          c.paidAtMs = nowMs;
          paid++;
        }
      }
    }
    return paid;
  }

  // ------------------------------------------------------------- dashboards

  /** OUTPUTS: clicks, conversions and EPC — earnings per click. */
  dashboard(affiliateId: string, fromMs: number, toMs: number):
    { clicks: number; conversions: number; earnedPaise: Paise; epcPaise: number; conversionRate: number } {
    const clicks = this.clicks.filter(
      (c) => c.affiliateId === affiliateId && c.atMs >= fromMs && c.atMs <= toMs).length;

    const commissions = [...this.commissions.values()].filter(
      (c) => c.affiliateId === affiliateId && c.attributedAtMs >= fromMs && c.attributedAtMs <= toMs);
    // a clawed-back or rejected commission is not earnings
    const earning = commissions.filter((c) => c.state !== 'CLAWED_BACK' && c.state !== 'REJECTED');
    const earnedPaise = earning.reduce((a, c) => a + c.amountPaise, 0);

    return {
      clicks,
      conversions: earning.length,
      earnedPaise,
      epcPaise: clicks === 0 ? 0 : Math.round(earnedPaise / clicks),
      conversionRate: clicks === 0 ? 0 : Math.round((earning.length / clicks) * 10_000) / 10_000,
    };
  }

  affiliate(affiliateId: string): Affiliate | undefined {
    return this.affiliates.get(affiliateId);
  }

  commission(commissionId: string): Commission | undefined {
    return this.commissions.get(commissionId);
  }

  clickCount(): number {
    return this.clicks.length;
  }
}
