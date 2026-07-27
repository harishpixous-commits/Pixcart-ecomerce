/**
 * LLM credential resolution — decides which provider a supplied key belongs to and how
 * to authenticate it, WITHOUT hard-coding secrets.
 *
 * Two shapes the platform accepts for the assistant LLM (FR-AI-001):
 *   1. Anthropic first-party  — key looks like `sk-ant-...`; endpoint api.anthropic.com,
 *      header `x-api-key`.
 *   2. Claude Platform on AWS  — long-term key whose decoded form contains
 *      `AeaApiKey-<id>-at-<accountId>`; endpoint and auth are AWS-side (Bearer token to
 *      the account/region gateway). The exact host is an environment/config value, never
 *      guessed in code.
 *
 * This resolver classifies the key and produces a typed config the factory turns into the
 * right adapter. If the key is unrecognised or the required endpoint config is absent, it
 * returns a diagnostic rather than a silent default — a wrong endpoint must never look
 * like a working provider.
 */

export type LlmCredential =
  | { kind: 'anthropic'; apiKey: string; model: string }
  | { kind: 'claude-on-aws'; token: string; endpoint: string; region: string; accountId: string; model: string }
  | { kind: 'unresolved'; reason: string };

export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  /** Claude-on-AWS long-term key (the console "AeaApiKey" token, base64url). */
  CLAUDE_AWS_API_KEY?: string;
  /** Required for the AWS path — the gateway base URL for this account/region. */
  CLAUDE_AWS_ENDPOINT?: string;
  CLAUDE_AWS_REGION?: string;
  LLM_MODEL?: string;
}

const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';

/** Best-effort decode of the AWS long-term key to read its embedded identifier. */
export function inspectAwsKey(token: string): { accountId?: string; keyId?: string } {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    // decoded contains "...AeaApiKey-<id>-at-<accountId>:<secret>"
    const m = decoded.match(/AeaApiKey-([a-z0-9]+)-at-(\d+)/i);
    if (m) return { keyId: m[1], accountId: m[2] };
  } catch {
    /* fall through */
  }
  return {};
}

export function resolveLlmCredential(env: LlmEnv): LlmCredential {
  const model = env.LLM_MODEL || DEFAULT_MODEL;

  // 1. Anthropic first-party.
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic && anthropic.startsWith('sk-ant-')) {
    return { kind: 'anthropic', apiKey: anthropic, model };
  }

  // 2. Claude Platform on AWS.
  const awsKey = (env.CLAUDE_AWS_API_KEY || env.ANTHROPIC_API_KEY)?.trim();
  if (awsKey) {
    const info = inspectAwsKey(awsKey);
    if (info.accountId) {
      if (!env.CLAUDE_AWS_ENDPOINT) {
        return {
          kind: 'unresolved',
          reason:
            `Key is a Claude-on-AWS long-term key (account ${info.accountId}), but ` +
            `CLAUDE_AWS_ENDPOINT is not set. Supply the account/region gateway URL from ` +
            `the "Claude Platform on AWS -> Quickstart" page; this code will not guess a host.`,
        };
      }
      return {
        kind: 'claude-on-aws',
        token: awsKey,
        endpoint: env.CLAUDE_AWS_ENDPOINT,
        region: env.CLAUDE_AWS_REGION || 'unknown',
        accountId: info.accountId,
        model,
      };
    }
    if (anthropic && !anthropic.startsWith('sk-ant-')) {
      return {
        kind: 'unresolved',
        reason:
          `ANTHROPIC_API_KEY is set but is neither an sk-ant- key nor a decodable ` +
          `Claude-on-AWS token. It was rejected by api.anthropic.com (HTTP 401). ` +
          `If this is an AWS console key, set CLAUDE_AWS_API_KEY + CLAUDE_AWS_ENDPOINT instead.`,
      };
    }
  }

  return { kind: 'unresolved', reason: 'No LLM credential provided.' };
}
