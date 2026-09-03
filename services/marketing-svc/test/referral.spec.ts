/**
 * FR-CUS-025 referral programme and FR-MKT-007 operations, including the documented budget-cap
 * acceptance scenario and a cross-slice proof that a blocked self-referral feeds the Slice-21 risk
 * engine's SELF_REFERRAL_MATCH rule — the rule that was written against this programme before it
 * existed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUARTERLY_CAP,
  MAX_REWARD_PAISE,
  NO_MATCH,
  QUALIFYING_ORDER_MIN_PAISE,
  ReferralProgramme,
  type ReferralCampaign,
} from '../src/domain/referral/referral.js';
import { decide, type RiskSignals } from '../../risk-svc/src/domain/risk.js';

const DAY = 24 * 3600 * 1000;
const START = Date.UTC(2026, 7, 1, 0, 0, 0);
const NOW = START + DAY;

const campaign = (over: Partial<ReferralCampaign> = {}): ReferralCampaign => ({
  campaignId: 'REF-2026',
  version: 1,
  fromMs: START,
  toMs: START + 90 * DAY,
  referrerRewardPaise: 200 * 100,
  refereeRewardPaise: 100 * 100,
  qualifyingOrderMinPaise: QUALIFYING_ORDER_MIN_PAISE,
  budgetPaise: 1_00_000 * 100,          // ₹1,00,000, the acceptance scenario's budget
  ...over,
});

const programme = (over: Partial<ReferralCampaign> = {}) => {
  const p = new ReferralProgramme();
  const r = p.configureCampaign(campaign(over));
  if (!r.ok) throw new Error('campaign config failed: ' + r.violations.join(','));
  p.issueCode('HARISH50', 'CUS-REFERRER', 'REF-2026');
  return p;
};

describe('FR-MKT-007 campaign configuration', () => {
  it('enforces the ₹500 reward ceiling on both sides', () => {
    const p = new ReferralProgramme();
    const over = p.configureCampaign(campaign({ referrerRewardPaise: MAX_REWARD_PAISE + 1 }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations.some((v) => v.startsWith('REFERRER_REWARD_EXCEEDS_MAX'))).toBe(true);

    const overReferee = p.configureCampaign(campaign({ refereeRewardPaise: MAX_REWARD_PAISE + 1 }));
    expect(overReferee.ok).toBe(false);
    expect(p.configureCampaign(campaign({ referrerRewardPaise: MAX_REWARD_PAISE })).ok).toBe(true);
  });

  it('makes the budget mandatory and rejects an inverted window or sub-floor qualifying order', () => {
    const p = new ReferralProgramme();
    const noBudget = p.configureCampaign(campaign({ budgetPaise: 0 }));
    expect(noBudget.ok).toBe(false);
    if (!noBudget.ok) expect(noBudget.violations).toContain('BUDGET_MANDATORY');

    const bad = p.configureCampaign(campaign({ toMs: START, qualifyingOrderMinPaise: 100 * 100 }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.violations).toContain('WINDOW_INVERTED');
      expect(bad.violations.some((v) => v.startsWith('QUALIFYING_ORDER_BELOW_FLOOR'))).toBe(true);
    }
  });

  it('defaults the per-referrer quarterly cap to 20', () => {
    expect(programme().campaign('REF-2026')!.perReferrerQuarterlyCap).toBe(DEFAULT_QUARTERLY_CAP);
  });

  it('mid-campaign changes are forward-only and must raise the version', () => {
    const p = programme();
    const backdated = p.updateCampaign(campaign({ version: 2, fromMs: NOW - DAY }), NOW);
    expect(backdated.ok).toBe(false);
    if (!backdated.ok) expect(backdated.violations).toContain('MID_CAMPAIGN_CHANGE_MUST_BE_FORWARD_ONLY');

    const sameVersion = p.updateCampaign(campaign({ version: 1, fromMs: NOW + 10 * DAY }), NOW);
    expect(sameVersion.ok).toBe(false);
    if (!sameVersion.ok) expect(sameVersion.violations).toContain('VERSION_MUST_INCREASE');

    expect(p.updateCampaign(campaign({ version: 2, fromMs: NOW + 10 * DAY }), NOW).ok).toBe(true);
  });
});

describe('FR-CUS-025 self-referral blocking (VALIDATION)', () => {
  it('blocks on a device, payment-instrument or address match, each independently', () => {
    for (const signals of [
      { ...NO_MATCH, deviceMatch: true },
      { ...NO_MATCH, paymentInstrumentMatch: true },
      { ...NO_MATCH, addressFuzzyMatch: true },
    ]) {
      const p = programme();
      const r = p.attribute('HARISH50', 'CUS-REFEREE', signals, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe('SELF_REFERRAL_BLOCKED');
        expect(r.riskSignal).toEqual(signals);
      }
      expect(p.attribution('CUS-REFEREE')).toBeUndefined();
      expect(p.auditTrail().some((e) => e.action === 'SELF_REFERRAL_BLOCKED')).toBe(true);
    }
  });

  it('blocks a referrer referring themselves outright', () => {
    const p = programme();
    const r = p.attribute('HARISH50', 'CUS-REFERRER', NO_MATCH, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SELF_REFERRAL_BLOCKED');
  });

  it('CROSS-SLICE: the blocked signal drives the risk engine that references this rule', () => {
    const p = programme();
    const blocked = p.attribute('HARISH50', 'CUS-REFEREE', { ...NO_MATCH, deviceMatch: true }, NOW);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;

    // feed the emitted signal into the Slice-21 risk engine on the REFERRAL flow
    const signals: RiskSignals = {
      amountPaise: 30_000, accountAgeDays: 0, ordersLastHour: 1, failedPaymentsLastHour: 0,
      distinctInstrumentsLastDay: 1, codRefusalsLast90d: 0, promoRedemptionsLastDay: 0,
      returnsLast90d: 0, ordersLast90d: 0, devicesLast30d: 1, priorStrikes: 0,
      selfReferralMatch: blocked.riskSignal !== undefined,
    };
    const decision = decide('REFERRAL', signals);
    expect(decision.reasons.map((r) => r.code)).toContain('SELF_REFERRAL_MATCH');
    expect(['STEP_UP', 'HOLD_REVIEW', 'DENY']).toContain(decision.action);
    expect(decision.action).not.toBe('ALLOW');
  });
});

describe('attribution rules', () => {
  it('attributes a clean referee and snapshots the promised rewards', () => {
    const p = programme();
    const r = p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attribution.state).toBe('ATTRIBUTED');
    expect(r.attribution.promisedReferrerPaise).toBe(200 * 100);
    expect(r.attribution.promisedRefereePaise).toBe(100 * 100);
    expect(r.attribution.campaignVersion).toBe(1);
  });

  it('first touch wins on an attribution conflict, and the loser is audited', () => {
    const p = programme();
    p.issueCode('OTHER99', 'CUS-REFERRER-2', 'REF-2026');
    p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW);
    const second = p.attribute('OTHER99', 'CUS-REFEREE', NO_MATCH, NOW + 1000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('ALREADY_ATTRIBUTED_FIRST_TOUCH_WINS');
    expect(p.attribution('CUS-REFEREE')!.code).toBe("HARISH50");
    const conflict = p.auditTrail().find((e) => e.action === 'ATTRIBUTION_CONFLICT_FIRST_TOUCH_WINS');
    expect(conflict).toBeDefined();
    expect(conflict!.detail).toContain('kept=HARISH50');
    expect(conflict!.detail).toContain('rejected=OTHER99');
  });

  it('refuses an inactive code, an unknown code and an out-of-window attribution', () => {
    const p = programme();
    expect(p.attribute('NOPE', 'CUS-1', NO_MATCH, NOW).ok).toBe(false);
    const outside = p.attribute('HARISH50', 'CUS-1', NO_MATCH, START + 200 * DAY);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe('OUTSIDE_CAMPAIGN_WINDOW');
    p.deactivateCode('HARISH50');
    const inactive = p.attribute('HARISH50', 'CUS-2', NO_MATCH, NOW);
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.reason).toBe('CODE_INACTIVE');
  });

  it('enforces the per-referrer quarterly cap', () => {
    const p = programme({ perReferrerQuarterlyCap: 3 });
    for (let i = 0; i < 3; i++) {
      expect(p.attribute('HARISH50', `CUS-${i}`, NO_MATCH, NOW).ok).toBe(true);
    }
    const capped = p.attribute('HARISH50', 'CUS-4', NO_MATCH, NOW);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toBe('PER_REFERRER_QUARTERLY_CAP_REACHED_3');
  });

  it('a suspected ring is held UNDER_REVIEW rather than rejected, and can be resolved', () => {
    const p = programme();
    const r = p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW, /*suspectedRing*/ true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attribution.state).toBe('UNDER_REVIEW');
    // it can neither qualify nor vest while held
    expect(p.recordQualifyingOrder('CUS-REFEREE', 600 * 100, NOW + 7 * DAY, NOW).ok).toBe(false);
    expect(p.vest('CUS-REFEREE', NOW + 30 * DAY).ok).toBe(false);

    expect(p.resolveReview('CUS-REFEREE', true, NOW + DAY)).toEqual({ ok: true, state: 'ATTRIBUTED' });
    expect(p.recordQualifyingOrder('CUS-REFEREE', 600 * 100, NOW + 8 * DAY, NOW + DAY).ok).toBe(true);
  });
});

