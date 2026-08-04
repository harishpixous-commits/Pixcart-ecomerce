/**
 * Notification decisioning — FR-CUS-022 (Notifications & Preferences).
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "deliver transactional and (consented) promotional notifications over
 *                push, in-app inbox, email, SMS and WhatsApp, honouring per-channel
 *                per-category preferences, quiet hours and legal opt-outs."
 *   RULES:      "Transactional (order/payment/security) cannot be opted out except
 *                channel choice; promotional requires consent (BRU-12); quiet hours
 *                22:00–08:00 local for promos."
 *   VALIDATION: "Template variables complete; DLT template ids for SMS (India);
 *                rate caps per channel/category."
 *   BRU-12:     "Every consent (marketing, personalisation, voice) is individually
 *                recorded, timestamped and revocable."
 *   FR-MKT-004: SMS via registered DLT templates (India), unicode (Tamil) support.
 *
 * Pure and deterministic. This module DECIDES what to send and refuses what policy
 * forbids; actual dispatch is a provider port (SMS/email/WhatsApp/push adapters,
 * provider-agnostic exactly like the AI orchestrator ports). All times are evaluated in
 * the recipient's local timezone (offset supplied); the domain never reads a clock itself.
 */

export type Channel = 'PUSH' | 'INAPP' | 'EMAIL' | 'SMS' | 'WHATSAPP';

/** Message category drives the opt-out and quiet-hours rules. */
export type Category = 'ORDER' | 'PAYMENT' | 'SECURITY' | 'PROMOTIONAL' | 'SHIPPING' | 'REFUND';

/** Transactional categories cannot be opted out (only the channel may be chosen). */
export const TRANSACTIONAL: ReadonlySet<Category> = new Set<Category>([
  'ORDER', 'PAYMENT', 'SECURITY', 'SHIPPING', 'REFUND',
]);

export function isTransactional(c: Category): boolean {
  return TRANSACTIONAL.has(c);
}

/** One recorded, timestamped, revocable consent (BRU-12). */
export interface ConsentRecord {
  category: 'PROMOTIONAL' | 'MARKETING';
  channel: Channel;
  grantedAt: string;   // ISO
  revokedAt?: string;  // ISO; present ⇒ revoked
}

export interface ChannelPreference {
  channel: Channel;
  enabled: boolean;
}

export interface RecipientProfile {
  recipientId: string;
  tzOffsetMinutes: number;            // recipient local offset from UTC
  channelPreferences: ChannelPreference[];
  consents: ConsentRecord[];
  stopList?: Channel[];               // legal opt-out / STOP handling (FR-MKT-004)
}

export interface NotificationRequest {
  notificationId: string;
  recipientId: string;
  category: Category;
  channel: Channel;
  templateId: string;
  /** Template variables; all declared variables must be present (VALIDATION). */
  variables: Record<string, string>;
  /** For SMS to India: the registered DLT template id is mandatory (FR-MKT-004). */
  dltTemplateId?: string;
  /** Event that triggered this (for (topic,eventId) idempotency at the consumer). */
  sourceEventId?: string;
  /** Instant the send is being evaluated (UTC epoch ms). */
  nowMs: number;
}

export type Decision =
  | { send: true }
  | { send: false; reason: string };

/** Quiet hours for promotional messages: 22:00–08:00 recipient-local (RULES). */
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;

export function isWithinQuietHours(nowMs: number, tzOffsetMinutes: number): boolean {
  const localMs = nowMs + tzOffsetMinutes * 60_000;
  const localHour = Math.floor(localMs / 3_600_000) % 24;
  const h = (localHour + 24) % 24;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

function hasActiveConsent(profile: RecipientProfile, channel: Channel): boolean {
  return profile.consents.some(
    (c) => c.channel === channel && c.revokedAt === undefined,
  );
}

function channelEnabled(profile: RecipientProfile, channel: Channel): boolean {
  const pref = profile.channelPreferences.find((p) => p.channel === channel);
  return pref ? pref.enabled : true; // default-on unless explicitly disabled
}

/** Declared {{var}} tokens must all be provided (VALIDATION: template variables complete). */
export function missingTemplateVariables(templateBody: string, variables: Record<string, string>): string[] {
  const declared = [...templateBody.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(declared)].filter((name) => !(name in variables) || variables[name] === '');
}

/**
 * The core policy gate. Returns whether the notification may be sent, with a reason when
 * refused. Order of checks encodes the doc's precedence:
 *   1. legal opt-out / STOP always wins (even transactional respects a channel STOP by
 *      falling back — here we refuse the STOPPED channel; the service picks another);
 *   2. transactional: cannot be opted out, but the channel must be enabled and, for SMS to
 *      India, carry a DLT template id;
 *   3. promotional: requires active consent (BRU-12) AND must be outside quiet hours.
 */
export function decide(req: NotificationRequest, profile: RecipientProfile): Decision {
  if ((profile.stopList ?? []).includes(req.channel)) {
    return { send: false, reason: `CHANNEL_STOPPED: ${req.channel} (legal opt-out)` };
  }

  // SMS to India requires a registered DLT template id (FR-MKT-004 / VALIDATION).
  if (req.channel === 'SMS' && !req.dltTemplateId) {
    return { send: false, reason: 'DLT_TEMPLATE_ID_REQUIRED for SMS (India)' };
  }

  if (isTransactional(req.category)) {
    if (!channelEnabled(profile, req.channel)) {
      return { send: false, reason: `CHANNEL_DISABLED: ${req.channel} (choose another for transactional)` };
    }
    return { send: true };
  }

  // Promotional path.
  if (!hasActiveConsent(profile, req.channel)) {
    return { send: false, reason: `NO_CONSENT for promotional on ${req.channel} (BRU-12)` };
  }
  if (!channelEnabled(profile, req.channel)) {
    return { send: false, reason: `CHANNEL_DISABLED: ${req.channel}` };
  }
  if (isWithinQuietHours(req.nowMs, profile.tzOffsetMinutes)) {
    return { send: false, reason: 'QUIET_HOURS (22:00–08:00 local, promotional)' };
  }
  return { send: true };
}
