/**
 * Push notification channel — FR-MKT-005.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "deliver push via FCM/APNs with token lifecycle management, rich payloads (image,
 *                actions, deep links), topic and segment targeting, collapse keys for updates, and
 *                per-device quiet-hour evaluation."
 *   INPUTS:     "Device tokens (register/refresh/invalidate), payload templates, targeting sets."
 *   OUTPUTS:    "Deliveries with receipt events (where OS provides), open/deep-link analytics,
 *                token-hygiene reports."
 *   VALIDATION: "Payload size limits; deep links validated against route registry; image URLs
 *                CDN-hosted."
 *   RULES:      "Order-status pushes use collapse keys (latest state wins); token invalid feedback
 *                prunes within 24 h; per-app-version capability gating."
 *   ERRORS:     "FCM/APNs partial outage → retry with jitter; oversized image → auto-fallback to
 *                text-only."
 *   SECURITY:   "No sensitive PII in payloads (fetch-on-open pattern for details); tokens [held
 *                securely]."
 *
 * QUIET HOURS AND CONSENT ARE NOT REIMPLEMENTED HERE. The FR-CUS-022 policy engine in
 * notification-svc already owns those decisions, and duplicating them would create two places for
 * the same rule to drift — this module consumes that decision and refuses to send when it says no.
 * The requirement's "per-device quiet-hour evaluation" is satisfied by passing each device's own
 * timezone offset into that engine, which is where the per-device part actually lives.
 *
 * Two properties are worth stating plainly:
 *
 *  1. A DEEP LINK MUST RESOLVE AGAINST THE ROUTE REGISTRY. An unregistered route is refused, not
 *     sent hopefully. A push whose link lands nowhere is worse than no push: the customer has been
 *     interrupted and then failed.
 *
 *  2. NO SENSITIVE DETAIL TRAVELS IN THE PAYLOAD. Push payloads pass through Google's and Apple's
 *     infrastructure and sit in OS notification logs, so the body carries a reference and the app
 *     fetches the detail on open. The validator refuses a payload carrying an order total, an
 *     address or a contact detail.
 */
import {
  decide,
  isWithinQuietHours,
  QUIET_END_HOUR,
  type Category,
  type NotificationRequest,
  type RecipientProfile,
} from '../../../../notification-svc/src/domain/policy.js';

/** VALIDATION: FCM's documented data payload ceiling. */
export const MAX_PAYLOAD_BYTES = 4 * 1024;
/** VALIDATION: an image beyond this falls back to text-only rather than failing. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** RULES: invalid-token feedback must be acted on within this window. */
export const TOKEN_PRUNE_WINDOW_MS = 24 * 3600 * 1000;
/** ERRORS: retry backoff base and jitter ceiling. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_ATTEMPTS = 5;

export type Platform = 'FCM' | 'APNS';

export type TokenState = 'ACTIVE' | 'STALE' | 'INVALID';

export interface DeviceToken {
  token: string;
  customerId: string;
  platform: Platform;
  /** Per-device timezone offset, which is what makes quiet hours per-device. */
  tzOffsetMinutes: number;
  appVersion: string;
  registeredAtMs: number;
  lastSeenAtMs: number;
  state: TokenState;
  invalidatedAtMs?: number;
}

/** VALIDATION: the route registry a deep link must resolve against. */
export type RouteRegistry = ReadonlySet<string>;

export const DEFAULT_ROUTES: RouteRegistry = new Set([
  'pixcart://order/{orderId}',
  'pixcart://order/{orderId}/track',
  'pixcart://product/{listingId}',
  'pixcart://cart',
  'pixcart://wishlist',
  'pixcart://returns/{rmaId}',
  'pixcart://support/ticket/{ticketId}',
  'pixcart://offers',
  'pixcart://store/{slug}',
]);

export interface PushAction {
  id: string;
  label: string;
  deepLink: string;
}

export interface PushPayload {
  messageId: string;
  category: Category;
  title: string;
  body: string;
  deepLink: string;
  /** Rich payload extras, subject to capability gating. */
  imageUrl?: string;
  imageBytes?: number;
  actions?: PushAction[];
  /** RULES: order-status pushes collapse so the latest state wins. */
  collapseKey?: string;
  /** SECURITY: the reference the app uses to fetch detail on open. */
  detailRef?: string;
}

export interface Violation {
  code: string;
  detail: string;
}

/** RULES: per-app-version capability gating. */
export interface Capabilities {
  richImage: boolean;
  actionButtons: boolean;
  collapseKeys: boolean;
}

/** A crude but honest semantic-version comparison for capability gating. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * RULES: capability gating by app version. An older client that cannot render an action button
 * must receive a payload without one rather than a payload it will silently drop half of.
 */
