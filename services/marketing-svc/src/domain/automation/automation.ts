/**
 * AI marketing automation — FR-MKT-009.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "optimise marketing execution with AI: send-time optimisation per user,
 *                channel-mix selection, subject/copy variant generation (human-approved
 *                templates), and budget pacing suggestions — always inside consent, caps and
 *                brand-tone constraints."
 *   INPUTS:     "Engagement histories, journey configs opting into optimisation, brand-tone rules,
 *                guard settings."
 *   OUTPUTS:    "Optimised schedules/channels with expected-lift, generated variants queued for
 *                approval, experiment auto-analysis, decisions log."
 *   VALIDATION: "Optimiser cannot bypass frequency caps/quiet hours (hard constraints); generated
 *                copy passes policy filter + human approval before first use."
 *   RULES:      "Exploration budget ≤ 10% of audience; underperforming variant auto-retire; all
 *                decisions explainable (feature attributions stored)."
 *   ERRORS:     "Model unavailable → fall back to configured defaults."
 *
 * THE WORD THAT DOES THE WORK IN THIS REQUIREMENT IS "CANNOT". An optimiser that merely *should
 * not* bypass quiet hours will bypass them the first time a model reports a large expected lift
 * at 2 a.m., because a number that says "23% more opens" is very persuasive to whoever wires the
 * scheduler. So the constraint is applied AFTER the optimiser has spoken and it overrides
 * unconditionally: the suggestion is clamped into the permitted window, the expected lift is
 * recomputed as unknown rather than carried across, and the decision log records that the
 * optimiser was overruled.
 *
 * Quiet hours are not reimplemented here. The FR-CUS-022 policy engine owns them, the FR-MKT-005
 * push channel already delegates to it, and a third copy of "22:00 to 08:00" would be a third
 * chance to get a customer's evening wrong.
 *
 * Copy generation is likewise not reimplemented: FR-AI-013 produces variants awaiting human
 * acceptance, and this module simply REFUSES to send one that has not been approved. Keeping the
 * approval gate at the point of use rather than only at the point of creation means a variant
 * cannot slip into a send by being created through some other path.
 */
import { isWithinQuietHours, QUIET_END_HOUR, QUIET_START_HOUR }
  from '../../../../notification-svc/src/domain/policy.js';

/** RULES: at most this share of an audience may be spent on exploration. */
export const MAX_EXPLORATION_SHARE = 0.10;
/** RULES: a variant below this share of the control's rate is auto-retired. */
export const RETIREMENT_RELATIVE_THRESHOLD = 0.7;
/** A variant needs at least this many sends before its performance means anything. */
export const MIN_SENDS_BEFORE_RETIREMENT = 500;

export type Channel = 'EMAIL' | 'PUSH' | 'SMS' | 'WHATSAPP';

export interface Violation {
  code: string;
  detail: string;
}

// ================================================= send-time optimisation

export interface Attribution {
  feature: string;
  contributionPct: number;
  note: string;
}

/** What the injected send-time model proposes. */
export interface SendTimeSuggestion {
  customerId: string;
  /** The hour the model thinks is best, in the customer's local time. */
  suggestedLocalHour: number;
  expectedLiftPct: number;
  /** RULES: all decisions explainable — the attributions travel with the suggestion. */
  attributions: Attribution[];
  modelVersion: string;
}

export type SendTimeModel = (customerId: string) => SendTimeSuggestion;

export type ScheduleOutcome = 'OPTIMISED' | 'CLAMPED_TO_PERMITTED_WINDOW' | 'FALLBACK_DEFAULT';

export interface ScheduledSend {
  customerId: string;
  /** The hour actually scheduled, in the customer's local time. */
  localHour: number;
  sendAtMs: number;
  outcome: ScheduleOutcome;
  /** Null when the optimiser was overruled: the model's lift does not survive being clamped. */
  expectedLiftPct: number | null;
  attributions: Attribution[];
  modelVersion: string;
  /** VALIDATION: records that a hard constraint overrode the model. */
  hardConstraintApplied?: string;
}

export interface OptimiserContext {
  customerId: string;
  tzOffsetMinutes: number;
  /** The journey's configured default hour, used when the model is unavailable. */
  defaultLocalHour: number;
  /** VALIDATION: sends already made to this customer in the frequency window. */
  sendsInFrequencyWindow: number;
  frequencyCap: number;
  nowMs: number;
}

