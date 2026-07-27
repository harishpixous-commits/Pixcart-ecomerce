/**
 * LLM provider factory — turns a resolved credential into the correct adapter for the
 * {@link LlmChain}, or explains why no provider is available.
 *
 * Deny-by-fabrication: when the credential is unresolved, the factory returns an empty
 * provider list plus a diagnostic. The orchestrator surfaces the diagnostic and the
 * assistant degrades to "unavailable" — it never invents an answer to hide a missing key.
 */
import { LlmProvider } from '../ports/ai.js';
import { AnthropicLlmAdapter } from './anthropic.js';
import { ClaudeOnAwsLlmAdapter } from './claude-on-aws.js';
import { LlmCredential, LlmEnv, resolveLlmCredential } from './llm-config.js';

export interface LlmProviderBuild {
  providers: LlmProvider[];
  diagnostic?: string;
  credentialKind: LlmCredential['kind'];
}

export function buildLlmProviders(env: LlmEnv): LlmProviderBuild {
  const cred = resolveLlmCredential(env);
  switch (cred.kind) {
    case 'anthropic':
      return {
        providers: [new AnthropicLlmAdapter({ apiKey: cred.apiKey, model: cred.model })],
        credentialKind: cred.kind,
      };
    case 'claude-on-aws':
      return {
        providers: [new ClaudeOnAwsLlmAdapter({ token: cred.token, endpoint: cred.endpoint, model: cred.model })],
        credentialKind: cred.kind,
      };
    case 'unresolved':
      return { providers: [], diagnostic: cred.reason, credentialKind: 'unresolved' };
  }
}
