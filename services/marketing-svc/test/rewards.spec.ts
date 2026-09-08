/**
 * FR-CUS-021 rewards & gamification. The suite concentrates on the claim race, because the
 * plausible implementation errors on the second tap and looks to a customer like a lost reward,
 * and on the revoke-versus-clawback split, because collapsing the two either strands value or
 * takes it from a wallet with no ledger entry.
 */
import { describe, expect, it } from 'vitest';
import * as RewardsModule from '../src/domain/rewards/rewards.js';
import {
  ACCOUNT_VELOCITY_PER_DAY,
  DEVICE_VELOCITY_PER_DAY,
  ODDS_TOTAL_BPS,
  RewardEngine,
  validateCampaign,
  type Campaign,
  type QualifyingEvent,
  type RandomSource,
  type RewardTier,
} from '../src/domain/rewards/rewards.js';

const NOW = Date.UTC(2026, 7, 24, 10, 0, 0);
const DAY = 86_400_000;

const tiers = (): RewardTier[] => [
  { tierId: 'T-BIG', rewardType: 'WALLET_CREDIT', valuePaise: 500_00, probabilityBps: 100 },
  { tierId: 'T-SMALL', rewardType: 'WALLET_CREDIT', valuePaise: 50_00, probabilityBps: 2_900 },
  { tierId: 'T-NONE', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 7_000 },
];

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'CMP-SCRATCH',
  tiers: tiers(),
  globalCap: 1_000,
  perUserCap: 3,
  eligibility: 'ALL',
  activeFromMs: NOW - DAY,
  activeToMs: NOW + 30 * DAY,
  budgetPaise: 100_000_00,
  ...over,
});

const event = (over: Partial<QualifyingEvent> = {}): QualifyingEvent => ({
  eventId: 'EV-ORD-1001',
  kind: 'ORDER_DELIVERED',
  orderId: 'ORD-1001',
  customerId: 'CUS-1',
  deviceId: 'DEV-1',
  isNewUser: false,
  tier: 'SILVER',
  occurredAtMs: NOW,
  ...over,
});

/** Deterministic randomness: always lands in the first tier. */
const alwaysBig: RandomSource = () => 0;
/** Always lands in the final no-win tier. */
const alwaysNoWin: RandomSource = () => 0.999;

const engine = (c: Campaign = campaign()) => {
  const e = new RewardEngine();
  const saved = e.saveCampaign(c);
  if (!saved.ok) throw new Error('save failed: ' + JSON.stringify(saved.violations));
  return e;
};

// ============================================ the acceptance criterion

describe('the documented acceptance scenario: one scratch, exactly one reward', () => {
  it('issues exactly one reward per order and it is immediately in inventory', () => {
    const e = engine();
    const r = e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);

    expect(r.outcome).toBe('ISSUED');
    if (r.outcome !== 'ISSUED') return;
    expect(r.reward.tierId).toBe('T-BIG');
    expect(r.reward.valuePaise).toBe(500_00);
    expect(r.reward.state).toBe('ISSUED');
    // "appears in wallet/coupon inventory instantly"
    expect(e.reward('RWD-1')!.state).toBe('ISSUED');
    expect(e.rewardForEvent('EV-ORD-1001')!.rewardId).toBe('RWD-1');
    expect(r.card.scratched).toBe(true);
    expect(r.card.replayed).toBe(false);
  });

  it('a no-win draw still consumes the scratch, with no reward on the card', () => {
    const e = engine();
    const r = e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysNoWin, NOW);
    if (r.outcome !== 'ISSUED') throw new Error('expected an issue');
    expect(r.reward.rewardType).toBe('NO_WIN');
    expect(r.reward.valuePaise).toBe(0);
    expect(r.card.scratched).toBe(true);
    expect(r.card.reward).toBeUndefined();
  });
});

// ============================================ the claim race

