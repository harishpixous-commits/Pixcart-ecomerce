/**
 * Notification centre (operator) — FR-ADM-015.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "let operators manage message templates (multi-locale, versioned, DLT-mapped),
 *                broadcast announcements (targeted, throttled), and monitor channel health
 *                (delivery, bounce, complaint rates) per provider."
 *   INPUTS:     "Template CRUD with variables, test-send, broadcast definitions (segment, channel
 *                mix, schedule), provider weights."
 *   OUTPUTS:    "Approved template registry, broadcast executions with per-channel stats, health
 *                dashboards with auto-failover events."
 *   VALIDATION: "Variable completeness vs sample payload; SMS templates must map to registered DLT
 *                ids; broadcast size confirmations > 50k."
 *   RULES:      "Transactional templates locked from MKT edit; complaint rate > threshold
 *                auto-pauses promotional sends on that channel."
 *
 * TWO RULES HERE ARE ABOUT WHO IS ALLOWED TO BREAK WHAT.
 *
 *  1. TRANSACTIONAL TEMPLATES ARE LOCKED FROM MARKETING. Not because marketers are careless, but
 *     because an order-confirmation template is part of a payment record: a well-meant tone edit
 *     that drops the {{orderId}} variable turns every receipt that month into an unusable
 *     document. The lock is enforced on the EDIT, and the transactional/promotional split is the
 *     FR-CUS-022 one rather than a second list that could disagree with it.
 *
 *  2. A COMPLAINT-RATE BREACH PAUSES PROMOTIONAL SENDS ONLY. This is the same asymmetry the
 *     FR-MKT-003 email channel applies to suppression, and for the same reason: complaints are
 *     about marketing, so pausing a channel's order confirmations because its offers annoyed
 *     people would punish customers for the platform's own marketing. Transactional traffic keeps
 *     flowing on a channel that has been paused for promotions.
 *
 * The variable-completeness check REUSES missingTemplateVariables from the FR-CUS-022 policy
 * engine rather than reimplementing template parsing — two parsers would eventually disagree about
 * what counts as a variable, and the one that disagrees silently is the one in the less-used path.
 */
import { isTransactional, missingTemplateVariables, type Category, type Channel } from './policy.js';

/**
 * RULES: the complaint rate above which promotional sends auto-pause on a channel.
 *
 * 0.1% is the figure mailbox providers act on, and it is defined HERE rather than in each channel
 * so that the platform has one answer to "what counts as too many complaints".
 */
export const COMPLAINT_RATE_THRESHOLD = 0.001;
/** The hard-bounce rate above which a provider is treated as unhealthy. */
export const HARD_BOUNCE_RATE_THRESHOLD = 0.02;
/** VALIDATION: a broadcast above this size needs explicit confirmation. */
export const BROADCAST_CONFIRMATION_THRESHOLD = 50_000;

export type OperatorRole = 'SUPER_ADMIN' | 'ADMIN' | 'MARKETING';

export type TemplateState = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

export interface Template {
  templateId: string;
  version: number;
  locale: string;
  category: Category;
  channel: Channel;
  body: string;
  /** The variables the body declares, for completeness checking. */
  declaredVariables: string[];
  /** VALIDATION: mandatory for SMS — a registered DLT template id. */
  dltId?: string;
  state: TemplateState;
  approvedByUserId?: string;
  approvedAtMs?: number;
}

export interface Violation {
  code: string;
  detail: string;
}

export type TemplateResult =
  | { ok: true; template: Template }
  | { ok: false; violations: Violation[] };

/**
 * VALIDATION: is this template complete and compliant?
 *
 * The variable check runs against a SAMPLE PAYLOAD rather than against the declared list alone,
 * because a template can declare every variable it uses and still be unsendable if the payload the
 * journey actually produces is missing one.
 */
export function validateTemplate(t: Template, samplePayload: Record<string, string>): Violation[] {
  const v: Violation[] = [];

  if (!t.templateId || t.templateId.trim().length === 0) {
    v.push({ code: 'TEMPLATE_ID_REQUIRED', detail: '' });
  }
  if (t.version < 1) v.push({ code: 'VERSION_MUST_BE_POSITIVE', detail: String(t.version) });
  if (!t.locale || !/^[a-z]{2}(-[A-Z]{2})?$/.test(t.locale)) {
    v.push({ code: 'LOCALE_MALFORMED', detail: t.locale ?? '' });
  }
  if (!t.body || t.body.trim().length === 0) {
    v.push({ code: 'BODY_REQUIRED', detail: '' });
  }

  // reused from the FR-CUS-022 policy engine: one template parser, not two
  const missing = missingTemplateVariables(t.body ?? '', samplePayload);
  for (const name of missing) {
    v.push({ code: 'VARIABLE_MISSING_FROM_SAMPLE_PAYLOAD', detail: name });
  }

  // VALIDATION: SMS templates must map to a registered DLT id (TRAI requirement in India)
  if (t.channel === 'SMS' && (!t.dltId || t.dltId.trim().length === 0)) {
    v.push({
      code: 'SMS_TEMPLATE_REQUIRES_REGISTERED_DLT_ID',
      detail: 'an unregistered SMS template is rejected by the operator, not by us',
    });
  }
  if (t.channel !== 'SMS' && t.dltId) {
    v.push({ code: 'DLT_ID_ONLY_APPLIES_TO_SMS', detail: t.channel });
  }
  return v;
}

