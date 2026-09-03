/**
 * Referral programme — FR-CUS-025, with the MKT-side operations of FR-MKT-007.
 *
 * Normative source (Documentation Suite v1.0):
 *
 *   FR-CUS-025 DESC:       "issue unique referral codes/links, attribute referee sign-up and
 *                           first qualifying order, and grant two-sided rewards with anti-abuse
 *                           controls."
 *   FR-CUS-025 INPUTS:     "campaign config (reward values, qualifying order ≥ ₹499)".
 *   FR-CUS-025 VALIDATION: "Self-referral blocked (device, payment-instrument, address fuzzy
 *                           match); code active & within campaign window."
 *   FR-CUS-025 RULES:      "Reward vests only after referee's return window lapses; claw-back on
 *                           refund; per-referrer cap (default 20/quarter)."
 *   FR-CUS-025 ERRORS:     "Attribution conflict (two codes) → first-touch wins with audit;
 *                           suspected ring → holds to Risk queue, users see 'under review'."
 *
 *   FR-MKT-007 VALIDATION: "Reward ≤ configured max (₹500 default); budget mandatory; change
 *                           mid-campaign forward-only."
 *   FR-MKT-007 ERRORS:     "Budget exhaust → auto-pause new attributions, in-flight vesting
 *                           honoured."
 *
 * This module also supplies the fact that the Slice-21 risk engine's SELF_REFERRAL_MATCH rule was
 * written against but had no producer: a blocked attribution emits the signal the risk engine
 * consumes, and the tests drive that hand-off end to end.
 *
 * The rule that shapes the design most is "budget exhaust → auto-pause NEW attributions,
 * IN-FLIGHT vesting honoured". A referee who was validly attributed before the budget ran dry has
 * earned their reward; pausing must stop new promises, not renege on existing ones. Vesting is
 * therefore checked against the attribution's own campaign state at attribution time, not against
 * the budget as it stands when vesting happens.
 */

export type Paise = number;

/** FR-MKT-007 VALIDATION: the configured reward ceiling. */
export const MAX_REWARD_PAISE: Paise = 500 * 100;
/** FR-CUS-025 INPUTS: a qualifying order is at least ₹499. */
export const QUALIFYING_ORDER_MIN_PAISE: Paise = 499 * 100;
/** FR-CUS-025 RULES: default per-referrer cap per quarter. */
export const DEFAULT_QUARTERLY_CAP = 20;

export interface ReferralCampaign {
  campaignId: string;
  version: number;
  fromMs: number;
  toMs: number;                       // half-open
  referrerRewardPaise: Paise;
  refereeRewardPaise: Paise;
  qualifyingOrderMinPaise: Paise;
  budgetPaise: Paise;
  perReferrerQuarterlyCap?: number;
}

/** Signals that would make an attribution a self-referral (VALIDATION). */
export interface AttributionSignals {
  deviceMatch: boolean;
  paymentInstrumentMatch: boolean;
  addressFuzzyMatch: boolean;
}

export const NO_MATCH: AttributionSignals = {
  deviceMatch: false, paymentInstrumentMatch: false, addressFuzzyMatch: false,
};

export type AttributionState =
  | 'ATTRIBUTED'      // valid, awaiting a qualifying order
  | 'QUALIFIED'       // qualifying order placed, awaiting return-window lapse
  | 'VESTED'          // rewards issued
  | 'CLAWED_BACK'     // refunded after vesting
  | 'UNDER_REVIEW';   // suspected ring, held to the Risk queue

export interface Attribution {
  refereeId: string;
  referrerId: string;
  code: string;
  campaignId: string;
  campaignVersion: number;
  attributedAtMs: number;
  state: AttributionState;
  /** Snapshot of the rewards promised at attribution time — honoured even if budget later runs out. */
  promisedReferrerPaise: Paise;
  promisedRefereePaise: Paise;
  qualifyingOrderPaise?: Paise;
  returnWindowEndsAtMs?: number;
}

export interface AuditEntry {
  atMs: number;
  action: string;
  detail: string;
}

export type ConfigResult =
  | { ok: true; campaign: ReferralCampaign }
  | { ok: false; violations: string[] };

export type AttributeResult =
  | { ok: true; attribution: Attribution; firstTouch: true }
  | { ok: false; reason: string; riskSignal?: AttributionSignals; underReview?: boolean };

export type VestResult =
  | { ok: true; referrerRewardPaise: Paise; refereeRewardPaise: Paise }
  | { ok: false; reason: string };

