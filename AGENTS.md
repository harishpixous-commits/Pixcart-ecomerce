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
| `services/` | Business logic: orders, ledger (payouts), returns, invoices, exports, docgen (Excel/PDF), notify, cms. Product page: `product_info` (Legal Metrology details, unit price, category requirements), `product_page` (bought count, best-seller rank, seller snapshot, offers, customer media, review topics), `review_settings` (Admin → Reviews → Settings), `delivery` (dates, dispatch cut-off) |
| `routers/promotions.py`, `services/deals.py`, `services/ads.py` | Deals (the deal price *is* the selling price while a deal runs; `deals.sync` starts/ends them, checkout calls it), sponsored products (serve records an impression per ad for the visitor cookie; signed one-use click links; paid-click limits per address and network; invalid clicks; daily billing to the ledger, attribution), Today's Deals / Bestsellers / New releases / Coupons APIs |
| `routers/engagement.py`, `services/engagement.py` | Product Q&A, back-in-stock and wishlist price-drop alerts (jobs), compare, frequently bought together |
| `integrations/` | Third-party keys: `registry` (fields), `store` (encrypted, merged over env), `checks` (Test connection) |
| `llm/` | Any LLM provider: `catalog` (types), `config` (connections/keys/routes), `adapters` (Anthropic + OpenAI-compatible), `router` (fallbacks) |
| `ai/` | AI studio tasks (drafts that a person reviews) and risk briefs |
| `shop_assistant/` | Customer chat on the storefront: `agent` (live + guided), `intents` (multilingual rules), customer-only `tools`, whitelist `views`, `kb` (help articles + public facts), `replies`, `prompts`, `settings`. Must never import `assistant/`, `ai/` or admin routers |
| `assistant/` | Admin AI assistant: `agent` loop, `tools`, `decision` layer, `actions` (confirm-before-run), `uploads`, `downloads`, `prompts`, `sandbox`, `settings` |
| `routers/delivery.py`, `routers/delivery_admin.py`, `services/fleet.py`, `services/delivery_settings.py`, `models/delivery.py` | Own delivery fleet (see `docs/DELIVERY.md`). Partner app API under `/delivery`, admin API under `/admin/delivery`. `fleet` holds every rule: offers and auto-assign (`candidates`, `offer`), `release` (kind-aware: delivery, return, pickup), the `sweep` job (expired offers, unassigned alerts), return pickups by the fleet (`request_return_pickup`), trip views and tracking, earnings and weekly payouts. Fees, timers, zones' behaviour and the app download live in `delivery_settings.DEFAULTS` (Admin → Delivery → Settings) |
| `jobs.py` | Scheduler: expire unpaid orders, retry refunds, send notifications, cleanup, fleet sweep (every 10 s), fleet alerts and weekly partner payouts |

### Frontend map (`frontend/src`)

`app/(shop)` storefront (product page: `p/[slug]/page.tsx` server sections + `buy-box.tsx` gallery/details/buy box;
blocks in `components/pdp.tsx`, reviews and customer photos in `components/reviews.tsx`; every block reads its switch from
`site.pdp`) · `app/seller` seller hub · `app/admin` admin panel (fleet: `app/admin/delivery`) · `app/delivery` delivery
partner app (installable web app; `mobile/partner-app` wraps it for Android; blocks in `components/delivery/`) ·
`components/charts/columns.tsx` (accessible column chart) · `components/map/live-map.tsx` (Leaflet) · `components/` shared UI
(`assistant/` dock, blocks, voice) · `lib/api.ts` (fetch with token refresh, `downloadFile`, `downloadPost`,
`streamPost` for SSE) · `lib/speech.ts` (browser speech) · `lib/admin.tsx` (`useCan(permission)`).