/** The next instant at a given local hour, at or after now, in UTC epoch ms. */
function nextLocalHourMs(localHour: number, tzOffsetMinutes: number, nowMs: number): number {
  const offset = tzOffsetMinutes * 60_000;
  const localNow = nowMs + offset;
  const localDayStart = Math.floor(localNow / 86_400_000) * 86_400_000;
  let target = localDayStart + localHour * 3_600_000;
  if (target <= localNow) target += 86_400_000;
  return target - offset;
}

/**
 * VALIDATION: the optimiser cannot bypass quiet hours or the frequency cap.
 *
 * The order is deliberate. The model speaks first, then the hard constraints are applied to what
 * it said — rather than the constraints being passed to the model as a hint it may weigh against
 * expected lift. A constraint the model can trade away is not a constraint.
 */
export function scheduleSend(ctx: OptimiserContext, model: SendTimeModel | null):
  { ok: true; scheduled: ScheduledSend } | { ok: false; reason: string } {
  // VALIDATION: the frequency cap is checked before anything is scheduled at all
  if (ctx.sendsInFrequencyWindow >= ctx.frequencyCap) {
    return { ok: false, reason: 'FREQUENCY_CAP_REACHED' };
  }

  let suggestion: SendTimeSuggestion | null = null;
  if (model !== null) {
    try {
      const s = model(ctx.customerId);
      if (Number.isFinite(s.suggestedLocalHour) && s.suggestedLocalHour >= 0 && s.suggestedLocalHour <= 23) {
        suggestion = s;
      }
    } catch {
      suggestion = null;
    }
  }

  // ERRORS: model unavailable → the journey's configured default, marked as a fallback
  if (suggestion === null) {
    const localHour = clampToPermittedHour(ctx.defaultLocalHour);
    return {
      ok: true,
      scheduled: {
        customerId: ctx.customerId,
        localHour,
        sendAtMs: nextLocalHourMs(localHour, ctx.tzOffsetMinutes, ctx.nowMs),
        outcome: 'FALLBACK_DEFAULT',
        expectedLiftPct: null,
        attributions: [],
        modelVersion: 'none',
      },
    };
  }

  const permittedHour = clampToPermittedHour(suggestion.suggestedLocalHour);
  const wasClamped = permittedHour !== suggestion.suggestedLocalHour;
  const sendAtMs = nextLocalHourMs(permittedHour, ctx.tzOffsetMinutes, ctx.nowMs);

  return {
    ok: true,
    scheduled: {
      customerId: ctx.customerId,
      localHour: permittedHour,
      sendAtMs,
      outcome: wasClamped ? 'CLAMPED_TO_PERMITTED_WINDOW' : 'OPTIMISED',
      // a clamped send is no longer the send the model predicted a lift for, so the lift does not
      // travel with it — carrying it across would be attributing an outcome to advice not taken
      expectedLiftPct: wasClamped ? null : suggestion.expectedLiftPct,
      attributions: [...suggestion.attributions],
      modelVersion: suggestion.modelVersion,
      hardConstraintApplied: wasClamped
        ? `QUIET_HOURS_${QUIET_START_HOUR}_TO_${QUIET_END_HOUR}`
        : undefined,
    },
  };
}

/**
 * Move an hour inside the permitted window. Quiet hours run from QUIET_START_HOUR to
 * QUIET_END_HOUR per the FR-CUS-022 engine, and a suggestion inside them becomes the first
 * permitted hour rather than being dropped — the customer still wants the message, at a civil hour.
 */
export function clampToPermittedHour(localHour: number): number {
  const hour = Math.min(23, Math.max(0, Math.round(localHour)));
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) return QUIET_END_HOUR;
  return hour;
}

/** Cross-check against the real engine: is this instant inside the customer's quiet window? */
export function wouldLandInQuietHours(sendAtMs: number, tzOffsetMinutes: number): boolean {
  return isWithinQuietHours(sendAtMs, tzOffsetMinutes);
}

// ================================================= channel mix

export interface ChannelConsent {
  channel: Channel;
  consented: boolean;
  /** Historical engagement rate on this channel, 0..1. */
  engagementRate: number;
}

export interface ChannelChoice {
  channel: Channel;
  expectedEngagementRate: number;
  attributions: Attribution[];
}

/**
 * Choose a channel. Consent is a filter applied BEFORE the ranking, not a penalty inside it: a
 * channel the customer refused is not a worse option, it is not an option.
 */
