# Credentials & external providers — status

This file tracks external credentials the platform needs. **No secret values live in the
repository**; they are injected at runtime from a vault / environment (Vol. 10 §10.5).
Names below are configuration keys, not values.

## Current status (Slice 3)

| Provider | Config key | Purpose (FR) | Status |
|---|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | Assistant LLM (FR-AI-001/002, FR-CUS-008) | **Rejected — HTTP 401.** Value supplied was 132 chars, prefix `AEAAQW…`, not an `sk-ant-…` key. Adapter registered but unhealthy. |
| Sarvam AI | `SARVAM_API_KEY` | STT/TTS/translate (FR-CUS-008 voice, 11-lang) | **Missing.** Uploaded file carried the literal placeholder `YOUR_SARVAM_API_KEY`. |
| Payment gateway | `PAYMENT_*` | FR-CUS-014 capture, FR-FIN-* | Not selected (Razorpay / Cashfree / PhonePe — awaiting decision). |
| Courier aggregator | `COURIER_*` | FR-LOG-001 | Not selected (Shiprocket / ClickPost / Delhivery). |
| SMS (DLT) / Email / WhatsApp | `SMS_*` `ESP_*` `WA_*` | FR-CUS-016/017 notifications | Not provided. |

## How to supply keys safely

Send them as plain `KEY=value` lines (not code snippets, not UTF-16). Validate the
Anthropic key before sending:

```
curl https://api.anthropic.com/v1/messages -s -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
```

`200` = good. `401` = wrong key.

## What is already built against these (so keys drop in with no rework)

- `ai/orchestrator/src/ports/ai.ts` — vendor-neutral `LlmProvider` / `SpeechProvider`
  ports, `LlmChain` fallback, `SessionBudget` (kill-switch, 6-hop cap), language framework.
  Fully unit-tested with in-test doubles; **the production chain has no built-in mock**, so
  a missing key fails a health check rather than fabricating an answer.
- `ai/orchestrator/src/adapters/anthropic.ts` — real `/v1/messages` adapter. Becomes the
  primary LLM provider automatically once a valid key passes `healthCheck()`.

A Sarvam `SpeechProvider` adapter follows the same shape and will be added when a real
`SARVAM_API_KEY` is provided (the uploaded value was a placeholder).
