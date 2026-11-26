# Admin AI assistant

A chat and voice assistant inside the admin panel (button at the bottom right, or **Ctrl+J**). Staff ask in any
language — "how much did we sell today?", "இன்னைக்கு எத்தனை ஆர்டர்?", "export last month's returns as PDF",
"compare this file with our orders", "cancel package PC…-1, customer asked" — and get exact answers from live data,
tables, charts, downloads and confirm-before-run changes.

## How one question is answered

```
browser ──POST /api/admin/assistant/conversations/{id}/messages (SSE)──▶ AssistantAskBAL
   1 save the question; load memory notes, attached files, recent history (older turns condensed)
   2 decision layer ──▶ intent, areas, period, tools to offer, prefetch
   3 prefetch (e.g. business_overview for "today") runs now; cards stream to the screen
   4 model turn on the route's fallback chain (LlmRouterBAL) ──▶ text streams; tool calls ──▶ AssistantToolsBAL
        (permission re-checked; cards stream; results go back to the model) … up to max_steps
   5 save reply (text + cards + model content) and token usage (AI usage log, monthly budget)
events: start · decision · tool · card · text · done | error
```

Without a connected model, `AssistantSandbox` answers common questions with the same real tools (cards are exact; only
the sentence is a template), so the panel works from day one.

## Exact numbers

All figures come from SQL in the assistant queries (`DAL/AssistantQueries*DAL.cs`), with the dashboard's definitions (sales = package totals of
placed orders excluding cancellations; net = sales − returns; AOV = sales ÷ orders). Periods are resolved on the
server (IST). Cards are built from the same data, so what is on screen never depends on the model's
wording. The system prompt forbids stating a figure that did not come from a tool.

## What it can do, by permission

| Permission | Allows |
|---|---|
| `assistant` | Chat; tools for every area the role can already see (orders → order tools, payouts → payout tools…) |
| `assistant_files` | Upload CSV/Excel/text/JSON (5 MB, 50,000 rows), `file_overview`, `file_query` (exact sums/counts), `file_compare` against live orders, packages, products (SKU), payouts, customers, sellers |
| `assistant_actions` | `propose_action` (approve/reject listings and sellers, cancel/deliver packages, refunds, returns, block customers, coupons, ticket replies, review moderation, settings, announcement, payouts). Each needs Confirm and the action's own permission |
| `assistant_voice` | Dictation and voice mode |
| `settings` | Assistant settings page |
| `ai_providers` | LLM connections, keys and routes |

Conversations, uploads and memory notes are private to the person. Files are deleted after 7 days; unconfirmed
actions expire after 30 minutes.

## Privacy

With **Send contact details to the AI provider** off (default), phone numbers, emails and addresses are masked in
everything sent to the model; staff still see them in the cards. Tool results, uploads, listings,
reviews and tickets are treated as data — instructions inside them are ignored. Keys are never in prompts.

## Models and providers (`BAL/AI`)

Admin → **AI providers**: add connections (Anthropic, OpenAI, Azure OpenAI, Google Gemini, Groq, Mistral, DeepSeek,
xAI, OpenRouter, Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, or any OpenAI-compatible server), several
keys each, and ordered routes:

- `assistant` — chat and tools (needs tool calling),
- `assistant_fast` — short spoken answers (falls back to `assistant`),
- `studio` — AI studio drafts.

On a 429/401/402 the key cools down and the next key is tried; on other failures the next model/provider. A reply
never switches model mid-stream. With nothing configured, the Claude key from Integrations is used.

## Decision layer (`BAL/AssistantDecision.cs`)

Runs before the model, in milliseconds:

- **Rules (default)** — English, Tamil, Hindi and Tanglish keywords and dates; detects order numbers, phones, emails.
- **Laya** — an open-weight System 1 decision model (Apache-2.0) that returns a calibrated choice and confidence
  instead of generating text. Run it, serve it over https at a public address (for example behind the load
  balancer) and enter that address in Admin → AI assistant:

  ```bash
  pip install "laya[serve]"
  LAYA_PRELOAD=1 LAYA_API_KEY=<long-random-token> laya-serve          # GPU recommended; CPU works
  ```
  The assistant calls `POST <address>/predict` with `{"state": <question>, "questions": {intent, area}}` and uses
  `answers.<q>.choice/confidence`. If Laya does not answer within the timeout, the rules decide.
  Every staff question goes to this server, so the address must be https and public (no private, loopback,
  link-local or cloud metadata addresses), and changing the address, path or token needs the **AI providers**
  permission plus your password (and authenticator code when two-step sign-in is on). A new address or path
  drops the saved token unless a new one is entered with it.
- **Off** — every tool offered, nothing prefetched.

Low confidence always offers every tool, so the layer only speeds things up; it never hides a capability.

## Voice (`PixCartWeb/src/app/core/speech.ts`)

- **Dictation** (mic in the input box) types what you say.
- **Voice mode** (speaker icon): tap and speak → the answer is spoken sentence by sentence *while it streams* →
  listens again (hands-free). Tap the orb while it speaks to interrupt. Replies in voice mode are short and spoken-style.
- Uses the browser's speech engines (best in Chrome/Edge; Tamil, Hindi, English (India) and more). Languages,
  default language, voice, speed, pitch and auto-listen are set in Admin → AI assistant.

## Downloads

Each reply: PDF, Excel (one sheet per table + the answer), CSV, Markdown, JSON. Whole chat: PDF, Excel, Markdown,
JSON. Built from the saved cards, never regenerated.

## Memory

Within a chat: the last N messages verbatim (setting), older ones condensed. Across chats: notes the person saves
("remember that I want amounts with GST") via the `remember` tool or the settings page; they are added to every request.

## Extending

New tool: its spec in `AssistantTools.cs` and its handler in `AssistantToolHandlers.cs` (+ domain in
`AssistantDecision.DomainTools`). New action: `AssistantActionsBAL`. New provider type: `BAL/AI/Llm.cs`.
Tests: `PixCartAPI/Tests/Assistant*Tests.cs`.
