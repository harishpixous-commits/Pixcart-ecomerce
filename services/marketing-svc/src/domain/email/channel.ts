/**
 * Email marketing channel — FR-MKT-003.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "send transactional and promotional email via ESP integration with domain
 *                authentication (SPF/DKIM/DMARC), template rendering (MJML-based),
 *                list-unsubscribe headers, bounce/complaint processing and deliverability
 *                dashboards."
 *   INPUTS:     "Rendered payloads from FR-CUS-022/FR-MKT-002, suppression lists, sending-domain
 *                config."
 *   OUTPUTS:    "Sends with message-ids, event stream (delivered/open/click/bounce/complaint),
 *                automatic suppression updates, domain-health metrics."
 *   VALIDATION: "HTML size ≤ 100 KB, alt-text lint; promotional sends require unsubscribe link
 *                (hard gate)."
 *   RULES:      "Hard bounce → permanent suppression; complaint → suppress + feedback to journey;
 *                warm-up throttles for new domains."
 *   ERRORS:     "ESP outage → secondary ESP failover for transactional only (promos queue)."
 *   SECURITY:   "Click tracking links signed; PII minimal in URLs; ESP webhooks verified."
 *   ACCEPTANCE: "Given a recipient who complained previously, When any promo campaign targets
 *                them, Then the send is suppressed with reason=complaint and counted in the
 *                suppression report."
 *
 * Two asymmetries in this requirement matter more than they look, and both are encoded rather
 * than left to a caller's judgement:
 *
 *  1. SUPPRESSION SCOPE DEPENDS ON THE REASON. A hard bounce means the mailbox does not exist, so
 *     it suppresses everything including transactional mail. A complaint or an unsubscribe is
 *     about MARKETING, so it must not stop an order confirmation or a refund notice — a customer
 *     who unsubscribed from offers has not waived their receipt, and withholding one would be both
 *     wrong and, for a payment record, arguably unlawful.
 *
 *  2. FAILOVER IS TRANSACTIONAL-ONLY. During an ESP outage a receipt fails over to the secondary
 *     provider; a promotional campaign QUEUES. Sending promos through an unwarmed backup domain
 *     during an incident is how a sender reputation gets destroyed, and nobody is waiting on an
 *     offer email.
 */
import { createHmac } from 'node:crypto';
// The health thresholds live in the FR-ADM-015 notification centre, which is the platform's single
// answer to "what counts as too many complaints". They were duplicated here as literals until
// Slice 71 gave them a home.
import { COMPLAINT_RATE_THRESHOLD, HARD_BOUNCE_RATE_THRESHOLD }
  from '../../../../notification-svc/src/domain/notification-centre.js';

export type MessageClass = 'TRANSACTIONAL' | 'PROMOTIONAL';

export type SuppressionReason = 'HARD_BOUNCE' | 'COMPLAINT' | 'UNSUBSCRIBED' | 'MANUAL';

export type EspHealth = 'HEALTHY' | 'OUTAGE';

/** VALIDATION: the rendered HTML ceiling. Gmail clips beyond roughly this size. */
export const MAX_HTML_BYTES = 100 * 1024;
/** RULES: a new sending domain ramps rather than starting at full volume. */
export const WARMUP_DAYS = 30;

export interface EmailImage {
  src: string;
  alt?: string;
}

export interface EmailPayload {
  messageId: string;
  to: string;
  subject: string;
  htmlBody: string;
  messageClass: MessageClass;
  /** VALIDATION: mandatory for promotional sends — a hard gate, not a warning. */
  unsubscribeUrl?: string;
  images: EmailImage[];
}

export interface SendingDomain {
  domain: string;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  /** Days since the domain started sending, driving the warm-up throttle. */
  ageDays: number;
}

export interface Violation {
  code: string;
  detail: string;
}

/**
 * RULES: which message classes a suppression reason blocks.
 *
 * A hard bounce blocks everything — there is no mailbox to deliver to. A complaint or unsubscribe
 * blocks promotional mail only, because neither is a withdrawal of consent to be told that an
 * order shipped.
 */