export class ReferralProgramme {
  private readonly campaigns = new Map<string, ReferralCampaign>();
  private readonly codes = new Map<string, { code: string; referrerId: string; campaignId: string; active: boolean }>();
  /** refereeId -> attribution. One per referee: first touch wins. */
  private readonly attributions = new Map<string, Attribution>();
  private readonly burn = new Map<string, Paise>();
  private readonly audit: AuditEntry[] = [];

  // --------------------------------------------------------- configuration

  /** FR-MKT-007: reward ceiling enforced, budget mandatory, qualifying floor respected. */
  configureCampaign(c: ReferralCampaign): ConfigResult {
    const violations: string[] = [];
    if (c.toMs <= c.fromMs) violations.push('WINDOW_INVERTED');
    if (c.budgetPaise === undefined || c.budgetPaise <= 0) violations.push('BUDGET_MANDATORY');
    if (c.referrerRewardPaise < 0 || c.refereeRewardPaise < 0) violations.push('REWARD_NEGATIVE');
    if (c.referrerRewardPaise > MAX_REWARD_PAISE) violations.push(`REFERRER_REWARD_EXCEEDS_MAX_${MAX_REWARD_PAISE}`);
    if (c.refereeRewardPaise > MAX_REWARD_PAISE) violations.push(`REFEREE_REWARD_EXCEEDS_MAX_${MAX_REWARD_PAISE}`);
    if (c.qualifyingOrderMinPaise < QUALIFYING_ORDER_MIN_PAISE) {
      violations.push(`QUALIFYING_ORDER_BELOW_FLOOR_${QUALIFYING_ORDER_MIN_PAISE}`);
    }
    if (violations.length > 0) return { ok: false, violations };

    const stored: ReferralCampaign = { ...c, perReferrerQuarterlyCap: c.perReferrerQuarterlyCap ?? DEFAULT_QUARTERLY_CAP };
    this.campaigns.set(c.campaignId, stored);
    if (!this.burn.has(c.campaignId)) this.burn.set(c.campaignId, 0);
    this.audit.push({ atMs: c.fromMs, action: 'CAMPAIGN_CONFIGURED', detail: `${c.campaignId} v${c.version}` });
    return { ok: true, campaign: stored };
  }

  /**
   * FR-MKT-007: a mid-campaign change is FORWARD-ONLY. Raising a version whose window has already
   * begun would silently re-price attributions already made, so it is refused.
   */
  updateCampaign(next: ReferralCampaign, nowMs: number): ConfigResult {
    const current = this.campaigns.get(next.campaignId);
    if (!current) return { ok: false, violations: ['UNKNOWN_CAMPAIGN'] };
    if (next.version <= current.version) return { ok: false, violations: ['VERSION_MUST_INCREASE'] };
    if (next.fromMs <= nowMs) return { ok: false, violations: ['MID_CAMPAIGN_CHANGE_MUST_BE_FORWARD_ONLY'] };
    return this.configureCampaign(next);
  }

  issueCode(code: string, referrerId: string, campaignId: string): { ok: boolean; reason?: string } {
    if (!this.campaigns.has(campaignId)) return { ok: false, reason: 'UNKNOWN_CAMPAIGN' };
    if (this.codes.has(code)) return { ok: false, reason: 'CODE_ALREADY_ISSUED' };
    this.codes.set(code, { code, referrerId, campaignId, active: true });
    return { ok: true };
  }

  deactivateCode(code: string): boolean {
    const c = this.codes.get(code);
    if (!c) return false;
    c.active = false;
    return true;
  }

  // --------------------------------------------------------- attribution

  /** Rewards committed but not yet vested — what an auto-pause must still honour. */
  inFlightCommitmentPaise(campaignId: string): Paise {
    let total = 0;
    for (const a of this.attributions.values()) {
      if (a.campaignId !== campaignId) continue;
      if (a.state === 'ATTRIBUTED' || a.state === 'QUALIFIED' || a.state === 'UNDER_REVIEW') {
        total += a.promisedReferrerPaise + a.promisedRefereePaise;
      }
    }
    return total;
  }

  /**
   * FR-MKT-007 ERRORS: new attributions auto-pause once budget (spent + in-flight commitments)
   * would be exceeded by one more attribution.
   */
  isAcceptingNewAttributions(campaignId: string): boolean {
    const c = this.campaigns.get(campaignId);
    if (!c) return false;
    const committed = (this.burn.get(campaignId) ?? 0) + this.inFlightCommitmentPaise(campaignId);
    const perAttribution = c.referrerRewardPaise + c.refereeRewardPaise;
    return committed + perAttribution <= c.budgetPaise;
  }

  private quarterOf(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  }