Storefront themes (`docs/THEMES.md`): `themes/` holds each theme as a module (`<id>/theme.ts` data: tokens, layout
options, colour presets; `<id>/slots.tsx` components: Header, Footer, MobileNav, ProductTile), `manifest.ts`
(`resolveTheme`), `css.ts` (CSS variables), `context.tsx` (`useTheme`, `useLayout`), `shop-frame.tsx`. Shop screens
read layout options with `useLayout()` and use only token classes (`peacock`, `marigold`, `vermilion`, `leaf`, `ink`,
`mist`, `line`, `shadow-card`, `rounded-xl`, `max-w-shop`, `shop-panel`), never hex colours. Shared tile behaviour:
`components/product-parts.tsx`; header parts: `components/shop-chrome.tsx`, `components/shop-nav.tsx`; images and
videos in blocks: `components/media.tsx`; skeletons: `components/skeletons.tsx`. Admin layouts:
`components/admin-shell/` (per staff member, `users.ui_prefs`).

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
11. **Fleet privacy**: a partner sees the customer's name, phone and address only while the trip is under way
    (`fleet.ON_TRIP`), and a customer sees the partner's phone only then. Partners sign in with OTP; staff see
    only the last 4 digits of Aadhaar. Customers' coordinates never go to third-party geocoders.

## Common tasks

| Task | Where |
|---|---|
| Add a third-party integration | `integrations/registry.py` (fields → settings), add the settings to `config.py`, a check in `integrations/checks.py`, read it via `integrations.get()` |
| Add an LLM provider | If it speaks OpenAI Chat Completions or Anthropic Messages: add a `ProviderType` in `llm/catalog.py` (no other code). Otherwise add an adapter in `llm/adapters.py` |
| Add an export | One `ExportSpec` in `services/exports.py` (headers, query, row, filters); CSV/Excel/PDF/bulk ZIP work automatically |
| Add an assistant tool | `@tool(...)` in `assistant/tools.py` with a permission and cards; map it to a domain in `assistant/decision.DOMAIN_TOOLS` |
| Add a shop assistant tool | `@tool(..., login=, feature=)` in `shop_assistant/tools.py`, output through `shop_assistant/views.py` (whitelist), filtered by the session's customer; see `docs/SHOP_ASSISTANT.md` |
| Add an assistant action | `ActionDef` + `prepare` branch + `execute` branch in `assistant/actions.py`, calling the existing endpoint function |
| Add an admin page | `frontend/src/app/admin/<page>/page.tsx` + a nav entry with its permission in the admin nav model (`components/admin-shell/`) |
| Add a storefront theme | Copy `frontend/src/themes/classic` to `themes/<id>`, change `theme.ts` and the slot components, register it in `themes/manifest.ts`, `themes/slots.tsx`, `THEME_IDS` and `backend/app/services/themes.py`; see `docs/THEMES.md` |
| Add a layout option | A field in `ThemeLayout` + `LAYOUT_CHOICES` (`themes/types.ts`), `applyLayout` (`themes/manifest.ts`), `LAYOUT_CHOICES` in `services/themes.py`, each theme's value, the screen that reads it with `useLayout()`, and the picker |
| Add a list-size setting | A default in `platform_settings.DEFAULTS` + its range in `LIMITS` + `LIST_KEYS` (sent as `site.lists`), the same default in `LIST_DEFAULTS` (`frontend/src/lib/site.tsx`), read it with `useLists()` or `get_settings()`, a field in `LIST_FIELDS` (`app/admin/settings/page.tsx`) |
| Add a home block | A kind in `cms.SECTION_KINDS` + its config in `validate_section`, rendering in `components/home-sections.tsx` (images and videos through `MediaFill`), the editor in `app/admin/storefront/sections.tsx` |
| Add a fleet setting | A default in `delivery_settings.DEFAULTS` (+ its bounds in `_INTS`/`_CHOICES`/`_TEXTS`), a field on `app/admin/delivery/settings/page.tsx`; read it with `await delivery_settings.get(session)` |
| Add a notification | An entry in `notify.EVENTS` (channels and default text; admins edit the templates), then `notify.notify(...)`, `notify_seller(...)` or `notify_staff(permission, ...)` where it happens |

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