export function capabilitiesFor(appVersion: string): Capabilities {
  return {
    richImage: compareVersions(appVersion, '3.0.0') >= 0,
    actionButtons: compareVersions(appVersion, '3.4.0') >= 0,
    collapseKeys: compareVersions(appVersion, '2.8.0') >= 0,
  };
}

// ================================================= deep links & PII

/** Does a concrete link match a registered route template? */
export function isRegisteredRoute(link: string, registry: RouteRegistry): boolean {
  for (const template of registry) {
    const pattern = '^' + template
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{[a-zA-Z]+\\\}/g, '[A-Za-z0-9_-]+') + '$';
    if (new RegExp(pattern).test(link)) return true;
  }
  return false;
}

/**
 * SECURITY: patterns that must not appear in a push payload. A push traverses Google's and
 * Apple's infrastructure and lands in an OS notification log, so a payload is the wrong place for
 * an amount, an address or a contact detail.
 */
const PII_IN_PAYLOAD_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'PAYLOAD_CONTAINS_EMAIL', re: /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/u },
  { code: 'PAYLOAD_CONTAINS_PHONE', re: /(?:\+?\d[\d\s-]{8,}\d)/ },
  { code: 'PAYLOAD_CONTAINS_AMOUNT', re: /(?:₹|Rs\.?\s?|INR\s?)\s?\d/i },
  { code: 'PAYLOAD_CONTAINS_CARD_TAIL', re: /\b(?:ending|xxxx)\s?\d{4}\b/i },
  { code: 'PAYLOAD_CONTAINS_PINCODE', re: /\b[1-9]\d{5}\b/ },
];

export function piiInPayload(payload: PushPayload): Violation[] {
  const text = `${payload.title} ${payload.body} ${(payload.actions ?? []).map((a) => a.label).join(' ')}`;
  const out: Violation[] = [];
  for (const p of PII_IN_PAYLOAD_PATTERNS) {
    if (p.re.test(text)) out.push({ code: p.code, detail: '' });
  }
  return out;
}

export function payloadBytes(payload: PushPayload): number {
  return Buffer.byteLength(JSON.stringify({
    title: payload.title,
    body: payload.body,
    deepLink: payload.deepLink,
    imageUrl: payload.imageUrl,
    actions: payload.actions,
    collapseKey: payload.collapseKey,
    detailRef: payload.detailRef,
  }), 'utf8');
}

/** VALIDATION: an image must be CDN-hosted, so it cannot be a tracking pixel or an arbitrary host. */
export function isCdnHosted(url: string, cdnHosts: ReadonlySet<string>): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && cdnHosts.has(parsed.host);
  } catch {
    return false;
  }
}

export interface ValidationContext {
  routes: RouteRegistry;
  cdnHosts: ReadonlySet<string>;
  capabilities: Capabilities;
}

export function validatePayload(payload: PushPayload, ctx: ValidationContext): Violation[] {
  const v: Violation[] = [];

  if (!payload.title || payload.title.trim().length === 0) {
    v.push({ code: 'TITLE_REQUIRED', detail: '' });
  }
  if (!payload.body || payload.body.trim().length === 0) {
    v.push({ code: 'BODY_REQUIRED', detail: '' });
  }

  if (!isRegisteredRoute(payload.deepLink, ctx.routes)) {
    v.push({ code: 'DEEP_LINK_NOT_IN_ROUTE_REGISTRY', detail: payload.deepLink });
  }
  for (const action of payload.actions ?? []) {
    if (!isRegisteredRoute(action.deepLink, ctx.routes)) {
      v.push({ code: 'ACTION_DEEP_LINK_NOT_IN_ROUTE_REGISTRY', detail: action.deepLink });
    }
  }

  if (payload.imageUrl !== undefined && !isCdnHosted(payload.imageUrl, ctx.cdnHosts)) {
    v.push({ code: 'IMAGE_URL_NOT_CDN_HOSTED', detail: payload.imageUrl });
  }

  const bytes = payloadBytes(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    v.push({ code: `PAYLOAD_EXCEEDS_${MAX_PAYLOAD_BYTES}_BYTES`, detail: `${bytes} bytes` });
  }

  v.push(...piiInPayload(payload));
  return v;
}

// ================================================= adaptation

export interface AdaptedPayload extends PushPayload {
  /** ERRORS: set when an oversized image was dropped in favour of text-only. */
  imageDroppedReason?: string;
  /** RULES: set when a capability the payload wanted is unavailable on this app version. */
  capabilitiesStripped: string[];
}

/**
 * Adapt a payload to a device. ERRORS: an oversized image AUTO-FALLS-BACK to text-only rather than
 * failing the send — the customer still gets told their order shipped. RULES: capabilities the
 * client cannot render are stripped rather than sent and silently dropped.
 */
