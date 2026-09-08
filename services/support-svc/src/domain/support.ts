/**
 * Customer support & help centre — FR-CUS-026.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "provide a help centre (searchable policies/FAQs), assisted contact
 *                (assistant-first with FR-CUS-008), ticketing with order context, live-chat
 *                hand-off, and grievance-officer escalation per e-commerce rules."
 *   INPUTS:     "Issue category, order reference (optional but prompted), description,
 *                attachments."
 *   OUTPUTS:    "Ticket id with SLA clock, status timeline, resolution record with CSAT prompt,
 *                grievance escalation trail."
 *   VALIDATION: "Category from taxonomy; attachments scanned; duplicate-ticket detection offers
 *                append."
 *   RULES:      "SLA matrix: payment issues first-response 2 h; order issues 4 h; general 24 h;
 *                grievance officer response ≤ 48 h (published); assistant hand-off transfers full
 *                transcript + consent."
 *   ERRORS:     "SLA breach → auto-escalate tier + notify duty manager; attachment fail → ticket
 *                still created with ret[ry]."
 *
 * This closes a dangling reference: the FR-AI-002 tool registry has offered
 * `create_support_ticket` to the assistant since Slice 41, but no ticket domain existed behind it.
 *
 * Two behaviours here are deliberate and worth stating, because the convenient implementation of
 * each is wrong:
 *
 *  1. AN ATTACHMENT FAILURE NEVER BLOCKS TICKET CREATION. A customer whose photo upload fails is
 *     still a customer with a problem, and refusing the ticket until the upload succeeds is how a
 *     complaint becomes an abandonment. The ticket is created, the failure is recorded, and a
 *     retry is offered against the existing ticket.
 *
 *  2. AN ASSISTANT HAND-OFF REQUIRES CONSENT AND CARRIES THE FULL TRANSCRIPT. Consent, because
 *     moving a conversation to a human is a disclosure the customer should agree to; the full
 *     transcript, because handing over a summary makes the customer repeat themselves, which is
 *     the single most common complaint about assisted support.
 */

/** VALIDATION: the issue taxonomy. A category outside it is refused. */
export type Category =
  | 'PAYMENT'
  | 'ORDER'
  | 'RETURN_REFUND'
  | 'ACCOUNT'
  | 'PRODUCT_QUALITY'
  | 'GENERAL'
  | 'GRIEVANCE';

export const CATEGORY_TAXONOMY: ReadonlySet<Category> = new Set<Category>([
  'PAYMENT', 'ORDER', 'RETURN_REFUND', 'ACCOUNT', 'PRODUCT_QUALITY', 'GENERAL', 'GRIEVANCE',
]);

const HOUR = 3_600_000;

/**
 * RULES: the published SLA matrix. Payment issues are tightest because the customer's money is
 * already gone; general enquiries are loosest because nothing is at stake while they wait.
 */
export const FIRST_RESPONSE_SLA_MS: Readonly<Record<Category, number>> = {
  PAYMENT: 2 * HOUR,
  ORDER: 4 * HOUR,
  RETURN_REFUND: 4 * HOUR,
  PRODUCT_QUALITY: 4 * HOUR,
  ACCOUNT: 24 * HOUR,
  GENERAL: 24 * HOUR,
  /** RULES: the grievance officer's published response window. */
  GRIEVANCE: 48 * HOUR,
};

/** Categories where an order reference is prompted for, because context is usually essential. */
export const ORDER_REF_PROMPTED: ReadonlySet<Category> = new Set<Category>([
  'PAYMENT', 'ORDER', 'RETURN_REFUND', 'PRODUCT_QUALITY',
]);

export type Tier = 'TIER_1' | 'TIER_2' | 'GRIEVANCE_OFFICER';

export type TicketState = 'OPEN' | 'AWAITING_CUSTOMER' | 'ESCALATED' | 'RESOLVED' | 'CLOSED';

export type ScanResult = 'CLEAN' | 'INFECTED' | 'SCAN_FAILED' | 'UPLOAD_FAILED';

export interface Attachment {
  ref: string;
  filename: string;
  scanResult: ScanResult;
}

export interface TimelineEntry {
  atMs: number;
  actor: string;
  action: string;
  detail: string;
}

/** RULES: the assistant hand-off payload. */
export interface AssistantTranscript {
  sessionId: string;
  /** Every turn, in order — not a summary. */
  turns: Array<{ role: 'CUSTOMER' | 'ASSISTANT'; text: string; atMs: number }>;
}

export interface TicketDraft {
  ticketId: string;
  customerId: string;
  category: Category;
  description: string;
  orderRef?: string;
  attachments: Attachment[];
  /** Set when the assistant escalated this to a human. */
  assistantSessionId?: string;
}

