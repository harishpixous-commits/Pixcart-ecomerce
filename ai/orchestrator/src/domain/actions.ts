/**
 * Conversational commerce actions — FR-AI-002.
 *
 * Normative source (Documentation Suite v1.0):
 *   DESC:       "expose a governed action toolset to the assistant — search_catalogue,
 *                get_product, compare, add_to_cart, get_order_status, initiate_return,
 *                apply_coupon, create_support_ticket — each mirroring existing service
 *                authorisation exactly."
 *   INPUTS:     "Typed tool calls with session auth, confirmation tokens for irreversible
 *                actions."
 *   OUTPUTS:    "Action results as structured cards (UI-renderable), domain events identical to
 *                UI-originated ones (tagged source=assistant)."
 *   VALIDATION: "Every call passes the owning service's validation (no bypass path); irreversible
 *                actions require fresh in-chat confirmation token (single-use, 2-min TTL)."
 *   RULES:      "Monetary-impact tools capped per session (e.g., ≤ 3 coupon attempts); guest
 *                sessions restricted to read+cart tools."
 *   ERRORS:     "Authorisation failure → assistant explains scope and offers login/hand-off;
 *                partial multi-item action → itemised outcome, no silent partials."
 *   SECURITY:   "Tool registry is deny-by-default; new tools require security review sign-off
 *                recorded in Decision Log."
 *
 * This closes a gap left open since Slice 3: the LlmChain has enforced a deny-by-default
 * `allowedTools` list from the beginning, but no actual commerce action catalogue existed behind
 * it. The gate had nothing to gate.
 *
 * THE "NO BYPASS PATH" REQUIREMENT SHAPES THE DESIGN. A tool cannot be registered without the
 * owning service's validator attached, so there is no way to define a tool that skips its
 * service's own checks — the absence is unrepresentable rather than merely discouraged. This
 * layer never mutates state: it authorises, validates, and returns an intent for the owning
 * service to execute, which is the same boundary discipline the rest of the platform follows.
 */

/** The eight tools the requirement names, and nothing else without registration. */
export type ToolName =
  | 'search_catalogue'
  | 'get_product'
  | 'compare'
  | 'add_to_cart'
  | 'get_order_status'
  | 'initiate_return'
  | 'apply_coupon'
  | 'create_support_ticket';

/** Classification drives which sessions may call a tool and what confirmation it needs. */
export type ToolClass = 'READ' | 'CART' | 'MONETARY' | 'IRREVERSIBLE';

/** RULES: guest sessions are restricted to read and cart tools. */
export const GUEST_PERMITTED_CLASSES: ReadonlySet<ToolClass> = new Set<ToolClass>(['READ', 'CART']);

/** VALIDATION: an irreversible action needs a fresh single-use token, valid two minutes. */
export const CONFIRMATION_TOKEN_TTL_MS = 2 * 60 * 1000;
/** RULES: monetary-impact tools are capped per session. */
export const MONETARY_ATTEMPTS_PER_SESSION = 3;

export interface SessionContext {
  sessionId: string;
  /** null for a guest session. */
  customerId: string | null;
  authenticated: boolean;
  nowMs: number;
}

/**
 * The owning service's validation, injected at registration. Returning a refusal here IS the
 * service saying no — this layer does not second-guess it or provide a fallback path.
 */
export type ServiceValidator = (args: Record<string, unknown>, session: SessionContext)
  => { ok: true } | { ok: false; reason: string };

export interface ToolDefinition {
  name: ToolName;
  toolClass: ToolClass;
  /** SECURITY: the Decision Log reference for the security review that admitted this tool. */
  securityReviewRef: string;
  /** VALIDATION: the owning service's validation. Mandatory — there is no bypass. */
  validate: ServiceValidator;
  /** True when the tool accepts a list and can therefore partially succeed. */
  multiItem?: boolean;
}

export interface ConfirmationToken {
  token: string;
  sessionId: string;
  tool: ToolName;
  issuedAtMs: number;
  expiresAtMs: number;
}

/** OUTPUTS: a UI-renderable structured card. */
export interface ResultCard {
  tool: ToolName;
  title: string;
  items: Array<{ label: string; value: string }>;
}

/** OUTPUTS: a domain event identical to a UI-originated one, tagged with its source. */
export interface DomainEventIntent {
  eventType: string;
  source: 'assistant';
  sessionId: string;
  customerId: string | null;
  payload: Record<string, unknown>;
}

/** ERRORS: one outcome per item — a multi-item action never reports a silent partial. */
export interface ItemOutcome {
  itemRef: string;
  ok: boolean;
  reason?: string;
}

