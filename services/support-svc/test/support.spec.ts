/**
 * FR-CUS-026 support & help centre. Two behaviours get the most attention, because the convenient
 * implementation of each is wrong: an attachment failure must not block a ticket, and an assistant
 * hand-off must carry the whole conversation with the customer's consent.
 */
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_TAXONOMY,
  DUPLICATE_WINDOW_MS,
  FIRST_RESPONSE_SLA_MS,
  findDuplicate,
  ORDER_REF_PROMPTED,
  searchHelpCentre,
  SupportDesk,
  type AssistantTranscript,
  type Attachment,
  type Category,
  type HelpArticle,
  type TicketDraft,
} from '../src/domain/support.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const attachment = (over: Partial<Attachment> = {}): Attachment => ({
  ref: 'att-1', filename: 'photo.jpg', scanResult: 'CLEAN', ...over,
});

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  ticketId: 'TKT-1',
  customerId: 'CUS-1',
  category: 'ORDER',
  description: 'My parcel says delivered but I never received it',
  orderRef: 'ORD-1001',
  attachments: [],
  ...over,
});

const created = (desk: SupportDesk, over: Partial<TicketDraft> = {}, at = NOW) => {
  const r = desk.create(draft(over), at);
  if (r.outcome !== 'CREATED') throw new Error('expected CREATED, got ' + r.outcome);
  return r;
};

// ============================================ SLA matrix

describe('the published SLA matrix (RULES)', () => {
  it('matches the documented first-response windows', () => {
    expect(FIRST_RESPONSE_SLA_MS.PAYMENT).toBe(2 * HOUR);
    expect(FIRST_RESPONSE_SLA_MS.ORDER).toBe(4 * HOUR);
    expect(FIRST_RESPONSE_SLA_MS.GENERAL).toBe(24 * HOUR);
    expect(FIRST_RESPONSE_SLA_MS.GRIEVANCE).toBe(48 * HOUR);
  });

  it('payment issues get the tightest clock, because the money has already gone', () => {
    expect(FIRST_RESPONSE_SLA_MS.PAYMENT).toBeLessThan(FIRST_RESPONSE_SLA_MS.ORDER);
    expect(FIRST_RESPONSE_SLA_MS.ORDER).toBeLessThan(FIRST_RESPONSE_SLA_MS.GENERAL);
  });

  it('sets the ticket clock from its own category', () => {
    const desk = new SupportDesk();
    const payment = created(desk, { ticketId: 'T-PAY', category: 'PAYMENT', orderRef: 'ORD-9' });
    expect(payment.ticket.firstResponseDueAtMs).toBe(NOW + 2 * HOUR);

    const general = created(desk, { ticketId: 'T-GEN', category: 'GENERAL', orderRef: undefined });
    expect(general.ticket.firstResponseDueAtMs).toBe(NOW + 24 * HOUR);
  });

  it('a grievance ticket starts at the grievance officer, not tier 1', () => {
    const desk = new SupportDesk();
    const g = created(desk, { ticketId: 'T-G', category: 'GRIEVANCE', orderRef: undefined });
    expect(g.ticket.tier).toBe('GRIEVANCE_OFFICER');
    expect(g.ticket.firstResponseDueAtMs).toBe(NOW + 48 * HOUR);
  });

  it('the clock stops at FIRST RESPONSE, not at resolution', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.recordFirstResponse('TKT-1', 'SUP-1', NOW + 3 * HOUR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.withinSla).toBe(true);
    // still open hours later, but the SLA was met
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 100 * HOUR)).toBe(false);
  });

  it('a late first response is recorded as a breach', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.recordFirstResponse('TKT-1', 'SUP-1', NOW + 5 * HOUR);
    if (r.ok) expect(r.withinSla).toBe(false);
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 5 * HOUR)).toBe(true);
    expect(desk.ticket('TKT-1')!.timeline.some((e) => e.detail === 'SLA BREACHED')).toBe(true);
  });

  it('the breach boundary is exact and a second first-response is refused', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 4 * HOUR)).toBe(false);
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 4 * HOUR + 1)).toBe(true);
    desk.recordFirstResponse('TKT-1', 'SUP-1', NOW + HOUR);
    expect(desk.recordFirstResponse('TKT-1', 'SUP-2', NOW + 2 * HOUR).ok).toBe(false);
  });

  it('a resolved ticket is never in breach', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.resolve('TKT-1', 'SUP-1', 'Refund issued and parcel traced', NOW + HOUR);
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 500 * HOUR)).toBe(false);
  });
});

