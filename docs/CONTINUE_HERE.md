# CONTINUE HERE — handover for the next AI agent (written 2026-11-26 11:00 IST)

You are continuing the PixCart rebuild exactly where the previous agent stopped. Read this whole file before you touch
anything. It tells you what the project is, the rules you must never break, what is done, what is half done, and the
exact next steps with commands. Everything here was true at the time of writing; verify a step's state (git log, the
ledger files) before you act on it.

---------------------------------------------------------------------------------------------------------------------

## 1. The project in one paragraph

PixCart is a multi-seller marketplace for India (customers, sellers, delivery partners, admin staff). It exists twice:

1. **The live version (the REFERENCE)**: Python FastAPI + Next.js + PostgreSQL, on Vercel/Neon. Repository
   `https://github.com/harishpixous-commits/Pixcart-ecomerce`, branch `main` (local clone:
   `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace`). It is the source of truth for every
   behaviour, rule, message, API answer and pixel. **Never change it, never deploy it, never merge into it.**
2. **The company version**: ASP.NET Core .NET 10 API + MySQL 8.4 (Dapper) + Angular 21 website + Flutter apps, hosted
   on Windows/IIS. It must be **100% identical** to the reference: every screen pixel for pixel (390 px and 1366 px),
   every button, form, option and flow working on the .NET backend, the admin panel with every configuration option.
   Development happens on branch `port/company` of the same personal repository (local worktree
   `C:\Users\haris\Downloads\PixCart-company`) and on module branches `port/*`. Finished, verified work is shipped to
   the company repositories (section 3).

The owner (Harish) wants: everything complete and working, the backend strong and well engineered (clean layered
.NET: Controllers -> BAL -> DAL, background workers, pipelines), the Angular code clean and professional, and the
company GitHub kept tidy.

---------------------------------------------------------------------------------------------------------------------

## 2. Rules you must never break

1. **Never modify the reference** (`main`, the folder `pixcart-marketplace`), never deploy anything, never touch the
   live Vercel/Neon site. The local copies of the reference services (section 5) are for comparison only.
