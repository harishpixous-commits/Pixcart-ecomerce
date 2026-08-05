/**
 * FR-ADM-008 platform promotions console as tests: budget approval at ₹1 lakh, exclusive-event
 * conflict detection at save, the 5% holdout, the price-integrity "fake discount" gate, budget
 * burn enforcement and holdout-based incremental ROI.
 */
import { describe, expect, it } from 'vitest';
import {
  BUDGET_APPROVAL_THRESHOLD_PAISE,
  bucket100,
  DEFAULT_HOLDOUT_PERCENT,
  PRICE_INTEGRITY_LOOKBACK_DAYS,
  PromotionsConsole,
  type Campaign,
} from '../src/domain/cms/promotions-console.js';

const DAY = 24 * 3600 * 1000;
const START = Date.UTC(2026, 9, 20, 0, 0, 0);   // Diwali-ish window

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'CMP-1',
  name: 'Festival Sale',
  kind: 'FESTIVAL',
  window: { fromMs: START, toMs: START + 5 * DAY },
  exclusive: false,
  budgetPaise: 50_000 * 100,
  audience: 'ALL',
  ...over,
});

describe('budget approval (VALIDATION)', () => {
  it('a budget below ₹1 lakh needs no approver', () => {
    const c = new PromotionsConsole();
    expect(c.save(campaign({ budgetPaise: BUDGET_APPROVAL_THRESHOLD_PAISE - 1 }))).toEqual({ ok: true, campaignId: 'CMP-1' });
  });

  it('a budget at or above ₹1 lakh is refused without a named approver', () => {
    const c = new PromotionsConsole();
    const r = c.save(campaign({ budgetPaise: BUDGET_APPROVAL_THRESHOLD_PAISE }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations).toContain('BUDGET_APPROVAL_REQUIRED_AT_OR_ABOVE_1_LAKH');

    expect(c.save(campaign({ budgetPaise: BUDGET_APPROVAL_THRESHOLD_PAISE, approvedBy: '01FIN-HEAD' })).ok).toBe(true);
  });

  it('rejects an inverted window, a non-positive budget and an absurd holdout', () => {
    const c = new PromotionsConsole();
    const r = c.save(campaign({ window: { fromMs: START, toMs: START }, budgetPaise: 0, holdoutPercent: 80 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toContain('WINDOW_INVERTED');
      expect(r.violations).toContain('BUDGET_MUST_BE_POSITIVE');
      expect(r.violations).toContain('HOLDOUT_PERCENT_OUT_OF_RANGE');
    }
  });
});

describe('exclusive-event conflict detection at save (VALIDATION)', () => {
  it('refuses a second exclusive event overlapping the first for the same audience', () => {
    const c = new PromotionsConsole();
    expect(c.save(campaign({ campaignId: 'EX-1', exclusive: true })).ok).toBe(true);
    const clash = c.save(campaign({
      campaignId: 'EX-2', exclusive: true,
      window: { fromMs: START + 2 * DAY, toMs: START + 8 * DAY },
    }));
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.violations.some((v) => v.startsWith('EXCLUSIVE_EVENT_CONFLICT'))).toBe(true);
  });

  it('allows exclusive events that do not overlap in time', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'EX-1', exclusive: true }));
    expect(c.save(campaign({
      campaignId: 'EX-2', exclusive: true,
      window: { fromMs: START + 5 * DAY, toMs: START + 9 * DAY },   // starts as the first ends
    })).ok).toBe(true);
  });

  it('allows exclusive events for different, non-ALL audiences', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'EX-1', exclusive: true, audience: 'NEW_USERS' }));
    expect(c.save(campaign({ campaignId: 'EX-2', exclusive: true, audience: 'LAPSED_USERS' })).ok).toBe(true);
    // ...but an ALL-audience exclusive event still conflicts with a segmented one
    const clash = c.save(campaign({ campaignId: 'EX-3', exclusive: true, audience: 'ALL' }));
    expect(clash.ok).toBe(false);
  });

  it('non-exclusive campaigns may overlap freely', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'A', exclusive: false }));
    expect(c.save(campaign({ campaignId: 'B', exclusive: false })).ok).toBe(true);
  });
});

