/**
 * AI provider ports (hexagonal boundary).
 *
 * The assistant orchestrator (FR-AI-001/002) and the voice framework (FR-CUS-008,
 * 11-language, EN/TA at launch) depend only on these interfaces — never on a vendor
 * SDK. Concrete adapters (Anthropic for the LLM; Sarvam for STT/TTS/translate, the house
 * standard) are wired at the edge once real credentials are provided and validated.
 *
 * Why ports first, before any key works:
 *   - Vol. 10 §10.6 / FR-AI-001: "deny-by-default tool registry; per-session scoped
 *     capability tokens; ... 6-hop budget" and "kill-switches ≤ 60 s (FR-ADM-011)";
 *   - Vol. 10 AI-abuse row: "per-user/session budgets, anomaly alarms on token spend,
 *     output safety filters both directions".
 * These are provider-independent guarantees, so they live here in the port layer and
 * every adapter inherits them. No adapter may bypass the budget or the kill-switch.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  /** Grounding passages (RAG); the orchestrator forbids ungrounded factual claims. */
  context?: string[];
  /** Deny-by-default: only tools named here may be called this turn (Vol. 10 §10.6). */
  allowedTools?: string[];
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  /** Tool the model asked to call, if any — always re-authorised against allowedTools. */
  toolCall?: { name: string; argumentsJson: string };
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Cheap liveness/credential probe; adapters implement with a 1-token call. */
  healthCheck(): Promise<boolean>;
}

// ---- speech ports (Sarvam is the intended adapter; interface stays vendor-neutral) ----

export interface SttRequest {
  audio: Uint8Array;
  /** BCP-47 language, e.g. "ta-IN". FR-CUS-008 launch languages: en-IN, ta-IN. */
  languageCode: string;
  mimeType: string;
}
export interface SttResponse { transcript: string; languageCode: string; provider: string; }

export interface TtsRequest {
  text: string;
  languageCode: string;
  speaker?: string;
}
export interface TtsResponse { audio: Uint8Array; mimeType: string; provider: string; }

export interface SpeechProvider {
  readonly name: string;
  transcribe(req: SttRequest): Promise<SttResponse>;
  synthesize(req: TtsRequest): Promise<TtsResponse>;
  healthCheck(): Promise<boolean>;
}

/** Languages the platform commits to (FR-CUS-008 11-language framework). */
export const SUPPORTED_LANGUAGES = [
  'en-IN', 'ta-IN', 'hi-IN', 'te-IN', 'kn-IN', 'ml-IN',
  'mr-IN', 'bn-IN', 'gu-IN', 'pa-IN', 'od-IN',
] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];
export const LAUNCH_LANGUAGES: LanguageCode[] = ['en-IN', 'ta-IN'];

export function isSupportedLanguage(code: string): code is LanguageCode {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(code);
}

/**
 * Per-session token budget with a kill-switch (Vol. 10 AI-abuse row + FR-ADM-011).
 * Provider-independent, so it wraps whichever LLM adapter is live.
 */
export class SessionBudget {
  private spent = 0;
  private killed = false;

  constructor(private readonly maxTokens: number) {
    if (maxTokens <= 0) throw new Error('maxTokens must be positive');
  }

  /** FR-ADM-011 kill-switch: trips immediately and cannot be un-tripped. */
  kill(): void {
    this.killed = true;
  }

  isKilled(): boolean {
    return this.killed;
  }

  remaining(): number {
    return Math.max(0, this.maxTokens - this.spent);
  }

  /** Reserve budget before a call; refuses if killed or the request cannot fit. */
  tryReserve(estimatedTokens: number): boolean {
    if (this.killed) return false;
    if (this.spent + estimatedTokens > this.maxTokens) return false;
    return true;
  }

  record(usage: LlmUsage): void {
    this.spent += usage.inputTokens + usage.outputTokens;
  }

  spentTokens(): number {
    return this.spent;
  }
}

export type LlmOutcome =
  | { ok: true; response: LlmResponse }
  | { ok: false; reason: 'BUDGET_EXCEEDED' | 'KILLED' | 'ALL_PROVIDERS_FAILED'; errors?: string[] };

/**
 * Ordered LLM fallback chain (Vol. 7 §7.x provider chains; FR-CUS-008 resilience).
 * Tries providers in order, enforcing the session budget and the 6-hop cap; a provider
 * error falls through to the next. The chain is constructed with real adapters only —
 * there is deliberately no built-in mock, so a missing key surfaces as a failed health
 * check, never as a fabricated answer.
 */
export class LlmChain {
  static readonly MAX_HOPS = 6; // Vol. 10 §10.6 "6-hop budget"

  constructor(private readonly providers: LlmProvider[]) {
    if (providers.length === 0) throw new Error('LlmChain needs at least one provider');
  }

  async complete(req: LlmRequest, budget: SessionBudget, hop = 0): Promise<LlmOutcome> {
    if (budget.isKilled()) return { ok: false, reason: 'KILLED' };
    if (hop >= LlmChain.MAX_HOPS) return { ok: false, reason: 'BUDGET_EXCEEDED', errors: ['6-hop cap reached'] };

    const estimate = req.maxTokens + estimateInputTokens(req.messages, req.context);
    if (!budget.tryReserve(estimate)) return { ok: false, reason: 'BUDGET_EXCEEDED' };

    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        const response = await p.complete(req);
        budget.record(response.usage);
        // Re-authorise any tool call against the allow-list (deny-by-default).
        if (response.toolCall && !(req.allowedTools ?? []).includes(response.toolCall.name)) {
          errors.push(`${p.name}: tool '${response.toolCall.name}' not in allow-list`);
          continue;
        }
        return { ok: true, response };
      } catch (e) {
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    return { ok: false, reason: 'ALL_PROVIDERS_FAILED', errors };
  }
}

/** Coarse token estimate (~4 chars/token) for pre-call budgeting; adapters report exact. */
export function estimateInputTokens(messages: LlmMessage[], context?: string[]): number {
  const chars =
    messages.reduce((a, m) => a + m.content.length, 0) +
    (context ?? []).reduce((a, c) => a + c.length, 0);
  return Math.ceil(chars / 4);
}