export function blockedClassesFor(reason: SuppressionReason): ReadonlySet<MessageClass> {
  switch (reason) {
    case 'HARD_BOUNCE':
      return new Set<MessageClass>(['TRANSACTIONAL', 'PROMOTIONAL']);
    case 'COMPLAINT':
    case 'UNSUBSCRIBED':
    case 'MANUAL':
      return new Set<MessageClass>(['PROMOTIONAL']);
  }
}

/** RULES: a hard bounce and a complaint are permanent; an unsubscribe can be re-consented. */
export function isPermanent(reason: SuppressionReason): boolean {
  return reason === 'HARD_BOUNCE' || reason === 'COMPLAINT';
}

export interface SuppressionEntry {
  email: string;
  reason: SuppressionReason;
  atMs: number;
  permanent: boolean;
}

export class SuppressionList {
  private readonly entries = new Map<string, SuppressionEntry>();

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Add a suppression. A stronger reason never yields to a weaker one: once a hard bounce or a
   * complaint is recorded, a later unsubscribe cannot narrow the scope back to promos only.
   */
  add(email: string, reason: SuppressionReason, atMs: number): SuppressionEntry {
    const k = this.key(email);
    const existing = this.entries.get(k);
    if (existing && isPermanent(existing.reason) && !isPermanent(reason)) {
      return existing;
    }
    if (existing && existing.reason === 'HARD_BOUNCE' && reason !== 'HARD_BOUNCE') {
      return existing;
    }
    const entry: SuppressionEntry = { email: k, reason, atMs, permanent: isPermanent(reason) };
    this.entries.set(k, entry);
    return entry;
  }

  entry(email: string): SuppressionEntry | undefined {
    return this.entries.get(this.key(email));
  }

  /** Is this address suppressed for this class of message? */
  isSuppressedFor(email: string, messageClass: MessageClass): boolean {
    const e = this.entries.get(this.key(email));
    if (!e) return false;
    return blockedClassesFor(e.reason).has(messageClass);
  }

  /** An unsubscribe may be reversed by fresh consent; a complaint or hard bounce may not. */
  reconsent(email: string): { ok: true } | { ok: false; reason: string } {
    const k = this.key(email);
    const e = this.entries.get(k);
    if (!e) return { ok: true };
    if (e.permanent) {
      return { ok: false, reason: `SUPPRESSION_IS_PERMANENT: ${e.reason}` };
    }
    this.entries.delete(k);
    return { ok: true };
  }

  /** OUTPUTS: the suppression report, counted by reason. */
  report(): { total: number; byReason: Record<SuppressionReason, number> } {
    const byReason: Record<SuppressionReason, number> = {
      HARD_BOUNCE: 0, COMPLAINT: 0, UNSUBSCRIBED: 0, MANUAL: 0,
    };
    for (const e of this.entries.values()) byReason[e.reason]++;
    return { total: this.entries.size, byReason };
  }

  size(): number {
    return this.entries.size;
  }
}

// ================================================= validation

/** VALIDATION: HTML size, alt-text lint, and the promotional unsubscribe hard gate. */
export function validatePayload(payload: EmailPayload, domain: SendingDomain): Violation[] {
  const v: Violation[] = [];

  const bytes = Buffer.byteLength(payload.htmlBody, 'utf8');
  if (bytes > MAX_HTML_BYTES) {
    v.push({ code: 'HTML_EXCEEDS_100KB', detail: `${bytes} bytes` });
  }
  if (!payload.htmlBody || payload.htmlBody.trim().length === 0) {
    v.push({ code: 'HTML_BODY_EMPTY', detail: '' });
  }
  if (!payload.subject || payload.subject.trim().length === 0) {
    v.push({ code: 'SUBJECT_REQUIRED', detail: '' });
  }
  if (!payload.to || !payload.to.includes('@')) {
    v.push({ code: 'RECIPIENT_MALFORMED', detail: payload.to ?? '' });
  }

  for (const img of payload.images) {
    if (!img.alt || img.alt.trim().length === 0) {
      v.push({ code: 'IMAGE_MISSING_ALT_TEXT', detail: img.src });
    }
  }

  // the hard gate: a promotional send without an unsubscribe link does not go out
  if (payload.messageClass === 'PROMOTIONAL') {
    if (!payload.unsubscribeUrl || payload.unsubscribeUrl.trim().length === 0) {
      v.push({ code: 'PROMOTIONAL_SEND_REQUIRES_UNSUBSCRIBE_LINK', detail: payload.messageId });
    } else if (!payload.unsubscribeUrl.startsWith('https://')) {
      v.push({ code: 'UNSUBSCRIBE_LINK_MUST_BE_HTTPS', detail: payload.unsubscribeUrl });
    }
  }

  // domain authentication must be complete before anything is sent from it
  if (!domain.spf) v.push({ code: 'SENDING_DOMAIN_MISSING_SPF', detail: domain.domain });
  if (!domain.dkim) v.push({ code: 'SENDING_DOMAIN_MISSING_DKIM', detail: domain.domain });
  if (!domain.dmarc) v.push({ code: 'SENDING_DOMAIN_MISSING_DMARC', detail: domain.domain });

  return v;
}

