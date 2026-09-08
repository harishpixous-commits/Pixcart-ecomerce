/**
 * FR-MKT-009 AI marketing automation. The word doing the work in this requirement is "cannot": an
 * optimiser that merely should not bypass quiet hours will bypass them the first time a model
 * reports a big lift at 2 a.m. So most of this suite is about the constraint winning.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateExploration,
  clampToPermittedHour,
  DecisionLog,
  isSendable,
  MAX_EXPLORATION_SHARE,
  MIN_SENDS_BEFORE_RETIREMENT,
  pacingSuggestion,
  performance,
  RETIREMENT_RELATIVE_THRESHOLD,
  retirementDecision,
  scheduleSend,
  selectChannel,
  wouldLandInQuietHours,
  type ChannelConsent,
  type OptimiserContext,
  type SendTimeModel,
  type SendTimeSuggestion,
  type Variant,
} from '../src/domain/automation/automation.js';
import { QUIET_END_HOUR, QUIET_START_HOUR } from '../../notification-svc/src/domain/policy.js';

const IST = 330;
/** 12:00 IST on 24 Aug 2026. */
const NOW = Date.UTC(2026, 7, 24, 6, 30);

const ctx = (over: Partial<OptimiserContext> = {}): OptimiserContext => ({
  customerId: 'CUS-1',
  tzOffsetMinutes: IST,
  defaultLocalHour: 10,
  sendsInFrequencyWindow: 0,
  frequencyCap: 3,
  nowMs: NOW,
  ...over,
});

const suggestion = (hour: number, over: Partial<SendTimeSuggestion> = {}): SendTimeSuggestion => ({
  customerId: 'CUS-1',
  suggestedLocalHour: hour,
  expectedLiftPct: 23,
  attributions: [
    { feature: 'historical_open_hour', contributionPct: 70, note: 'opens cluster in the evening' },
    { feature: 'timezone', contributionPct: 30, note: 'IST' },
  ],
  modelVersion: 'sto-v4',
  ...over,
});

const model = (hour: number): SendTimeModel => () => suggestion(hour);

const variant = (over: Partial<Variant> = {}): Variant => ({
  variantId: 'VAR-1',
  templateRef: 'TPL-1',
  state: 'APPROVED',
  approvalRef: 'APPROVAL-9',
  approvedByUserId: 'MKT-USER-1',
  approvedAtMs: NOW,
  policyFilterPassed: true,
  isControl: false,
  ...over,
});

// ============================================ the optimiser cannot bypass quiet hours