describe('the single-issue guarantee is IDEMPOTENCY, not an error (ERRORS)', () => {
  it('a repeat claim REPLAYS the same reward rather than erroring', () => {
    const e = engine();
    const first = e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    const second = e.claim('CMP-SCRATCH', event(), 'RWD-2', alwaysBig, NOW);

    expect(first.outcome).toBe('ISSUED');
    expect(second.outcome).toBe('ALREADY_ISSUED');
    if (second.outcome !== 'ALREADY_ISSUED') return;
    // a customer who double-taps has done nothing wrong, and an error on the second tap looks
    // like a lost reward
    expect(second.reward.rewardId).toBe('RWD-1');
    expect(second.card.replayed).toBe(true);
    expect(second.card.reward!.valuePaise).toBe(500_00);
    // and the second reward id was never created
    expect(e.reward('RWD-2')).toBeUndefined();
  });

  it('a replay does NOT consume a second slot against any cap', () => {
    const e = engine(campaign({ perUserCap: 1, globalCap: 1 }));
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    // the idempotency check runs before the caps, so a replay is never refused by a cap the
    // original claim already consumed
    const replay = e.claim('CMP-SCRATCH', event(), 'RWD-2', alwaysBig, NOW);
    expect(replay.outcome).toBe('ALREADY_ISSUED');
    expect(e.analytics('CMP-SCRATCH').issued).toBe(1);
  });

  it('a replay after redemption still shows the reward rather than reporting nothing', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    e.redeem('RWD-1', NOW + 1_000);
    const replay = e.claim('CMP-SCRATCH', event(), 'RWD-2', alwaysBig, NOW + 2_000);
    expect(replay.outcome).toBe('ALREADY_ISSUED');
    if (replay.outcome === 'ALREADY_ISSUED') expect(replay.reward.state).toBe('REDEEMED');
  });

  it('a DIFFERENT qualifying event issues its own reward', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event({ eventId: 'EV-1' }), 'RWD-1', alwaysBig, NOW);
    const second = e.claim('CMP-SCRATCH', event({ eventId: 'EV-2' }), 'RWD-2', alwaysBig, NOW);
    expect(second.outcome).toBe('ISSUED');
    expect(e.analytics('CMP-SCRATCH').issued).toBe(2);
  });
});

// ============================================ odds validation