// ============================================ attachment failure

describe('an attachment failure NEVER blocks ticket creation (ERRORS)', () => {
  it('creates the ticket, records the failure and offers a retry', () => {
    const desk = new SupportDesk();
    const r = desk.create(draft({
      attachments: [
        attachment({ ref: 'a1', scanResult: 'CLEAN' }),
        attachment({ ref: 'a2', filename: 'video.mp4', scanResult: 'UPLOAD_FAILED' }),
        attachment({ ref: 'a3', filename: 'scan.pdf', scanResult: 'SCAN_FAILED' }),
      ],
    }), NOW);

    expect(r.outcome).toBe('CREATED');
    if (r.outcome !== 'CREATED') return;
    // a customer whose upload failed is still a customer with a problem
    expect(r.ticket.attachments).toHaveLength(1);
    expect(r.ticket.failedAttachments).toHaveLength(2);
    expect(r.retryableAttachments).toHaveLength(2);
    expect(r.ticket.timeline.some((e) => e.action === 'ATTACHMENT_FAILED')).toBe(true);
  });

  it('a successful retry moves the attachment onto the ticket', () => {
    const desk = new SupportDesk();
    created(desk, { attachments: [attachment({ ref: 'a2', scanResult: 'UPLOAD_FAILED' })] });
    const r = desk.retryAttachment('TKT-1', attachment({ ref: 'a2', scanResult: 'CLEAN' }), NOW + 60_000);
    expect(r.ok).toBe(true);
    const t = desk.ticket('TKT-1')!;
    expect(t.failedAttachments).toHaveLength(0);
    expect(t.attachments).toHaveLength(1);
    expect(t.timeline.some((e) => e.action === 'ATTACHMENT_RETRY_SUCCEEDED')).toBe(true);
  });

  it('a still-failing retry is refused without losing the ticket', () => {
    const desk = new SupportDesk();
    created(desk, { attachments: [attachment({ ref: 'a2', scanResult: 'UPLOAD_FAILED' })] });
    const r = desk.retryAttachment('TKT-1', attachment({ ref: 'a2', scanResult: 'SCAN_FAILED' }), NOW);
    expect(r.ok).toBe(false);
    expect(desk.ticket('TKT-1')).toBeDefined();
  });

  it('but an INFECTED attachment IS a refusal — we will not hold malware', () => {
    const desk = new SupportDesk();
    const r = desk.create(draft({ attachments: [attachment({ scanResult: 'INFECTED' })] }), NOW);
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') {
      expect(r.violations.some((v) => v.code === 'ATTACHMENT_FAILED_MALWARE_SCAN')).toBe(true);
    }
    expect(desk.retryAttachment('TKT-1', attachment({ scanResult: 'INFECTED' }), NOW).ok).toBe(false);
  });
});

// ============================================ duplicate detection