describe('the optimiser CANNOT bypass quiet hours (VALIDATION)', () => {
  it('overrules a 2 a.m. suggestion however large the claimed lift', () => {
    // a number saying "23% more opens" is very persuasive to whoever wires the scheduler
    const r = scheduleSend(ctx(), model(2));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scheduled.outcome).toBe('CLAMPED_TO_PERMITTED_WINDOW');
    expect(r.scheduled.localHour).toBe(QUIET_END_HOUR);
    expect(r.scheduled.hardConstraintApplied).toBe(`QUIET_HOURS_${QUIET_START_HOUR}_TO_${QUIET_END_HOUR}`);
  });

  it('DISCARDS the expected lift when the suggestion was clamped', () => {
    const r = scheduleSend(ctx(), model(23));
    if (!r.ok) throw new Error('expected a schedule');
    // a clamped send is not the send the model predicted a lift for; carrying the number across
    // would attribute an outcome to advice that was not taken
    expect(r.scheduled.expectedLiftPct).toBeNull();
  });

  it('keeps the lift when the suggestion was permitted as given', () => {
    const r = scheduleSend(ctx(), model(19));
    if (!r.ok) throw new Error('expected a schedule');
    expect(r.scheduled.outcome).toBe('OPTIMISED');
    expect(r.scheduled.localHour).toBe(19);
    expect(r.scheduled.expectedLiftPct).toBe(23);
  });

  it('clamps every hour inside the quiet window to the first permitted hour', () => {
    for (const hour of [22, 23, 0, 1, 5, 7]) {
      expect(clampToPermittedHour(hour)).toBe(QUIET_END_HOUR);
    }
    for (const hour of [8, 12, 18, 21]) {
      expect(clampToPermittedHour(hour)).toBe(hour);
    }
    expect(QUIET_START_HOUR).toBe(22);
    expect(QUIET_END_HOUR).toBe(8);
  });

  it('the boundaries are exact', () => {
    expect(clampToPermittedHour(21)).toBe(21);
    expect(clampToPermittedHour(22)).toBe(QUIET_END_HOUR);
    expect(clampToPermittedHour(7)).toBe(QUIET_END_HOUR);
    expect(clampToPermittedHour(8)).toBe(8);
  });

  it('CROSS-CHECK against the real policy engine: the scheduled instant is not in quiet hours', () => {
    for (const hour of [0, 2, 6, 23]) {
      const r = scheduleSend(ctx(), model(hour));
      if (!r.ok) throw new Error('expected a schedule');
      // verified against the same isWithinQuietHours the push channel uses
      expect(wouldLandInQuietHours(r.scheduled.sendAtMs, IST)).toBe(false);
    }
  });

  it('a permitted suggestion also lands outside quiet hours', () => {
    const r = scheduleSend(ctx(), model(20));
    if (!r.ok) throw new Error('expected a schedule');
    expect(wouldLandInQuietHours(r.scheduled.sendAtMs, IST)).toBe(false);
  });

  it('schedules for the NEXT occurrence when the hour has already passed today', () => {
    // it is 12:00 IST; a 10:00 suggestion must go tomorrow rather than into the past
    const r = scheduleSend(ctx(), model(10));
    if (!r.ok) throw new Error('expected a schedule');
    expect(r.scheduled.sendAtMs).toBeGreaterThan(NOW);
  });

  it('respects the customer OWN timezone rather than a server one', () => {
    const indian = scheduleSend(ctx({ tzOffsetMinutes: IST }), model(9));
    const british = scheduleSend(ctx({ customerId: 'CUS-UK', tzOffsetMinutes: 60 }), model(9));
    if (!indian.ok || !british.ok) throw new Error('expected schedules');
    expect(indian.scheduled.sendAtMs).not.toBe(british.scheduled.sendAtMs);
    expect(wouldLandInQuietHours(british.scheduled.sendAtMs, 60)).toBe(false);
  });
});

describe('the optimiser cannot bypass the frequency cap (VALIDATION)', () => {
  it('refuses to schedule at all once the cap is reached', () => {
    const r = scheduleSend(ctx({ sendsInFrequencyWindow: 3, frequencyCap: 3 }), model(19));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('FREQUENCY_CAP_REACHED');
  });

  it('the cap is checked BEFORE the model is consulted, so no lift can argue against it', () => {
    let modelCalled = false;
    const spy: SendTimeModel = () => {
      modelCalled = true;
      return suggestion(19, { expectedLiftPct: 400 });
    };
    scheduleSend(ctx({ sendsInFrequencyWindow: 5, frequencyCap: 3 }), spy);
    expect(modelCalled).toBe(false);
  });

  it('schedules normally below the cap', () => {
    expect(scheduleSend(ctx({ sendsInFrequencyWindow: 2, frequencyCap: 3 }), model(19)).ok).toBe(true);
  });
});

// ============================================ model unavailability

describe('model unavailability falls back to the configured default (ERRORS)', () => {
  it('uses the journey default when no model is supplied', () => {
    const r = scheduleSend(ctx({ defaultLocalHour: 11 }), null);
    if (!r.ok) throw new Error('expected a schedule');
    expect(r.scheduled.outcome).toBe('FALLBACK_DEFAULT');
    expect(r.scheduled.localHour).toBe(11);
    expect(r.scheduled.expectedLiftPct).toBeNull();
    expect(r.scheduled.modelVersion).toBe('none');
  });

  it('falls back when the model throws', () => {
    const broken: SendTimeModel = () => { throw new Error('model down'); };
    const r = scheduleSend(ctx(), broken);
    if (!r.ok) throw new Error('expected a schedule');
    expect(r.scheduled.outcome).toBe('FALLBACK_DEFAULT');
  });

  it('falls back on a nonsense suggested hour rather than clamping it into plausibility', () => {
    for (const hour of [-5, 25, Number.NaN]) {
      const r = scheduleSend(ctx(), () => suggestion(hour));
      if (!r.ok) throw new Error('expected a schedule');
      expect(r.scheduled.outcome).toBe('FALLBACK_DEFAULT');
    }
  });

  it('THE FALLBACK IS ALSO CLAMPED: a badly configured default cannot send at 3 a.m.', () => {
    const r = scheduleSend(ctx({ defaultLocalHour: 3 }), null);
    if (!r.ok) throw new Error('expected a schedule');
    expect(r.scheduled.localHour).toBe(QUIET_END_HOUR);
    expect(wouldLandInQuietHours(r.scheduled.sendAtMs, IST)).toBe(false);
  });
});

