# Credentials & external providers — status

This file tracks external credentials the platform needs. **No secret values live in the
repository**; they are injected at runtime from a vault / environment (Vol. 10 §10.5).
Names below are configuration keys, not values.

## Current status (Slice 4)

| Provider | Config key | Purpose (FR) | Status |
|---|---|---|---|
| **AWS Bedrock (Claude)** | `BEDROCK_API_KEY` `BEDROCK_REGION` `BEDROCK_MODEL_ID` | Assistant LLM (FR-AI-001/002, FR-CUS-008) | **Valid key, correct adapter — blocked by sandbox network only.** The value is a Bedrock long-term API key (`AeaApiKey-…-276699357742`, account 276699357742, region eu-north-1 / Stockholm), not an Anthropic first-party key. It authenticates with `Authorization: Bearer` against `bedrock-runtime.<region>.amazonaws.com`. This sandbox's egress allow-list excludes that host (proxy returns `403 x-deny: host_not_allowed`), so it cannot be exercised here. It will work unchanged wherever the host is reachable — validate with `scripts/verify-bedrock.mjs`. |
| Sarvam AI | `SARVAM_API_KEY` | STT/TTS/translate (FR-CUS-008 voice, 11-lang) | **Missing** — uploaded value was the literal placeholder `YOUR_SARVAM_API_KEY`. |
| Payment gateway | `PAYMENT_*` | FR-CUS-014 capture, FR-FIN-* | Not selected (Razorpay / Cashfree / PhonePe). |
| Courier aggregator | `COURIER_*` | FR-LOG-001 | Not selected. |
| SMS (DLT) / Email / WhatsApp | `SMS_*` `ESP_*` `WA_*` | FR-CUS-016/017 | Not provided. |

## Bedrock: earlier misdiagnosis, now corrected

An earlier slice reported this key "rejected 401". That was because it was tried against
the Anthropic first-party API (`api.anthropic.com`, `x-api-key`). The AWS console
screenshot showed it is a **Bedrock** key; against the Bedrock runtime with `Bearer` auth
the response is no longer 401 but `403 host_not_allowed` — a sandbox network block, not an
auth failure. The adapter (`src/adapters/bedrock.ts`) and verifier
(`scripts/verify-bedrock.mjs`) implement the Bedrock contract exactly.

**To activate in a Bedrock-reachable environment:**
```
BEDROCK_API_KEY=<key> node ai/orchestrator/scripts/verify-bedrock.mjs
# prints the working BEDROCK_REGION and BEDROCK_MODEL_ID; set all three and the
# BedrockLlmAdapter becomes the orchestrator's primary provider (healthCheck passes).
```
If, from your side, every probe line is `403 host_not_allowed`, that host must be added to
the network allow-list (an org-owner setting) — the key itself is fine.

## Older note (superseded)


## Claude on AWS — what to send

The key is fine; I need the **endpoint** it talks to. On the console page in your
screenshot, open **Quickstart** — it shows the base URL / curl example for account
`276699357742` (region `eu-north-1`). Send me that URL, then set in the runtime:

```
CLAUDE_AWS_API_KEY=<the AeaApiKey long-term token>
CLAUDE_AWS_ENDPOINT=<the gateway base URL from Quickstart>
CLAUDE_AWS_REGION=eu-north-1
```

`buildLlmProviders` then auto-selects the Claude-on-AWS adapter as the primary LLM — no
code change. From THIS sandbox the AWS host is blocked, so the live call runs in
CI/staging/prod where AWS egress is allowed. An Anthropic first-party `sk-ant-` key also
works via the same factory if you prefer that path.

## What is already built against these (so keys drop in with no rework)

- `ai/orchestrator/src/ports/ai.ts` — vendor-neutral `LlmProvider` / `SpeechProvider`
  ports, `LlmChain` fallback, `SessionBudget` (kill-switch, 6-hop cap), language framework.
  Fully unit-tested with in-test doubles; **the production chain has no built-in mock**, so
  a missing key fails a health check rather than fabricating an answer.
- `ai/orchestrator/src/adapters/anthropic.ts` — real `/v1/messages` adapter. Becomes the
  primary LLM provider automatically once a valid key passes `healthCheck()`.

A Sarvam `SpeechProvider` adapter follows the same shape and will be added when a real
`SARVAM_API_KEY` is provided (the uploaded value was a placeholder).