describe('qualifying order and vesting (RULES)', () => {
  const qualified = () => {
    const p = programme();
    p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW);
    const returnWindowEnds = NOW + 7 * DAY;
    expect(p.recordQualifyingOrder('CUS-REFEREE', 600 * 100, returnWindowEnds, NOW).ok).toBe(true);
    return { p, returnWindowEnds };
  };

  it('an order below ₹499 does not qualify', () => {
    const p = programme();
    p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW);
    const low = p.recordQualifyingOrder('CUS-REFEREE', 498 * 100, NOW + 7 * DAY, NOW);
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.reason).toContain('ORDER_BELOW_QUALIFYING_MINIMUM');
    expect(p.recordQualifyingOrder('CUS-REFEREE', QUALIFYING_ORDER_MIN_PAISE, NOW + 7 * DAY, NOW).ok).toBe(true);
  });

  it('the reward vests ONLY after the referee return window lapses', () => {
    const { p, returnWindowEnds } = qualified();
    const early = p.vest('CUS-REFEREE', returnWindowEnds - 1);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('RETURN_WINDOW_NOT_LAPSED');

    const vested = p.vest('CUS-REFEREE', returnWindowEnds);
    expect(vested.ok).toBe(true);
    if (vested.ok) {
      expect(vested.referrerRewardPaise).toBe(200 * 100);
      expect(vested.refereeRewardPaise).toBe(100 * 100);
    }
    expect(p.spentPaise('REF-2026')).toBe(300 * 100);
    expect(p.vest('CUS-REFEREE', returnWindowEnds + DAY).ok).toBe(false);
  });

  it('vesting is refused before a qualifying order exists', () => {
    const p = programme();
    p.attribute('HARISH50', 'CUS-REFEREE', NO_MATCH, NOW);
    const r = p.vest('CUS-REFEREE', NOW + 30 * DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NOT_QUALIFIED_ATTRIBUTED');
  });

  it('a refund claws the reward back and returns the budget', () => {
    const { p, returnWindowEnds } = qualified();
    p.vest('CUS-REFEREE', returnWindowEnds);
    expect(p.spentPaise('REF-2026')).toBe(300 * 100);

    const clawed = p.clawback('CUS-REFEREE', 'qualifying order refunded', returnWindowEnds + DAY);
    expect(clawed.ok).toBe(true);
    expect(clawed.reclaimedPaise).toBe(300 * 100);
    expect(p.spentPaise('REF-2026')).toBe(0);
    expect(p.attribution('CUS-REFEREE')!.state).toBe('CLAWED_BACK');
    // and it cannot be clawed back twice
    expect(p.clawback('CUS-REFEREE', 'again', returnWindowEnds + 2 * DAY).ok).toBe(false);
  });
});