describe('duplicate detection offers an append (VALIDATION)', () => {
  it('suggests appending to the open ticket rather than opening a second', () => {
    const desk = new SupportDesk();
    created(desk);
    const second = desk.create(draft({ ticketId: 'TKT-2' }), NOW + HOUR);
    expect(second.outcome).toBe('APPEND_SUGGESTED');
    if (second.outcome !== 'APPEND_SUGGESTED') return;
    expect(second.existingTicketId).toBe('TKT-1');
    expect(second.reason).toContain('ORD-1001');
    // fragmenting across two SLA clocks and two agents is what this prevents
    expect(desk.ticket('TKT-2')).toBeUndefined();
  });

  it('a different order in the same category is NOT a duplicate', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.create(draft({ ticketId: 'TKT-2', orderRef: 'ORD-2002' }), NOW + HOUR).outcome)
      .toBe('CREATED');
  });

  it('a different category on the same order is NOT a duplicate', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.create(draft({ ticketId: 'TKT-2', category: 'PAYMENT' }), NOW + HOUR).outcome)
      .toBe('CREATED');
  });

  it('a RESOLVED ticket does not block a new one', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.resolve('TKT-1', 'SUP-1', 'Parcel located and delivered', NOW + HOUR);
    expect(desk.create(draft({ ticketId: 'TKT-2' }), NOW + 2 * HOUR).outcome).toBe('CREATED');
  });

  it('outside the duplicate window a new ticket is permitted', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.create(draft({ ticketId: 'TKT-2' }), NOW + DUPLICATE_WINDOW_MS + 1).outcome)
      .toBe('CREATED');
    expect(DUPLICATE_WINDOW_MS).toBe(24 * HOUR);
  });

  it('findDuplicate matches on category alone when no order reference is given', () => {
    const desk = new SupportDesk();
    created(desk, { ticketId: 'T-GEN', category: 'GENERAL', orderRef: undefined });
    const dup = findDuplicate(
      draft({ ticketId: 'T-GEN-2', category: 'GENERAL', orderRef: undefined }),
      desk.openTickets(), NOW + HOUR);
    expect(dup?.ticketId).toBe('T-GEN');
  });

  it('appending re-opens a ticket that was awaiting the customer', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.awaitCustomer('TKT-1', 'SUP-1', NOW + HOUR);
    expect(desk.ticket('TKT-1')!.state).toBe('AWAITING_CUSTOMER');
    const r = desk.append('TKT-1', 'CUS-1', 'Here is the photo you asked for', NOW + 2 * HOUR);
    expect(r.ok).toBe(true);
    expect(desk.ticket('TKT-1')!.state).toBe('OPEN');
  });

  it('appending to an unknown or resolved ticket is refused', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.append('NOPE', 'CUS-1', 'text', NOW).ok).toBe(false);
    desk.resolve('TKT-1', 'SUP-1', 'Resolved fully', NOW + HOUR);
    expect(desk.append('TKT-1', 'CUS-1', 'text', NOW + 2 * HOUR).ok).toBe(false);
    expect(desk.append('TKT-1', 'CUS-1', '  ', NOW).ok).toBe(false);
  });
});

// ============================================ validation

describe('ticket validation (VALIDATION)', () => {
  it('refuses a category outside the taxonomy', () => {
    const desk = new SupportDesk();
    const r = desk.create(draft({ category: 'HACKING_ATTEMPT' as unknown as Category }), NOW);
    expect(r.outcome).toBe('REJECTED');
    if (r.outcome === 'REJECTED') {
      expect(r.violations.some((v) => v.code === 'CATEGORY_NOT_IN_TAXONOMY')).toBe(true);
    }
    expect(CATEGORY_TAXONOMY.size).toBe(7);
  });

  it('refuses a too-short description, a missing customer and a reused ticket id', () => {
    const desk = new SupportDesk();
    expect(desk.create(draft({ description: 'help' }), NOW).outcome).toBe('REJECTED');
    expect(desk.create(draft({ customerId: '  ' }), NOW).outcome).toBe('REJECTED');
    created(desk);
    const reused = desk.create(draft({ orderRef: 'ORD-OTHER' }), NOW);
    expect(reused.outcome).toBe('REJECTED');
    if (reused.outcome === 'REJECTED') {
      expect(reused.violations.some((v) => v.code === 'TICKET_ID_ALREADY_USED')).toBe(true);
    }
  });

  it('prompts for an order reference where context is usually essential', () => {
    const desk = new SupportDesk();
    const prompted = desk.create(draft({ ticketId: 'T-A', category: 'PAYMENT', orderRef: undefined }), NOW);
    if (prompted.outcome !== 'CREATED') throw new Error('expected CREATED');
    expect(prompted.orderRefPrompted).toBe(true);

    const notPrompted = desk.create(draft({ ticketId: 'T-B', category: 'GENERAL', orderRef: undefined }), NOW);
    if (notPrompted.outcome !== 'CREATED') throw new Error('expected CREATED');
    expect(notPrompted.orderRefPrompted).toBe(false);

    // but it is optional, not mandatory — the ticket was created either way
    expect(ORDER_REF_PROMPTED.has('PAYMENT')).toBe(true);
    expect(ORDER_REF_PROMPTED.has('GENERAL')).toBe(false);
  });
});

// ============================================ assistant hand-off

