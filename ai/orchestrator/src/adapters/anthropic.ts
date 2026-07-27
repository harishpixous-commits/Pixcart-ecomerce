/**
 * Anthropic adapter for the {@link LlmProvider} port (FR-AI-001 assistant orchestrator).
 *
 * Talks to the real Messages API (POST https://api.anthropic.com/v1/messages). The API
 * key is injected — never read from source, never logged (Vol. 10 §10.5 secrets policy).
 * This adapter fabricates nothing: if the key is absent or rejected, {@link healthCheck}
 * returns false and {@link complete} throws, so the LlmChain falls through rather than
 * inventing an answer.
 *
 * Status in this build: the orchestrator is wired to construct this adapter, but the key
 * supplied so far is rejected by the API (HTTP 401), so it is registered as unhealthy.
 * The moment a valid `sk-ant-…` key is provided it becomes the primary provider with no
 * code change.
 */
import {
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from '../ports/ai.js';

export interface AnthropicConfig {
  apiKey: string;
  model: string;                 // e.g. claude-sonnet-4-6, claude-haiku-4-5-20251001
  baseUrl?: string;              // default https://api.anthropic.com
  anthropicVersion?: string;     // default 2023-06-01
  timeoutMs?: number;
}

export class AnthropicLlmAdapter implements LlmProvider {
  readonly name = 'anthropic';
  private readonly cfg: Required<AnthropicConfig>;

  constructor(cfg: AnthropicConfig) {
    this.cfg = {
      baseUrl: 'https://api.anthropic.com',
      anthropicVersion: '2023-06-01',
      timeoutMs: 30_000,
      ...cfg,
    };
    if (!this.cfg.apiKey) throw new Error('anthropic: apiKey required');
    if (!this.cfg.model) throw new Error('anthropic: model required');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    // Anthropic takes a top-level system string; the rest map 1:1 to user/assistant turns.
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    // Grounding passages are injected as a system-side context block (RAG discipline).
    const systemWithContext = req.context && req.context.length
      ? `${system}\n\n<context>\n${req.context.join('\n---\n')}\n</context>`
      : system;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: req.maxTokens,
      messages: turns,
    };
    if (systemWithContext) body.system = systemWithContext;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': this.cfg.anthropicVersion,
          'x-api-key': this.cfg.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeError(res);
      throw new Error(`anthropic HTTP ${res.status}: ${detail}`); // no key material in message
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const toolUse = (data.content ?? []).find((b) => b.type === 'tool_use');

    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
      toolCall: toolUse ? { name: toolUse.name ?? '', argumentsJson: JSON.stringify(toolUse.input ?? {}) } : undefined,
      provider: this.name,
      model: this.cfg.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await this.complete({
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 4,
      });
      return typeof r.text === 'string';
    } catch {
      return false;
    }
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function safeError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { type?: string; message?: string } };
    return `${j.error?.type ?? 'error'}: ${(j.error?.message ?? '').slice(0, 120)}`;
  } catch {
    return res.statusText;
  }
}
