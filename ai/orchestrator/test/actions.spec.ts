/**
 * FR-AI-002 conversational commerce actions. The registry's guarantees are tested rather than the
 * tools' business logic, because each tool's logic belongs to its owning service — what matters
 * here is that no call can reach a service without passing that service's own validation, and
 * that nothing irreversible or monetary happens without the documented ceremony.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_TOKEN_TTL_MS,
  eventTypeFor,
  GUEST_PERMITTED_CLASSES,
  MONETARY_ATTEMPTS_PER_SESSION,
  TOOL_CLASSES,
  ToolRegistry,
  type ServiceValidator,
  type SessionContext,
  type ToolDefinition,
  type ToolName,
} from '../src/domain/actions.js';

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  sessionId: 'S1', customerId: 'CUS-1', authenticated: true, nowMs: NOW, ...over,
});

const guest = (over: Partial<SessionContext> = {}): SessionContext =>
  session({ customerId: null, authenticated: false, ...over });

const allow: ServiceValidator = () => ({ ok: true });
const refuse = (reason: string): ServiceValidator => () => ({ ok: false, reason });

const def = (name: ToolName, over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  toolClass: TOOL_CLASSES[name],
  securityReviewRef: 'DECISION-LOG-D-021',
  validate: allow,
  ...over,
});

/** A registry with all eight documented tools registered. */
const fullRegistry = (overrides: Partial<Record<ToolName, Partial<ToolDefinition>>> = {}) => {
  const r = new ToolRegistry();
  for (const name of Object.keys(TOOL_CLASSES) as ToolName[]) {
    const res = r.register(def(name, overrides[name] ?? {}));
    if (!res.ok) throw new Error(`register ${name} failed: ${res.reason}`);
  }
  return r;
};

// ================================================= deny-by-default & registration