  private referrerAttributionsInQuarter(referrerId: string, quarter: string): number {
    let n = 0;
    for (const a of this.attributions.values()) {
      if (a.referrerId === referrerId && this.quarterOf(a.attributedAtMs) === quarter) n++;
    }
    return n;
  }

  /**
   * Attribute a referee to a code.
   *
   * Order of checks matters: self-referral is evaluated FIRST, because an abusive attribution
   * should be recorded as a risk signal even if the code also happens to be expired or the budget
   * exhausted — the abuse is the more important fact.
   */
  attribute(code: string, refereeId: string, signals: AttributionSignals, nowMs: number,
            suspectedRing = false): AttributeResult {
    const entry = this.codes.get(code);
    if (!entry) return { ok: false, reason: 'UNKNOWN_CODE' };
    const campaign = this.campaigns.get(entry.campaignId);
    if (!campaign) return { ok: false, reason: 'UNKNOWN_CAMPAIGN' };

    // VALIDATION: self-referral blocked on any of device, instrument or address match.
    if (signals.deviceMatch || signals.paymentInstrumentMatch || signals.addressFuzzyMatch) {
      this.audit.push({
        atMs: nowMs, action: 'SELF_REFERRAL_BLOCKED',
        detail: `code=${code} referee=${refereeId} device=${signals.deviceMatch} `
          + `instrument=${signals.paymentInstrumentMatch} address=${signals.addressFuzzyMatch}`,
      });
      return { ok: false, reason: 'SELF_REFERRAL_BLOCKED', riskSignal: signals };
    }

    if (entry.referrerId === refereeId) {
      return { ok: false, reason: 'SELF_REFERRAL_BLOCKED', riskSignal: signals };
    }

    // ERRORS: attribution conflict — first touch wins, and the second is audited rather than lost.
    const existing = this.attributions.get(refereeId);
    if (existing) {
      this.audit.push({
        atMs: nowMs, action: 'ATTRIBUTION_CONFLICT_FIRST_TOUCH_WINS',
        detail: `referee=${refereeId} kept=${existing.code} rejected=${code}`,
      });
      return { ok: false, reason: 'ALREADY_ATTRIBUTED_FIRST_TOUCH_WINS' };
    }

    if (!entry.active) return { ok: false, reason: 'CODE_INACTIVE' };
    if (nowMs < campaign.fromMs || nowMs >= campaign.toMs) return { ok: false, reason: 'OUTSIDE_CAMPAIGN_WINDOW' };

    const cap = campaign.perReferrerQuarterlyCap ?? DEFAULT_QUARTERLY_CAP;
    if (this.referrerAttributionsInQuarter(entry.referrerId, this.quarterOf(nowMs)) >= cap) {
      return { ok: false, reason: `PER_REFERRER_QUARTERLY_CAP_REACHED_${cap}` };
    }

    if (!this.isAcceptingNewAttributions(entry.campaignId)) {
      this.audit.push({ atMs: nowMs, action: 'BUDGET_AUTO_PAUSE', detail: `campaign=${entry.campaignId}` });
      return { ok: false, reason: 'BUDGET_EXHAUSTED_NEW_ATTRIBUTIONS_PAUSED' };
    }

    const attribution: Attribution = {
      refereeId,
      referrerId: entry.referrerId,
      code,
      campaignId: entry.campaignId,
      campaignVersion: campaign.version,
      attributedAtMs: nowMs,
      // ERRORS: a suspected ring is held for Risk rather than rejected outright — the user sees
      // "under review" and the reward neither vests nor disappears while it is investigated.
      state: suspectedRing ? 'UNDER_REVIEW' : 'ATTRIBUTED',
      promisedReferrerPaise: campaign.referrerRewardPaise,
      promisedRefereePaise: campaign.refereeRewardPaise,
    };
    this.attributions.set(refereeId, attribution);
    this.audit.push({
      atMs: nowMs, action: suspectedRing ? 'ATTRIBUTED_UNDER_REVIEW' : 'ATTRIBUTED',
      detail: `referee=${refereeId} referrer=${entry.referrerId} code=${code}`,
    });
    return { ok: true, attribution, firstTouch: true };
  }