/**
 * RULES: may this role edit this template?
 *
 * Marketing may not touch a transactional template. An order-confirmation template is part of a
 * payment record, and a well-meant tone edit that drops {{orderId}} turns every receipt that month
 * into an unusable document.
 */
export function mayEdit(role: OperatorRole, t: Template):
  { permitted: true } | { permitted: false; reason: string } {
  if (t.state === 'ARCHIVED') {
    return { permitted: false, reason: 'ARCHIVED_TEMPLATES_ARE_IMMUTABLE' };
  }
  if (role === 'MARKETING' && isTransactional(t.category)) {
    return {
      permitted: false,
      reason: `TRANSACTIONAL_TEMPLATE_LOCKED_FROM_MARKETING: ${t.category}`,
    };
  }
  return { permitted: true };
}

export class TemplateRegistry {
  private readonly templates = new Map<string, Template>();

  private key(templateId: string, version: number, locale: string): string {
    return `${templateId}:${version}:${locale}`;
  }

  /** Create or revise a template. A revision is a NEW version, never an in-place rewrite. */
  save(t: Template, role: OperatorRole, samplePayload: Record<string, string>): TemplateResult {
    const permitted = mayEdit(role, t);
    if (!permitted.permitted) {
      return { ok: false, violations: [{ code: 'EDIT_NOT_PERMITTED', detail: permitted.reason }] };
    }
    const violations = validateTemplate(t, samplePayload);
    if (violations.length > 0) return { ok: false, violations };

    const k = this.key(t.templateId, t.version, t.locale);
    const existing = this.templates.get(k);
    if (existing && existing.state === 'APPROVED') {
      return {
        ok: false,
        violations: [{
          code: 'APPROVED_VERSION_IS_IMMUTABLE_RAISE_A_NEW_VERSION',
          detail: `${t.templateId} v${t.version} ${t.locale}`,
        }],
      };
    }
    this.templates.set(k, { ...t, state: 'DRAFT', approvedByUserId: undefined, approvedAtMs: undefined });
    return { ok: true, template: this.templates.get(k)! };
  }

  /** OUTPUTS: the approved template registry. Approval names its approver. */
  approve(templateId: string, version: number, locale: string, userId: string, nowMs: number):
    TemplateResult {
    const k = this.key(templateId, version, locale);
    const t = this.templates.get(k);
    if (!t) return { ok: false, violations: [{ code: 'UNKNOWN_TEMPLATE', detail: k }] };
    if (t.state === 'APPROVED') {
      return { ok: false, violations: [{ code: 'ALREADY_APPROVED', detail: k }] };
    }
    if (!userId || userId.trim().length === 0) {
      return { ok: false, violations: [{ code: 'APPROVER_REQUIRED', detail: '' }] };
    }
    const approved: Template = { ...t, state: 'APPROVED', approvedByUserId: userId, approvedAtMs: nowMs };
    this.templates.set(k, approved);
    return { ok: true, template: approved };
  }

  template(templateId: string, version: number, locale: string): Template | undefined {
    return this.templates.get(this.key(templateId, version, locale));
  }

  /** The locales a template is approved in — used to decide whether a broadcast can go out. */
  approvedLocales(templateId: string, version: number): string[] {
    return [...this.templates.values()]
      .filter((t) => t.templateId === templateId && t.version === version && t.state === 'APPROVED')
      .map((t) => t.locale)
      .sort();
  }

  /** INPUTS: a test-send is permitted from a DRAFT, which is the point of a test-send. */
  testSend(templateId: string, version: number, locale: string, samplePayload: Record<string, string>):
    { ok: true; rendered: string } | { ok: false; reason: string } {
    const t = this.template(templateId, version, locale);
    if (!t) return { ok: false, reason: 'UNKNOWN_TEMPLATE' };
    const missing = missingTemplateVariables(t.body, samplePayload);
    if (missing.length > 0) {
      return { ok: false, reason: `MISSING_VARIABLES: ${missing.join(', ')}` };
    }
    let rendered = t.body;
    for (const [name, value] of Object.entries(samplePayload)) {
      rendered = rendered.split(`{{${name}}}`).join(value);
    }
    return { ok: true, rendered };
  }
}