describe('the registry is deny-by-default (SECURITY)', () => {
  it('an unregistered tool cannot be invoked', () => {
    const r = new ToolRegistry();
    const res = r.invoke('search_catalogue', {}, session());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('TOOL_NOT_IN_REGISTRY');
  });

  it('an invented tool name is refused even on a full registry', () => {
    const res = fullRegistry().invoke('delete_all_orders', {}, session());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('TOOL_NOT_IN_REGISTRY');
  });

  it('registration requires a security-review sign-off reference', () => {
    const r = new ToolRegistry();
    const res = r.register(def('get_product', { securityReviewRef: '  ' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('TOOL_REQUIRES_SECURITY_REVIEW_SIGN_OFF');
    expect(r.isRegistered('get_product')).toBe(false);
  });

  it('registration requires the owning service validator — there is NO bypass path', () => {
    const r = new ToolRegistry();
    const res = r.register({
      name: 'add_to_cart',
      toolClass: 'CART',
      securityReviewRef: 'DECISION-LOG-D-021',
      validate: undefined as unknown as ServiceValidator,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('TOOL_REQUIRES_OWNING_SERVICE_VALIDATOR');
  });

  it('a tool cannot be registered twice, so a validator cannot be swapped out later', () => {
    const r = new ToolRegistry();
    expect(r.register(def('get_product')).ok).toBe(true);
    const again = r.register(def('get_product', { validate: allow }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('TOOL_ALREADY_REGISTERED');
  });

  it('all eight documented tools register and are classified', () => {
    const r = fullRegistry();
    for (const name of Object.keys(TOOL_CLASSES) as ToolName[]) {
      expect(r.isRegistered(name)).toBe(true);
      expect(r.definition(name)!.toolClass).toBe(TOOL_CLASSES[name]);
    }
    expect(Object.keys(TOOL_CLASSES)).toHaveLength(8);
  });
});

// ================================================= no bypass path

describe('every call passes the owning service validation (VALIDATION)', () => {
  it("a service refusal is the answer — this layer offers no fallback", () => {
    const r = fullRegistry({ add_to_cart: { validate: refuse('OUT_OF_STOCK') } });
    const res = r.invoke('add_to_cart', { listingId: 'L1' }, session());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('OUT_OF_STOCK');
      expect(res.remedy).toBe('OFFER_HUMAN_HANDOFF');
    }
  });

  it('the validator receives the args and the session, so it can scope by customer', () => {
    let seen: { args: Record<string, unknown>; sessionId: string } | null = null;
    const capturing: ServiceValidator = (args, s) => {
      seen = { args, sessionId: s.sessionId };
      return { ok: true };
    };
    const r = fullRegistry({ get_order_status: { validate: capturing } });
    r.invoke('get_order_status', { orderId: 'ORD-9' }, session({ sessionId: 'S-XYZ' }));
    expect(seen).not.toBeNull();
    expect(seen!.args.orderId).toBe('ORD-9');
    expect(seen!.sessionId).toBe('S-XYZ');
  });
});

// ================================================= guest restrictions

describe('guest sessions are restricted to read and cart tools (RULES)', () => {
  it('permits read and cart tools for a guest', () => {
    const r = fullRegistry();
    expect(GUEST_PERMITTED_CLASSES.has('READ')).toBe(true);
    expect(GUEST_PERMITTED_CLASSES.has('CART')).toBe(true);
    expect(r.invoke('search_catalogue', { q: 'saree' }, guest()).ok).toBe(true);
    expect(r.invoke('add_to_cart', { listingId: 'L1' }, guest()).ok).toBe(true);
  });

  it('refuses monetary and irreversible tools for a guest, offering login', () => {
    const r = fullRegistry();
    const coupon = r.invoke('apply_coupon', { code: 'SAVE10' }, guest());
    expect(coupon.ok).toBe(false);
    if (!coupon.ok) {
      expect(coupon.reason).toContain('GUEST_SESSION_MAY_NOT_CALL_MONETARY_TOOL');
      expect(coupon.remedy).toBe('OFFER_LOGIN');
    }
    const ret = r.invoke('initiate_return', { subOrderId: 'SUB-1' }, guest());
    expect(ret.ok).toBe(false);
    if (!ret.ok) expect(ret.remedy).toBe('OFFER_LOGIN');
  });

  it('a guest probing an irreversible tool consumes no token and no attempt', () => {
    const r = fullRegistry();
    r.invoke('apply_coupon', { code: 'X' }, guest());
    expect(r.monetaryAttemptsUsed('S1')).toBe(0);
  });

  it('the allow-list handed to the LLM chain is narrower for a guest', () => {
    const r = fullRegistry();
    const asGuest = r.allowedToolNames(guest());
    const asCustomer = r.allowedToolNames(session());
    expect(asCustomer).toHaveLength(8);
    expect(asGuest).not.toContain('apply_coupon');
    expect(asGuest).not.toContain('initiate_return');
    expect(asGuest).toContain('search_catalogue');
    expect(asGuest).toContain('add_to_cart');
  });
});

// ================================================= confirmation tokens

describe('irreversible actions require a fresh single-use 2-minute token (VALIDATION)', () => {
  it('refuses without a token and names the remedy', () => {
    const r = fullRegistry();
    const res = r.invoke('initiate_return', { subOrderId: 'SUB-1' }, session());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('CONFIRMATION_TOKEN_REQUIRED');
      expect(res.remedy).toBe('REQUEST_CONFIRMATION');
    }
  });

  it('accepts a valid token exactly once', () => {
    const r = fullRegistry();
    const t = r.issueConfirmationToken('TOK-1', session(), 'initiate_return');
    expect(t).not.toBeNull();
    expect(t!.expiresAtMs).toBe(NOW + CONFIRMATION_TOKEN_TTL_MS);
    expect(CONFIRMATION_TOKEN_TTL_MS).toBe(120_000);

    const first = r.invoke('initiate_return', { subOrderId: 'SUB-1' }, session(),
      { confirmationToken: 'TOK-1' });
    expect(first.ok).toBe(true);

    const replay = r.invoke('initiate_return', { subOrderId: 'SUB-1' }, session(),
      { confirmationToken: 'TOK-1' });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('CONFIRMATION_TOKEN_ALREADY_USED');
  });

  it('refuses an expired token at the boundary', () => {
    const r = fullRegistry();
    r.issueConfirmationToken('TOK-1', session(), 'initiate_return');
    const justInside = r.invoke('initiate_return', {}, session({ nowMs: NOW + CONFIRMATION_TOKEN_TTL_MS - 1 }),
      { confirmationToken: 'TOK-1' });
    expect(justInside.ok).toBe(true);

    const r2 = fullRegistry();
    r2.issueConfirmationToken('TOK-2', session(), 'initiate_return');
    const expired = r2.invoke('initiate_return', {}, session({ nowMs: NOW + CONFIRMATION_TOKEN_TTL_MS }),
      { confirmationToken: 'TOK-2' });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe('CONFIRMATION_TOKEN_EXPIRED');
  });

  it('a token is bound to its session and its tool', () => {
    const r = fullRegistry();
    r.issueConfirmationToken('TOK-1', session({ sessionId: 'S1' }), 'initiate_return');

    const wrongSession = r.invoke('initiate_return', {}, session({ sessionId: 'S2' }),
      { confirmationToken: 'TOK-1' });
    expect(wrongSession.ok).toBe(false);
    if (!wrongSession.ok) expect(wrongSession.reason).toBe('CONFIRMATION_TOKEN_WRONG_SESSION');

    // and an unknown token is refused outright
    const unknown = r.invoke('initiate_return', {}, session(), { confirmationToken: 'NOPE' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe('CONFIRMATION_TOKEN_UNKNOWN');
  });

  it('a token cannot be issued for a non-irreversible tool', () => {
    const r = fullRegistry();
    expect(r.issueConfirmationToken('TOK-1', session(), 'search_catalogue')).toBeNull();
    expect(r.issueConfirmationToken('TOK-2', session(), 'apply_coupon')).toBeNull();
  });
});

// ================================================= monetary cap

describe('monetary-impact tools are capped per session (RULES)', () => {
  it('allows three coupon attempts then refuses with a hand-off', () => {
    const r = fullRegistry();
    for (let i = 0; i < MONETARY_ATTEMPTS_PER_SESSION; i++) {
      expect(r.invoke('apply_coupon', { code: `C${i}` }, session()).ok).toBe(true);
    }
    expect(r.monetaryAttemptsUsed('S1')).toBe(3);
    const capped = r.invoke('apply_coupon', { code: 'C4' }, session());
    expect(capped.ok).toBe(false);
    if (!capped.ok) {
      expect(capped.reason).toBe('MONETARY_TOOL_SESSION_CAP_REACHED_3');
      expect(capped.remedy).toBe('OFFER_HUMAN_HANDOFF');
    }
  });

  it('a FAILED coupon still consumes an attempt — the cap is on attempts, not successes', () => {
    const r = fullRegistry({ apply_coupon: { validate: refuse('COUPON_INVALID') } });
    for (let i = 0; i < MONETARY_ATTEMPTS_PER_SESSION; i++) {
      expect(r.invoke('apply_coupon', { code: `BAD${i}` }, session()).ok).toBe(false);
    }
    const capped = r.invoke('apply_coupon', { code: 'BAD4' }, session());
    if (!capped.ok) expect(capped.reason).toContain('CAP_REACHED');
  });

  it('the cap is per session, so another session starts fresh', () => {
    const r = fullRegistry();
    for (let i = 0; i < 3; i++) r.invoke('apply_coupon', { code: `C${i}` }, session({ sessionId: 'S1' }));
    expect(r.invoke('apply_coupon', { code: 'C' }, session({ sessionId: 'S2' })).ok).toBe(true);
    expect(r.monetaryAttemptsUsed('S2')).toBe(1);
  });

  it('read tools are uncapped', () => {
    const r = fullRegistry();
    for (let i = 0; i < 50; i++) expect(r.invoke('search_catalogue', { q: 'x' }, session()).ok).toBe(true);
    expect(r.monetaryAttemptsUsed('S1')).toBe(0);
  });
});

// ================================================= itemised partials

describe('a multi-item action never reports a silent partial (ERRORS)', () => {
  const perItem: ServiceValidator = (args) =>
    args.itemRef === 'L-BAD' ? { ok: false, reason: 'OUT_OF_STOCK' } : { ok: true };

  it('reports an outcome per item and flags the partial explicitly', () => {
    const r = fullRegistry({ add_to_cart: { multiItem: true, validate: perItem } });
    const res = r.invoke('add_to_cart', {}, session(), { items: ['L-OK1', 'L-BAD', 'L-OK2'] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('PARTIAL_ITEM_FAILURE');
      expect(res.itemOutcomes).toHaveLength(3);
      expect(res.itemOutcomes!.filter((o) => o.ok)).toHaveLength(2);
      const bad = res.itemOutcomes!.find((o) => o.itemRef === 'L-BAD')!;
      expect(bad.ok).toBe(false);
      expect(bad.reason).toBe('OUT_OF_STOCK');
    }
  });

  it('all items succeeding is a clean success with the outcomes still itemised', () => {
    const r = fullRegistry({ add_to_cart: { multiItem: true, validate: perItem } });
    const res = r.invoke('add_to_cart', {}, session(), { items: ['L-OK1', 'L-OK2'] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.itemOutcomes!.every((o) => o.ok)).toBe(true);
      expect(res.card.items.some((i) => i.label === 'items_succeeded' && i.value === '2')).toBe(true);
    }
  });

  it('all items failing is reported as such, not as a partial', () => {
    const r = fullRegistry({ add_to_cart: { multiItem: true, validate: perItem } });
    const res = r.invoke('add_to_cart', {}, session(), { items: ['L-BAD', 'L-BAD'] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('ALL_ITEMS_FAILED');
      expect(res.itemOutcomes!.every((o) => !o.ok)).toBe(true);
    }
  });
});

// ================================================= outputs

describe('outputs: structured cards and assistant-tagged domain events (OUTPUTS)', () => {
  it('a success yields a UI-renderable card and an event tagged source=assistant', () => {
    const r = fullRegistry();
    const res = r.invoke('get_order_status', { orderId: 'ORD-7' }, session());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.card.tool).toBe('get_order_status');
    expect(res.card.items.some((i) => i.label === 'orderId' && i.value === 'ORD-7')).toBe(true);
    expect(res.event.source).toBe('assistant');
    expect(res.event.eventType).toBe('order.status.viewed.v1');
    expect(res.event.sessionId).toBe('S1');
    expect(res.event.customerId).toBe('CUS-1');
    expect(res.event.payload.orderId).toBe('ORD-7');
  });

  it('every tool maps to a domain event type', () => {
    for (const name of Object.keys(TOOL_CLASSES) as ToolName[]) {
      const t = eventTypeFor(name);
      expect(t).toMatch(/^[a-z]+(\.[a-z]+)+\.v1$/);
    }
  });

  it('a guest event carries a null customer rather than a fabricated one', () => {
    const res = fullRegistry().invoke('search_catalogue', { q: 'saree' }, guest());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event.customerId).toBeNull();
  });
});