export type InvokeResult =
  | { ok: true; card: ResultCard; event: DomainEventIntent; itemOutcomes?: ItemOutcome[] }
  | {
      ok: false;
      reason: string;
      /** ERRORS: on an authorisation failure the assistant is told what to offer. */
      remedy?: 'OFFER_LOGIN' | 'OFFER_HUMAN_HANDOFF' | 'REQUEST_CONFIRMATION' | 'NONE';
      itemOutcomes?: ItemOutcome[];
    };

export type RegisterResult = { ok: true } | { ok: false; reason: string };

export class ToolRegistry {
  private readonly tools = new Map<ToolName, ToolDefinition>();
  /** sessionId -> count of monetary-impact attempts. */
  private readonly monetaryAttempts = new Map<string, number>();
  private readonly tokens = new Map<string, ConfirmationToken>();
  private readonly spentTokens = new Set<string>();

  /**
   * SECURITY: registration is the only way a tool becomes callable, and it requires both a
   * security-review reference and the owning service's validator. A tool without either cannot
   * exist, so "deny-by-default" and "no bypass path" are properties of the type rather than
   * conventions a caller must honour.
   */
  register(def: ToolDefinition): RegisterResult {
    if (!def.securityReviewRef || def.securityReviewRef.trim().length === 0) {
      return { ok: false, reason: 'TOOL_REQUIRES_SECURITY_REVIEW_SIGN_OFF' };
    }
    if (typeof def.validate !== 'function') {
      return { ok: false, reason: 'TOOL_REQUIRES_OWNING_SERVICE_VALIDATOR' };
    }
    if (this.tools.has(def.name)) return { ok: false, reason: 'TOOL_ALREADY_REGISTERED' };
    this.tools.set(def.name, def);
    return { ok: true };
  }

  /** The allow-list the Slice-3 LlmChain consumes — only registered tools appear. */
  allowedToolNames(session: SessionContext): ToolName[] {
    return [...this.tools.values()]
      .filter((t) => session.authenticated || GUEST_PERMITTED_CLASSES.has(t.toolClass))
      .map((t) => t.name);
  }

  isRegistered(name: string): boolean {
    return this.tools.has(name as ToolName);
  }