export function selectChannel(consents: ChannelConsent[]):
  { ok: true; choice: ChannelChoice } | { ok: false; reason: string } {
  const permitted = consents.filter((c) => c.consented);
  if (permitted.length === 0) {
    return { ok: false, reason: 'NO_CONSENTED_CHANNEL' };
  }
  const best = permitted
    .slice()
    .sort((a, b) => b.engagementRate - a.engagementRate || a.channel.localeCompare(b.channel))[0];
  return {
    ok: true,
    choice: {
      channel: best.channel,
      expectedEngagementRate: best.engagementRate,
      attributions: [{
        feature: 'historical_engagement',
        contributionPct: 100,
        note: `${best.channel} engagement ${(best.engagementRate * 100).toFixed(1)}% `
          + `across ${permitted.length} consented channel(s)`,
      }],
    },
  };
}

// ================================================= variants

export type VariantState = 'DRAFT' | 'APPROVED' | 'RETIRED';

export interface Variant {
  variantId: string;
  templateRef: string;
  state: VariantState;
  /** VALIDATION: human approval before first use. */
  approvalRef?: string;
  approvedByUserId?: string;
  approvedAtMs?: number;
  /** Whether the copy cleared the brand-tone and policy filter. */
  policyFilterPassed: boolean;
  isControl: boolean;
}

/**
 * VALIDATION: may this variant be sent? The gate lives at the POINT OF USE rather than only at
 * creation, so a variant cannot reach a send by having been created through some other path.
 */
export function isSendable(v: Variant): { ok: true } | { ok: false; reason: string } {
  if (v.state === 'RETIRED') return { ok: false, reason: 'VARIANT_RETIRED' };
  if (v.state !== 'APPROVED') return { ok: false, reason: 'VARIANT_NOT_HUMAN_APPROVED' };
  if (!v.approvalRef || !v.approvedByUserId) {
    return { ok: false, reason: 'APPROVAL_REFERENCE_AND_APPROVER_REQUIRED' };
  }
  if (!v.policyFilterPassed) return { ok: false, reason: 'COPY_DID_NOT_PASS_POLICY_FILTER' };
  return { ok: true };
}

export interface VariantPerformance {
  variantId: string;
  sends: number;
  conversions: number;
  rate: number;
}

export function performance(variantId: string, sends: number, conversions: number): VariantPerformance {
  return {
    variantId,
    sends,
    conversions,
    rate: sends === 0 ? 0 : Math.round((conversions / sends) * 10_000) / 10_000,
  };
}

export interface RetirementDecision {
  variantId: string;
  retire: boolean;
  reason: string;
  relativeToControl: number | null;
}

/**
 * RULES: auto-retire an underperforming variant.
 *
 * A variant is retired only once it has enough sends to have earned the judgement. Retiring on
 * thirty sends is how a genuinely better variant gets killed by an unlucky first afternoon, and
 * the control is never retired — retiring it would leave nothing to measure against.
 */
export function retirementDecision(candidate: VariantPerformance, control: VariantPerformance,
                                   isControl: boolean): RetirementDecision {
  if (isControl) {
    return {
      variantId: candidate.variantId,
      retire: false,
      reason: 'CONTROL_IS_NEVER_RETIRED',
      relativeToControl: 1,
    };
  }
  if (candidate.sends < MIN_SENDS_BEFORE_RETIREMENT) {
    return {
      variantId: candidate.variantId,
      retire: false,
      reason: `INSUFFICIENT_SENDS_${candidate.sends}_OF_${MIN_SENDS_BEFORE_RETIREMENT}`,
      relativeToControl: null,
    };
  }
  if (control.rate === 0) {
    return {
      variantId: candidate.variantId,
      retire: false,
      reason: 'CONTROL_HAS_NO_BASELINE_RATE',
      relativeToControl: null,
    };
  }
  const relative = Math.round((candidate.rate / control.rate) * 10_000) / 10_000;
  if (relative < RETIREMENT_RELATIVE_THRESHOLD) {
    return {
      variantId: candidate.variantId,
      retire: true,
      reason: `RATE_${relative}_OF_CONTROL_BELOW_${RETIREMENT_RELATIVE_THRESHOLD}`,
      relativeToControl: relative,
    };
  }
  return {
    variantId: candidate.variantId,
    retire: false,
    reason: 'PERFORMING_ADEQUATELY',
    relativeToControl: relative,
  };
}

