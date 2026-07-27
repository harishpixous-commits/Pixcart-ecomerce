#!/usr/bin/env node
/**
 * pixcart-verify-bedrock — one-shot credential + connectivity check for the Bedrock LLM.
 *
 * Run this wherever bedrock-runtime.<region>.amazonaws.com is reachable (CI, a bastion,
 * your laptop). It confirms the key works and discovers the right (region, modelId) pair,
 * then prints the two env vars to set. It does the same thing the orchestrator's
 * healthCheck() does, but standalone so you can validate before deploying.
 *
 * Usage:
 *   BEDROCK_API_KEY=<key> node ai/orchestrator/scripts/verify-bedrock.mjs [region ...]
 *
 * Exit 0 and prints BEDROCK_REGION / BEDROCK_MODEL_ID on success; exit 1 otherwise.
 * No secret is ever printed.
 */
const key = process.env.BEDROCK_API_KEY;
if (!key) {
  console.error('Set BEDROCK_API_KEY in the environment (not on the command line).');
  process.exit(2);
}

const regions = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['eu-north-1', 'eu-central-1', 'eu-west-1', 'us-east-1'];

// EU inference-profile ids are prefixed "eu."; US "us.". Try both against each region.
const models = [
  'eu.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'eu.anthropic.claude-3-haiku-20240307-v1:0',
  'anthropic.claude-3-haiku-20240307-v1:0',
];

const body = JSON.stringify({
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with exactly: PIXCART-BEDROCK-OK' }],
});

async function attempt(region, modelId) {
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
      body,
    });
    if (res.ok) {
      const d = await res.json();
      const text = (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      console.log(`  OK  ${region} / ${modelId}  -> ${JSON.stringify(text)}`);
      return { region, modelId };
    }
    const j = await res.json().catch(() => ({}));
    console.log(`  ${res.status} ${region} / ${modelId}  ${(j.message ?? res.statusText ?? '').slice(0, 80)}`);
  } catch (e) {
    console.log(`  ERR ${region} / ${modelId}  ${String(e.message).slice(0, 80)}`);
  }
  return null;
}

const found = await (async () => {
  for (const r of regions) for (const m of models) {
    const hit = await attempt(r, m);
    if (hit) return hit;
  }
  return null;
})();

if (found) {
  console.log('\nWorking configuration:');
  console.log(`  BEDROCK_REGION=${found.region}`);
  console.log(`  BEDROCK_MODEL_ID=${found.modelId}`);
  process.exit(0);
} else {
  console.error('\nNo (region, model) accepted the key. If every line says 403 host_not_allowed,');
  console.error('the network — not the key — is blocking bedrock-runtime.*.amazonaws.com.');
  process.exit(1);
}
