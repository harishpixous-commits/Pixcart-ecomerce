/**
 * FR-MKT-006 affiliate programme. The suite concentrates on last-click attribution, because
 * crediting the wrong partner is the failure affiliates actually notice — they reconcile — and on
 * the validation hold, because paying before the return window lapses means clawing money back
 * from someone who has already spent it.
 */
import { describe, expect, it } from 'vitest';
import {
  AffiliateProgramme,
  CLICK_FLOOD_PER_HOUR,
  commissionAmountPaise,
  DEFAULT_COOKIE_WINDOW_MS,
  detectClickFlooding,
  isCouponLeakDomain,
  rateBpsFor,
  type AffiliateApplication,
  type ClickEvent,
  type CommissionPlan,
  type Conversion,
  type FraudFilters,
} from '../src/domain/affiliate/affiliate.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const plan = (over: Partial<CommissionPlan> = {}): CommissionPlan => ({
  planId: 'PLAN-1',
  rateBpsByCategory: { 'CAT-SAREES': 800, 'CAT-ELECTRONICS': 200 },
  defaultRateBps: 500,
  ...over,
});

const filters = (over: Partial<FraudFilters> = {}): FraudFilters => ({
  couponLeakDomains: new Set(['couponleak.example', 'freecodes.example']),
  ...over,
});

const application = (over: Partial<AffiliateApplication> = {}): AffiliateApplication => ({
  affiliateId: 'AFF-1',
  displayName: 'Saree Blog',
  identityRef: 'id-ref-1',
  payout: { beneficiaryName: 'Saree Blog LLP', accountRef: 'acct-1', ifsc: 'HDFC0001234' },
  ndaSignatureRef: 'esign-nda-1',
  termsSignatureRef: 'esign-terms-1',
  primaryDomain: 'sareeblog.example',
  ...over,
});

const click = (over: Partial<ClickEvent> = {}): ClickEvent => ({
  clickId: 'CLK-1',
  affiliateId: 'AFF-1',
  linkId: 'LNK-1',
  visitorId: 'VIS-1',
  sourceDomain: 'sareeblog.example',
  atMs: NOW - HOUR,
  ...over,
});

const conversion = (over: Partial<Conversion> = {}): Conversion => ({
  orderId: 'ORD-1',
  visitorId: 'VIS-1',
  customerId: 'CUS-1',
  categoryId: 'CAT-SAREES',
  netSaleValuePaise: 10_000_00,
  atMs: NOW,
  returnWindowEndsAtMs: NOW + 7 * DAY,
  ...over,
});

/** An onboarded programme with one link ready. */
const programme = (planOver: Partial<CommissionPlan> = {}) => {
  const p = new AffiliateProgramme(plan(planOver), filters());
  const r = p.onboard(application(), NOW - 30 * DAY);
  if (!r.ok) throw new Error('onboard failed: ' + r.violations.join(','));
  p.createLink({ linkId: 'LNK-1', affiliateId: 'AFF-1', targetUrl: 'https://pixcart/p/1', code: 'SAREEBLOG' });
  return p;
};

// ============================================ onboarding

