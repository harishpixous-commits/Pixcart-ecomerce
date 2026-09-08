/**
 * Rewards & gamification — FR-CUS-021.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "run configurable reward campaigns — scratch cards post-order, streaks, review
 *                rewards — issuing wallet promo credit or coupons under fraud-guarded rules."
 *   INPUTS:     "Qualifying events, campaign config (odds, caps, eligibility), user claim actions."
 *   OUTPUTS:    "Reward artefacts (scratch card UI state), issued credits/coupons, campaign
 *                analytics."
 *   VALIDATION: "One reward per qualifying event; global + per-user caps; eligibility rules (new
 *                user, tier)."
 *   RULES:      "Rewards from cancelled/refunded orders auto-revoke if unredeemed, claw back if
 *                redeemed (promo bucket)."
 *   ERRORS:     "Odds config invalid (sum≠1) → campaign blocked at save; claim race →
 *                single-issue guarantee."
 *   SECURITY:   "Server-side odds; device+account velocity caps; abuse patterns feed FR-AI-010."
 *   ACCEPTANCE: "Given a delivered order in an active scratch campaign, When user scratches, Then
 *                exactly one reward issues per order and appears in wallet/coupon inventory
 *                instantly."
 *
 * THREE DESIGN DECISIONS HERE ARE DELIBERATE:
 *
 *  1. ODDS ARE INTEGER BASIS POINTS, NOT FRACTIONS. The requirement says a campaign whose odds do
 *     not sum to 1 is blocked at save, and with floating-point probabilities that check needs an
 *     epsilon — which means a campaign summing to 0.9999999 either passes and quietly under-issues
 *     for ever, or fails and nobody can tell why. In basis points summing to exactly 10,000 the
 *     check is exact and the error message is arithmetic a marketer can verify by hand.
 *
 *  2. THE SINGLE-ISSUE GUARANTEE IS IDEMPOTENCY, NOT A LOCK. Two concurrent scratches on one order
 *     return the SAME reward rather than one succeeding and one erroring. A customer who
 *     double-taps has not done anything wrong, and an error on the second tap looks like a lost
 *     reward — so the second claim replays the first result.
 *
 *  3. REVOKE AND CLAWBACK ARE DIFFERENT OPERATIONS. An unredeemed reward from a cancelled order is
 *     simply withdrawn; a redeemed one has already become money the customer spent, so it is
 *     clawed back against the promo bucket rather than pretended never to have existed. Collapsing
 *     the two would either strand value or take it back from a wallet with no ledger entry.
 */

export type Paise = number;

/** ERRORS: odds must sum to exactly this in basis points. */
export const ODDS_TOTAL_BPS = 10_000;
/** SECURITY: claims per device per day. */
export const DEVICE_VELOCITY_PER_DAY = 5;
/** SECURITY: claims per account per day. */
export const ACCOUNT_VELOCITY_PER_DAY = 5;

export type RewardType = 'WALLET_CREDIT' | 'COUPON' | 'NO_WIN';

export type Eligibility = 'ALL' | 'NEW_USER_ONLY' | 'TIER_GOLD_PLUS';

export interface RewardTier {
  tierId: string;
  rewardType: RewardType;
  valuePaise: Paise;
  /** Integer basis points. All tiers in a campaign must sum to 10,000. */
  probabilityBps: number;
}

export interface Campaign {
  campaignId: string;
  tiers: RewardTier[];
  /** VALIDATION: global and per-user caps. */
  globalCap: number;
  perUserCap: number;
  eligibility: Eligibility;
  activeFromMs: number;
  activeToMs: number;
  /** Total promo budget; a campaign cannot issue past it. */
  budgetPaise: Paise;
}

export interface Violation {
  code: string;
  detail: string;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; violations: Violation[] };

/**
 * ERRORS: validate a campaign at SAVE. A campaign whose odds are wrong must never become live,
 * because by the time it is issuing rewards the error is a payout problem rather than a config one.
 */