/** OUTPUTS: the List-Unsubscribe headers a promotional send carries. */
export function listUnsubscribeHeaders(payload: EmailPayload): Record<string, string> {
  if (payload.messageClass !== 'PROMOTIONAL' || !payload.unsubscribeUrl) return {};
  return {
    'List-Unsubscribe': `<${payload.unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ================================================= warm-up

/**
 * RULES: warm-up throttles for a new domain. The cap ramps across the warm-up window so a fresh
 * domain is not judged on a sudden burst.
 */
export function warmupDailyCap(domain: SendingDomain, steadyStateCap: number): number {
  if (domain.ageDays >= WARMUP_DAYS) return steadyStateCap;
  const fraction = Math.max(1, domain.ageDays) / WARMUP_DAYS;
  return Math.max(50, Math.floor(steadyStateCap * fraction));
}

// ================================================= sending

export type SendOutcome =
  | { outcome: 'SENT'; messageId: string; esp: 'PRIMARY' | 'SECONDARY'; headers: Record<string, string> }
  /** ACCEPTANCE: a suppressed send names its reason and is counted. */
  | { outcome: 'SUPPRESSED'; reason: SuppressionReason }
  /** ERRORS: a promo during an outage queues rather than failing over. */
  | { outcome: 'QUEUED'; reason: string }
  | { outcome: 'REJECTED'; violations: Violation[] }
  | { outcome: 'THROTTLED'; dailyCap: number };

export interface SendContext {
  suppression: SuppressionList;
  domain: SendingDomain;
  primaryHealth: EspHealth;
  secondaryHealth: EspHealth;
  steadyStateCap: number;
  sentToday: number;
}

/**
 * Attempt a send. Order matters: validation first (a malformed promo should be fixed, not merely
 * suppressed), then suppression, then throttle, then ESP routing.
 */
export function send(payload: EmailPayload, ctx: SendContext): SendOutcome {
  const violations = validatePayload(payload, ctx.domain);
  if (violations.length > 0) return { outcome: 'REJECTED', violations };

  if (ctx.suppression.isSuppressedFor(payload.to, payload.messageClass)) {
    const entry = ctx.suppression.entry(payload.to)!;
    return { outcome: 'SUPPRESSED', reason: entry.reason };
  }

  // RULES: the warm-up cap applies to promotional volume; transactional mail is expected and
  // never throttled, because a customer is waiting for it.
  if (payload.messageClass === 'PROMOTIONAL') {
    const cap = warmupDailyCap(ctx.domain, ctx.steadyStateCap);
    if (ctx.sentToday >= cap) return { outcome: 'THROTTLED', dailyCap: cap };
  }

  const headers = listUnsubscribeHeaders(payload);

  if (ctx.primaryHealth === 'HEALTHY') {
    return { outcome: 'SENT', messageId: payload.messageId, esp: 'PRIMARY', headers };
  }

  // ERRORS: failover is transactional-only.
  if (payload.messageClass === 'TRANSACTIONAL') {
    if (ctx.secondaryHealth === 'HEALTHY') {
      return { outcome: 'SENT', messageId: payload.messageId, esp: 'SECONDARY', headers };
    }
    return { outcome: 'QUEUED', reason: 'BOTH_ESPS_UNAVAILABLE' };
  }
  return { outcome: 'QUEUED', reason: 'PROMOTIONAL_SENDS_QUEUE_DURING_ESP_OUTAGE' };
}

// ================================================= event processing

export type EventType = 'DELIVERED' | 'OPEN' | 'CLICK' | 'SOFT_BOUNCE' | 'HARD_BOUNCE' | 'COMPLAINT';

export interface EspEvent {
  messageId: string;
  email: string;
  type: EventType;
  atMs: number;
}

export interface EventEffect {
  suppressed: boolean;
  reason?: SuppressionReason;
  /** RULES: a complaint feeds back to the journey so it stops targeting them. */
  journeyFeedback?: 'STOP_TARGETING';
}

/**
 * Process an ESP event. A SOFT bounce is deliberately not suppressed: a full mailbox or a
 * temporary server failure is not a dead address, and suppressing on one would silently lose a
 * customer over a transient condition.
 */
export function processEvent(event: EspEvent, suppression: SuppressionList): EventEffect {
  switch (event.type) {
    case 'HARD_BOUNCE':
      suppression.add(event.email, 'HARD_BOUNCE', event.atMs);
      return { suppressed: true, reason: 'HARD_BOUNCE' };
    case 'COMPLAINT':
      suppression.add(event.email, 'COMPLAINT', event.atMs);
      return { suppressed: true, reason: 'COMPLAINT', journeyFeedback: 'STOP_TARGETING' };
    case 'SOFT_BOUNCE':
    case 'DELIVERED':
    case 'OPEN':
    case 'CLICK':
      return { suppressed: false };
  }
}

/** OUTPUTS: domain-health metrics from the event stream. */
export function domainHealth(events: EspEvent[]):
  { delivered: number; hardBounceRate: number; complaintRate: number; healthy: boolean } {
  const attempted = events.filter((e) =>
    e.type === 'DELIVERED' || e.type === 'HARD_BOUNCE' || e.type === 'SOFT_BOUNCE').length;
  const delivered = events.filter((e) => e.type === 'DELIVERED').length;
  const hard = events.filter((e) => e.type === 'HARD_BOUNCE').length;
  const complaints = events.filter((e) => e.type === 'COMPLAINT').length;

  const hardBounceRate = attempted === 0 ? 0 : Math.round((hard / attempted) * 10_000) / 10_000;
  const complaintRate = delivered === 0 ? 0 : Math.round((complaints / delivered) * 10_000) / 10_000;
  return {
    delivered,
    hardBounceRate,
    complaintRate,
    healthy: hardBounceRate < HARD_BOUNCE_RATE_THRESHOLD && complaintRate < COMPLAINT_RATE_THRESHOLD,
  };
}

// ================================================= security

/**
 * SECURITY: a signed click-tracking link carrying no PII. The message id is opaque and the
 * signature binds the target, so a tampered destination fails verification — and crucially the
 * recipient's address never appears in a URL that will be logged by every hop in between.
 */
export function signClickUrl(baseUrl: string, messageId: string, targetUrl: string, secret: string): string {
  const payload = `${messageId}|${targetUrl}`;
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('hex').slice(0, 32);
  const params = new URLSearchParams({ m: messageId, u: targetUrl, s: sig });
  return `${baseUrl}?${params.toString()}`;
}

export function verifyClickUrl(url: string, secret: string):
  { ok: true; targetUrl: string; messageId: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'URL_MALFORMED' };
  }
  const messageId = parsed.searchParams.get('m');
  const targetUrl = parsed.searchParams.get('u');
  const sig = parsed.searchParams.get('s');
  if (!messageId || !targetUrl || !sig) return { ok: false, reason: 'CLICK_URL_MISSING_PARAMETERS' };

  const expected = createHmac('sha256', secret)
    .update(`${messageId}|${targetUrl}`, 'utf8').digest('hex').slice(0, 32);
  if (expected !== sig) return { ok: false, reason: 'CLICK_URL_SIGNATURE_INVALID' };
  return { ok: true, targetUrl, messageId };
}

/** SECURITY: ESP webhooks are verified before their events are trusted. */
export function verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