export function adaptForDevice(payload: PushPayload, capabilities: Capabilities): AdaptedPayload {
  const stripped: string[] = [];
  let imageUrl = payload.imageUrl;
  let imageDroppedReason: string | undefined;
  let actions = payload.actions;
  let collapseKey = payload.collapseKey;

  if (imageUrl !== undefined && payload.imageBytes !== undefined && payload.imageBytes > MAX_IMAGE_BYTES) {
    imageUrl = undefined;
    imageDroppedReason = `IMAGE_EXCEEDS_${MAX_IMAGE_BYTES}_BYTES_FALLBACK_TO_TEXT`;
  }
  if (imageUrl !== undefined && !capabilities.richImage) {
    imageUrl = undefined;
    stripped.push('richImage');
  }
  if (actions !== undefined && actions.length > 0 && !capabilities.actionButtons) {
    actions = undefined;
    stripped.push('actionButtons');
  }
  if (collapseKey !== undefined && !capabilities.collapseKeys) {
    collapseKey = undefined;
    stripped.push('collapseKeys');
  }

  return {
    ...payload,
    imageUrl,
    actions,
    collapseKey,
    imageDroppedReason,
    capabilitiesStripped: stripped,
  };
}

// ================================================= token lifecycle

export interface TokenHygieneReport {
  active: number;
  stale: number;
  invalid: number;
  awaitingPrune: number;
  /** RULES: true when an invalid token has sat unpruned beyond 24 hours. */
  pruneSlaBreached: boolean;
}

export class TokenRegistry {
  private readonly tokens = new Map<string, DeviceToken>();

  register(token: DeviceToken): void {
    const existing = this.tokens.get(token.token);
    // a re-registration refreshes rather than duplicating
    this.tokens.set(token.token, { ...(existing ?? token), ...token, state: 'ACTIVE' });
  }

  /** A refresh replaces an old token with a new one for the same device. */
  refresh(oldToken: string, newToken: string, nowMs: number): { ok: boolean; reason?: string } {
    const existing = this.tokens.get(oldToken);
    if (!existing) return { ok: false, reason: 'UNKNOWN_TOKEN' };
    this.tokens.delete(oldToken);
    this.tokens.set(newToken, {
      ...existing, token: newToken, lastSeenAtMs: nowMs, state: 'ACTIVE', invalidatedAtMs: undefined,
    });
    return { ok: true };
  }

  /** RULES: invalid-token feedback from FCM/APNs marks the token for pruning. */
  markInvalid(token: string, nowMs: number): boolean {
    const t = this.tokens.get(token);
    if (!t) return false;
    this.tokens.set(token, { ...t, state: 'INVALID', invalidatedAtMs: nowMs });
    return true;
  }

  /** RULES: prune within 24 hours of the invalid feedback. */
  prune(nowMs: number): string[] {
    const pruned: string[] = [];
    for (const [key, t] of this.tokens) {
      if (t.state === 'INVALID') {
        this.tokens.delete(key);
        pruned.push(key);
      }
    }
    return pruned;
  }

  hygiene(nowMs: number): TokenHygieneReport {
    let active = 0;
    let stale = 0;
    let invalid = 0;
    let awaitingPrune = 0;
    let breached = false;
    for (const t of this.tokens.values()) {
      if (t.state === 'ACTIVE') active++;
      else if (t.state === 'STALE') stale++;
      else {
        invalid++;
        awaitingPrune++;
        if (t.invalidatedAtMs !== undefined && nowMs - t.invalidatedAtMs > TOKEN_PRUNE_WINDOW_MS) {
          breached = true;
        }
      }
    }
    return { active, stale, invalid, awaitingPrune, pruneSlaBreached: breached };
  }

  token(token: string): DeviceToken | undefined {
    return this.tokens.get(token);
  }

  activeFor(customerId: string): DeviceToken[] {
    return [...this.tokens.values()].filter((t) => t.customerId === customerId && t.state === 'ACTIVE');
  }

  size(): number {
    return this.tokens.size;
  }
}

// ================================================= collapse keys

/**
 * RULES: order-status pushes collapse so the latest state wins. The key is the order, so a
 * superseded status never lands on a lock screen after the newer one.
 */
export function orderStatusCollapseKey(orderId: string): string {
  return `order-status:${orderId}`;
}

export interface CollapseDecision {
  send: boolean;
  supersedes?: string;
  reason?: string;
}

/**
 * Decide whether a collapsing push should go out, given what is already pending for that key.
 * A newer state supersedes an older; an OLDER state arriving late is dropped, because delivering
 * "packed" after "delivered" would actively misinform.
 */
