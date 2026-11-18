# Working on this codebase (for developers and AI coding agents)

Read this first. It explains where things are, the rules every change must follow, and how to prove a change works.
For launching, see `docs/GO_LIVE.md`. For the AI assistant internals, see `docs/AI_ASSISTANT.md`.

## What this is

A multi-seller marketplace for India: storefront (customers), seller hub, admin panel, and an AI assistant inside
the admin panel. Money is in integer **paise**; dates are shown in **IST**; GST, TCS and TDS are computed per package.

```
backend/   FastAPI + SQLAlchemy 2 (async) + PostgreSQL 16 + Alembic          → API on :8000
frontend/  Next.js 16 (App Router) + React 19 + Tailwind                      → web on :3000, proxies /api
e2e/       Playwright browser tests against a running stack
infra/     Terraform for AWS (VPC, RDS, ECS Fargate, ALB, WAF, S3+CloudFront, Secrets Manager)
tools/     razorpay-sim (local Razorpay API + checkout + webhooks) and its smoke test
docs/      GO_LIVE (launch runbook), DEPLOY (AWS details), BUSINESS_RULES, AI_ASSISTANT, SHOP_ASSISTANT
```

### Backend map (`backend/app`)

| Path | What it holds |
|---|---|
| `main.py` | App, middleware, router list |
| `config.py` | Environment settings (defaults only; production refuses unsafe secrets) |
| `core/` | auth deps, `permissions.py` (roles/permission catalogue), errors, security (hashing, Fernet), validators |
| `models/` | Tables. `extended.py` has phase-2+ tables incl. `AdminRole`, `Assistant*`, `AiRun` |
| `routers/` | HTTP endpoints. Admin endpoints take `Perm("<permission>")` |
| `services/` | Business logic: orders, ledger (payouts), returns, invoices, exports, docgen (Excel/PDF), notify, cms |
| `integrations/` | Third-party keys: `registry` (fields), `store` (encrypted, merged over env), `checks` (Test connection) |
| `llm/` | Any LLM provider: `catalog` (types), `config` (connections/keys/routes), `adapters` (Anthropic + OpenAI-compatible), `router` (fallbacks) |
| `ai/` | AI studio tasks (drafts that a person reviews) and risk briefs |
| `shop_assistant/` | Customer chat on the storefront: `agent` (live + guided), `intents` (multilingual rules), customer-only `tools`, whitelist `views`, `kb` (help articles + public facts), `replies`, `prompts`, `settings`. Must never import `assistant/`, `ai/` or admin routers |
| `assistant/` | Admin AI assistant: `agent` loop, `tools`, `decision` layer, `actions` (confirm-before-run), `uploads`, `downloads`, `prompts`, `sandbox`, `settings` |
| `jobs.py` | Scheduler: expire unpaid orders, retry refunds, send notifications, cleanup |

### Frontend map (`frontend/src`)

`app/(shop)` storefront · `app/seller` seller hub · `app/admin` admin panel · `components/` shared UI
(`assistant/` dock, blocks, voice) · `lib/api.ts` (fetch with token refresh, `downloadFile`, `downloadPost`,
`streamPost` for SSE) · `lib/speech.ts` (browser speech) · `lib/admin.tsx` (`useCan(permission)`).

## Rules for every change

1. **No hard-coded business values.** Brand, contact, tax rates, fees, keys, models, prompts' house rules, voice
   settings come from: `platform_settings` rows (admin panel) → environment (`config.py` defaults). Read keys with
   `await app.integrations.get()`, never `settings.razorpay_key_id` directly.
2. **Every admin endpoint declares one permission**: `admin: Perm("orders")`. New permission? Add it to
   `core/permissions.CATALOG` (+ a data migration if existing roles should get it). The owner role always has all.
3. **Write actions are audited**: `audit(session, user, "thing.action", "entity", id, detail)`. Never put secrets or
   personal data in `detail`.
4. **Money**: integer paise end to end; format only at the edge (`queries.inr`, `exports.money`).
5. **Time**: store UTC; filter and display by IST calendar days (`services/reports.IST`, `assistant/periods.py`).
6. **Secrets**: encrypt with `core.security.encrypt_field`; return only `••••last4`; never log them.
7. **Untrusted input**: validate with Pydantic; uploaded files are parsed, never executed; text from DB/files given
   to the AI is data, not instructions.
8. **AI never changes data by itself**: it calls `propose_action`; the change runs only when a person confirms,
   through the same endpoint function the admin panel uses.
9. **Migrations**: `alembic revision --autogenerate -m "..."`, review it, then `alembic upgrade head`,
   `alembic downgrade -1`, `alembic upgrade head`, `alembic check` must pass.
10. **UI text** is plain, active, sentence case; errors say what to do next.

## Common tasks

| Task | Where |
|---|---|
| Add a third-party integration | `integrations/registry.py` (fields → settings), add the settings to `config.py`, a check in `integrations/checks.py`, read it via `integrations.get()` |
| Add an LLM provider | If it speaks OpenAI Chat Completions or Anthropic Messages: add a `ProviderType` in `llm/catalog.py` (no other code). Otherwise add an adapter in `llm/adapters.py` |
| Add an export | One `ExportSpec` in `services/exports.py` (headers, query, row, filters); CSV/Excel/PDF/bulk ZIP work automatically |
| Add an assistant tool | `@tool(...)` in `assistant/tools.py` with a permission and cards; map it to a domain in `assistant/decision.DOMAIN_TOOLS` |
| Add a shop assistant tool | `@tool(..., login=, feature=)` in `shop_assistant/tools.py`, output through `shop_assistant/views.py` (whitelist), filtered by the session's customer; see `docs/SHOP_ASSISTANT.md` |
| Add an assistant action | `ActionDef` + `prepare` branch + `execute` branch in `assistant/actions.py`, calling the existing endpoint function |
| Add an admin page | `frontend/src/app/admin/<page>/page.tsx` + a nav entry with its permission in `app/admin/layout.tsx` |

## Run and test

```bash
# backend
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/alembic upgrade head && .venv/bin/python -m scripts.seed --demo
.venv/bin/uvicorn app.main:app --reload                       # :8000
.venv/bin/ruff check app tests && .venv/bin/python -m pytest -q   # needs PostgreSQL on localhost

# frontend
cd frontend && npm ci && npx tsc --noEmit && npx eslint src && npx next build
API_ORIGIN=http://127.0.0.1:8000 npx next start -p 3000

# browser tests (stack running; API log path for console OTPs)
cd e2e && npm ci && npx playwright install chromium && API_LOG=/tmp/api.log npx playwright test
# with the Razorpay simulator wired in (see tools/razorpay-sim/sim.py): RAZORPAY_SIM=1 npx playwright test

# payments end to end without Razorpay
python tools/razorpay-sim/smoke.py
```

**Definition of done:** ruff clean, all pytest tests pass, `alembic check` clean, `tsc` and `eslint` with 0 errors,
`next build` succeeds, Playwright suite green, and the screen was looked at (desktop and mobile).
