/**
 * Credential resolution tests (FR-AI-001 provider wiring). These prove the platform
 * classifies keys correctly and — crucially — refuses to guess an AWS endpoint, using
 * the SHAPE of the actual key that was uploaded. No secret value is hard-coded here: the
 * AWS-style fixtures are synthetic tokens with the same structure, so the test is safe to
 * commit and still exercises the real code path.
 */
import { describe, expect, it } from 'vitest';
import { buildLlmProviders } from '../src/adapters/llm-factory.js';
import { inspectAwsKey, resolveLlmCredential } from '../src/adapters/llm-config.js';

/** Build a synthetic Claude-on-AWS token with the real embedded structure. */
function fakeAwsToken(keyId: string, accountId: string, secret: string): string {
  const inner = `AeaApiKey-${keyId}-at-${accountId}:${secret}`;
  return Buffer.from(inner, 'utf8').toString('base64url');
}

describe('LLM credential resolution', () => {
  it('classifies an sk-ant key as Anthropic first-party', () => {
    const c = resolveLlmCredential({ ANTHROPIC_API_KEY: 'sk-ant-abc123', LLM_MODEL: 'claude-3-5-haiku-20241022' });
    expect(c.kind).toBe('anthropic');
    if (c.kind === 'anthropic') expect(c.model).toBe('claude-3-5-haiku-20241022');
  });

  it('decodes the embedded account id from a Claude-on-AWS token', () => {
    const tok = fakeAwsToken('uzztxbo8', '276699357742', 'x'.repeat(40));
    const info = inspectAwsKey(tok);
    expect(info.accountId).toBe('276699357742');
    expect(info.keyId).toBe('uzztxbo8');
  });

  it('refuses to guess a host when a Claude-on-AWS key has no endpoint configured', () => {
    const tok = fakeAwsToken('uzztxbo8', '276699357742', 'x'.repeat(40));
    const c = resolveLlmCredential({ CLAUDE_AWS_API_KEY: tok });
    expect(c.kind).toBe('unresolved');
    if (c.kind === 'unresolved') {
      expect(c.reason).toContain('276699357742');
      expect(c.reason).toContain('CLAUDE_AWS_ENDPOINT');
    }
  });

  it('resolves a Claude-on-AWS credential once the endpoint is supplied', () => {
    const tok = fakeAwsToken('uzztxbo8', '276699357742', 'x'.repeat(40));
    const c = resolveLlmCredential({
      CLAUDE_AWS_API_KEY: tok,
      CLAUDE_AWS_ENDPOINT: 'https://gateway.example-aws.invalid',
      CLAUDE_AWS_REGION: 'eu-north-1',
    });
    expect(c.kind).toBe('claude-on-aws');
    if (c.kind === 'claude-on-aws') {
      expect(c.accountId).toBe('276699357742');
      expect(c.endpoint).toBe('https://gateway.example-aws.invalid');
    }
  });

  it('treats the ACTUAL uploaded key shape as Claude-on-AWS needing an endpoint (not sk-ant)', () => {
    // The uploaded value decoded to "...AeaApiKey-uzztxbo8-at-276699357742:<secret>".
    // Reproduce ONLY its structure, never its secret, and assert the platform routes it
    // to the AWS path and demands an endpoint rather than calling api.anthropic.com.
    const tok = fakeAwsToken('uzztxbo8', '276699357742', 'S'.repeat(60));
    const build = buildLlmProviders({ ANTHROPIC_API_KEY: tok });
    expect(build.credentialKind).toBe('unresolved');
    expect(build.providers).toHaveLength(0);
    expect(build.diagnostic).toContain('276699357742');
  });

  it('builds an Anthropic provider (length 1) for a valid sk-ant key', () => {
    const build = buildLlmProviders({ ANTHROPIC_API_KEY: 'sk-ant-live-key' });
    expect(build.credentialKind).toBe('anthropic');
    expect(build.providers).toHaveLength(1);
    expect(build.providers[0].name).toBe('anthropic');
  });

  it('builds a Claude-on-AWS provider when key + endpoint are both present', () => {
    const tok = fakeAwsToken('uzztxbo8', '276699357742', 'S'.repeat(60));
    const build = buildLlmProviders({
      CLAUDE_AWS_API_KEY: tok,
      CLAUDE_AWS_ENDPOINT: 'https://gateway.example-aws.invalid',
    });
    expect(build.credentialKind).toBe('claude-on-aws');
    expect(build.providers[0].name).toBe('claude-on-aws');
  });

  it('returns a clear diagnostic when no credential is present at all', () => {
    const build = buildLlmProviders({});
    expect(build.providers).toHaveLength(0);
    expect(build.diagnostic).toBe('No LLM credential provided.');
  });
});