// ================================================= exploration budget

export interface ExplorationAllocation {
  audienceSize: number;
  exploitCount: number;
  exploreCount: number
  exploreShare: number;
  /** RULES: true when the requested share was reduced to the cap. */
  cappedToLimit: boolean;
}

/**
 * RULES: the exploration budget is capped at 10% of the audience. Exploration spends real
 * customers' attention on copy that is by definition unproven, so the ceiling is enforced here
 * rather than trusted to whoever configures a campaign.
 */
export function allocateExploration(audienceSize: number, requestedShare: number): ExplorationAllocation {
  const size = Math.max(0, Math.floor(audienceSize));
  const requested = Math.max(0, requestedShare);
  const share = Math.min(MAX_EXPLORATION_SHARE, requested);
  const exploreCount = Math.floor(size * share);
  return {
    audienceSize: size,
    exploitCount: size - exploreCount,
    exploreCount,
    exploreShare: size === 0 ? 0 : Math.round((exploreCount / size) * 10_000) / 10_000,
    cappedToLimit: requested > MAX_EXPLORATION_SHARE,
  };
}

// ================================================= budget pacing

export interface PacingSuggestion {
  dayOfPeriod: number;
  daysInPeriod: number;
  budgetPaise: number;
  spentPaise: number;
  /** What an even pace would have spent by now. */
  onPacePaise: number;
  suggestedTodayPaise: number;
  status: 'UNDERSPENDING' | 'ON_PACE' | 'OVERSPENDING';
  /** Advisory only: pacing never moves money by itself. */
  advisory: true;
}

export function pacingSuggestion(budgetPaise: number, spentPaise: number,
                                 dayOfPeriod: number, daysInPeriod: number): PacingSuggestion {
  const days = Math.max(1, daysInPeriod);
  const day = Math.min(days, Math.max(1, dayOfPeriod));
  const onPace = Math.round((budgetPaise * day) / days);
  const remaining = Math.max(0, budgetPaise - spentPaise);
  const daysLeft = Math.max(1, days - day + 1);

  const drift = spentPaise - onPace;
  const tolerance = Math.round(budgetPaise * 0.05);
  const status = drift > tolerance ? 'OVERSPENDING'
    : drift < -tolerance ? 'UNDERSPENDING'
      : 'ON_PACE';

  return {
    dayOfPeriod: day,
    daysInPeriod: days,
    budgetPaise,
    spentPaise,
    onPacePaise: onPace,
    suggestedTodayPaise: Math.round(remaining / daysLeft),
    status,
    advisory: true,
  };
}

// ================================================= decision log

export interface DecisionLogEntry {
  atMs: number;
  customerId: string;
  decision: 'SEND_TIME' | 'CHANNEL' | 'VARIANT' | 'RETIREMENT' | 'PACING';
  outcome: string;
  modelVersion: string;
  /** RULES: feature attributions stored, so every decision is explainable after the fact. */
  attributions: Attribution[];
  hardConstraintApplied?: string;
}

export class DecisionLog {
  private readonly entries: DecisionLogEntry[] = [];

  record(entry: DecisionLogEntry): void {
    this.entries.push(entry);
  }

  /** Record a scheduled send, carrying its attributions and any override. */
  recordSchedule(scheduled: ScheduledSend, atMs: number): void {
    this.entries.push({
      atMs,
      customerId: scheduled.customerId,
      decision: 'SEND_TIME',
      outcome: scheduled.outcome,
      modelVersion: scheduled.modelVersion,
      attributions: scheduled.attributions,
      hardConstraintApplied: scheduled.hardConstraintApplied,
    });
  }

  all(): DecisionLogEntry[] {
    return [...this.entries];
  }

  forCustomer(customerId: string): DecisionLogEntry[] {
    return this.entries.filter((e) => e.customerId === customerId);
  }

  /** Decisions where a hard constraint overrode the optimiser — worth reviewing as a set. */
  overrides(): DecisionLogEntry[] {
    return this.entries.filter((e) => e.hardConstraintApplied !== undefined);
  }

  /** Every logged decision must carry attributions, or it is not explainable. */
  unexplainable(): DecisionLogEntry[] {
    return this.entries.filter((e) =>
      e.attributions.length === 0 && e.outcome !== 'FALLBACK_DEFAULT');
  }
}