export function collapseDecision(
  collapseKey: string,
  sequence: number,
  pending: Map<string, { messageId: string; sequence: number }>,
): CollapseDecision {
  const current = pending.get(collapseKey);
  if (!current) return { send: true };
  if (sequence > current.sequence) {
    return { send: true, supersedes: current.messageId };
  }
  return { send: false, reason: 'SUPERSEDED_BY_NEWER_STATE' };
}

// ================================================= sending

export type SendOutcome =
  | { outcome: 'SENT'; payload: AdaptedPayload; platform: Platform }
  | { outcome: 'REJECTED'; violations: Violation[] }
  /** Consent, stop-list or channel preference, as decided by the FR-CUS-022 policy engine. */
  | { outcome: 'SUPPRESSED_BY_POLICY'; reason: string }
  /** Quiet hours: held rather than dropped, because the message is still wanted later. */
  | { outcome: 'DEFERRED'; sendAfterMs: number; reason: string }
  | { outcome: 'DROPPED'; reason: string };

export interface PushSendContext {
  routes: RouteRegistry;
  cdnHosts: ReadonlySet<string>;
  profile: RecipientProfile;
  templateId: string;
  nowMs: number;
}

/** The next instant a device leaves its own quiet window, in UTC epoch ms. */
export function quietHoursEndMs(device: DeviceToken, nowMs: number): number {
  const offset = device.tzOffsetMinutes * 60_000;
  const localMs = nowMs + offset;
  const localDayStart = Math.floor(localMs / 86_400_000) * 86_400_000;
  const localHour = Math.floor((localMs - localDayStart) / 3_600_000);
  // if it is already past midnight but before the window closes, today's close; else tomorrow's
  const closeLocal = localHour < QUIET_END_HOUR
    ? localDayStart + QUIET_END_HOUR * 3_600_000
    : localDayStart + 86_400_000 + QUIET_END_HOUR * 3_600_000;
  return closeLocal - offset;
}

/**
 * Send to one device. Consent and quiet hours are DELEGATED to the FR-CUS-022 policy engine, with
 * the DEVICE's timezone offset supplied — that is where "per-device quiet-hour evaluation" lives.
 * A quiet-hours refusal becomes a DEFERRAL rather than a drop, because the customer still wants
 * the message, just not at 2 a.m.
 */
export function sendToDevice(payload: PushPayload, device: DeviceToken, ctx: PushSendContext): SendOutcome {
  if (device.state !== 'ACTIVE') {
    return { outcome: 'DROPPED', reason: `TOKEN_${device.state}` };
  }

  const capabilities = capabilitiesFor(device.appVersion);
  const violations = validatePayload(payload, { routes: ctx.routes, cdnHosts: ctx.cdnHosts, capabilities });
  if (violations.length > 0) return { outcome: 'REJECTED', violations };

  const request: NotificationRequest = {
    notificationId: payload.messageId,
    recipientId: device.customerId,
    category: payload.category,
    channel: 'PUSH',
    templateId: ctx.templateId,
    variables: {},
    nowMs: ctx.nowMs,
  };

  // the device's own offset is what makes the quiet-hour evaluation per-device
  const profileForDevice: RecipientProfile = {
    ...ctx.profile,
    tzOffsetMinutes: device.tzOffsetMinutes,
  };
  const policy = decide(request, profileForDevice);

  if (policy.send) {
    return { outcome: 'SENT', payload: adaptForDevice(payload, capabilities), platform: device.platform };
  }
  if (policy.reason.startsWith('QUIET_HOURS')) {
    return {
      outcome: 'DEFERRED',
      sendAfterMs: quietHoursEndMs(device, ctx.nowMs),
      reason: policy.reason,
    };
  }
  return { outcome: 'SUPPRESSED_BY_POLICY', reason: policy.reason };
}

/** Whether a device is currently inside its own quiet window — the per-device evaluation. */
export function deviceInQuietHours(device: DeviceToken, nowMs: number): boolean {
  return isWithinQuietHours(nowMs, device.tzOffsetMinutes);
}

// ================================================= retry with jitter

/**
 * ERRORS: a partial FCM/APNs outage retries with exponential backoff plus jitter. The jitter is
 * essential rather than cosmetic: without it every queued push retries in the same instant and
 * the recovering provider is hit by a thundering herd.
 */
export function retryDelayMs(attempt: number, jitterFraction: number): number | null {
  if (attempt < 1 || attempt > RETRY_MAX_ATTEMPTS) return null;
  const base = RETRY_BASE_MS * 2 ** (attempt - 1);
  const clamped = Math.min(1, Math.max(0, jitterFraction));
  return Math.round(base * (0.5 + clamped * 0.5));
}