// ============================================ variants need human approval

describe('a variant cannot be sent without human approval (VALIDATION)', () => {
  it('permits an approved variant that cleared the policy filter', () => {
    expect(isSendable(variant()).ok).toBe(true);
  });

  it('REFUSES a draft variant, however good it looks', () => {
    const r = isSendable(variant({ state: 'DRAFT' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VARIANT_NOT_HUMAN_APPROVED');
  });

  it('refuses an approved variant with no approver recorded', () => {
    // the gate lives at the POINT OF USE, so a variant cannot reach a send by having been created
    // through some other path
    const noRef = isSendable(variant({ approvalRef: undefined }));
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.reason).toBe('APPROVAL_REFERENCE_AND_APPROVER_REQUIRED');
    expect(isSendable(variant({ approvedByUserId: undefined })).ok).toBe(false);
  });

  it('refuses copy that did not pass the policy filter, even when a human approved it', () => {
    const r = isSendable(variant({ policyFilterPassed: false }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('COPY_DID_NOT_PASS_POLICY_FILTER');
  });

  it('refuses a retired variant', () => {
    const r = isSendable(variant({ state: 'RETIRED' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('VARIANT_RETIRED');
  });
});

// ============================================ retirement

describe('underperforming variants auto-retire, but not prematurely (RULES)', () => {
  const control = performance('VAR-CONTROL', 5_000, 250);    // 5%

  it('retires a variant well below the control once it has enough sends', () => {
    const poor = performance('VAR-B', 1_000, 20);            // 2%, 0.4 of control
    const d = retirementDecision(poor, control, false);
    expect(d.retire).toBe(true);
    expect(d.relativeToControl).toBe(0.4);
    expect(d.reason).toContain('BELOW_0.7');
  });

  it('does NOT retire on too few sends, however bad the early numbers', () => {
    const unlucky = performance('VAR-B', 30, 0);
    const d = retirementDecision(unlucky, control, false);
    expect(d.retire).toBe(false);
    // retiring on thirty sends is how a genuinely better variant gets killed by one unlucky
    // afternoon
    expect(d.reason).toContain('INSUFFICIENT_SENDS_30');
    expect(MIN_SENDS_BEFORE_RETIREMENT).toBe(500);
  });

  it('keeps a variant performing adequately', () => {
    const fine = performance('VAR-B', 1_000, 48);            // 4.8%, 0.96 of control
    const d = retirementDecision(fine, control, false);
    expect(d.retire).toBe(false);
    expect(d.reason).toBe('PERFORMING_ADEQUATELY');
  });

  it('the relative threshold boundary is exact', () => {
    // exactly 0.7 of control is 3.5%
    const atThreshold = performance('VAR-B', 1_000, 35);
    expect(retirementDecision(atThreshold, control, false).retire).toBe(false);
    const justBelow = performance('VAR-C', 1_000, 34);
    expect(retirementDecision(justBelow, control, false).retire).toBe(true);
    expect(RETIREMENT_RELATIVE_THRESHOLD).toBe(0.7);
  });

  it('NEVER retires the control, which would leave nothing to measure against', () => {
    const badControl = performance('VAR-CONTROL', 5_000, 1);
    const d = retirementDecision(badControl, badControl, true);
    expect(d.retire).toBe(false);
    expect(d.reason).toBe('CONTROL_IS_NEVER_RETIRED');
  });

  it('does not retire against a control with no baseline rate', () => {
    const zeroControl = performance('VAR-CONTROL', 5_000, 0);
    const d = retirementDecision(performance('VAR-B', 1_000, 10), zeroControl, false);
    expect(d.retire).toBe(false);
    expect(d.reason).toBe('CONTROL_HAS_NO_BASELINE_RATE');
    expect(d.relativeToControl).toBeNull();
  });

  it('computes a rate without dividing by zero', () => {
    expect(performance('V', 0, 0).rate).toBe(0);
  });
});

// ============================================ exploration budget

describe('the exploration budget is capped at 10% of the audience (RULES)', () => {
  it('allocates the requested share when it is within the cap', () => {
    const a = allocateExploration(10_000, 0.05);
    expect(a.exploreCount).toBe(500);
    expect(a.exploitCount).toBe(9_500);
    expect(a.exploreShare).toBe(0.05);
    expect(a.cappedToLimit).toBe(false);
  });

  it('CAPS an over-ambitious request rather than honouring it', () => {
    const a = allocateExploration(10_000, 0.5);
    // exploration spends real customers' attention on copy that is by definition unproven
    expect(a.exploreCount).toBe(1_000);
    expect(a.exploreShare).toBe(0.1);
    expect(a.cappedToLimit).toBe(true);
    expect(MAX_EXPLORATION_SHARE).toBe(0.1);
  });

  it('the cap boundary is exact', () => {
    expect(allocateExploration(10_000, 0.1).cappedToLimit).toBe(false);
    expect(allocateExploration(10_000, 0.1001).cappedToLimit).toBe(true);
  });

  it('handles a zero audience and a zero request without dividing by zero', () => {
    const empty = allocateExploration(0, 0.1);
    expect(empty.exploreCount).toBe(0);
    expect(empty.exploreShare).toBe(0);
    expect(allocateExploration(1_000, 0).exploreCount).toBe(0);
    expect(allocateExploration(-5, 0.1).audienceSize).toBe(0);
  });

  it('a small audience floors exploration rather than rounding a person up', () => {
    // 5% of 9 people is 0.45 of a person
    expect(allocateExploration(9, 0.05).exploreCount).toBe(0);
    expect(allocateExploration(9, 0.05).exploitCount).toBe(9);
  });
});

// ============================================ channel mix

describe('channel selection filters on consent BEFORE ranking (DESC)', () => {
  const consents = (over: Partial<Record<string, ChannelConsent>> = {}): ChannelConsent[] => [
    { channel: 'EMAIL', consented: true, engagementRate: 0.12 },
    { channel: 'PUSH', consented: true, engagementRate: 0.28 },
    { channel: 'SMS', consented: false, engagementRate: 0.9 },
    ...Object.values(over).filter(Boolean) as ChannelConsent[],
  ];

  it('picks the best CONSENTED channel, ignoring a better non-consented one', () => {
    const r = selectChannel(consents());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a channel the customer refused is not a worse option, it is not an option
    expect(r.choice.channel).toBe('PUSH');
    expect(r.choice.expectedEngagementRate).toBe(0.28);
    expect(r.choice.attributions[0].note).toContain('PUSH');
  });

  it('refuses when no channel is consented', () => {
    const r = selectChannel([
      { channel: 'EMAIL', consented: false, engagementRate: 0.5 },
      { channel: 'PUSH', consented: false, engagementRate: 0.6 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NO_CONSENTED_CHANNEL');
  });

  it('refuses on an empty channel list', () => {
    expect(selectChannel([]).ok).toBe(false);
  });

  it('breaks a tie deterministically', () => {
    const tied: ChannelConsent[] = [
      { channel: 'PUSH', consented: true, engagementRate: 0.2 },
      { channel: 'EMAIL', consented: true, engagementRate: 0.2 },
    ];
    expect(selectChannel(tied).ok && selectChannel(tied).ok).toBe(true);
    const first = selectChannel(tied);
    const second = selectChannel([...tied].reverse());
    if (first.ok && second.ok) expect(first.choice.channel).toBe(second.choice.channel);
  });
});

// ============================================ budget pacing

describe('budget pacing is advisory (OUTPUTS)', () => {
  it('reports on-pace spending', () => {
    const p = pacingSuggestion(300_000_00, 150_000_00, 15, 30);
    expect(p.onPacePaise).toBe(150_000_00);
    expect(p.status).toBe('ON_PACE');
    expect(p.advisory).toBe(true);
  });

  it('flags overspending and underspending against a tolerance', () => {
    expect(pacingSuggestion(300_000_00, 250_000_00, 15, 30).status).toBe('OVERSPENDING');
    expect(pacingSuggestion(300_000_00, 50_000_00, 15, 30).status).toBe('UNDERSPENDING');
    // small drift is not an alarm
    expect(pacingSuggestion(300_000_00, 152_000_00, 15, 30).status).toBe('ON_PACE');
  });

  it('spreads the remainder across the days left', () => {
    const p = pacingSuggestion(300_000_00, 200_000_00, 20, 30);
    // 100,000 remaining over 11 days left
    expect(p.suggestedTodayPaise).toBe(Math.round(100_000_00 / 11));
  });

  it('never suggests negative spend when already over budget', () => {
    expect(pacingSuggestion(100_000_00, 150_000_00, 20, 30).suggestedTodayPaise).toBe(0);
  });

  it('clamps a nonsensical day or period rather than dividing by zero', () => {
    expect(pacingSuggestion(100_00, 0, 0, 0).daysInPeriod).toBe(1);
    expect(pacingSuggestion(100_00, 0, 99, 30).dayOfPeriod).toBe(30);
  });
});

// ============================================ decision log

describe('every decision is explainable (RULES)', () => {
  it('stores the feature attributions alongside the outcome', () => {
    const log = new DecisionLog();
    const r = scheduleSend(ctx(), model(19));
    if (!r.ok) throw new Error('expected a schedule');
    log.recordSchedule(r.scheduled, NOW);

    const entry = log.forCustomer('CUS-1')[0];
    expect(entry.decision).toBe('SEND_TIME');
    expect(entry.outcome).toBe('OPTIMISED');
    expect(entry.modelVersion).toBe('sto-v4');
    expect(entry.attributions).toHaveLength(2);
    expect(entry.attributions[0].feature).toBe('historical_open_hour');
  });

  it('records when a hard constraint OVERRODE the optimiser, and lists overrides as a set', () => {
    const log = new DecisionLog();
    const clamped = scheduleSend(ctx(), model(2));
    const clean = scheduleSend(ctx({ customerId: 'CUS-2' }), model(19));
    if (!clamped.ok || !clean.ok) throw new Error('expected schedules');
    log.recordSchedule(clamped.scheduled, NOW);
    log.recordSchedule(clean.scheduled, NOW);

    expect(log.all()).toHaveLength(2);
    const overrides = log.overrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0].customerId).toBe('CUS-1');
    expect(overrides[0].hardConstraintApplied).toContain('QUIET_HOURS');
  });

  it('an optimised decision with no attributions is reported as unexplainable', () => {
    const log = new DecisionLog();
    const r = scheduleSend(ctx(), () => suggestion(19, { attributions: [] }));
    if (!r.ok) throw new Error('expected a schedule');
    log.recordSchedule(r.scheduled, NOW);
    expect(log.unexplainable()).toHaveLength(1);
  });

  it('a fallback is NOT unexplainable, since there was no model decision to explain', () => {
    const log = new DecisionLog();
    const r = scheduleSend(ctx(), null);
    if (!r.ok) throw new Error('expected a schedule');
    log.recordSchedule(r.scheduled, NOW);
    expect(log.unexplainable()).toEqual([]);
  });

  it('scopes entries per customer', () => {
    const log = new DecisionLog();
    const a = scheduleSend(ctx({ customerId: 'CUS-A' }), model(19));
    const b = scheduleSend(ctx({ customerId: 'CUS-B' }), model(20));
    if (!a.ok || !b.ok) throw new Error('expected schedules');
    log.recordSchedule(a.scheduled, NOW);
    log.recordSchedule(b.scheduled, NOW);
    expect(log.forCustomer('CUS-A')).toHaveLength(1);
    expect(log.forCustomer('CUS-B')).toHaveLength(1);
  });
});