describe('an assistant hand-off needs consent and the FULL transcript (RULES)', () => {
  const transcript = (): AssistantTranscript => ({
    sessionId: 'SESS-1',
    turns: [
      { role: 'CUSTOMER', text: 'My parcel says delivered', atMs: NOW - 600_000 },
      { role: 'ASSISTANT', text: 'Let me check that order', atMs: NOW - 590_000 },
      { role: 'CUSTOMER', text: 'It is not at my door', atMs: NOW - 580_000 },
    ],
  });

  it('transfers every turn, in order, with consent', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.handOffFromAssistant('TKT-1', transcript(), true, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.turnsTransferred).toBe(3);

    const t = desk.ticket('TKT-1')!;
    expect(t.transcript!.turns).toHaveLength(3);
    // handing over a summary would make the customer repeat themselves
    expect(t.transcript!.turns[0].text).toBe('My parcel says delivered');
    expect(t.transcript!.turns[2].text).toBe('It is not at my door');
    expect(t.timeline.some((e) => e.action === 'HAND_OFF')).toBe(true);
  });

  it('is REFUSED without consent, because a hand-off is a disclosure', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.handOffFromAssistant('TKT-1', transcript(), false, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('HAND_OFF_REQUIRES_CUSTOMER_CONSENT');
    expect(desk.ticket('TKT-1')!.transcript).toBeUndefined();
  });

  it('is refused with an empty transcript, since the point is not repeating oneself', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.handOffFromAssistant('TKT-1', { sessionId: 'S', turns: [] }, true, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('TRANSCRIPT_EMPTY');
  });

  it('sorts turns chronologically even if delivered out of order', () => {
    const desk = new SupportDesk();
    created(desk);
    const jumbled: AssistantTranscript = {
      sessionId: 'S',
      turns: [
        { role: 'CUSTOMER', text: 'third', atMs: NOW - 100 },
        { role: 'CUSTOMER', text: 'first', atMs: NOW - 300 },
        { role: 'ASSISTANT', text: 'second', atMs: NOW - 200 },
      ],
    };
    desk.handOffFromAssistant('TKT-1', jumbled, true, NOW);
    expect(desk.ticket('TKT-1')!.transcript!.turns.map((t) => t.text)).toEqual(['first', 'second', 'third']);
  });
});

// ============================================ escalation

describe('an SLA breach escalates the tier AND notifies the duty manager (ERRORS)', () => {
  it('does both, because escalating silently just moves the ticket to another queue to be missed in', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.escalateOnBreach('TKT-1', NOW + 5 * HOUR);
    expect(r.escalated).toBe(true);
    expect(r.tier).toBe('TIER_2');
    expect(r.dutyManagerNotified).toBe(true);

    const t = desk.ticket('TKT-1')!;
    expect(t.state).toBe('ESCALATED');
    expect(t.dutyManagerNotified).toBe(true);
    expect(t.timeline.some((e) => e.action === 'SLA_BREACH_ESCALATION')).toBe(true);
  });

  it('does not escalate a ticket inside its SLA', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.escalateOnBreach('TKT-1', NOW + HOUR);
    expect(r.escalated).toBe(false);
    expect(r.reason).toBe('SLA_NOT_BREACHED');
    expect(desk.ticket('TKT-1')!.tier).toBe('TIER_1');
  });

  it('escalates tier 2 onward to the grievance officer', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.escalateOnBreach('TKT-1', NOW + 5 * HOUR);
    const again = desk.escalateOnBreach('TKT-1', NOW + 10 * HOUR);
    expect(again.tier).toBe('GRIEVANCE_OFFICER');
  });

  it('an explicit grievance escalation restarts the published 48-hour clock', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.recordFirstResponse('TKT-1', 'SUP-1', NOW + HOUR);
    const r = desk.escalateToGrievanceOfficer('TKT-1', 'Customer invoked grievance redressal', NOW + 2 * HOUR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.responseDueAtMs).toBe(NOW + 2 * HOUR + 48 * HOUR);

    const t = desk.ticket('TKT-1')!;
    expect(t.tier).toBe('GRIEVANCE_OFFICER');
    // the grievance clock is its own window, so the earlier response does not satisfy it
    expect(t.firstRespondedAtMs).toBeUndefined();
    expect(desk.isFirstResponseBreached('TKT-1', NOW + 2 * HOUR + 49 * HOUR)).toBe(true);
  });

  it('a grievance escalation needs a reason', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.escalateToGrievanceOfficer('TKT-1', 'x', NOW).ok).toBe(false);
    expect(desk.escalateToGrievanceOfficer('NOPE', 'valid reason here', NOW).ok).toBe(false);
  });
});