describe('onboarding requires e-signed NDA and terms (RULES)', () => {
  it('onboards a complete application', () => {
    const p = new AffiliateProgramme(plan(), filters());
    const r = p.onboard(application(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.affiliate.state).toBe('ACTIVE');
      expect(r.affiliate.onboardedAtMs).toBe(NOW);
    }
  });

  it('refuses an unsigned NDA or unsigned terms', () => {
    const p = new AffiliateProgramme(plan(), filters());
    const noNda = p.onboard(application({ ndaSignatureRef: undefined }), NOW);
    expect(noNda.ok).toBe(false);
    if (!noNda.ok) expect(noNda.violations).toContain('NDA_MUST_BE_E_SIGNED_AT_ONBOARDING');

    const noTerms = p.onboard(application({ termsSignatureRef: '  ' }), NOW);
    expect(noTerms.ok).toBe(false);
    if (!noTerms.ok) expect(noTerms.violations).toContain('TERMS_MUST_BE_E_SIGNED_AT_ONBOARDING');
  });

  it('refuses missing KYC-light identity, payout details or domain, reporting all at once', () => {
    const p = new AffiliateProgramme(plan(), filters());
    const r = p.onboard(application({
      identityRef: '',
      payout: { beneficiaryName: 'X', accountRef: '', ifsc: '' },
      primaryDomain: 'nodots',
    }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violations).toContain('KYC_IDENTITY_REFERENCE_REQUIRED');
      expect(r.violations).toContain('PAYOUT_DETAILS_REQUIRED');
      expect(r.violations).toContain('PRIMARY_DOMAIN_REQUIRED');
    }
  });

  it('refuses a duplicate onboarding', () => {
    const p = programme();
    expect(p.onboard(application(), NOW).ok).toBe(false);
  });

  it('only an active affiliate may create links', () => {
    const p = programme();
    expect(p.createLink({ linkId: 'LNK-2', affiliateId: 'AFF-1', targetUrl: 'u', code: 'C' }).ok).toBe(true);
    expect(p.createLink({ linkId: 'LNK-2', affiliateId: 'AFF-1', targetUrl: 'u', code: 'C' }).ok).toBe(false);
    expect(p.createLink({ linkId: 'LNK-3', affiliateId: 'AFF-NONE', targetUrl: 'u', code: 'C' }).ok).toBe(false);

    p.holdForPolicyViolation('AFF-1', 'brand bidding on trademarked terms');
    expect(p.createLink({ linkId: 'LNK-4', affiliateId: 'AFF-1', targetUrl: 'u', code: 'C' }).ok).toBe(false);
  });
});

// ============================================ last-click attribution