// ================================================= channel health

export interface ProviderStats {
  providerId: string;
  channel: Channel;
  attempted: number;
  delivered: number;
  hardBounces: number;
  complaints: number;
}

export interface ChannelHealth {
  providerId: string;
  channel: Channel;
  deliveryRate: number;
  hardBounceRate: number;
  complaintRate: number;
  healthy: boolean;
  /** RULES: promotional sends pause on a complaint breach. */
  promotionalPaused: boolean;
  /** Transactional traffic is NOT paused — see the note at the top of this file. */
  transactionalPaused: false;
  reasons: string[];
}

export function channelHealth(stats: ProviderStats): ChannelHealth {
  const attempted = Math.max(0, stats.attempted);
  // Rates are compared EXACT and rounded only for display. Rounding before the comparison would
  // shift the effective threshold: a true complaint rate of 0.0010049 rounds to 0.001, which is
  // not greater than 0.001, so a channel that had genuinely breached would not pause.
  const exact = (n: number, d: number) => (d === 0 ? 0 : n / d);
  const shown = (x: number) => Math.round(x * 100_000) / 100_000;

  const exactDelivery = exact(stats.delivered, attempted);
  const exactHardBounce = exact(stats.hardBounces, attempted);
  const exactComplaint = exact(stats.complaints, stats.delivered);

  const deliveryRate = shown(exactDelivery);
  const hardBounceRate = shown(exactHardBounce);
  const complaintRate = shown(exactComplaint);

  const reasons: string[] = [];
  if (exactComplaint > COMPLAINT_RATE_THRESHOLD) {
    reasons.push(`COMPLAINT_RATE_${complaintRate}_ABOVE_${COMPLAINT_RATE_THRESHOLD}`);
  }
  if (exactHardBounce > HARD_BOUNCE_RATE_THRESHOLD) {
    reasons.push(`HARD_BOUNCE_RATE_${hardBounceRate}_ABOVE_${HARD_BOUNCE_RATE_THRESHOLD}`);
  }

  return {
    providerId: stats.providerId,
    channel: stats.channel,
    deliveryRate,
    hardBounceRate,
    complaintRate,
    healthy: reasons.length === 0,
    // RULES: a complaint breach pauses PROMOTIONAL sends on this channel
    promotionalPaused: exactComplaint > COMPLAINT_RATE_THRESHOLD,
    transactionalPaused: false,
    reasons,
  };
}

/**
 * RULES: may a send of this category go out on this channel right now?
 *
 * The asymmetry is the substance: complaints are about marketing, so pausing a channel's order
 * confirmations because its offers annoyed people would punish customers for the platform's own
 * marketing.
 */
export function maySend(category: Category, health: ChannelHealth):
  { permitted: true } | { permitted: false; reason: string } {
  if (isTransactional(category)) return { permitted: true };
  if (health.promotionalPaused) {
    return {
      permitted: false,
      reason: `PROMOTIONAL_SENDS_PAUSED_ON_${health.channel}: ${health.reasons.join('; ')}`,
    };
  }
  return { permitted: true };
}

// ================================================= provider failover

export interface ProviderWeight {
  providerId: string;
  weight: number;
}

export interface FailoverEvent {
  channel: Channel;
  fromProviderId: string;
  toProviderId: string;
  reason: string;
  atMs: number;
}

export interface FailoverResult {
  weights: ProviderWeight[];
  events: FailoverEvent[];
}

/**
 * OUTPUTS: auto-failover. Weight is moved off an unhealthy provider and onto the healthiest
 * remaining one, and the shift is recorded as an EVENT rather than only reflected in the numbers —
 * a weight that changed silently is a weight nobody can explain next quarter.
 *
 * If every provider is unhealthy the weights are left ALONE: shuffling traffic between equally bad
 * providers achieves nothing and destroys the baseline needed to tell which is recovering.
 */
