/**
 * Wire-level integration test for the Claude-on-AWS adapter.
 *
 * The real AWS gateway is unreachable from CI's sandbox (egress allow-list), so this test
 * stands up a LOCAL http server that speaks the Anthropic Messages contract and points the
 * adapter at it. That proves the adapter's real behaviour — Bearer auth header, /v1/messages
 * path, system+context assembly, usage parsing, tool-call extraction, error propagation —
 * with an actual network round-trip, not a stubbed fetch. Wherever the real AWS host is
 * allowed, the identical code path runs against it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ClaudeOnAwsLlmAdapter } from '../src/adapters/claude-on-aws.js';

let server: Server;
let base: string;
let lastRequest: { path: string; auth?: string; body: any } | null = null;
let mode: 'ok' | 'tool' | 'error' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastRequest = { path: req.url ?? '', auth: req.headers['authorization'] as string, body: JSON.parse(raw || '{}') };
      if (mode === 'error') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      if (mode === 'tool') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'tool_use', name: 'get_order_status', input: { orderId: 'O1' } }],
          usage: { input_tokens: 11, output_tokens: 3 },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: 'PIXCART-OK' }],
        usage: { input_tokens: 9, output_tokens: 4 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));


describe('ClaudeOnAwsLlmAdapter wire behaviour', () => {
  it('sends Bearer auth to /v1/messages and returns text + usage', async () => {
    mode = 'ok';
    const a = new ClaudeOnAwsLlmAdapter({ token: 'AeaApiKey-test', endpoint: base, model: 'claude-3-5-haiku-20241022' });
    const r = await a.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 });
    expect(r.text).toBe('PIXCART-OK');
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(r.provider).toBe('claude-on-aws');
    expect(lastRequest?.path).toBe('/v1/messages');
    expect(lastRequest?.auth).toBe('Bearer AeaApiKey-test');
  });

  it('assembles system + grounding context into the request body', async () => {
    mode = 'ok';
    const a = new ClaudeOnAwsLlmAdapter({ token: 'T', endpoint: base, model: 'm' });
    await a.complete({
      messages: [{ role: 'system', content: 'be helpful' }, { role: 'user', content: 'track order' }],
      context: ['order O1 shipped', 'EDD tomorrow'],
      maxTokens: 16,
    });
    expect(lastRequest?.body.system).toContain('be helpful');
    expect(lastRequest?.body.system).toContain('<context>');
    expect(lastRequest?.body.system).toContain('order O1 shipped');
    expect(lastRequest?.body.messages).toEqual([{ role: 'user', content: 'track order' }]);
  });

  it('extracts a tool_use call from the response', async () => {
    mode = 'tool';
    const a = new ClaudeOnAwsLlmAdapter({ token: 'T', endpoint: base, model: 'm' });
    const r = await a.complete({ messages: [{ role: 'user', content: 'where is my order' }], maxTokens: 16 });
    expect(r.toolCall).toEqual({ name: 'get_order_status', argumentsJson: JSON.stringify({ orderId: 'O1' }) });
  });

  it('propagates a gateway error (no fabricated answer) so the chain can fall through', async () => {
    mode = 'error';
    const a = new ClaudeOnAwsLlmAdapter({ token: 'T', endpoint: base, model: 'm' });
    await expect(a.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }))
      .rejects.toThrow(/claude-on-aws HTTP 429.*rate_limit_error/);
  });

  it('healthCheck is true against a live-shaped endpoint and false when it errors', async () => {
    mode = 'ok';
    const a = new ClaudeOnAwsLlmAdapter({ token: 'T', endpoint: base, model: 'm' });
    expect(await a.healthCheck()).toBe(true);
    mode = 'error';
    expect(await a.healthCheck()).toBe(false);
  });
});