describe('LAST-click attribution within the cookie window (DESC / VALIDATION)', () => {
  it('credits the most recent click, not the first', () => {
    const p = new AffiliateProgramme(plan(), filters());
    p.onboard(application({ affiliateId: 'AFF-1' }), NOW - 30 * DAY);
    p.onboard(application({ affiliateId: 'AFF-2', primaryDomain: 'other.example' }), NOW - 30 * DAY);
    p.createLink({ linkId: 'LNK-1', affiliateId: 'AFF-1', targetUrl: 'u', code: 'A' });
    p.createLink({ linkId: 'LNK-2', affiliateId: 'AFF-2', targetUrl: 'u', code: 'B' });

    p.recordClick(click({ clickId: 'C-FIRST', affiliateId: 'AFF-1', linkId: 'LNK-1', atMs: NOW - 5 * HOUR }));
    p.recordClick(click({
      clickId: 'C-LAST', affiliateId: 'AFF-2', linkId: 'LNK-2',
      sourceDomain: 'other.example', atMs: NOW - 1 * HOUR,
    }));

    const r = p.attribute('COM-1', conversion(), new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // crediting the first click would pay the wrong partner, and affiliates reconcile
    expect(r.commission.affiliateId).toBe('AFF-2');
    expect(r.commission.clickId).toBe('C-LAST');
  });

  it('ignores a click outside the cookie window', () => {
    const p = programme();
    p.recordClick(click({ atMs: NOW - DEFAULT_COOKIE_WINDOW_MS - 1 }));
    const r = p.attribute('COM-1', conversion(), new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_CLICK_WITHIN_COOKIE_WINDOW');
  });

  it('accepts a click exactly at the window boundary', () => {
    const p = programme();
    p.recordClick(click({ atMs: NOW - DEFAULT_COOKIE_WINDOW_MS }));
    expect(p.attribute('COM-1', conversion(), new Map()).ok).toBe(true);
    expect(DEFAULT_COOKIE_WINDOW_MS).toBe(24 * HOUR);
  });

  it('honours a configured cookie window over the default', () => {
    const p = programme({ cookieWindowMs: 2 * HOUR });
    p.recordClick(click({ atMs: NOW - 3 * HOUR }));
    expect(p.attribute('COM-1', conversion(), new Map()).ok).toBe(false);

    const p2 = programme({ cookieWindowMs: 2 * HOUR });
    p2.recordClick(click({ atMs: NOW - HOUR }));
    expect(p2.attribute('COM-2', conversion(), new Map()).ok).toBe(true);
  });

  it('ignores clicks by a different visitor', () => {
    const p = programme();
    p.recordClick(click({ visitorId: 'VIS-OTHER' }));
    expect(p.attribute('COM-1', conversion({ visitorId: 'VIS-1' }), new Map()).ok).toBe(false);
  });

  it('ignores a click recorded AFTER the conversion', () => {
    const p = programme();
    p.recordClick(click({ atMs: NOW + HOUR }));
    expect(p.attribute('COM-1', conversion(), new Map()).ok).toBe(false);
  });
});

// ============================================ self-purchase

describe('a self-purchase earns nothing (VALIDATION)', () => {
  it('refuses attribution when the buyer IS the affiliate', () => {
    const p = programme();
    p.recordClick(click());
    // an affiliate buying through their own link is discounting their own order at the
    // platform's expense, not introducing a customer
    const r = p.attribute('COM-1', conversion({ customerId: 'CUS-AFF' }),
      new Map([['AFF-1', 'CUS-AFF']]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('SELF_PURCHASE_EXCLUDED');
  });

  it('attributes normally when the buyer is someone else', () => {
    const p = programme();
    p.recordClick(click());
    expect(p.attribute('COM-1', conversion({ customerId: 'CUS-1' }),
      new Map([['AFF-1', 'CUS-AFF']])).ok).toBe(true);
  });
});

// ============================================ fraud filters

describe('fraud filters run at click ingestion (VALIDATION)', () => {
  it('rejects a click from a coupon-leak domain', () => {
    const p = programme();
    const r = p.recordClick(click({ sourceDomain: 'couponleak.example' }));
    expect(r.recorded).toBe(false);
    expect(r.reason).toContain('COUPON_LEAK_DOMAIN');
    expect(p.clickCount()).toBe(0);
    expect(isCouponLeakDomain('CouponLeak.Example', filters())).toBe(true);
  });

  it('detects click flooding and stops recording beyond the threshold', () => {
    const p = programme();
    for (let i = 0; i <= CLICK_FLOOD_PER_HOUR; i++) {
      p.recordClick(click({ clickId: `C-${i}`, visitorId: `V-${i}`, atMs: NOW - 30 * 60_000 }));
    }
    const flooded = p.recordClick(click({ clickId: 'C-OVER', visitorId: 'V-OVER', atMs: NOW - 30 * 60_000 }));
    expect(flooded.recorded).toBe(false);
    expect(flooded.reason).toContain('CLICK_FLOODING');
  });

  it('the flood window is rolling, so yesterday volume does not block today', () => {
    const old: ClickEvent[] = Array.from({ length: CLICK_FLOOD_PER_HOUR + 50 }, (_, i) =>
      click({ clickId: `O-${i}`, atMs: NOW - 5 * HOUR }));
    expect(detectClickFlooding(old, 'sareeblog.example', NOW).blocked).toBe(false);
    expect(detectClickFlooding(old, 'sareeblog.example', NOW - 5 * HOUR + 60_000).blocked).toBe(true);
  });

  it('flooding is judged per source domain', () => {
    const clicks: ClickEvent[] = Array.from({ length: CLICK_FLOOD_PER_HOUR + 10 }, (_, i) =>
      click({ clickId: `F-${i}`, sourceDomain: 'floody.example', atMs: NOW - 60_000 }));
    expect(detectClickFlooding(clicks, 'floody.example', NOW).blocked).toBe(true);
    expect(detectClickFlooding(clicks, 'sareeblog.example', NOW).blocked).toBe(false);
  });

  it('rejects a click on an unknown link or a mismatched affiliate', () => {
    const p = programme();
    expect(p.recordClick(click({ linkId: 'LNK-NONE' })).recorded).toBe(false);
    expect(p.recordClick(click({ affiliateId: 'AFF-OTHER' })).recorded).toBe(false);
  });
});

// ============================================ commission maths

describe('commission rates and rounding', () => {
  it('uses the category rate, falling back to the plan default', () => {
    expect(rateBpsFor(plan(), 'CAT-SAREES')).toBe(800);
    expect(rateBpsFor(plan(), 'CAT-ELECTRONICS')).toBe(200);
    expect(rateBpsFor(plan(), 'CAT-UNLISTED')).toBe(500);
  });

  it('computes commission in integer paise, rounding half up', () => {
    expect(commissionAmountPaise(10_000_00, 800)).toBe(800_00);
    expect(commissionAmountPaise(10_000_00, 200)).toBe(200_00);
    // 1,234,567 x 833 = 1,028,394,311; / 10,000 = 102,839.4311 -> 102,839 (half up)
    expect(commissionAmountPaise(1_234_567, 833)).toBe(102_839);
    // and a .5 case rounds UP rather than toward zero: 100 x 50 bps = 0.5 -> 1
    expect(commissionAmountPaise(100, 50)).toBe(1);
    expect(commissionAmountPaise(0, 800)).toBe(0);
  });

  it('applies the category rate to the attributed commission', () => {
    const p = programme();
    p.recordClick(click());
    const r = p.attribute('COM-1', conversion({ categoryId: 'CAT-ELECTRONICS' }), new Map());
    if (!r.ok) throw new Error('expected attribution');
    expect(r.commission.rateBps).toBe(200);
    expect(r.commission.amountPaise).toBe(200_00);
    expect(r.commission.state).toBe('PENDING');
  });
});

// ============================================ lifecycle

describe('the pending → validated → paid lifecycle (OUTPUTS / RULES)', () => {
  const attributed = () => {
    const p = programme();
    p.recordClick(click());
    const r = p.attribute('COM-1', conversion(), new Map());
    if (!r.ok) throw new Error('expected attribution');
    return p;
  };

  it('validation is refused until the return window lapses', () => {
    const p = attributed();
    const early = p.validate('COM-1', NOW + 7 * DAY - 1);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('RETURN_WINDOW_NOT_LAPSED');

    expect(p.validate('COM-1', NOW + 7 * DAY).ok).toBe(true);
    expect(p.commission('COM-1')!.state).toBe('VALIDATED');
    expect(p.commission('COM-1')!.validatedAtMs).toBe(NOW + 7 * DAY);
  });

  it('a held affiliate commission does not validate', () => {
    const p = attributed();
    p.holdForPolicyViolation('AFF-1', 'brand bidding on our trademark');
    const r = p.validate('COM-1', NOW + 8 * DAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('AFFILIATE_ON_HOLD');

    p.releaseHold('AFF-1');
    expect(p.validate('COM-1', NOW + 8 * DAY).ok).toBe(true);
  });

  it('a commission cannot be validated twice', () => {
    const p = attributed();
    p.validate('COM-1', NOW + 8 * DAY);
    expect(p.validate('COM-1', NOW + 9 * DAY).ok).toBe(false);
    expect(p.validate('COM-NONE', NOW + 9 * DAY).ok).toBe(false);
  });

  it('a return claws the commission back, whether pending or already paid', () => {
    const pending = attributed();
    const c1 = pending.clawback('COM-1', 'order returned in full', NOW + 3 * DAY);
    expect(c1.ok).toBe(true);
    if (c1.ok) {
      expect(c1.reclaimedPaise).toBe(800_00);
      expect(c1.wasPaid).toBe(false);
    }
    expect(pending.commission('COM-1')!.state).toBe('CLAWED_BACK');

    const paid = attributed();
    paid.validate('COM-1', NOW + 8 * DAY);
    const batch = paid.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    paid.markBatchPaid(batch, NOW + 9 * DAY);
    expect(paid.commission('COM-1')!.state).toBe('PAID');

    const c2 = paid.clawback('COM-1', 'late return accepted', NOW + 12 * DAY);
    expect(c2.ok).toBe(true);
    if (c2.ok) expect(c2.wasPaid).toBe(true);
  });

  it('a clawback cannot be repeated', () => {
    const p = attributed();
    p.clawback('COM-1', 'returned', NOW + 3 * DAY);
    expect(p.clawback('COM-1', 'returned again', NOW + 4 * DAY).ok).toBe(false);
    expect(p.clawback('COM-NONE', 'x', NOW).ok).toBe(false);
  });
});

// ============================================ brand bidding

describe('a brand-bidding violation holds the account with a notice (RULES)', () => {
  it('holds and issues a notice explaining what happens to pending commissions', () => {
    const p = programme();
    const r = p.holdForPolicyViolation('AFF-1', 'bidding on "pixcart" trademark in paid search');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notice).toContain('on hold');
    expect(r.notice).toContain('trademark');
    // the notice must say what happens to money already earned
    expect(r.notice).toContain('Pending commissions are retained');
    expect(p.affiliate('AFF-1')!.state).toBe('HELD');
  });

  it('requires a reason, and refuses an unknown affiliate', () => {
    const p = programme();
    expect(p.holdForPolicyViolation('AFF-1', 'x').ok).toBe(false);
    expect(p.holdForPolicyViolation('AFF-NONE', 'valid reason text').ok).toBe(false);
  });

  it('releasing a hold restores the account, and is a no-op when not held', () => {
    const p = programme();
    p.holdForPolicyViolation('AFF-1', 'brand bidding violation');
    expect(p.releaseHold('AFF-1')).toBe(true);
    expect(p.affiliate('AFF-1')!.state).toBe('ACTIVE');
    expect(p.releaseHold('AFF-1')).toBe(false);
  });
});

// ============================================ payouts

describe('monthly payout batches (OUTPUTS)', () => {
  const withCommissions = () => {
    const p = new AffiliateProgramme(plan(), filters());
    p.onboard(application({ affiliateId: 'AFF-1' }), NOW - 30 * DAY);
    p.onboard(application({ affiliateId: 'AFF-2', primaryDomain: 'two.example' }), NOW - 30 * DAY);
    p.createLink({ linkId: 'LNK-1', affiliateId: 'AFF-1', targetUrl: 'u', code: 'A' });
    p.createLink({ linkId: 'LNK-2', affiliateId: 'AFF-2', targetUrl: 'u', code: 'B' });

    p.recordClick(click({ clickId: 'C1', visitorId: 'V1', atMs: NOW - HOUR }));
    p.attribute('COM-1', conversion({ orderId: 'O1', visitorId: 'V1' }), new Map());

    p.recordClick(click({
      clickId: 'C2', affiliateId: 'AFF-2', linkId: 'LNK-2', visitorId: 'V2',
      sourceDomain: 'two.example', atMs: NOW - HOUR,
    }));
    p.attribute('COM-2', conversion({ orderId: 'O2', visitorId: 'V2', netSaleValuePaise: 5_000_00 }), new Map());
    return p;
  };

  it('includes only VALIDATED commissions, grouped per affiliate', () => {
    const p = withCommissions();
    // only the first is validated
    p.validate('COM-1', NOW + 8 * DAY);

    const batch = p.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0].affiliateId).toBe('AFF-1');
    expect(batch.lines[0].amountPaise).toBe(800_00);
    expect(batch.totalPaise).toBe(800_00);
    // a pending commission is not a debt yet
    expect(batch.lines[0].commissionIds).toEqual(['COM-1']);
  });

  it('carries each affiliate payout details for the settlement rails', () => {
    const p = withCommissions();
    p.validate('COM-1', NOW + 8 * DAY);
    const batch = p.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    expect(batch.lines[0].payout.ifsc).toBe('HDFC0001234');
    expect(batch.lines[0].payout.accountRef).toBe('acct-1');
  });

  it('excludes a held affiliate, whose commissions stay validated and wait', () => {
    const p = withCommissions();
    p.validate('COM-1', NOW + 8 * DAY);
    p.holdForPolicyViolation('AFF-1', 'brand bidding under investigation');

    const batch = p.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    expect(batch.lines).toHaveLength(0);
    expect(batch.totalPaise).toBe(0);
    expect(p.commission('COM-1')!.state).toBe('VALIDATED');
  });

  it('marking a batch paid advances only its own validated commissions', () => {
    const p = withCommissions();
    p.validate('COM-1', NOW + 8 * DAY);
    const batch = p.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    expect(p.markBatchPaid(batch, NOW + 9 * DAY)).toBe(1);
    expect(p.commission('COM-1')!.state).toBe('PAID');
    expect(p.commission('COM-1')!.paidAtMs).toBe(NOW + 9 * DAY);
    // the unvalidated one is untouched
    expect(p.commission('COM-2')!.state).toBe('PENDING');
    // and paying the same batch again advances nothing
    expect(p.markBatchPaid(batch, NOW + 10 * DAY)).toBe(0);
  });

  it('sums several commissions for one affiliate into a single line', () => {
    const p = programme();
    p.recordClick(click({ clickId: 'C1', visitorId: 'V1', atMs: NOW - HOUR }));
    p.attribute('COM-1', conversion({ orderId: 'O1', visitorId: 'V1' }), new Map());
    p.recordClick(click({ clickId: 'C2', visitorId: 'V2', atMs: NOW - HOUR }));
    p.attribute('COM-2', conversion({ orderId: 'O2', visitorId: 'V2', netSaleValuePaise: 5_000_00 }), new Map());
    p.validate('COM-1', NOW + 8 * DAY);
    p.validate('COM-2', NOW + 8 * DAY);

    const batch = p.buildPayoutBatch('B-1', '2026-08', NOW + 9 * DAY);
    expect(batch.lines).toHaveLength(1);
    expect(batch.lines[0].commissionIds).toEqual(['COM-1', 'COM-2']);
    expect(batch.lines[0].amountPaise).toBe(800_00 + 400_00);
  });
});

// ============================================ dashboards

describe('dashboards report clicks, conversions and EPC (OUTPUTS)', () => {
  it('computes earnings per click from earning commissions only', () => {
    const p = programme();
    for (let i = 0; i < 10; i++) {
      p.recordClick(click({ clickId: `C-${i}`, visitorId: `V-${i}`, atMs: NOW - HOUR }));
    }
    p.attribute('COM-1', conversion({ orderId: 'O1', visitorId: 'V-0' }), new Map());

    const d = p.dashboard('AFF-1', NOW - DAY, NOW + DAY);
    expect(d.clicks).toBe(10);
    expect(d.conversions).toBe(1);
    expect(d.earnedPaise).toBe(800_00);
    expect(d.epcPaise).toBe(8_000);          // 80,000 paise over 10 clicks
    expect(d.conversionRate).toBeCloseTo(0.1, 4);
  });

  it('a clawed-back commission is not earnings', () => {
    const p = programme();
    p.recordClick(click({ clickId: 'C-0', visitorId: 'V-0', atMs: NOW - HOUR }));
    p.attribute('COM-1', conversion({ visitorId: 'V-0' }), new Map());
    expect(p.dashboard('AFF-1', NOW - DAY, NOW + DAY).earnedPaise).toBe(800_00);

    p.clawback('COM-1', 'order returned', NOW + 3 * DAY);
    const after = p.dashboard('AFF-1', NOW - DAY, NOW + DAY);
    expect(after.earnedPaise).toBe(0);
    expect(after.conversions).toBe(0);
    expect(after.epcPaise).toBe(0);
  });

  it('does not divide by zero with no clicks', () => {
    const d = programme().dashboard('AFF-1', NOW - DAY, NOW + DAY);
    expect(d).toEqual({ clicks: 0, conversions: 0, earnedPaise: 0, epcPaise: 0, conversionRate: 0 });
  });

  it('respects the reporting window', () => {
    const p = programme();
    p.recordClick(click({ clickId: 'C-OLD', visitorId: 'V-OLD', atMs: NOW - 10 * DAY }));
    p.recordClick(click({ clickId: 'C-NEW', visitorId: 'V-NEW', atMs: NOW - HOUR }));
    expect(p.dashboard('AFF-1', NOW - DAY, NOW + DAY).clicks).toBe(1);
  });
});