describe('holdout group (RULES: default 5%, auto-maintained)', () => {
  const c = new PromotionsConsole();
  c.save(campaign({ campaignId: 'HOLD' }));

  it('defaults to 5% and is stable per user', () => {
    expect(c.campaign('HOLD')!.holdoutPercent).toBe(DEFAULT_HOLDOUT_PERCENT);
    const first = c.isInHoldout('HOLD', 'user-77');
    for (let i = 0; i < 5; i++) expect(c.isInHoldout('HOLD', 'user-77')).toBe(first);
  });

  it('holds out roughly 5% across many users', () => {
    let held = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) if (c.isInHoldout('HOLD', `u${i}`)) held++;
    const share = held / n;
    expect(share).toBeGreaterThan(0.03);
    expect(share).toBeLessThan(0.07);
  });

  it('a held-out user is not eligible even inside the window', () => {
    const heldUser = Array.from({ length: 500 }, (_, i) => `u${i}`).find((u) => c.isInHoldout('HOLD', u))!;
    expect(heldUser).toBeDefined();
    expect(c.isEligible('HOLD', heldUser, START + DAY)).toBe(false);

    const treatedUser = Array.from({ length: 500 }, (_, i) => `u${i}`).find((u) => !c.isInHoldout('HOLD', u))!;
    expect(c.isEligible('HOLD', treatedUser, START + DAY)).toBe(true);
  });

  it('nobody is eligible outside the campaign window', () => {
    const treatedUser = Array.from({ length: 500 }, (_, i) => `u${i}`).find((u) => !c.isInHoldout('HOLD', u))!;
    expect(c.isEligible('HOLD', treatedUser, START - 1)).toBe(false);
    expect(c.isEligible('HOLD', treatedUser, START + 5 * DAY)).toBe(false);
  });

  it('a zero holdout means nobody is held out', () => {
    const z = new PromotionsConsole();
    z.save(campaign({ campaignId: 'NOHOLD', holdoutPercent: 0 }));
    for (let i = 0; i < 200; i++) expect(z.isInHoldout('NOHOLD', `u${i}`)).toBe(false);
  });
});

describe('price integrity: no fake discounts (RULES)', () => {
  const c = new PromotionsConsole();
  c.save(campaign({ campaignId: 'FEST' }));

  it('refuses a listing whose MRP was raised inside the lookback window', () => {
    const r = c.mayJoinEvent('FEST', {
      listingId: 'L1',
      currentMrpPaise: 4_999_00,
      mrpLastRaisedAtMs: START - 5 * DAY,       // raised five days before the event
      mrpBeforeRaisePaise: 2_499_00,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('PRICE_INTEGRITY_MRP_INFLATED_BEFORE_EVENT');
  });

  it('admits a listing whose MRP has been stable for longer than the lookback', () => {
    const r = c.mayJoinEvent('FEST', {
      listingId: 'L2',
      currentMrpPaise: 4_999_00,
      mrpLastRaisedAtMs: START - (PRICE_INTEGRITY_LOOKBACK_DAYS + 1) * DAY,
      mrpBeforeRaisePaise: 4_499_00,
    });
    expect(r).toEqual({ ok: true });
  });

  it('admits a listing that has never raised its MRP', () => {
    expect(c.mayJoinEvent('FEST', { listingId: 'L3', currentMrpPaise: 1_999_00 })).toEqual({ ok: true });
  });

  it('an unknown campaign is refused rather than assumed open', () => {
    expect(c.mayJoinEvent('NOPE', { listingId: 'L4', currentMrpPaise: 1 }).ok).toBe(false);
  });
});

describe('budget burn and incremental ROI', () => {
  it('burn accumulates and is refused beyond the cap', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'B1', budgetPaise: 10_000 * 100 }));
    expect(c.recordBurn('B1', 6_000 * 100)).toEqual({ ok: true, spentPaise: 6_000 * 100 });
    expect(c.burnPercent('B1')).toBe(60);

    const over = c.recordBurn('B1', 5_000 * 100);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain('BUDGET_EXCEEDED');
    expect(c.spentPaise("B1")).toBe(6_000 * 100);

    expect(c.recordBurn('B1', 4_000 * 100).ok).toBe(true);
    expect(c.burnPercent('B1')).toBe(100);
  });

  it('refuses non-positive burn and unknown campaigns', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'B2' }));
    expect(c.recordBurn('B2', 0).ok).toBe(false);
    expect(c.recordBurn('NOPE', 100).ok).toBe(false);
  });

  it('incremental ROI is measured against the holdout, and is null when unmeasurable', () => {
    const c = new PromotionsConsole();
    c.save(campaign({ campaignId: 'R1', budgetPaise: 10_000 * 100 }));
    // no spend yet → not measurable
    expect(c.incrementalRoi('R1', { users: 100, revenuePaise: 1_000_000 }, { users: 10, revenuePaise: 50_000 })).toBeNull();

    c.recordBurn('R1', 1_000 * 100);   // ₹1,000 spent
    // treated ₹100/user vs holdout ₹50/user over 100 treated users → ₹5,000 incremental on ₹1,000
    const roi = c.incrementalRoi('R1',
      { users: 100, revenuePaise: 100 * 100 * 100 },
      { users: 20, revenuePaise: 20 * 50 * 100 });
    expect(roi).toBeCloseTo(5, 2);

    // an empty cohort is unmeasurable rather than assumed
    expect(c.incrementalRoi('R1', { users: 0, revenuePaise: 0 }, { users: 20, revenuePaise: 1 })).toBeNull();
  });

  it('the bucket function is stable and in range', () => {
    expect(bucket100('x')).toBe(bucket100('x'));
    for (const k of ['a', 'user-1', 'CMP-1|user-9']) {
      const b = bucket100(k);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});