describe('the documented acceptance scenario: budget ₹1,00,000 and the burn hits the cap', () => {
  it('new attributions auto-pause once the budget is committed, and in-flight vesting is HONOURED', () => {
    // ₹300 committed per attribution against a ₹1,000 budget → 3 attributions fit, the 4th pauses.
    const p = programme({ budgetPaise: 1_000 * 100, perReferrerQuarterlyCap: 50 });
    for (let i = 0; i < 3; i++) {
      expect(p.attribute('HARISH50', `CUS-${i}`, NO_MATCH, NOW).ok).toBe(true);
    }
    expect(p.isAcceptingNewAttributions('REF-2026')).toBe(false);

    const paused = p.attribute('HARISH50', 'CUS-LATE', NO_MATCH, NOW);
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.reason).toBe('BUDGET_EXHAUSTED_NEW_ATTRIBUTIONS_PAUSED');
    expect(p.attribution('CUS-LATE')).toBeUndefined();
    expect(p.auditTrail().some((e) => e.action === 'BUDGET_AUTO_PAUSE')).toBe(true);

    // IN-FLIGHT VESTING IS HONOURED: the three already attributed still qualify and vest in full,
    // even though the campaign is now refusing new attributions.
    const windowEnds = NOW + 7 * DAY;
    for (let i = 0; i < 3; i++) {
      expect(p.recordQualifyingOrder(`CUS-${i}`, 600 * 100, windowEnds, NOW).ok).toBe(true);
      const v = p.vest(`CUS-${i}`, windowEnds);
      expect(v.ok).toBe(true, `attribution ${i} was promised a reward before the pause`);
      if (v.ok) expect(v.referrerRewardPaise + v.refereeRewardPaise).toBe(300 * 100);
    }
    expect(p.spentPaise('REF-2026')).toBe(900 * 100);
    expect(p.budgetBurnPercent('REF-2026')).toBe(90);
  });

  it('a clawback frees budget and re-opens new attributions', () => {
    const p = programme({ budgetPaise: 1_000 * 100, perReferrerQuarterlyCap: 50 });
    for (let i = 0; i < 3; i++) p.attribute('HARISH50', `CUS-${i}`, NO_MATCH, NOW);
    expect(p.isAcceptingNewAttributions('REF-2026')).toBe(false);

    const windowEnds = NOW + 7 * DAY;
    p.recordQualifyingOrder('CUS-0', 600 * 100, windowEnds, NOW);
    p.vest('CUS-0', windowEnds);
    p.clawback('CUS-0', 'refunded', windowEnds + DAY);
    expect(p.isAcceptingNewAttributions('REF-2026')).toBe(true);
  });
});