export interface Ticket {
  ticketId: string;
  customerId: string;
  category: Category;
  description: string;
  orderRef?: string;
  createdAtMs: number;
  state: TicketState;
  tier: Tier;
  /** OUTPUTS: the SLA clock. */
  firstResponseDueAtMs: number;
  firstRespondedAtMs?: number;
  /** Attachments that scanned clean and are attached. */
  attachments: Attachment[];
  /** ERRORS: attachments that failed, retryable against this ticket. */
  failedAttachments: Attachment[];
  timeline: TimelineEntry[];
  transcript?: AssistantTranscript;
  resolution?: { atMs: number; agentId: string; summary: string; csatPromptSent: boolean };
  dutyManagerNotified: boolean;
}

export interface Violation {
  code: string;
  detail: string;
}

export type CreateResult =
  | { outcome: 'CREATED'; ticket: Ticket; retryableAttachments: Attachment[]; orderRefPrompted: boolean }
  /** VALIDATION: duplicate detection offers an append rather than a second ticket. */
  | { outcome: 'APPEND_SUGGESTED'; existingTicketId: string; reason: string }
  | { outcome: 'REJECTED'; violations: Violation[] };

/** Window within which a similar ticket is treated as a duplicate. */
export const DUPLICATE_WINDOW_MS = 24 * HOUR;

function isOpenState(state: TicketState): boolean {
  return state === 'OPEN' || state === 'AWAITING_CUSTOMER' || state === 'ESCALATED';
}

/**
 * VALIDATION: duplicate-ticket detection. A second ticket about the same order in the same
 * category, while the first is still open, fragments the history across two SLA clocks and two
 * agents — so an append is offered instead.
 */
export function findDuplicate(draft: TicketDraft, existing: Ticket[], nowMs: number): Ticket | undefined {
  return existing.find((t) =>
    t.customerId === draft.customerId
    && t.category === draft.category
    && isOpenState(t.state)
    && nowMs - t.createdAtMs <= DUPLICATE_WINDOW_MS
    // an order reference makes the match definite; without one, category alone is enough
    && (draft.orderRef === undefined || t.orderRef === draft.orderRef));
}

export class SupportDesk {
  private readonly tickets = new Map<string, Ticket>();

  /**
   * Create a ticket. An attachment that failed to upload or scan does NOT prevent creation — the
   * ticket is created, the failure recorded, and a retry offered.
   */
  create(draft: TicketDraft, nowMs: number): CreateResult {
    const violations: Violation[] = [];

    if (!CATEGORY_TAXONOMY.has(draft.category)) {
      violations.push({ code: 'CATEGORY_NOT_IN_TAXONOMY', detail: String(draft.category) });
    }
    if (!draft.description || draft.description.trim().length < 10) {
      violations.push({ code: 'DESCRIPTION_TOO_SHORT', detail: '' });
    }
    if (!draft.customerId || draft.customerId.trim().length === 0) {
      violations.push({ code: 'CUSTOMER_REQUIRED', detail: '' });
    }
    if (this.tickets.has(draft.ticketId)) {
      violations.push({ code: 'TICKET_ID_ALREADY_USED', detail: draft.ticketId });
    }
    // an INFECTED attachment is a refusal, unlike a failed one: we will not hold malware
    for (const a of draft.attachments) {
      if (a.scanResult === 'INFECTED') {
        violations.push({ code: 'ATTACHMENT_FAILED_MALWARE_SCAN', detail: a.filename });
      }
    }
    if (violations.length > 0) return { outcome: 'REJECTED', violations };

    const duplicate = findDuplicate(draft, [...this.tickets.values()], nowMs);
    if (duplicate) {
      return {
        outcome: 'APPEND_SUGGESTED',
        existingTicketId: duplicate.ticketId,
        reason: `An open ${draft.category} ticket already exists`
          + (duplicate.orderRef ? ` for order ${duplicate.orderRef}` : ''),
      };
    }

    const clean = draft.attachments.filter((a) => a.scanResult === 'CLEAN');
    const failed = draft.attachments.filter(
      (a) => a.scanResult === 'SCAN_FAILED' || a.scanResult === 'UPLOAD_FAILED');

    const ticket: Ticket = {
      ticketId: draft.ticketId,
      customerId: draft.customerId,
      category: draft.category,
      description: draft.description,
      orderRef: draft.orderRef,
      createdAtMs: nowMs,
      state: 'OPEN',
      tier: draft.category === 'GRIEVANCE' ? 'GRIEVANCE_OFFICER' : 'TIER_1',
      firstResponseDueAtMs: nowMs + FIRST_RESPONSE_SLA_MS[draft.category],
      attachments: clean,
      failedAttachments: failed,
      timeline: [{
        atMs: nowMs,
        actor: draft.customerId,
        action: 'CREATED',
        detail: `${draft.category}${draft.orderRef ? ` order=${draft.orderRef}` : ''}`,
      }],
      dutyManagerNotified: false,
    };

    if (failed.length > 0) {
      ticket.timeline.push({
        atMs: nowMs,
        actor: 'SYSTEM',
        action: 'ATTACHMENT_FAILED',
        detail: `${failed.length} attachment(s) failed; retry available on this ticket`,
      });
    }

    this.tickets.set(ticket.ticketId, ticket);
    return {
      outcome: 'CREATED',
      ticket,
      retryableAttachments: failed,
      // INPUTS: the order reference is "optional but prompted"
      orderRefPrompted: ORDER_REF_PROMPTED.has(draft.category) && draft.orderRef === undefined,
    };
  }