2. **No AI traces and no porting traces in the company repositories** (owner's explicit order, 2026-11-26):
   - never add `Co-Authored-By: ...`, `Generated with ...` or any AI/tool name to a commit, in ANY repository;
   - commit identity: `git -c user.name=PixCart-Dev -c user.email=dev@pixcart.local commit -m "..."`
     (the machine has no global git identity; never put the owner's email address in any command);
   - in the company repos no comment, doc, README, UI text, identifier or commit message may say "reference",
     "Python", "ported/porting/migrated from", ".tsx", ".py", "Next.js", "React", "Instinct", "Claude Code";
   - ship to the company repos ONLY through `tools/company-export/update_company.sh` (section 3). It copies the
     product files, cleans porting notes out of comments (and proves with an independent lexer that only comments
     changed), applies the hand-written company files in `tools/company-export/company-overrides/`, builds and tests
     the exported copy, and commits with a neutral message. Never copy files there by hand.
   - The personal repo's `port/*` branches may keep porting notes in comments (they are working notes); write NEW
     comments as plain product descriptions anyway (they then need no cleaning).
3. **No secrets** in code, commits, chat or logs. The local demo admin password is only in
   `C:\Users\haris\pixcart-tools\parity-admin-password.txt` (read it into an environment variable at run time; never
   write it anywhere). Provider keys are entered in Admin -> Integrations, never in code.
4. **No real money, SMS or email**: payments only through the local Razorpay simulator (port 8790); OTP codes come back
   as `dev_otp` in development.
5. **Never delete** other people's files, branches or data; never bulk-delete demo data; restore any global setting you
   change while testing (theme, storefront content, marketplace settings, integrations, staff roles, sign-in settings).
6. Small commits with clear messages; build and test before each commit; do not claim something works until you have
   verified it (pixel comparison, clicking through, tests).
7. The machine has little free memory (16 GB with VS Code and Chrome open): at most two Angular dev servers and one or
   two headless browsers at a time; stop every process you start (except shared dev servers you will reuse).
8. When you kill processes, kill only the specific process you started (by port). Never close the owner's Chrome.

---------------------------------------------------------------------------------------------------------------------

## 3. Repositories, branches and worktrees

| What | Where |
|---|---|
| Personal repo (both codebases) | `https://github.com/harishpixous-commits/Pixcart-ecomerce` |
| Reference (live) | branch `main` at `f09357e` — worktree `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace` (READ ONLY) |
| Integration branch of the rebuild | `port/company` — worktree `C:\Users\haris\Downloads\PixCart-company` (this file lives here) |
| Angular page groups still open | `port/pages-delivery`, `port/pages-seller-b`, `port/pages-admin-b`, `port/pages-admin-c` — worktrees `C:\Users\haris\Downloads\PixCart-pg-<group>` |
| Flutter app branches (not started) | `port/flutter-customer`, `port/flutter-partner`, `port/flutter-seller` — worktrees `C:\Users\haris\Downloads\PixCart-fl-<app>` |
| Older module branches | `port/auth`, `port/catalog`, `port/commerce`, `port/ai`, `port/web-core`, `port/flutter`, `port/assistant-live`, `port/backend-review`, `port/pages-admin-a`, `port/pages-seller-a`, `port/pages-shop-browse`, `port/pages-shop-customer`, `dotnet-angular` — all merged or superseded; do not continue them |
| Company web repo | `https://github.com/PixoustechIndia-org/Pix-ShopCart_Web` (Angular + .NET), branch `main` — local clone `C:\Users\haris\Downloads\Pix-ShopCart_Web` |
| Company mobile repo | `https://github.com/PixoustechIndia-org/Pix-ShopCart_Mobile` (Flutter), branch `main` — local clone `C:\Users\haris\Downloads\Pix-ShopCart_Mobile` |

Company repos state: on 2026-11-26 both were reset to ONE clean commit each (web `2f78b1e`, mobile `a4492d0`, author
PixCart-Dev, no AI/porting words). The old history is kept only in the local branch `backup/history-2026-11-26` of
each clone (never push it). From now on: normal commits on top, never force-push.

**How to ship to the company repos** (after work is merged into `port/company` and its tests pass):
```bash
bash /c/Users/haris/Downloads/PixCart-company/tools/company-export/update_company.sh web "Short neutral subject" "Optional body"
bash /c/Users/haris/Downloads/PixCart-company/tools/company-export/update_company.sh mobile "Short neutral subject"
```
The script refuses forbidden words in the message, exports, builds (.NET + all 248+ API tests, Angular production
build + screen contract tests, or Flutter analyze + tests), refuses to commit build output, then commits and pushes.
The export report (`C:\Users\haris\pixcart-tools\parity-kit\export-<web|mobile>-report.json`) lists every cleaned
comment and every line that still mentions a porting word ("left_for_review": product uses of "reference" such as
payment references are fine). Read it after each export. If you add a new kind of porting note the cleaner does not
know, fix it in the source instead.

---------------------------------------------------------------------------------------------------------------------

## 4. Code layout (company stack)

```
PixCartAPI/   API (Controllers, Configurations, Helpers, Infrastructure: RouteGuardFilter / QueryRulesFilter /
              BodyRulesFilter / ApiJsonFilter / JobsWorker / RefundWorker, Middleware), BAL (business logic,
              Interface/, BackgroundWorkerService/, AI/, ShopAssistant/), DAL (Dapper SQL, Helpers/Scripts/V###__*.sql
              migrations), Model, Utils, Tests (xUnit against a real MySQL; 248 tests, all passing)
PixCartWeb/   Angular 21 (standalone, signals, zoneless, OnPush), PrimeNG unstyled + pass-through classes, Bootstrap
              grid only, src/styles/_site.scss = the site's utility classes. Areas: src/app/shop, seller, delivery,
              admin (+ shared, core, themes). Each URL has a page file src/app/<area>/pages/<name>.page.ts.
PixCartMobile/ Flutter: apps/customer_app (largely done), apps/partner_app and apps/seller_app (skeletons only),
              packages/pixcart_core (API client, session, settings, tokens), packages/pixcart_ui (widgets)
tools/        publish-windows.ps1 (IIS package), parity/ (comparison tools), company-export/ (shipping),
              handover-kit/ (local helper scripts), agent-briefs/ (briefs for page/Flutter agents), schema/
              (generators that read the reference OpenAPI), DataMigrator (PostgreSQL -> MySQL data copy),
              razorpay-sim (local payment simulator)
docs/         product docs + this file + PORTING_GUIDE.md (how to port a page) + DEPLOY_WINDOWS_IIS.md
```

Backend parity layers (generated from the reference OpenAPI, do not hand-edit the JSON): `route-guards.json`
(sign-in and permission per route), `query-rules.json` (path/query validation), `body-rules.json` (body validation
with pydantic-style messages). Errors from path, query and body checks are merged into one 422 like the reference.
Times are written in the reference's isoformat style; JSON is written unescaped.

---------------------------------------------------------------------------------------------------------------------

## 5. Local services (all on this machine)

| Service | Port | How it runs (start it only if it is down) |
|---|---|---|
| PostgreSQL (reference demo DB `pixcart_demo`) | 5433 | `C:/Users/haris/pixcart-tools/pgsql/bin/postgres.exe -D C:/Users/haris/pixcart-tools/data -p 5433` |
| Reference API (FastAPI) | 8100 | in `pixcart-marketplace\backend`: `.venv\Scripts\python.exe -m uvicorn app.main:app --port 8100` (reads backend/.env) |
| Reference website (Next.js production build) | 3100 | in `pixcart-marketplace\frontend`: `C:\Users\haris\pixcart-tools\node-v22.23.5-win-x64\node.exe node_modules\next\dist\bin\next start -p 3100` |
| Razorpay simulator (key `rzp_test_sim`, secret `sim_secret`, webhook secret `sim_whsec`) | 8790 | `pixcart-marketplace\backend\.venv\Scripts\python.exe -m uvicorn sim:app --app-dir tools/razorpay-sim --port 8790` (from the PixCart-company folder); it posts webhooks only to 8100 |
| MySQL 8.4 (`pixcart_parity` = copy of the demo data for the .NET API; tests create their own databases) | 3307 | `C:\Users\haris\pixcart-tools\mysql\bin\mysqld.exe --datadir=C:/Users/haris/pixcart-tools/mysql-data --port=3307 --mysqlx=OFF --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci --default-time-zone=+00:00 --console` (user root / pixcart, local only) |
| .NET API on the copied demo data | 5180 | `powershell -File C:\Users\haris\Downloads\PixCart-company\tools\handover-kit\run-parity-api.ps1` (stop it before building PixCartAPI) |
| Angular page-group dev servers | 4215 delivery, 4216 seller-b, 4217 admin-b, 4218 admin-c | `npx ng serve --port <p>` in the group's `PixCartWeb` (proxy sends /api and /media to 8100) |

Tools: Node 22 at `C:\Users\haris\pixcart-tools\node-v22.23.5-win-x64` (put it FIRST on PATH; the default node is
v18 and Angular refuses it). Flutter 3.50.1 at `C:\Users\haris\pixcart-tools\flutter\bin`. .NET 10 SDK on PATH.
Playwright: `C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\e2e\node_modules`. In Git Bash always
`export MSYS_NO_PATHCONV=1` before passing URL paths like `/admin/orders` to node.

Demo accounts: admin `admin@pixcart.in` (password in the file above), seller phone `9000000001`, delivery partner
`7300000001`, customer `9999900001`; OTP codes come back as `dev_otp`. The local demo allows 20 codes per phone per
hour (product default 5; `tools/handover-kit/otp_limits.py restore` sets the defaults back when all testing is done).

To refresh the MySQL copy from the demo PostgreSQL data: `dotnet run --project tools/DataMigrator -- --from
"Host=localhost;Port=5433;Database=pixcart_demo;Username=postgres;Password=..." --to
"Server=127.0.0.1;Port=3307;Database=pixcart_parity;User=root;Password=pixcart;" --yes` (+ `--media-*`/`--private-*`).

---------------------------------------------------------------------------------------------------------------------

## 6. State of every workstream

### 6.1 Backend (.NET API) — complete route set, verified by differential tests; deep review still open
- Every reference route exists (a test fails if a route or rule is missing on either side). 248 xUnit tests pass.
- Differential checks against the reference on the same data (tools/parity): request validation 119/119 identical;
  cash-on-delivery journey 23/23 (random return numbers normalised); online payments 20/20; read comparison of all GET
  routes by role clean except data the reference itself does not define; extra routes fixed.
- Much of the backend was first written by the "Instinct" agent (its old notes: `docs/INSTINCT_HANDOVER_20261124.md`,
  gaps listed there: admin assistant actions create_coupon / set_coupon_active / moderate_review / reply_ticket /
  set_announcement prepared but not end-to-end exercised; run_payouts only with zero balances; refresh-token
  theft-replay branch; online-payment return refund through RefundWorker; review media upload success path; Q&A
  approval gates; credit-note number collision quirk (16-char truncation) unresolved; invoice totals not re-validated
  at issue time (same as the reference)).
- OPEN: a module-by-module review of the .NET code against the Python code (business logic: money, state transitions,
  side effects, permissions, locking). Twice started, both times stopped by usage limits before any result. The
  review prompt and the 20 slices are in `tools/agent-briefs/review-backend-workflow.js` (it is a workflow script for
  the previous agent's tool; read it as a checklist: one slice at a time, compare each Python route/service with its
  .NET controller -> BAL -> DAL, list divergences with Python file:line, .NET file:line and a concrete scenario, then
  double-check each finding before fixing it with a test).

### 6.2 Angular website — every page built and merged (2026-11-26)
- All pages are real (0 placeholders in `port/company`): shop, seller hub, delivery partner app and admin panel.
  The last four groups (admin-b, admin-c, seller-b, delivery: 55 pages) were pixel-checked against the reference at
  390 and 1366 px (main view of every page within 0.5%, most under 0.05%) and merged on 2026-11-26. The 34 admin pages
  were also compared with the Angular app running on the .NET API (within 0.044%).
- Full flows on the real deployment shape (the IIS package from `tools/publish-windows.ps1`, API and website on one
  address, MySQL): the reference Playwright suite `pixcart-marketplace\e2e` passes 45/45, and
  `tools/handover-kit/flow_product_to_order.cjs` passes 9/9 (seller adds a product with a photo -> admin approves ->
  a new customer finds it and buys it -> seller confirms -> admin and seller exports).
- How to rerun them: seed a fresh PostgreSQL database with the reference seed (`DATABASE_URL=...pixcart_e2e_net`,
  `MEDIA_ROOT=C:/Users/haris/pixcart-tools/e2e-net-media`, then `alembic upgrade head` and `python -m scripts.seed --demo`
  in `pixcart-marketplace\backend`; pixcart_e2e_net already exists and is clean), copy it to MySQL `pixcart_e2e` with
  tools/DataMigrator, `ADMIN_PASSWORD=PixCart@Admin2026 dotnet API.dll create-admin --email admin@pixcart.in`, build the
  package to `C:\Users\haris\pixcart-tools\e2e-site`, start it with `tools/handover-kit/run-e2e-site.ps1` (port 5300,
  sign-in codes in `C:\Users\haris\pixcart-tools\e2e-api-net.log`), then in `pixcart-marketplace\e2e`:
  `BASE_URL=http://localhost:5300 API_LOG=C:/Users/haris/pixcart-tools/e2e-api-net.log RAZORPAY_SIM=1
  CHROME_PATH=<playwright chromium> npx playwright test --output C:/Users/haris/pixcart-tools/e2e-results`.
- Not yet done for the newly merged pages: a click-through of every dialog, form and second tab against the reference
  (the e2e suite covers the main ones). Use `tools/agent-briefs/page-brief-v3.md` for that work.

### 6.3 Backend fixes found by the full flows (2026-11-26, shipped)
- The customer's order page had no delivery tracking (`fleet` was always empty): new `DeliveryTrackingBAL` (partner,
  trip steps, delivery code only while the package is with the partner, live position only when recent).
- Cancelling a package our partners carry did not stop the trip: `DeliveryFleetBAL.OnCancelledAsync` (stop before
  pickup, return trip to the store after pickup), called from `OrdersBAL.CancelSubOrderAsync`.
- Sponsored products never appeared in search: the `ISponsoredProducts` hook had no implementation (`SponsoredProducts`).
- AI availability and AI translation of shop texts had no implementation (`BAL/AI/AiHooks.cs`).
- Staff messages to a customer were in-app only: now also by email through `INotifyBAL`.
- The visitor's country never reached the regional suggestion on the Angular site: the API now reads the
  Cloudflare/Vercel country header when the page sends none.
- Missing pages carry `noindex`; every dialog is named by its title (accessibility).
- Tests: `DeliveryTrackingTests` (3) and the region header cases; 251 backend tests pass.

### 6.4 Flutter apps
- `apps/customer_app` is largely built (26 files: home, categories, listing, product with gallery, cart, checkout
  with Razorpay native/web, orders, order, account, auth); verify it against the website at 390x844.
- `apps/partner_app` and `apps/seller_app` are skeletons (one main.dart each). They must be built screen by screen
  to match the delivery partner pages and the seller hub on a phone. Brief: `tools/agent-briefs/flutter-brief-v2.md`.
  Use the branches `port/flutter-partner` / `port/flutter-seller` / `port/flutter-customer` (worktrees
  `PixCart-fl-*`); merge into `port/company` when verified; ship with `update_company.sh mobile`.
- Build for comparison: `flutter build web --dart-define=API_BASE=http://localhost:8100 --dart-define=SITE_URL=http://localhost:3100`
  in the app folder, serve with `node PixCartMobile/tools/parity/serve.cjs build/web <port> http://localhost:8100`,
  compare with `node PixCartMobile/tools/parity/compare.cjs --ref http://localhost:3100 --app http://localhost:<port>
  --routes <urls> [--login <phone>] --out <dir>`. One Flutter build at a time (memory).

### 6.5 Database hand-over package (done and shipped 2026-11-26)
- `db/pixcart_demo_db.sql` (one file: CREATE DATABASE pixcart_demo + 79 tables + all data, as it is in the .NET demo
  database), `db/media/` (61 files), `db/private/` (13 files), `db/README.md` (import command, image folders,
  connection string, migrations, sign-ins). Built by `tools/handover-kit/make_demo_db.py` (as-is by default;
  `--sanitize` also empties logs/sessions and anonymises test accounts); checked by
  `tools/handover-kit/verify_demo_db.cjs`. Admin password in the package: `PixCart@Demo2026`. The owner also has
  `C:\Users\haris\Downloads\pixcart_demo_db.zip` (the same folder) to send to the team.
- Verified on a brand-new MySQL 8.4 server: one-command import, images copied, API with only the connection string
  set: storefront, listing, search, product detail, my orders, customer and admin sign-in, all images loading.

### 6.6 Backend review against the Python code (in progress)
- Workflow script: `C:\Users\haris\.claude\projects\c--Users-haris-Downloads-pixcart-marketplace-1\04206c7d-7455-4338-a84b-b43ab23f2c61\workflows\scripts\review-backend-vs-python-seq-wf_7e328aa3-01c.js`
  (one module at a time, each finding verified by an independent skeptic). Resume it with
  `Workflow({scriptPath: <that file>, resumeFromRunId: 'wf_7e328aa3-01c'})` once the usage limit has reset: finished
  modules come from the cache and it continues at cart-checkout-orders. Same checklist as
  `tools/agent-briefs/review-backend-sequential.js`.
- Done: auth-accounts, catalog-storefront, cms-regional (3 of 20). All 12 confirmed findings are fixed with tests
  (2026-11-26): exact role codes; account writes carry only changed fields (`AccountDAL.SaveUserChangesAsync` with
  `UserModel.Copy()`, no whole-row writes left); refused refresh keeps the cookie; route ids without `:guid` (422 after
  sign-in, `RouteTableTests` guards ambiguity); /api/site online_payments from IRazorpayBAL; FSSAI field error; email
  footer from `ISiteBAL` (merged site settings); translation search as a LIKE pattern; search filters as sent; 1/0,
  yes/no, on/off switches (`FormBoolBinder`); aggregates touch updated_at only on change; exact brands and slugs;
  banner grid and promise strip check every item (the unverified finding was real).
- Found while fixing: every error answer lost X-Request-ID (ExceptionMiddleware clears the response) and the security
  headers lived only in web.config (none under Kestrel, no X-Frame-Options); now `RequestContextMiddleware` adds them
  on start (API set like FastAPI, page set like next.config.mjs) and web.config no longer duplicates them. Unknown
  API/media paths answer 404 `{"detail":"Not Found"}` and wrong methods 405 `{"detail":"Method Not Allowed"}` with
  Allow (`UnmatchedRouteMiddleware`; the SPA fallback no longer catches /api).
- 2026-11-27: cart-checkout-orders and payments-fees-coupons reviewed (5 of 20 done); every confirmed finding fixed
  with tests in `Tests/CheckoutRulesTests.cs` and shipped (company commits 6ac5933 and the next one): GSTIN 400, double
  submit placed once, save-for-later limit, deleted address in the quote, not_cancellable 400, expiry confirms every
  attempt, checkout locks only cart and variant rows (`FOR UPDATE OF c, v`), RazorpayX payout and Shiprocket webhooks
  applied (`BAL/WebhookTargets.cs`, registered in ServiceConfiguration), fee GST half-even, coupon shares as doubles,
  shortfall text, non-JSON Razorpay errors. Also: `App__ExternalProviderMode=open` in the package's web.config (production
  refuses to start without it).