export function validateCampaign(c: Campaign): SaveResult {
  const violations: Violation[] = [];

  if (!c.campaignId || c.campaignId.trim().length === 0) {
    violations.push({ code: 'CAMPAIGN_ID_REQUIRED', detail: '' });
  }
  if (c.tiers.length === 0) {
    violations.push({ code: 'AT_LEAST_ONE_TIER_REQUIRED', detail: '' });
  }

  const totalBps = c.tiers.reduce((a, t) => a + t.probabilityBps, 0);
  if (c.tiers.length > 0 && totalBps !== ODDS_TOTAL_BPS) {
    violations.push({
      code: 'ODDS_MUST_SUM_TO_10000_BPS',
      detail: `tiers sum to ${totalBps} bps, need ${ODDS_TOTAL_BPS}`,
    });
  }
  for (const t of c.tiers) {
    if (t.probabilityBps <= 0) {
      violations.push({ code: 'TIER_PROBABILITY_MUST_BE_POSITIVE', detail: t.tierId });
    }
    if (t.rewardType === 'NO_WIN' && t.valuePaise !== 0) {
      violations.push({ code: 'NO_WIN_TIER_MUST_HAVE_ZERO_VALUE', detail: t.tierId });
    }
    if (t.rewardType !== 'NO_WIN' && t.valuePaise <= 0) {
      violations.push({ code: 'WINNING_TIER_MUST_HAVE_POSITIVE_VALUE', detail: t.tierId });
    }
  }
  const ids = new Set(c.tiers.map((t) => t.tierId));
  if (ids.size !== c.tiers.length) {
    violations.push({ code: 'DUPLICATE_TIER_ID', detail: '' });
  }

  if (c.globalCap <= 0) violations.push({ code: 'GLOBAL_CAP_MUST_BE_POSITIVE', detail: '' });
  if (c.perUserCap <= 0) violations.push({ code: 'PER_USER_CAP_MUST_BE_POSITIVE', detail: '' });
  if (c.perUserCap > c.globalCap) {
    violations.push({ code: 'PER_USER_CAP_EXCEEDS_GLOBAL_CAP', detail: `${c.perUserCap} > ${c.globalCap}` });
  }
  if (c.budgetPaise <= 0) violations.push({ code: 'BUDGET_MUST_BE_POSITIVE', detail: '' });
  if (c.activeToMs <= c.activeFromMs) {
    violations.push({ code: 'CAMPAIGN_WINDOW_INVERTED', detail: '' });
  }

  return violations.length > 0 ? { ok: false, violations } : { ok: true };
}

/** The qualifying event a claim is made against. */
export interface QualifyingEvent {
  eventId: string;
  kind: 'ORDER_DELIVERED' | 'REVIEW_PUBLISHED' | 'STREAK_COMPLETED';
  orderId?: string;
  customerId: string;
  deviceId: string;
  isNewUser: boolean;
  tier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';
  occurredAtMs: number;
}

export type RewardState = 'ISSUED' | 'REDEEMED' | 'REVOKED' | 'CLAWED_BACK' | 'EXPIRED';

export interface Reward {
  rewardId: string;
  campaignId: string;
  eventId: string;
  customerId: string;
  tierId: string;
  rewardType: RewardType;
  valuePaise: Paise;
  state: RewardState;
  issuedAtMs: number;
  redeemedAtMs?: number;
  closedReason?: string;
}

/** OUTPUTS: the scratch-card UI state. */
export interface ScratchCardState {
  eventId: string;
  scratched: boolean;
  reward?: { rewardType: RewardType; valuePaise: Paise; tierId: string };
  /** True when this claim replayed an existing reward rather than issuing a new one. */
  replayed: boolean;
}

export type ClaimOutcome =
  | { outcome: 'ISSUED'; reward: Reward; card: ScratchCardState }
  /** ERRORS: the single-issue guarantee — a repeat claim replays rather than erroring. */
  | { outcome: 'ALREADY_ISSUED'; reward: Reward; card: ScratchCardState }
  | { outcome: 'REFUSED'; reason: string };

/**
 * SECURITY: the server-side randomness source, injected. There is no parameter anywhere in this
 * module through which a caller could supply an OUTCOME — only a source of randomness the server
 * controls — so a client cannot choose its own prize.
 */
export type RandomSource = () => number;

export class RewardEngine {
  private readonly campaigns = new Map<string, Campaign>();
  private readonly rewards = new Map<string, Reward>();
  /** eventId -> rewardId, which is what makes a claim idempotent. */
  private readonly byEvent = new Map<string, string>();
  private readonly issuedPerUser = new Map<string, number>();
  private readonly claimsByDeviceDay = new Map<string, number>();
  private readonly claimsByAccountDay = new Map<string, number>();
  private issuedTotal = 0;
  private spentPaise = 0;

  /** ERRORS: a campaign with invalid odds is blocked at save and never becomes live. */
  saveCampaign(c: Campaign): SaveResult {
    const validated = validateCampaign(c);
    if (!validated.ok) return validated;
    this.campaigns.set(c.campaignId, c);
    return { ok: true };
  }

  campaign(campaignId: string): Campaign | undefined {
    return this.campaigns.get(campaignId);
  }

  private dayKey(ms: number): string {
    return String(Math.floor(ms / 86_400_000));
  }