  definition(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** VALIDATION: issue a fresh, single-use confirmation token for an irreversible action. */
  issueConfirmationToken(token: string, session: SessionContext, tool: ToolName): ConfirmationToken | null {
    const def = this.tools.get(tool);
    if (!def || def.toolClass !== 'IRREVERSIBLE') return null;
    const t: ConfirmationToken = {
      token, sessionId: session.sessionId, tool,
      issuedAtMs: session.nowMs, expiresAtMs: session.nowMs + CONFIRMATION_TOKEN_TTL_MS,
    };
    this.tokens.set(token, t);
    return t;
  }

  private consumeToken(token: string | undefined, session: SessionContext, tool: ToolName):
    { ok: true } | { ok: false; reason: string } {
    if (!token) return { ok: false, reason: 'CONFIRMATION_TOKEN_REQUIRED' };
    if (this.spentTokens.has(token)) return { ok: false, reason: 'CONFIRMATION_TOKEN_ALREADY_USED' };
    const t = this.tokens.get(token);
    if (!t) return { ok: false, reason: 'CONFIRMATION_TOKEN_UNKNOWN' };
    if (t.sessionId !== session.sessionId) return { ok: false, reason: 'CONFIRMATION_TOKEN_WRONG_SESSION' };
    if (t.tool !== tool) return { ok: false, reason: 'CONFIRMATION_TOKEN_WRONG_TOOL' };
    if (session.nowMs >= t.expiresAtMs) return { ok: false, reason: 'CONFIRMATION_TOKEN_EXPIRED' };
    this.spentTokens.add(token);
    this.tokens.delete(token);
    return { ok: true };
  }

  monetaryAttemptsUsed(sessionId: string): number {
    return this.monetaryAttempts.get(sessionId) ?? 0;
  }

  /**
   * Invoke a tool. Order of checks is deliberate: registration, then session class, then the
   * monetary cap, then confirmation, and only then the owning service's validation — so a guest
   * probing an irreversible tool learns it is out of scope without consuming a token or an
   * attempt, and the service's own validator is never reached by a call that had no business
   * being made.
   */
  invoke(
    name: string,
    args: Record<string, unknown>,
    session: SessionContext,
    opts: { confirmationToken?: string; items?: string[] } = {},
  ): InvokeResult {
    // SECURITY: deny-by-default.
    if (!this.isRegistered(name)) {
      return { ok: false, reason: `TOOL_NOT_IN_REGISTRY: ${name}`, remedy: 'NONE' };
    }
    const def = this.tools.get(name as ToolName)!;

    // RULES: guest sessions are restricted to read and cart tools.
    if (!session.authenticated && !GUEST_PERMITTED_CLASSES.has(def.toolClass)) {
      return {
        ok: false,
        reason: `GUEST_SESSION_MAY_NOT_CALL_${def.toolClass}_TOOL: ${def.name}`,
        remedy: 'OFFER_LOGIN',
      };
    }

    // RULES: monetary-impact tools are capped per session.
    if (def.toolClass === 'MONETARY') {
      const used = this.monetaryAttemptsUsed(session.sessionId);
      if (used >= MONETARY_ATTEMPTS_PER_SESSION) {
        return {
          ok: false,
          reason: `MONETARY_TOOL_SESSION_CAP_REACHED_${MONETARY_ATTEMPTS_PER_SESSION}`,
          remedy: 'OFFER_HUMAN_HANDOFF',
        };
      }
      // the attempt counts whether or not the coupon turns out to be valid: that is what makes
      // it a cap on ATTEMPTS rather than on successes
      this.monetaryAttempts.set(session.sessionId, used + 1);
    }

    // VALIDATION: irreversible actions need a fresh, single-use, in-session token.
    if (def.toolClass === 'IRREVERSIBLE') {
      const conf = this.consumeToken(opts.confirmationToken, session, def.name);
      if (!conf.ok) {
        return { ok: false, reason: conf.reason, remedy: 'REQUEST_CONFIRMATION' };
      }
    }

    // VALIDATION: the owning service's own validation. There is no path around this.
    const serviceCheck = def.validate(args, session);
    if (!serviceCheck.ok) {
      return { ok: false, reason: serviceCheck.reason, remedy: 'OFFER_HUMAN_HANDOFF' };
    }

    // ERRORS: a multi-item action reports an outcome per item — never a silent partial.
    let itemOutcomes: ItemOutcome[] | undefined;
    if (def.multiItem && opts.items) {
      itemOutcomes = opts.items.map((itemRef) => {
        const per = def.validate({ ...args, itemRef }, session);
        return per.ok ? { itemRef, ok: true } : { itemRef, ok: false, reason: per.reason };
      });
      const anyFailed = itemOutcomes.some((o) => !o.ok);
      const anySucceeded = itemOutcomes.some((o) => o.ok);
      if (anyFailed && !anySucceeded) {
        return { ok: false, reason: 'ALL_ITEMS_FAILED', remedy: 'NONE', itemOutcomes };
      }
      if (anyFailed) {
        // a partial is reported as a partial, itemised, rather than as a bare success
        return {
          ok: false,
          reason: 'PARTIAL_ITEM_FAILURE',
          remedy: 'NONE',
          itemOutcomes,
        };
      }
    }

    return {
      ok: true,
      card: buildCard(def.name, args, itemOutcomes),
      event: {
        eventType: eventTypeFor(def.name),
        source: 'assistant',
        sessionId: session.sessionId,
        customerId: session.customerId,
        payload: { ...args, tool: def.name },
      },
      itemOutcomes,
    };
  }
}

/** OUTPUTS: domain events identical to UI-originated ones — same type, different source tag. */
export function eventTypeFor(tool: ToolName): string {
  switch (tool) {
    case 'add_to_cart': return 'cart.item.added.v1';
    case 'apply_coupon': return 'cart.coupon.applied.v1';
    case 'initiate_return': return 'rma.return.requested.v1';
    case 'create_support_ticket': return 'support.ticket.created.v1';
    case 'search_catalogue': return 'discovery.search.performed.v1';
    case 'get_product': return 'discovery.product.viewed.v1';
    case 'compare': return 'discovery.compare.performed.v1';
    case 'get_order_status': return 'order.status.viewed.v1';
  }
}

function buildCard(tool: ToolName, args: Record<string, unknown>, itemOutcomes?: ItemOutcome[]): ResultCard {
  const items = Object.entries(args).map(([label, value]) => ({ label, value: String(value) }));
  if (itemOutcomes) {
    items.push({ label: 'items_succeeded', value: String(itemOutcomes.filter((o) => o.ok).length) });
  }
  return { tool, title: tool.replace(/_/g, ' '), items };
}

/** The classification the requirement implies for each named tool. */
export const TOOL_CLASSES: Readonly<Record<ToolName, ToolClass>> = {
  search_catalogue: 'READ',
  get_product: 'READ',
  compare: 'READ',
  get_order_status: 'READ',
  add_to_cart: 'CART',
  apply_coupon: 'MONETARY',
  initiate_return: 'IRREVERSIBLE',
  create_support_ticket: 'CART',
};