  /** Risk queue decision on a held attribution. */
  resolveReview(refereeId: string, approve: boolean, nowMs: number): { ok: boolean; state?: AttributionState } {
    const a = this.attributions.get(refereeId);
    if (!a || a.state !== 'UNDER_REVIEW') return { ok: false };
    a.state = approve ? 'ATTRIBUTED' : 'CLAWED_BACK';
    this.audit.push({ atMs: nowMs, action: approve ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', detail: refereeId });
    return { ok: true, state: a.state };
  }

  /** Record the referee's first qualifying order (≥ the campaign floor). */
  recordQualifyingOrder(refereeId: string, orderPaise: Paise, returnWindowEndsAtMs: number, nowMs: number):
    { ok: true } | { ok: false; reason: string } {
    const a = this.attributions.get(refereeId);
    if (!a) return { ok: false, reason: 'NOT_ATTRIBUTED' };
    if (a.state === 'UNDER_REVIEW') return { ok: false, reason: 'UNDER_REVIEW' };
    if (a.state !== 'ATTRIBUTED') return { ok: false, reason: `NOT_AWAITING_QUALIFYING_ORDER_${a.state}` };
    const campaign = this.campaigns.get(a.campaignId)!;
    if (orderPaise < campaign.qualifyingOrderMinPaise) {
      return { ok: false, reason: `ORDER_BELOW_QUALIFYING_MINIMUM_${campaign.qualifyingOrderMinPaise}` };
    }
    a.state = 'QUALIFIED';
    a.qualifyingOrderPaise = orderPaise;
    a.returnWindowEndsAtMs = returnWindowEndsAtMs;
    this.audit.push({ atMs: nowMs, action: 'QUALIFIED', detail: `${refereeId} order=${orderPaise}` });
    return { ok: true };
  }

  /**
   * RULES: the reward vests ONLY after the referee's return window lapses. The promised amounts
   * are taken from the attribution's own snapshot, so a budget that has since been exhausted
   * cannot renege on a commitment already made — in-flight vesting is honoured.
   */
  vest(refereeId: string, nowMs: number): VestResult {
    const a = this.attributions.get(refereeId);
    if (!a) return { ok: false, reason: 'NOT_ATTRIBUTED' };
    if (a.state === 'UNDER_REVIEW') return { ok: false, reason: 'UNDER_REVIEW' };
    if (a.state !== 'QUALIFIED') return { ok: false, reason: `NOT_QUALIFIED_${a.state}` };
    if (a.returnWindowEndsAtMs === undefined || nowMs < a.returnWindowEndsAtMs) {
      return { ok: false, reason: 'RETURN_WINDOW_NOT_LAPSED' };
    }
    a.state = 'VESTED';
    const total = a.promisedReferrerPaise + a.promisedRefereePaise;
    this.burn.set(a.campaignId, (this.burn.get(a.campaignId) ?? 0) + total);
    this.audit.push({ atMs: nowMs, action: 'VESTED', detail: `${refereeId} total=${total}` });
    return { ok: true, referrerRewardPaise: a.promisedReferrerPaise, refereeRewardPaise: a.promisedRefereePaise };
  }

  /** RULES: claw-back on refund of the qualifying order. */
  clawback(refereeId: string, reason: string, nowMs: number): { ok: boolean; reclaimedPaise?: Paise; reason?: string } {
    const a = this.attributions.get(refereeId);
    if (!a) return { ok: false, reason: 'NOT_ATTRIBUTED' };
    if (a.state !== 'VESTED') return { ok: false, reason: `NOT_VESTED_${a.state}` };
    const total = a.promisedReferrerPaise + a.promisedRefereePaise;
    a.state = 'CLAWED_BACK';
    this.burn.set(a.campaignId, Math.max(0, (this.burn.get(a.campaignId) ?? 0) - total));
    this.audit.push({ atMs: nowMs, action: 'CLAWED_BACK', detail: `${refereeId} ${reason} total=${total}` });
    return { ok: true, reclaimedPaise: total };
  }

  // --------------------------------------------------------- analytics

  /** FR-MKT-007: viral coefficient — joined per inviting referrer. */
  kFactor(campaignId: string, invitesSent: number): number {
    if (invitesSent <= 0) return 0;
    let joined = 0;
    for (const a of this.attributions.values()) {
      if (a.campaignId === campaignId && a.state !== 'CLAWED_BACK') joined++;
    }
    return Math.round((joined / invitesSent) * 100) / 100;
  }

  spentPaise(campaignId: string): Paise { return this.burn.get(campaignId) ?? 0; }

  budgetBurnPercent(campaignId: string): number {
    const c = this.campaigns.get(campaignId);
    if (!c || c.budgetPaise === 0) return 0;
    return Math.round((this.spentPaise(campaignId) / c.budgetPaise) * 10000) / 100;
  }

  attribution(refereeId: string): Attribution | undefined { return this.attributions.get(refereeId); }
  auditTrail(): AuditEntry[] { return [...this.audit]; }
  campaign(campaignId: string): ReferralCampaign | undefined { return this.campaigns.get(campaignId); }
}