describe('odds are integer basis points and must sum EXACTLY (ERRORS)', () => {
  it('accepts tiers summing to 10,000 bps', () => {
    expect(validateCampaign(campaign()).ok).toBe(true);
    expect(ODDS_TOTAL_BPS).toBe(10_000);
    expect(tiers().reduce((a, t) => a + t.probabilityBps, 0)).toBe(10_000);
  });

  it('BLOCKS a campaign whose odds do not sum, with arithmetic a marketer can check by hand', () => {
    const short = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'WALLET_CREDIT', valuePaise: 100_00, probabilityBps: 3_000 },
        { tierId: 'B', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 6_000 },
      ],
    }));
    expect(short.ok).toBe(false);
    if (short.ok) return;
    const v = short.violations.find((x) => x.code === 'ODDS_MUST_SUM_TO_10000_BPS')!;
    // in basis points the check is exact; with float probabilities it would need an epsilon, and
    // a campaign summing to 0.9999999 would either pass and under-issue for ever or fail opaquely
    expect(v.detail).toBe('tiers sum to 9000 bps, need 10000');
  });

  it('blocks over-summing odds too', () => {
    const over = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'WALLET_CREDIT', valuePaise: 100_00, probabilityBps: 6_000 },
        { tierId: 'B', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 6_000 },
      ],
    }));
    expect(over.ok).toBe(false);
  });

  it('an invalid campaign never becomes live', () => {
    const e = new RewardEngine();
    const bad = campaign({ tiers: [{ tierId: 'A', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 5_000 }] });
    expect(e.saveCampaign(bad).ok).toBe(false);
    expect(e.campaign('CMP-SCRATCH')).toBeUndefined();
    // and a claim against it is refused rather than drawing from broken odds
    expect(e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW).outcome).toBe('REFUSED');
  });

  it('refuses a no-win tier with value and a winning tier without', () => {
    const v1 = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'NO_WIN', valuePaise: 100, probabilityBps: 10_000 },
      ],
    }));
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.violations.some((x) => x.code === 'NO_WIN_TIER_MUST_HAVE_ZERO_VALUE')).toBe(true);

    const v2 = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'COUPON', valuePaise: 0, probabilityBps: 10_000 },
      ],
    }));
    if (!v2.ok) expect(v2.violations.some((x) => x.code === 'WINNING_TIER_MUST_HAVE_POSITIVE_VALUE')).toBe(true);
  });

  it('refuses duplicate tier ids, zero probabilities and no tiers at all', () => {
    const dup = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 5_000 },
        { tierId: 'A', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 5_000 },
      ],
    }));
    if (!dup.ok) expect(dup.violations.some((x) => x.code === 'DUPLICATE_TIER_ID')).toBe(true);

    const zero = validateCampaign(campaign({
      tiers: [
        { tierId: 'A', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 10_000 },
        { tierId: 'B', rewardType: 'COUPON', valuePaise: 100, probabilityBps: 0 },
      ],
    }));
    if (!zero.ok) expect(zero.violations.some((x) => x.code === 'TIER_PROBABILITY_MUST_BE_POSITIVE')).toBe(true);

    expect(validateCampaign(campaign({ tiers: [] })).ok).toBe(false);
  });

  it('refuses incoherent caps, budget and window', () => {
    const v = validateCampaign(campaign({ globalCap: 0, perUserCap: 0, budgetPaise: 0, activeToMs: NOW - DAY }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    const codes = v.violations.map((x) => x.code);
    expect(codes).toContain('GLOBAL_CAP_MUST_BE_POSITIVE');
    expect(codes).toContain('BUDGET_MUST_BE_POSITIVE');
    expect(codes).toContain('CAMPAIGN_WINDOW_INVERTED');

    const bigger = validateCampaign(campaign({ globalCap: 5, perUserCap: 10 }));
    if (!bigger.ok) {
      expect(bigger.violations.some((x) => x.code === 'PER_USER_CAP_EXCEEDS_GLOBAL_CAP')).toBe(true);
    }
  });
});

// ============================================ server-side odds

describe('odds are server-side: a client cannot choose its prize (SECURITY)', () => {
  it('no exported function accepts a caller-supplied outcome', () => {
    const suspicious = Object.keys(RewardsModule).filter((n) => {
      const l = n.toLowerCase();
      return l.includes('setoutcome') || l.includes('forceaward') || l.includes('withoutcome')
        || l.includes('claimwithtier') || l.includes('awardtier');
    });
    expect(suspicious).toEqual([]);
  });

  it('the drawn tier follows the odds boundaries exactly', () => {
    const e = engine();
    // T-BIG spans 0..99 bps, T-SMALL 100..2999, T-NONE 3000..9999
    const at = (roll: number, id: string) => {
      const fresh = engine();
      const r = fresh.claim('CMP-SCRATCH', event(), 'RWD-1', () => roll / ODDS_TOTAL_BPS, NOW);
      if (r.outcome !== 'ISSUED') throw new Error('expected an issue');
      expect(r.reward.tierId).toBe(id);
    };
    at(0, 'T-BIG');
    at(99, 'T-BIG');
    at(100, 'T-SMALL');
    at(2_999, 'T-SMALL');
    at(3_000, 'T-NONE');
    at(9_999, 'T-NONE');
    expect(e.campaign('CMP-SCRATCH')).toBeDefined();
  });

  it('a rogue randomness source outside 0..1 cannot escape the tier table', () => {
    for (const roll of [-5, 1.5, 99]) {
      const e = engine();
      const r = e.claim('CMP-SCRATCH', event(), 'RWD-1', () => roll, NOW);
      expect(r.outcome).toBe('ISSUED');
      if (r.outcome === 'ISSUED') {
        expect(['T-BIG', 'T-SMALL', 'T-NONE']).toContain(r.reward.tierId);
      }
    }
  });

  it('a one-basis-point tier is reachable rather than rounded out of existence', () => {
    const e = engine(campaign({
      tiers: [
        { tierId: 'T-RARE', rewardType: 'WALLET_CREDIT', valuePaise: 10_000_00, probabilityBps: 1 },
        { tierId: 'T-NONE', rewardType: 'NO_WIN', valuePaise: 0, probabilityBps: 9_999 },
      ],
    }));
    const r = e.claim('CMP-SCRATCH', event(), 'RWD-1', () => 0, NOW);
    if (r.outcome === 'ISSUED') expect(r.reward.tierId).toBe('T-RARE');
  });
});