// ============================================ resolution

describe('resolution records a summary and prompts for CSAT (OUTPUTS)', () => {
  it('records the resolution and sends the CSAT prompt', () => {
    const desk = new SupportDesk();
    created(desk);
    const r = desk.resolve('TKT-1', 'SUP-1', 'Parcel traced to neighbour; redelivered', NOW + 3 * HOUR);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.csatPromptSent).toBe(true);

    const t = desk.ticket('TKT-1')!;
    expect(t.state).toBe('RESOLVED');
    expect(t.resolution!.summary).toContain('redelivered');
    expect(t.resolution!.agentId).toBe('SUP-1');
  });

  it('refuses an empty summary and a double resolution', () => {
    const desk = new SupportDesk();
    created(desk);
    expect(desk.resolve('TKT-1', 'SUP-1', 'ok', NOW).ok).toBe(false);
    desk.resolve('TKT-1', 'SUP-1', 'Fully resolved with refund', NOW);
    expect(desk.resolve('TKT-1', 'SUP-2', 'Resolved again somehow', NOW + HOUR).ok).toBe(false);
  });

  it('the timeline is the full history in order', () => {
    const desk = new SupportDesk();
    created(desk);
    desk.recordFirstResponse('TKT-1', 'SUP-1', NOW + HOUR);
    desk.append('TKT-1', 'CUS-1', 'Any update?', NOW + 2 * HOUR);
    desk.resolve('TKT-1', 'SUP-1', 'Refund processed in full', NOW + 3 * HOUR);
    const actions = desk.ticket('TKT-1')!.timeline.map((e) => e.action);
    expect(actions).toEqual(['CREATED', 'FIRST_RESPONSE', 'APPENDED', 'RESOLVED']);
  });
});

// ============================================ help centre

describe('the help centre excludes unreviewed policy pages', () => {
  const articles = (): HelpArticle[] => [
    {
      articleId: 'A1', title: 'Return and refund policy', body: 'You may return unworn items in 14 days',
      category: 'RETURN_REFUND', locale: 'en-IN', isPolicy: true, legalReviewRef: 'LEGAL-2026-04',
    },
    {
      articleId: 'A2', title: 'Draft cancellation policy', body: 'Cancellation terms pending review',
      category: 'ORDER', locale: 'en-IN', isPolicy: true,
    },
    {
      articleId: 'A3', title: 'How to track your order', body: 'Open the order and tap track parcel',
      category: 'ORDER', locale: 'en-IN', isPolicy: false,
    },
    {
      articleId: 'A4', title: 'ஆர்டரை கண்காணிப்பது எப்படி', body: 'ஆர்டரைத் திறந்து கண்காணி என்பதைத் தட்டவும்',
      category: 'ORDER', locale: 'ta-IN', isPolicy: false,
    },
  ];

  it('excludes a policy article with no legal-review reference', () => {
    const results = searchHelpCentre(articles(), 'cancellation policy', 'en-IN');
    // an unreviewed policy page is a liability, and a complaining customer is the worst audience
    expect(results.map((a) => a.articleId)).not.toContain('A2');
  });

  it('includes a reviewed policy article', () => {
    const results = searchHelpCentre(articles(), 'refund policy', 'en-IN');
    expect(results.map((a) => a.articleId)).toContain('A1');
  });

  it('ranks a title match above a body mention', () => {
    const results = searchHelpCentre(articles(), 'track order', 'en-IN');
    expect(results[0].articleId).toBe('A3');
  });

  it('filters by locale and serves Tamil independently', () => {
    const tamil = searchHelpCentre(articles(), 'ஆர்டரை', 'ta-IN');
    expect(tamil.map((a) => a.articleId)).toEqual(['A4']);
    expect(searchHelpCentre(articles(), 'track', 'ta-IN')).toEqual([]);
  });

  it('an empty or noise-only query returns nothing rather than everything', () => {
    expect(searchHelpCentre(articles(), '', 'en-IN')).toEqual([]);
    expect(searchHelpCentre(articles(), '  a  ', 'en-IN')).toEqual([]);
  });

  it('respects the result limit', () => {
    expect(searchHelpCentre(articles(), 'order', 'en-IN', 1)).toHaveLength(1);
  });
});
