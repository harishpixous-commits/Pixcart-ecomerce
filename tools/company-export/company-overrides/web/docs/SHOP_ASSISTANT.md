# Shop assistant (customer chat on the website)

The **Help** button on every storefront page opens a chat and voice assistant for shoppers. It is a separate
system from the staff [AI assistant](AI_ASSISTANT.md): its own code, tables, settings, knowledge base, prompts,
tools, API routes and permissions. It can never read admin data.

## What customers can do

| Journey | Guest | Signed-in customer |
|---|---|---|
| Find products ("running shoes under 2000"), product questions | ✓ | ✓ |
| Policies: delivery fee and days, COD, returns, refunds, sign-in/OTP, coupons, invoices, selling, grievance | ✓ | ✓ |
| Where is my order? Package progress, courier, tracking link, expected date | asked to sign in | ✓ |
| Cancel before shipping (a **Yes, cancel** button; nothing happens until pressed) | — | ✓ |
| Return eligibility and last date, damaged/wrong item help | — | ✓ |
| Return and refund status | — | ✓ |
| Talk to a person: a pre-filled support request the customer edits and **Sends**; the chat is attached for the team | — | ✓ |
| Request status, with the team's latest reply (staff-only notes never shown) | — | ✓ |
| Voice: speak a question, hear the answer, or hands-free conversation (English, Tamil, Hindi; any browser language can be added) | ✓ | ✓ |

Customers can write in English, Tanglish, Tamil or Hindi. A guest chat moves to the customer's account when they
sign in. Each chat has a "Was this helpful?" rating.

## How an answer is made

```
storefront widget ──POST /api/shop-assistant/sessions/{id}/messages (SSE)──▶ ShopAssistantBAL
  1 save the message; ShopIntents.Detect() (multilingual rules: track, cancel, return, refund, payment, search, human…)
  2 live mode   — AI model on the "shop_assistant" route + customer tools only; streams text and cards
    guided mode — no model / budget used up / "Guided only" / the model fails: same tools chosen by the intent,
                  sentences from ShopReplies (English, Tamil, Hindi). Customers always get an answer.
  3 save the reply; in live mode record tokens (ai_runs task "shop_assistant", no chat text)
events: start · tool · card · text · done | error
```

## Why admin data cannot leak

- **Separate code**: the shop assistant (`BAL/ShopAssistant`, `ShopAssistantBAL`) never calls the admin assistant
  or the admin controllers.
- **Separate data**: tables `shop_chat_sessions`, `shop_chat_messages`, `shop_chat_actions`, `shop_kb_articles`;
  settings key `platform_settings['shop_assistant']`. The admin assistant's chats, uploads, memory and actions are
  never read.
- **Customer-only tools** (`ShopToolSpecs`): public products, published help articles and pages, a whitelist of public
  settings, and the signed-in customer's own orders, returns, refunds and tickets. The
  customer comes from the session, never from the model; queries filter by `user_id`, so another customer's order
  number finds nothing. Asking for an admin tool returns "no such tool".
- **Whitelist views** (`ShopAssistantViews`): commission, payouts, TCS/TDS, settlement, seller KYC, SKUs, tax splits and
  staff-only ticket notes have no field in any card or model input.
- **Confirm before change**: cancellations run only when the customer presses the button (re-checked, 30-minute
  expiry, one use). Support requests are sent only from the form.
- **Guests** reach their chat only with the key their browser received; limits are per chat, per account and a
  wide per-IP guard.
- The prompt treats customer text, listings and articles as information, refuses to act as staff, and never asks
  for OTPs, passwords, card numbers or UPI PINs.

## Admin → Shop assistant

| Tab | Permission | What |
|---|---|---|
| Settings and switches | `shop_assistant` | Master **on/off**, guests on/off, each feature on/off (products, orders, cancel, returns/refunds, support requests, help articles), AI or guided mode, monthly AI token budget, answer length, house rules, name, greeting, quick replies, voice (on/off, languages, default, read aloud, hands-free, speed, pitch), message limits |
| Help articles | `shop_assistant_kb` | Write, publish/hide, order and delete the articles the chat answers from; keywords in any language; placeholders such as `{free_delivery_amount}` filled from live settings; **Try a question** shows which article would answer |
| Customer chats | `shop_assistant_chats` | Read chats (filter by rating or "sent to support"), with the linked support request |
| Statistics | `shop_assistant_chats` | Chats, questions, voice use, escalations, ratings, cancellations, AI vs guided, top questions and articles |

Starting roles: **Owner** all three; **Operations** and **Customer support** articles + chats; **Marketing** articles.
Change them in Admin → Staff and roles.

The AI model is chosen in Admin → AI providers, route **Shop assistant (customer chat on the website)**. Empty =
the AI assistant's route. It needs a model with tool calling.

## API

Customer: `GET /api/shop-assistant/config`, `POST /sessions`, `GET /sessions`, `GET /sessions/{id}`,
`POST /sessions/{id}/messages` (SSE), `POST /sessions/{id}/ticket`, `POST /sessions/{id}/feedback`,
`POST /actions/{id}/confirm`, `POST /actions/{id}/dismiss`. Guests send `X-Chat-Key`.

Admin: `/api/admin/shop-assistant/settings` (GET, PUT), `/articles` (GET, POST, PUT, DELETE, `POST /articles/try`),
`/chats`, `/chats/{id}`, `/stats`.

## Extending

New tool: its spec in `ShopToolSpecs` (with its sign-in and feature flags), returning data from `ShopAssistantViews`.
New intent words: `ShopIntents`. New guided sentence: `ShopReplies`. Starter articles: `ShopStarter` (added once to
an empty knowledge base). Tests: `PixCartAPI/Tests/ShopAssistantLiveTests.cs`.