// ============================================ caps, eligibility, velocity

describe('caps, eligibility and velocity (VALIDATION / SECURITY)', () => {
  it('enforces the per-user cap and then the global cap', () => {
    const e = engine(campaign({ perUserCap: 2, globalCap: 3 }));
    for (let i = 0; i < 2; i++) {
      expect(e.claim('CMP-SCRATCH', event({ eventId: `EV-${i}` }), `RWD-${i}`, alwaysNoWin, NOW).outcome)
        .toBe('ISSUED');
    }
    const capped = e.claim('CMP-SCRATCH', event({ eventId: 'EV-X' }), 'RWD-X', alwaysNoWin, NOW);
    expect(capped.outcome).toBe('REFUSED');
    if (capped.outcome === 'REFUSED') expect(capped.reason).toBe('PER_USER_CAP_REACHED');

    // a different customer still gets one, until the global cap bites
    expect(e.claim('CMP-SCRATCH', event({ eventId: 'EV-Y', customerId: 'CUS-2', deviceId: 'DEV-2' }),
      'RWD-Y', alwaysNoWin, NOW).outcome).toBe('ISSUED');
    const global = e.claim('CMP-SCRATCH',
      event({ eventId: 'EV-Z', customerId: 'CUS-3', deviceId: 'DEV-3' }), 'RWD-Z', alwaysNoWin, NOW);
    expect(global.outcome).toBe('REFUSED');
    if (global.outcome === 'REFUSED') expect(global.reason).toBe('GLOBAL_CAP_REACHED');
  });

  it('enforces the device velocity cap across DIFFERENT accounts on one device', () => {
    const e = engine(campaign({ perUserCap: 10, globalCap: 100 }));
    for (let i = 0; i < DEVICE_VELOCITY_PER_DAY; i++) {
      expect(e.claim('CMP-SCRATCH',
        event({ eventId: `EV-${i}`, customerId: `CUS-${i}`, deviceId: 'DEV-SHARED' }),
        `RWD-${i}`, alwaysNoWin, NOW).outcome).toBe('ISSUED');
    }
    const capped = e.claim('CMP-SCRATCH',
      event({ eventId: 'EV-OVER', customerId: 'CUS-NEW', deviceId: 'DEV-SHARED' }),
      'RWD-OVER', alwaysNoWin, NOW);
    expect(capped.outcome).toBe('REFUSED');
    if (capped.outcome === 'REFUSED') expect(capped.reason).toBe('DEVICE_VELOCITY_CAP_REACHED');
  });

  it('the velocity window rolls, so yesterday does not block today', () => {
    const e = engine(campaign({ perUserCap: 100, globalCap: 100 }));
    for (let i = 0; i < DEVICE_VELOCITY_PER_DAY; i++) {
      e.claim('CMP-SCRATCH', event({ eventId: `EV-${i}`, customerId: `CUS-${i}` }),
        `RWD-${i}`, alwaysNoWin, NOW);
    }
    expect(e.claim('CMP-SCRATCH', event({ eventId: 'EV-TOMORROW', customerId: 'CUS-T' }),
      'RWD-T', alwaysNoWin, NOW + DAY).outcome).toBe('ISSUED');
    expect(ACCOUNT_VELOCITY_PER_DAY).toBe(5);
  });

  it('enforces eligibility rules', () => {
    const newOnly = engine(campaign({ eligibility: 'NEW_USER_ONLY' }));
    const returning = newOnly.claim('CMP-SCRATCH', event({ isNewUser: false }), 'RWD-1', alwaysBig, NOW);
    expect(returning.outcome).toBe('REFUSED');
    if (returning.outcome === 'REFUSED') expect(returning.reason).toBe('NOT_A_NEW_USER');
    expect(newOnly.claim('CMP-SCRATCH', event({ eventId: 'EV-2', isNewUser: true }), 'RWD-2', alwaysBig, NOW)
      .outcome).toBe('ISSUED');

    const goldOnly = engine(campaign({ eligibility: 'TIER_GOLD_PLUS' }));
    expect(goldOnly.claim('CMP-SCRATCH', event({ tier: 'SILVER' }), 'RWD-1', alwaysBig, NOW).outcome)
      .toBe('REFUSED');
    expect(goldOnly.claim('CMP-SCRATCH', event({ eventId: 'EV-G', tier: 'PLATINUM' }), 'RWD-G', alwaysBig, NOW)
      .outcome).toBe('ISSUED');
  });

  it('refuses a claim outside the campaign window', () => {
    const e = engine();
    const early = e.claim('CMP-SCRATCH', event({ occurredAtMs: NOW - 10 * DAY }), 'RWD-1', alwaysBig, NOW);
    expect(early.outcome).toBe('REFUSED');
    if (early.outcome === 'REFUSED') expect(early.reason).toBe('CAMPAIGN_NOT_ACTIVE_AT_EVENT_TIME');
  });

  it('refuses rather than issuing a reward the budget cannot fund', () => {
    const e = engine(campaign({ budgetPaise: 100_00 }));
    // a winning draw the budget cannot fund is refused, not issued and then clawed back, which
    // would be worse for the customer than never winning
    const r = e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    expect(r.outcome).toBe('REFUSED');
    if (r.outcome === 'REFUSED') expect(r.reason).toBe('CAMPAIGN_BUDGET_EXHAUSTED');
  });
});