  /** VALIDATION: append to the existing ticket the duplicate check pointed at. */
  append(ticketId: string, actorId: string, text: string, nowMs: number):
    { ok: true; ticket: Ticket } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (!isOpenState(t.state)) return { ok: false, reason: `TICKET_NOT_OPEN: ${t.state}` };
    if (!text || text.trim().length === 0) return { ok: false, reason: 'TEXT_REQUIRED' };
    t.timeline.push({ atMs: nowMs, actor: actorId, action: 'APPENDED', detail: text });
    // a customer reply re-opens a ticket that was waiting on them
    if (t.state === 'AWAITING_CUSTOMER' && actorId === t.customerId) t.state = 'OPEN';
    return { ok: true, ticket: t };
  }

  /** ERRORS: retry a failed attachment against the existing ticket. */
  retryAttachment(ticketId: string, attachment: Attachment, nowMs: number):
    { ok: true } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (attachment.scanResult === 'INFECTED') return { ok: false, reason: 'ATTACHMENT_FAILED_MALWARE_SCAN' };
    if (attachment.scanResult !== 'CLEAN') return { ok: false, reason: 'ATTACHMENT_STILL_FAILING' };
    t.failedAttachments = t.failedAttachments.filter((a) => a.ref !== attachment.ref);
    t.attachments.push(attachment);
    t.timeline.push({ atMs: nowMs, actor: t.customerId, action: 'ATTACHMENT_RETRY_SUCCEEDED', detail: attachment.filename });
    return { ok: true };
  }

  // ------------------------------------------------------------- SLA

  /** OUTPUTS: the SLA clock stops at first response, not at resolution. */
  recordFirstResponse(ticketId: string, agentId: string, nowMs: number):
    { ok: true; withinSla: boolean } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (t.firstRespondedAtMs !== undefined) return { ok: false, reason: 'FIRST_RESPONSE_ALREADY_RECORDED' };
    t.firstRespondedAtMs = nowMs;
    const withinSla = nowMs <= t.firstResponseDueAtMs;
    t.timeline.push({
      atMs: nowMs, actor: agentId, action: 'FIRST_RESPONSE',
      detail: withinSla ? 'within SLA' : 'SLA BREACHED',
    });
    return { ok: true, withinSla };
  }

  isFirstResponseBreached(ticketId: string, nowMs: number): boolean {
    const t = this.tickets.get(ticketId);
    if (!t) return false;
    if (t.state === 'RESOLVED' || t.state === 'CLOSED') return false;
    if (t.firstRespondedAtMs !== undefined) return t.firstRespondedAtMs > t.firstResponseDueAtMs;
    return nowMs > t.firstResponseDueAtMs;
  }

  /**
   * ERRORS: an SLA breach auto-escalates the tier AND notifies the duty manager. Both, because
   * escalating without telling anyone just moves the ticket to a different queue to be missed in.
   */
  escalateOnBreach(ticketId: string, nowMs: number):
    { escalated: boolean; tier?: Tier; dutyManagerNotified?: boolean; reason?: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { escalated: false, reason: 'UNKNOWN_TICKET' };
    if (!this.isFirstResponseBreached(ticketId, nowMs)) {
      return { escalated: false, reason: 'SLA_NOT_BREACHED' };
    }
    const next: Tier = t.tier === 'TIER_1' ? 'TIER_2'
      : t.tier === 'TIER_2' ? 'GRIEVANCE_OFFICER' : 'GRIEVANCE_OFFICER';
    const changed = next !== t.tier;
    t.tier = next;
    t.state = 'ESCALATED';
    t.dutyManagerNotified = true;
    t.timeline.push({
      atMs: nowMs, actor: 'SYSTEM', action: 'SLA_BREACH_ESCALATION',
      detail: `tier=${next}; duty manager notified`,
    });
    return { escalated: changed || true, tier: next, dutyManagerNotified: true };
  }

  /** RULES: explicit escalation to the grievance officer, per e-commerce rules. */
  escalateToGrievanceOfficer(ticketId: string, reason: string, nowMs: number):
    { ok: true; responseDueAtMs: number } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (!reason || reason.trim().length < 5) return { ok: false, reason: 'ESCALATION_REASON_REQUIRED' };
    t.tier = 'GRIEVANCE_OFFICER';
    t.state = 'ESCALATED';
    // the grievance clock is its own published window, restarted from the escalation
    t.firstResponseDueAtMs = nowMs + FIRST_RESPONSE_SLA_MS.GRIEVANCE;
    t.firstRespondedAtMs = undefined;
    t.timeline.push({ atMs: nowMs, actor: 'SYSTEM', action: 'GRIEVANCE_ESCALATION', detail: reason });
    return { ok: true, responseDueAtMs: t.firstResponseDueAtMs };
  }

  // ------------------------------------------------------------- assistant hand-off

  /**
   * RULES: the assistant hand-off transfers the full transcript AND requires consent. A hand-off
   * without consent is refused; a hand-off carrying an empty transcript is refused too, because
   * the point is that the customer does not repeat themselves.
   */
  handOffFromAssistant(ticketId: string, transcript: AssistantTranscript, consentGiven: boolean,
                       nowMs: number): { ok: true; turnsTransferred: number } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (!consentGiven) return { ok: false, reason: 'HAND_OFF_REQUIRES_CUSTOMER_CONSENT' };
    if (transcript.turns.length === 0) return { ok: false, reason: 'TRANSCRIPT_EMPTY' };

    t.transcript = {
      sessionId: transcript.sessionId,
      turns: [...transcript.turns].sort((a, b) => a.atMs - b.atMs),
    };
    t.timeline.push({
      atMs: nowMs, actor: 'ASSISTANT', action: 'HAND_OFF',
      detail: `${transcript.turns.length} turns transferred with consent`,
    });
    return { ok: true, turnsTransferred: transcript.turns.length };
  }

  // ------------------------------------------------------------- resolution

  /** OUTPUTS: a resolution record with a CSAT prompt. */
  resolve(ticketId: string, agentId: string, summary: string, nowMs: number):
    { ok: true; csatPromptSent: boolean } | { ok: false; reason: string } {
    const t = this.tickets.get(ticketId);
    if (!t) return { ok: false, reason: 'UNKNOWN_TICKET' };
    if (t.state === 'RESOLVED' || t.state === 'CLOSED') return { ok: false, reason: `ALREADY_${t.state}` };
    if (!summary || summary.trim().length < 5) return { ok: false, reason: 'RESOLUTION_SUMMARY_REQUIRED' };
    t.state = 'RESOLVED';
    t.resolution = { atMs: nowMs, agentId, summary, csatPromptSent: true };
    t.timeline.push({ atMs: nowMs, actor: agentId, action: 'RESOLVED', detail: summary });
    return { ok: true, csatPromptSent: true };
  }

  awaitCustomer(ticketId: string, agentId: string, nowMs: number): boolean {
    const t = this.tickets.get(ticketId);
    if (!t || !isOpenState(t.state)) return false;
    t.state = 'AWAITING_CUSTOMER';
    t.timeline.push({ atMs: nowMs, actor: agentId, action: 'AWAITING_CUSTOMER', detail: '' });
    return true;
  }

  ticket(ticketId: string): Ticket | undefined {
    return this.tickets.get(ticketId);
  }

  openTickets(): Ticket[] {
    return [...this.tickets.values()].filter((t) => isOpenState(t.state));
  }
}