- The owner's rule (2026-11-27): never change the demo database package (test sign-ins, data, images); `db/` is exactly
  as first delivered. For the browser suite only, the local pixcart_e2e copy sets every partner offline (the demo
  partner "Arun Kumar" is online in the data and the delivery test signs up another "Arun Kumar").
- Open (lower priority): formatting follows the server's culture (this machine is en-IN: amounts from a lakh up are
  grouped 1,23,456 here but 123,456 in Python); pin the culture at start-up and run every suite.
- Next: the remaining 15 slices. The review script is split: `review-backend-vs-python-seq-wf_7e328aa3-01c.js` (stream A,
  resume run wf_7e328aa3-01c: continues at returns-refunds-invoices up to admin-ops) and `review-backend-vs-python-seq-b.js`
  (stream B, admin-extras to llm-ai, start fresh) in the same scripts folder. Run one stream at a time (usage limits).
  Fix each confirmed finding with a test, run the API suite, publish the package, run the browser suite and both crawls
  and the order flow, then ship with update_company.sh.

### 6.6b Differential and visual checks after the fixes (2026-11-26, data refreshed with DataMigrator first)
- `tools/parity/api_diff.py` (every GET route, 5 roles): 668 identical, 17 different, all understood: session
  times and ids of the tool's own sign-ins; the Sentry setup text (names ASP.NET Core on purpose); the GET of the
  payment callback (both redirect; only the redirect target differs per server); lists the Python version leaves
  unordered (staff role choices and deal variants: no ORDER BY, physical row order; seller analytics and campaign
  products: hash aggregate or join order); and the seller dashboard's daily dates, where Python labels each Indian
  day one day early (date_trunc in the server's Asia/Calcutta zone, read back in UTC, then .date()): .NET keeps the
  correct Indian day, like every other daily figure in both versions.
- `scenario_diff.py` (cash-on-delivery journey, 23 steps), `payment_scenario.py` (Razorpay: paid, failed, approved
  later; 20 steps) and `body_diff.py` (validation of 119 write routes): all identical.
- `compare.cjs` shop sweep (21 routes x 390/1366, full pages): 42 of 42 within 0.19% (most about 0.03%); search and
  category pages within 0.09%.

### 6.6c Build quality and hosting (2026-11-26)
- The build has 0 warnings; `PixCartAPI/Directory.Build.props` makes nullable warnings errors. Three of the old
  warnings were real crashes and are fixed: the payment window and saved cards for an account without a mobile
  number, and a WhatsApp send without template parameters.
- One-site hosting (IIS package, website in wwwroot): page paths are served by a middleware, not a fallback route
  (a fallback route also counts as a candidate for API paths, which turned a wrong method's 405 into 404, and a
  regex-constrained one never matched the home page). `Tests/WebsiteHostTests.cs` runs the API with a website
  build in its content root, so this is covered by the tests now. Always rebuild the package
  (`tools/publish-windows.ps1 -Output C:\Users\haris\pixcart-tools\e2e-site`) and run the browser suite on it
  before shipping changes to the pipeline.

### 6.7 Storefront search reproduces the Python search exactly (2026-11-26)
- Engine `PixCartAPI/Utils/TextSearch/` is PostgreSQL's text search as the Python version uses it, written in C#
  (company-facing comments are neutral on purpose; this mapping lives only here):
  `TextTokenizer` = the default parser (wparser_def.c state table, rule by rule); `SearchVector` = tsvector of the
  'simple' configuration (setweight, `||` with the MAXNUMPOS/MAXENTRYPOS limits); `SearchQuery` = to_tsquery prefix
  terms (a word the parser splits becomes a phrase), `@@`, and ts_rank (calc_rank_and / calc_rank_or, float rounding
  as in C); `Trigrams` = pg_trgm word_similarity (iterate_word_similarity); `SqlLike` = ILIKE; `ShopperWords` =
  `re.split(r"[^\w]+", q.lower())`; `ResultSort` = tuplesort (sort_template.h quicksort and the bounded heap), so
  equal facet counts come out in PostgreSQL's order; `TextCollation` = varstr_cmp order.
- Rules (routers/catalog.py and app/db.py): match = vector @@ prefix query OR text <% title (threshold 0.45, set in
  db.py) OR brand ILIKE text; relevance = ts_rank + word_similarity (float4); order in_stock desc, relevance desc,
  sold_count desc, id. Typo matches are always included (the old .NET code added them only when results were few,
  at 0.6).
- Integration: `CatalogDAL.SearchCandidatesAsync` reads id, updated_at and sold_count of the public products in
  scope; search documents are cached per product version in the singleton `DAL.SearchDocumentCache`; matches and
  relevance are computed in memory and joined into the SQL as `JSON_TABLE(@textMatches ...) rk` with an integer order
  key (the float's bit pattern), so MySQL orders exactly. Facets: brands grouped byte-exact (utf8mb4_0900_bin),
  ordered by collation and then by count with ResultSort (PostgreSQL's plan: sort by brand, GroupAggregate, sort by
  count, limit).
- Proof: `Tests/TextSearchTests.cs` with `Tests/Fixtures/search-ranking.json` (from
  `tools/handover-kit/make_search_fixture.py`: 36 products x 52 searches, every vector, match, rank and similarity
  bit-exact) and `Tests/TextSearchCorpusTests.cs` with `text-search-cases.json` (`make_text_search_cases.py`: 1,702
  ASCII and 294 non-ASCII parser texts, 140 documents x 45 AND/OR queries, 1,860 similarity pairs, 220 sort cases, all
  exact). Live: 162 search and suggestion responses compared with the Python API: results, totals and facets
  identical for every query.
- Inherent differences: suggestions with equal word similarity (Python orders by similarity only, and PostgreSQL then
  returns ties in physical row order, which MySQL cannot know; .NET breaks ties by units sold, then id); category
  names in suggestions (Python has no ORDER BY; .NET uses created_at, position, name).

---------------------------------------------------------------------------------------------------------------------

## 7. Order of work from here

1. Backend review against the Python code (section 6.6), fixing every confirmed divergence with a test.
2. Flutter: verify the customer app, build the partner app and the seller app (section 6.4).
3. Click-through of every dialog, form and second tab of the last 55 pages (section 6.2).
4. The five videos.
5. At the very end: `python -I tools/handover-kit/otp_limits.py restore` (product sign-in limits back), stop the
   dev servers you started, final ship to both company repos.

After every step: commit (neutral identity, no trailers), push `port/company` (and the branch you worked on) to the
personal repo, update this file's section 6 so the next agent knows the state.

---------------------------------------------------------------------------------------------------------------------

## 8. Useful checks

```bash
# placeholders left in the integration branch
grep -rl 'placeholder-page' /c/Users/haris/Downloads/PixCart-company/PixCartWeb/src/app | wc -l
# API tests (stop the API on 5180 first; tests use MySQL on 3307 and create their own databases)
cd /c/Users/haris/Downloads/PixCart-company/PixCartAPI && dotnet build PixCartAPI.sln -v q && dotnet test Tests/Tests.csproj --no-build
# website build and screen tests (Node 22 first on PATH)
export PATH="/c/Users/haris/pixcart-tools/node-v22.23.5-win-x64:$PATH"; cd /c/Users/haris/Downloads/PixCart-company/PixCartWeb && npx ng build && npm run test:shop-contracts
# differential API checks against the reference (see tools/parity/README.md)
python -I tools/parity/api_diff.py --help
```