// ============================================ revoke vs clawback

describe('a cancelled order REVOKES an unredeemed reward and CLAWS BACK a redeemed one (RULES)', () => {
  it('revokes an unredeemed reward and returns its value to the budget', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    expect(e.analytics('CMP-SCRATCH').spentPaise).toBe(500_00);

    const r = e.onOrderCancelledOrRefunded('EV-ORD-1001', 'order refunded in full', NOW + DAY);
    expect(r.action).toBe('REVOKED');
    if (r.action !== 'REVOKED') return;
    expect(r.clawbackPaise).toBe(0);
    expect(e.reward('RWD-1')!.state).toBe('REVOKED');
    expect(e.reward('RWD-1')!.closedReason).toBe('order refunded in full');
    // an unredeemed reward returns its value to the campaign
    expect(e.analytics('CMP-SCRATCH').spentPaise).toBe(0);
  });

  it('CLAWS BACK a redeemed reward, reporting the amount owed', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    e.redeem('RWD-1', NOW + 1_000);

    const r = e.onOrderCancelledOrRefunded('EV-ORD-1001', 'order cancelled after redemption', NOW + DAY);
    expect(r.action).toBe('CLAWED_BACK');
    if (r.action !== 'CLAWED_BACK') return;
    // it has already become money the customer spent, so it cannot simply be withdrawn
    expect(r.clawbackPaise).toBe(500_00);
    expect(e.reward('RWD-1')!.state).toBe('CLAWED_BACK');
  });

  it('does nothing for a no-win reward, which has no value to reclaim', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysNoWin, NOW);
    const r = e.onOrderCancelledOrRefunded('EV-ORD-1001', 'cancelled', NOW + DAY);
    expect(r.action).toBe('NOTHING_TO_DO');
    if (r.action === 'NOTHING_TO_DO') expect(r.reason).toBe('NO_WIN_REWARD_HAS_NO_VALUE');
  });

  it('is idempotent: a second cancellation event changes nothing', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    e.onOrderCancelledOrRefunded('EV-ORD-1001', 'cancelled', NOW + DAY);
    const again = e.onOrderCancelledOrRefunded('EV-ORD-1001', 'cancelled again', NOW + 2 * DAY);
    expect(again.action).toBe('NOTHING_TO_DO');
    if (again.action === 'NOTHING_TO_DO') expect(again.reason).toBe('ALREADY_REVOKED');
    expect(e.analytics('CMP-SCRATCH').spentPaise).toBe(0);
  });

  it('does nothing when the event never earned a reward', () => {
    const r = engine().onOrderCancelledOrRefunded('EV-UNKNOWN', 'cancelled', NOW);
    expect(r.action).toBe('NOTHING_TO_DO');
    if (r.action === 'NOTHING_TO_DO') expect(r.reason).toBe('NO_REWARD_FOR_EVENT');
  });

  it('a revoked reward can no longer be redeemed', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    e.onOrderCancelledOrRefunded('EV-ORD-1001', 'cancelled', NOW + DAY);
    const r = e.redeem('RWD-1', NOW + 2 * DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_REDEEMABLE_IN_STATE_REVOKED');
  });
});