// ================================================= help centre

export interface HelpArticle {
  articleId: string;
  title: string;
  body: string;
  category: Category;
  locale: string;
  /** Policy articles carry the legal-review reference from FR-ADM-007. */
  legalReviewRef?: string;
  isPolicy: boolean;
}

/**
 * A searchable help centre. Policy articles without a legal-review reference are excluded from
 * results rather than shown: an unreviewed policy page is a liability, and showing it to a
 * customer with a complaint is the worst moment for it to be wrong.
 */
export function searchHelpCentre(articles: HelpArticle[], query: string, locale: string, limit = 10):
  HelpArticle[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  return articles
    .filter((a) => a.locale.split('-')[0] === locale.split('-')[0])
    .filter((a) => !a.isPolicy || (a.legalReviewRef !== undefined && a.legalReviewRef.length > 0))
    .map((a) => {
      const haystack = `${a.title} ${a.body}`.toLowerCase();
      const hits = terms.filter((t) => haystack.includes(t)).length;
      // a title match counts for more than a body mention
      const titleHits = terms.filter((t) => a.title.toLowerCase().includes(t)).length;
      return { article: a, score: hits + titleHits * 2 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.article.articleId.localeCompare(b.article.articleId))
    .slice(0, limit)
    .map((x) => x.article);
}