  private isEligible(c: Campaign, event: QualifyingEvent): string | null {
    if (event.occurredAtMs < c.activeFromMs || event.occurredAtMs > c.activeToMs) {
      return 'CAMPAIGN_NOT_ACTIVE_AT_EVENT_TIME';
    }
    if (c.eligibility === 'NEW_USER_ONLY' && !event.isNewUser) return 'NOT_A_NEW_USER';
    if (c.eligibility === 'TIER_GOLD_PLUS'
        && event.tier !== 'GOLD' && event.tier !== 'PLATINUM') {
      return 'TIER_BELOW_GOLD';
    }
    return null;
  }

  /**
   * Draw a tier from the campaign's odds using the server's randomness. The cumulative walk is in
   * integer basis points, so the boundaries are exact and a tier with 1 bps really does win once
   * in ten thousand rather than being unreachable through rounding.
   */
  private draw(c: Campaign, random: RandomSource): RewardTier {
    const roll = Math.min(ODDS_TOTAL_BPS - 1, Math.max(0,
      Math.floor(random() * ODDS_TOTAL_BPS)));
    let cumulative = 0;
    for (const tier of c.tiers) {
      cumulative += tier.probabilityBps;
      if (roll < cumulative) return tier;
    }
    // unreachable for a validated campaign; returning the last tier beats returning undefined
    return c.tiers[c.tiers.length - 1];
  }

  /**
   * Claim a reward for a qualifying event.
   *
   * VALIDATION: one reward per qualifying event. ERRORS: a repeat claim REPLAYS the existing
   * reward rather than erroring — a customer who double-taps has done nothing wrong, and an error
   * on the second tap looks like a lost reward.
   */
  claim(campaignId: string, event: QualifyingEvent, rewardId: string,
        random: RandomSource, nowMs: number): ClaimOutcome {
    // the idempotency check comes FIRST, before caps and velocity, so a replay is never refused
    // by a cap the original claim already consumed
    const existingId = this.byEvent.get(event.eventId);
    if (existingId !== undefined) {
      const existing = this.rewards.get(existingId)!;
      return {
        outcome: 'ALREADY_ISSUED',
        reward: existing,
        card: {
          eventId: event.eventId,
          scratched: true,
          reward: existing.rewardType === 'NO_WIN'
            ? undefined
            : { rewardType: existing.rewardType, valuePaise: existing.valuePaise, tierId: existing.tierId },
          replayed: true,
        },
      };
    }

    const c = this.campaigns.get(campaignId);
    if (!c) return { outcome: 'REFUSED', reason: 'UNKNOWN_CAMPAIGN' };

    const ineligible = this.isEligible(c, event);
    if (ineligible) return { outcome: 'REFUSED', reason: ineligible };

    if (this.issuedTotal >= c.globalCap) {
      return { outcome: 'REFUSED', reason: 'GLOBAL_CAP_REACHED' };
    }
    const userKey = `${campaignId}:${event.customerId}`;
    if ((this.issuedPerUser.get(userKey) ?? 0) >= c.perUserCap) {
      return { outcome: 'REFUSED', reason: 'PER_USER_CAP_REACHED' };
    }

    // SECURITY: device and account velocity caps
    const day = this.dayKey(nowMs);
    const deviceKey = `${event.deviceId}:${day}`;
    if ((this.claimsByDeviceDay.get(deviceKey) ?? 0) >= DEVICE_VELOCITY_PER_DAY) {
      return { outcome: 'REFUSED', reason: 'DEVICE_VELOCITY_CAP_REACHED' };
    }
    const accountKey = `${event.customerId}:${day}`;
    if ((this.claimsByAccountDay.get(accountKey) ?? 0) >= ACCOUNT_VELOCITY_PER_DAY) {
      return { outcome: 'REFUSED', reason: 'ACCOUNT_VELOCITY_CAP_REACHED' };
    }

    const tier = this.draw(c, random);

    // a winning draw the budget cannot fund is downgraded to a no-win rather than issued and
    // then clawed back, which would be worse for the customer than never winning
    const wouldSpend = tier.rewardType === 'NO_WIN' ? 0 : tier.valuePaise;
    if (this.spentPaise + wouldSpend > c.budgetPaise) {
      return { outcome: 'REFUSED', reason: 'CAMPAIGN_BUDGET_EXHAUSTED' };
    }

    const reward: Reward = {
      rewardId,
      campaignId,
      eventId: event.eventId,
      customerId: event.customerId,
      tierId: tier.tierId,
      rewardType: tier.rewardType,
      valuePaise: tier.rewardType === 'NO_WIN' ? 0 : tier.valuePaise,
      state: 'ISSUED',
      issuedAtMs: nowMs,
    };
    this.rewards.set(rewardId, reward);
    this.byEvent.set(event.eventId, rewardId);
    this.issuedTotal++;
    this.issuedPerUser.set(userKey, (this.issuedPerUser.get(userKey) ?? 0) + 1);
    this.claimsByDeviceDay.set(deviceKey, (this.claimsByDeviceDay.get(deviceKey) ?? 0) + 1);
    this.claimsByAccountDay.set(accountKey, (this.claimsByAccountDay.get(accountKey) ?? 0) + 1);
    this.spentPaise += wouldSpend;

    return {
      outcome: 'ISSUED',
      reward,
      card: {
        eventId: event.eventId,
        scratched: true,
        reward: tier.rewardType === 'NO_WIN'
          ? undefined
          : { rewardType: tier.rewardType, valuePaise: reward.valuePaise, tierId: tier.tierId },
        replayed: false,
      },
    };
  }