describe('FR-MKT-007 analytics', () => {
  it('the k-factor is joined per invite and excludes clawed-back attributions', () => {
    const p = programme({ perReferrerQuarterlyCap: 50 });
    for (let i = 0; i < 5; i++) p.attribute('HARISH50', `CUS-${i}`, NO_MATCH, NOW);
    expect(p.kFactor('REF-2026', 10)).toBe(0.5);

    const windowEnds = NOW + 7 * DAY;
    p.recordQualifyingOrder('CUS-0', 600 * 100, windowEnds, NOW);
    p.vest('CUS-0', windowEnds);
    p.clawback('CUS-0', 'refunded', windowEnds + DAY);
    expect(p.kFactor('REF-2026', 10)).toBe(0.4);
    expect(p.kFactor('REF-2026', 0)).toBe(0);
  });

  it('budget burn is reported as a percentage', () => {
    const p = programme({ budgetPaise: 1_000 * 100 });
    expect(p.budgetBurnPercent('REF-2026')).toBe(0);
    p.attribute('HARISH50', 'CUS-1', NO_MATCH, NOW);
    const windowEnds = NOW + 7 * DAY;
    p.recordQualifyingOrder('CUS-1', 600 * 100, windowEnds, NOW);
    p.vest('CUS-1', windowEnds);
    expect(p.budgetBurnPercent('REF-2026')).toBe(30);
  });
});