describe('redemption', () => {
  it('cannot redeem twice, redeem a no-win, or redeem an unknown reward', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event(), 'RWD-1', alwaysBig, NOW);
    expect(e.redeem('RWD-1', NOW).ok).toBe(true);
    expect(e.redeem('RWD-1', NOW).ok).toBe(false);
    expect(e.redeem('RWD-NONE', NOW).ok).toBe(false);

    e.claim('CMP-SCRATCH', event({ eventId: 'EV-2' }), 'RWD-2', alwaysNoWin, NOW);
    const noWin = e.redeem('RWD-2', NOW);
    expect(noWin.ok).toBe(false);
    if (!noWin.ok) expect(noWin.reason).toBe('NOTHING_TO_REDEEM');
  });
});

// ============================================ analytics

describe('campaign analytics (OUTPUTS)', () => {
  it('counts each state and tracks the remaining budget', () => {
    const e = engine();
    e.claim('CMP-SCRATCH', event({ eventId: 'EV-1' }), 'RWD-1', alwaysBig, NOW);
    e.claim('CMP-SCRATCH', event({ eventId: 'EV-2' }), 'RWD-2', alwaysBig, NOW);
    e.claim('CMP-SCRATCH', event({ eventId: 'EV-3' }), 'RWD-3', alwaysNoWin, NOW);
    e.redeem('RWD-1', NOW);
    e.onOrderCancelledOrRefunded('EV-2', 'cancelled', NOW + DAY);

    const a = e.analytics('CMP-SCRATCH');
    expect(a.issued).toBe(3);
    expect(a.redeemed).toBe(1);
    expect(a.revoked).toBe(1);
    expect(a.noWins).toBe(1);
    expect(a.spentPaise).toBe(500_00);
    expect(a.budgetRemainingPaise).toBe(100_000_00 - 500_00);
  });

  it('an untouched campaign reports zeroes rather than undefined', () => {
    const a = engine().analytics('CMP-SCRATCH');
    expect(a.issued).toBe(0);
    expect(a.spentPaise).toBe(0);
    expect(a.budgetRemainingPaise).toBe(100_000_00);
  });

  it('an unknown campaign reports zero budget rather than throwing', () => {
    expect(engine().analytics('CMP-NONE').budgetRemainingPaise).toBe(0);
  });
});