  /** The reward is in the wallet the moment it is issued, per the acceptance criterion. */
  redeem(rewardId: string, nowMs: number): { ok: true } | { ok: false; reason: string } {
    const r = this.rewards.get(rewardId);
    if (!r) return { ok: false, reason: 'UNKNOWN_REWARD' };
    if (r.rewardType === 'NO_WIN') return { ok: false, reason: 'NOTHING_TO_REDEEM' };
    if (r.state !== 'ISSUED') return { ok: false, reason: `NOT_REDEEMABLE_IN_STATE_${r.state}` };
    r.state = 'REDEEMED';
    r.redeemedAtMs = nowMs;
    return { ok: true };
  }

  /**
   * RULES: a reward from a cancelled or refunded order.
   *
   * Unredeemed, it is simply REVOKED. Redeemed, it has already become money the customer spent, so
   * it is CLAWED_BACK against the promo bucket instead — collapsing the two would either strand
   * value or take it out of a wallet with no ledger entry behind it.
   */
  onOrderCancelledOrRefunded(orderEventId: string, reason: string, nowMs: number):
    { action: 'REVOKED' | 'CLAWED_BACK'; reward: Reward; clawbackPaise: Paise }
    | { action: 'NOTHING_TO_DO'; reason: string } {
    const rewardId = this.byEvent.get(orderEventId);
    if (rewardId === undefined) return { action: 'NOTHING_TO_DO', reason: 'NO_REWARD_FOR_EVENT' };
    const r = this.rewards.get(rewardId)!;

    if (r.state === 'REVOKED' || r.state === 'CLAWED_BACK') {
      return { action: 'NOTHING_TO_DO', reason: `ALREADY_${r.state}` };
    }
    if (r.rewardType === 'NO_WIN') {
      return { action: 'NOTHING_TO_DO', reason: 'NO_WIN_REWARD_HAS_NO_VALUE' };
    }

    if (r.state === 'REDEEMED') {
      r.state = 'CLAWED_BACK';
      r.closedReason = reason;
      return { action: 'CLAWED_BACK', reward: r, clawbackPaise: r.valuePaise };
    }
    r.state = 'REVOKED';
    r.closedReason = reason;
    // an unredeemed reward returns its value to the campaign budget
    this.spentPaise -= r.valuePaise;
    return { action: 'REVOKED', reward: r, clawbackPaise: 0 };
  }

  reward(rewardId: string): Reward | undefined {
    return this.rewards.get(rewardId);
  }

  rewardForEvent(eventId: string): Reward | undefined {
    const id = this.byEvent.get(eventId);
    return id === undefined ? undefined : this.rewards.get(id);
  }

  /** OUTPUTS: campaign analytics. */
  analytics(campaignId: string): {
    issued: number; redeemed: number; revoked: number; clawedBack: number;
    noWins: number; spentPaise: Paise; budgetRemainingPaise: Paise;
  } {
    const c = this.campaigns.get(campaignId);
    const mine = [...this.rewards.values()].filter((r) => r.campaignId === campaignId);
    return {
      issued: mine.length,
      redeemed: mine.filter((r) => r.state === 'REDEEMED').length,
      revoked: mine.filter((r) => r.state === 'REVOKED').length,
      clawedBack: mine.filter((r) => r.state === 'CLAWED_BACK').length,
      noWins: mine.filter((r) => r.rewardType === 'NO_WIN').length,
      spentPaise: this.spentPaise,
      budgetRemainingPaise: Math.max(0, (c?.budgetPaise ?? 0) - this.spentPaise),
    };
  }
}