export function applyFailover(channel: Channel, weights: ProviderWeight[],
                              healths: ChannelHealth[], nowMs: number): FailoverResult {
  const healthById = new Map(healths.map((h) => [h.providerId, h]));
  const healthy = weights.filter((w) => healthById.get(w.providerId)?.healthy !== false);
  const unhealthy = weights.filter((w) => healthById.get(w.providerId)?.healthy === false);

  if (unhealthy.length === 0 || healthy.length === 0) {
    return { weights: weights.map((w) => ({ ...w })), events: [] };
  }

  // the healthiest remaining provider is the one with the lowest complaint rate
  const target = healthy
    .slice()
    .sort((a, b) => {
      const ha = healthById.get(a.providerId);
      const hb = healthById.get(b.providerId);
      return (ha?.complaintRate ?? 0) - (hb?.complaintRate ?? 0)
        || a.providerId.localeCompare(b.providerId);
    })[0];

  const events: FailoverEvent[] = [];
  const next = new Map(weights.map((w) => [w.providerId, w.weight]));
  let moved = 0;
  for (const bad of unhealthy) {
    if (bad.weight <= 0) continue;
    moved += bad.weight;
    next.set(bad.providerId, 0);
    events.push({
      channel,
      fromProviderId: bad.providerId,
      toProviderId: target.providerId,
      reason: healthById.get(bad.providerId)!.reasons.join('; '),
      atMs: nowMs,
    });
  }
  next.set(target.providerId, (next.get(target.providerId) ?? 0) + moved);

  return {
    weights: [...next.entries()]
      .map(([providerId, weight]) => ({ providerId, weight }))
      .sort((a, b) => a.providerId.localeCompare(b.providerId)),
    events,
  };
}

// ================================================= broadcasts

export interface BroadcastDefinition {
  broadcastId: string;
  templateId: string;
  templateVersion: number;
  category: Category;
  channels: Channel[];
  segmentName: string;
  audienceSize: number;
  scheduledForMs: number;
  /** Throttle, in sends per minute. */
  throttlePerMinute: number;
  /** VALIDATION: explicit confirmation, required above the size threshold. */
  sizeConfirmedByUserId?: string;
}

export interface BroadcastExecution {
  broadcastId: string;
  perChannel: Array<{ channel: Channel; queued: number; paused: boolean; pauseReason?: string }>;
  totalQueued: number;
  estimatedMinutes: number;
}

export type BroadcastResult =
  | { ok: true; execution: BroadcastExecution }
  | { ok: false; violations: Violation[] };

/**
 * Launch a broadcast.
 *
 * VALIDATION: above 50,000 recipients an explicit confirmation is required, naming the person who
 * gave it. A broadcast is the one operation where a mis-typed segment reaches everybody before
 * anybody notices, and an undo does not exist.
 */
export function launchBroadcast(def: BroadcastDefinition, registry: TemplateRegistry,
                                healths: ChannelHealth[]): BroadcastResult {
  const violations: Violation[] = [];

  if (def.channels.length === 0) {
    violations.push({ code: 'AT_LEAST_ONE_CHANNEL_REQUIRED', detail: '' });
  }
  if (def.audienceSize < 0) {
    violations.push({ code: 'AUDIENCE_SIZE_CANNOT_BE_NEGATIVE', detail: String(def.audienceSize) });
  }
  if (def.throttlePerMinute <= 0) {
    violations.push({ code: 'THROTTLE_MUST_BE_POSITIVE', detail: String(def.throttlePerMinute) });
  }
  if (def.audienceSize > BROADCAST_CONFIRMATION_THRESHOLD
      && (!def.sizeConfirmedByUserId || def.sizeConfirmedByUserId.trim().length === 0)) {
    violations.push({
      code: `BROADCAST_OVER_${BROADCAST_CONFIRMATION_THRESHOLD}_REQUIRES_CONFIRMATION`,
      detail: `${def.audienceSize} recipients`,
    });
  }

  // the template must be approved in at least one locale before it can be broadcast
  const approvedLocales = registry.approvedLocales(def.templateId, def.templateVersion);
  if (approvedLocales.length === 0) {
    violations.push({
      code: 'TEMPLATE_VERSION_NOT_APPROVED_IN_ANY_LOCALE',
      detail: `${def.templateId} v${def.templateVersion}`,
    });
  }

  if (violations.length > 0) return { ok: false, violations };

  const healthByChannel = new Map(healths.map((h) => [h.channel, h]));
  const perChannel = def.channels.map((channel) => {
    const health = healthByChannel.get(channel);
    const decision = health ? maySend(def.category, health) : { permitted: true as const };
    if (!decision.permitted) {
      return { channel, queued: 0, paused: true, pauseReason: decision.reason };
    }
    return { channel, queued: def.audienceSize, paused: false };
  });

  const totalQueued = perChannel.reduce((a, c) => a + c.queued, 0);
  return {
    ok: true,
    execution: {
      broadcastId: def.broadcastId,
      perChannel,
      totalQueued,
      estimatedMinutes: Math.ceil(totalQueued / def.throttlePerMinute),
    },
  };
}
