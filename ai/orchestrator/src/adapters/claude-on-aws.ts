/**
 * Claude Platform on AWS adapter for the {@link LlmProvider} port.
 *
 * "Claude Platform on AWS" exposes an Anthropic-compatible Messages API behind an
 * AWS-account gateway. The long-term console key ("AeaApiKey-…") is presented as a
 * Bearer token; the request/response bodies follow the Anthropic Messages shape, so this
 * adapter reuses that mapping and differs only in base URL and auth header.
 *
 * Endpoint policy: the gateway host is injected via config (CLAUDE_AWS_ENDPOINT), never
 * hard-coded — the account/region URL comes from the console "Quickstart" page. If the
 * host is unreachable (e.g. blocked by network egress rules), {@link healthCheck} returns
 * false and {@link complete} throws, so the orchestrator falls through instead of
 * fabricating a reply.
 *
 * SANDBOX NOTE: this build could not execute a live call — the sandbox egress allow-list
 * excludes AWS hosts (the gateway returned "Host not in allowlist"). The adapter is
 * written to the documented contract and will make real calls wherever AWS egress is
 * permitted (CI, staging, prod). See docs/CREDENTIALS.md.
 */
import { LlmProvider, LlmRequest, LlmResponse } from '../ports/ai.js';

export interface ClaudeOnAwsConfig {
  token: string;         // AeaApiKey long-term token (Bearer)
  endpoint: string;      // account/region gateway base URL (no default; injected)
  model: string;
  anthropicVersion?: string;
  timeoutMs?: number;
}

export class ClaudeOnAwsLlmAdapter implements LlmProvider {
  readonly name = 'claude-on-aws';
  private readonly cfg: Required<ClaudeOnAwsConfig>;

  constructor(cfg: ClaudeOnAwsConfig) {
    this.cfg = { anthropicVersion: '2023-06-01', timeoutMs: 30_000, ...cfg };
    if (!this.cfg.token) throw new Error('claude-on-aws: token required');
    if (!this.cfg.endpoint) throw new Error('claude-on-aws: endpoint required (no default host)');
    if (!this.cfg.model) throw new Error('claude-on-aws: model required');
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    const systemWithContext = req.context?.length
      ? `${system}\n\n<context>\n${req.context.join('\n---\n')}\n</context>`
      : system;

    const body: Record<string, unknown> = { model: this.cfg.model, max_tokens: req.maxTokens, messages: turns };
    if (systemWithContext) body.system = systemWithContext;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const url = this.cfg.endpoint.replace(/\/+$/, '') + '/v1/messages';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': this.cfg.anthropicVersion,
          authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await safeError(res);
      throw new Error(`claude-on-aws HTTP ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as AwsMessagesResponse;
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    const toolUse = (data.content ?? []).find((b) => b.type === 'tool_use');

    return {
      text,
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      toolCall: toolUse ? { name: toolUse.name ?? '', argumentsJson: JSON.stringify(toolUse.input ?? {}) } : undefined,
      provider: this.name,
      model: this.cfg.model,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await this.complete({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 4 });
      return typeof r.text === 'string';
    } catch {
      return false;
    }
  }
}

interface AwsMessagesResponse {
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function safeError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { type?: string; message?: string }; message?: string };
    return `${j.error?.type ?? 'error'}: ${(j.error?.message ?? j.message ?? '').slice(0, 140)}`;
  } catch {
    return res.statusText;
  }
}
