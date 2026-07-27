/**
 * AI orchestrator port guarantees (FR-AI-001 / Vol.10 §10.6), tested WITHOUT any live
 * credential: session token budget, FR-ADM-011 kill-switch, 6-hop cap, provider
 * fallback, and deny-by-default tool re-authorisation. Providers here are in-test
 * doubles that implement the port — the production chain carries no built-in mock, so a
 * missing key fails a health check instead of fabricating output.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateInputTokens,
  isSupportedLanguage,
  LAUNCH_LANGUAGES,
  LlmChain,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  SessionBudget,
  SUPPORTED_LANGUAGES,
} from '../src/ports/ai.js';

function stubProvider(name: string, impl: (req: LlmRequest) => LlmResponse | Promise<LlmResponse>): LlmProvider {
  return {
    name,
    complete: async (req) => impl(req),
    healthCheck: async () => true,
  };
}

const reply = (name: string, text: string, inTok = 10, outTok = 5): LlmProvider =>
  stubProvider(name, () => ({ text, usage: { inputTokens: inTok, outputTokens: outTok }, provider: name, model: `${name}-test` }));

const boom = (name: string): LlmProvider =>
  stubProvider(name, () => { throw new Error('provider unavailable'); });

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: 'track my order' }],
  maxTokens: 50,
  ...over,
});

describe('language framework (FR-CUS-008)', () => {
  it('commits to 11 languages with en-IN and ta-IN at launch', () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(11);
    expect(LAUNCH_LANGUAGES).toEqual(['en-IN', 'ta-IN']);
    expect(isSupportedLanguage('ta-IN')).toBe(true);
    expect(isSupportedLanguage('fr-FR')).toBe(false);
  });
});

describe('SessionBudget (Vol.10 AI-abuse row, FR-ADM-011)', () => {
  it('reserves within budget and refuses once it would overspend', () => {
    const b = new SessionBudget(100);
    expect(b.tryReserve(60)).toBe(true);
    b.record({ inputTokens: 40, outputTokens: 20 });   // 60 spent
    expect(b.remaining()).toBe(40);
    expect(b.tryReserve(41)).toBe(false);
    expect(b.tryReserve(40)).toBe(true);
  });

  it('kill-switch trips immediately and cannot be reversed', () => {
    const b = new SessionBudget(1000);
    b.kill();
    expect(b.isKilled()).toBe(true);
    expect(b.tryReserve(1)).toBe(false);
  });
});

describe('LlmChain', () => {
  it('returns the first healthy provider and records its usage against the budget', async () => {
    const chain = new LlmChain([reply('anthropic', 'PIXCART-OK', 12, 8)]);
    const budget = new SessionBudget(1000);
    const out = await chain.complete(req(), budget);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response.text).toBe('PIXCART-OK');
    expect(budget.spentTokens()).toBe(20);
  });

  it('falls through a failing provider to the next (resilience)', async () => {
    const chain = new LlmChain([boom('primary'), reply('secondary', 'from-fallback')]);
    const out = await chain.complete(req(), new SessionBudget(1000));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response.provider).toBe('secondary');
  });

  it('reports ALL_PROVIDERS_FAILED with per-provider errors when every hop fails', async () => {
    const chain = new LlmChain([boom('p1'), boom('p2')]);
    const out = await chain.complete(req(), new SessionBudget(1000));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('ALL_PROVIDERS_FAILED');
      expect(out.errors).toHaveLength(2);
    }
  });

  it('refuses to call anything when the session is killed', async () => {
    const budget = new SessionBudget(1000);
    budget.kill();
    const out = await new LlmChain([reply('anthropic', 'should-not-run')]).complete(req(), budget);
    expect(out).toEqual({ ok: false, reason: 'KILLED' });
  });

  it('refuses when the estimated call cannot fit the remaining budget', async () => {
    const out = await new LlmChain([reply('anthropic', 'x')]).complete(req({ maxTokens: 500 }), new SessionBudget(50));
    expect(out).toEqual({ ok: false, reason: 'BUDGET_EXCEEDED' });
  });

  it('enforces the 6-hop cap (Vol.10 §10.6)', async () => {
    const out = await new LlmChain([reply('anthropic', 'x')]).complete(req(), new SessionBudget(100000), LlmChain.MAX_HOPS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('BUDGET_EXCEEDED');
  });

  it('deny-by-default: a tool call outside the allow-list is rejected, not executed', async () => {
    const rogue = stubProvider('rogue', () => ({
      text: '', usage: { inputTokens: 5, outputTokens: 5 }, provider: 'rogue', model: 'r',
      toolCall: { name: 'delete_account', argumentsJson: '{}' },
    }));
    const out = await new LlmChain([rogue]).complete(
      req({ allowedTools: ['get_order_status'] }), new SessionBudget(1000));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('ALL_PROVIDERS_FAILED');
  });

  it('allows a tool call that is on the allow-list', async () => {
    const good = stubProvider('good', () => ({
      text: '', usage: { inputTokens: 5, outputTokens: 5 }, provider: 'good', model: 'g',
      toolCall: { name: 'get_order_status', argumentsJson: '{"orderId":"O1"}' },
    }));
    const out = await new LlmChain([good]).complete(
      req({ allowedTools: ['get_order_status'] }), new SessionBudget(1000));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.response.toolCall?.name).toBe('get_order_status');
  });

  it('token estimate counts messages and grounding context', () => {
    expect(estimateInputTokens([{ role: 'user', content: 'a'.repeat(40) }])).toBe(10);
    expect(estimateInputTokens([{ role: 'user', content: 'a'.repeat(40) }], ['b'.repeat(40)])).toBe(20);
  });
});
