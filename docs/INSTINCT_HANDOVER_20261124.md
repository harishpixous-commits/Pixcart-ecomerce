# Instinct rebuild handover - refreshed 2026-11-24 08:50 IST

Branch: `instinct/port-commerce` (base: `dotnet-angular`). HEAD at refresh: `9cc5f4d`.
This is a progress snapshot, not final acceptance and not a stopping point. Development
continues on the same branch after this snapshot.

Everything below was run on a local machine against a local MySQL 8.4 and a loopback
Razorpay mock. No production system, live provider, or paid service was touched; no
deployment of any kind was made. The live `main` branch (FastAPI/Next/Vercel) was used
only as a read-only reference and was never modified.

## Local run prerequisites (what a fresh machine needs)

1. .NET 10 SDK.
2. MySQL 8.4 running locally (the session used port 3307, user/password
   `pixcart`/`pixcart`, schema `pixcart`). The schema comes from the branch's own
   migration files; the session database additionally carries hand-seeded test fixtures
   (test seller/products/orders/users) that are NOT in the repo. A fresh database gets an
   empty but valid schema; fixture-dependent behavior needs its own seed data.
3. Node + npm for the web skeleton (Angular 21).
4. Flutter SDK for `mobile/` (not installed or exercised this session).

## How to run what exists

```bash
# API (from repo root):
cd PixCartAPI/API
App__RazorpayKeyId=mock_key App__RazorpayKeySecret=mock_secret \
App__RazorpayApiBase=http://127.0.0.1:8599/v1 App__JobsRunAtStartup=true \
dotnet run --urls http://127.0.0.1:5080
# health: curl http://127.0.0.1:5080/api/health  -> {"ok":true}
# App__JobsRunAtStartup=true starts the background JobsWorker (local fakes only).

# Web skeleton (currently the untouched Angular starter, see "Frontend state"):
cd PixCartWeb && npm ci && npx ng build   # verified building 2026-11-24
npx ng serve                              # serves the default Angular starter page
```

## Backend state (.NET 10 + Dapper + MySQL)

Ported module by module from the live FastAPI reference: commerce, seller,
delivery/fleet, admin ops, refunds/returns, platform settings, assistant (sandbox ask
engine), AI scaffolding with fake providers only, background jobs (local
fakes/recording transports only), customer auth, storefront catalog, addresses,
wishlist, customer reviews, engagement (Q&A/alerts/compare), promotions shopper
surfaces.

### Implemented AND runtime-exercised locally (local MySQL + locally minted JWTs)

- Customer auth (c4e064c): otp request (purpose checks, cooldown, per-phone/per-IP
  limits, dev-OTP in test mode only), otp verify (attempts counter, signup validation,
  account creation, session issue), password login (lockout, totp_required/totp),
  change password (revokes sessions), TOTP setup/enable/disable, refresh rotation,
  logout, sessions list, sign-out-others, me/PATCH me.
- Storefront catalog (6f295b7): categories tree, home rails, product search with all
  query params and facets, suggest, product page, store page, platform page, 404/422
  paths. Includes the Rank "0" vs "0.0" ORDER BY ordinal fix.
- Addresses (84d2ece): full CRUD, default handling, coordinate rounding, 20-address
  limit, 401/404/422 paths.
- Wishlist (52cd8aa): add/list/remove, idempotency, price_at_add, 401/404.
- Customer reviews + product reports (00dedfa): public listing with gates,
  delivered-buyer write/edit/delete, helpful toggle, reports with duplicate handling,
  contact-flag moderation flow, filters and sorts. Rating aggregates verified.
- Engagement (be58f00): Q&A lifecycle (ask/answer/vote/report), stock alerts round
  trip, compare, bought-together (empty case), seller questions/badges/answer, admin
  queue with publish/hide, 403/404 paths.
- Promotions shopper (9cc5f4d): deals page (live/upcoming/discounts tabs, facets,
  kind/category/price/discount filters, 5 sorts), top bestsellers/new with category
  filter and unknown-category 404, coupons page with per-seller shop_link.
- Commerce core (earlier slices): cart/checkout/orders, seller hub, delivery fleet +
  delivery admin (queue/partners/KYC/docs/zones/cash/payouts/reports/returns/app
  upload), returns/refunds end-to-end for COD incl. pickup trips and credit notes.
- Jobs (e4edc78): expire_unpaid, unconfirmed cancel, retry_refunds, low_stock notify,
  stuck_check, payouts (gated, verified with balances due), delivery_payouts.
- AI scaffolding (7a395f7): sandbox-gated studio/settings/briefs/listing_check,
  seller listing_writer, customer_message; live provider branch fail-closed.
- Assistant core + ask engine (0981728, 48a6411, 68c9e98): settings, memory,
  conversations, decision layer, 18 executable read tools, sandbox ask loop over SSE.
- Assistant actions + admin ops (8d16c39, 120a63c, 38bfd1a, 991eda6, 9900296, ddd5c5d,
  2071a6a): all 19 action kinds wired with dispatch; admin moderation for sellers,
  products, coupons, reviews, tickets, announcements; staff-deliver verified; decide
  endpoint fully runtime-verified.

### Implemented but NOT fully exercised (honest gaps)

- Assistant action kinds: 19/19 wired. create_coupon / set_coupon_active /
  moderate_review / reply_ticket / set_announcement prepare branches are
  compile-verified only (the sandbox ask engine has no natural-language path to them);
  their dispatch was exercised via the decide endpoint with seeded pending rows.
- run_payouts dispatch exercised only with zero balances due.
- Refresh-token theft-replay branch and 60-second grace-window renew branch (auth).
- Online-payment return refund row -> RefundWorker -> mock Razorpay (fixtures were
  COD); RefundWorker itself verified in the orders slice.
- Staff return auto-assign success branch; return admin auto-assign + courier routes
  partially exercised.
- Review topic filter/stats (needs >=2 mentions), report_hide_at auto-hide threshold,
  review media/video upload success path (pipeline reached, size guard hit).
- Q&A: buyer-role answers (needs a third user), qa_report_hide_at auto-hide,
  qa_need_approval=true and qa_buyers_answer_only=true gates, bought-together with
  actual co-purchased products, compare with multiple products.
- Jobs skipped so far: push notification dispatch (INotifyBAL push channel), AI
  review_summaries, ads billing/prune, engagement alert senders, assistant cleanup.
- All provider calls (payments, LLM, SMS, push) are mock/console-only by design; real
  integration needs Harish's approval plus test keys.

### Not yet ported (missing surfaces, not merely unverified)

- Sponsored products: shopper ads serve/click/claim, seller ads CRUD/report, admin
  ads oversight, ads billing job. (Tables and settings defaults exist; the port is in
  progress.)
- /api/catalog/related and /api/orders/buy-again.
- Seller/admin deals management routes (shopper deals page is ported).
- Customer.py leftovers: notifications surface, invoices, delivery estimates, privacy
  (DPDP) endpoints, product events, customer-side support tickets.
- Shop assistant and admin shop assistant.
- Push notification dispatch channel.

## Frontend state (Angular) - parity NOT started

`PixCartWeb` is the untouched foundation-commit skeleton: it builds (`npx ng build`
verified 2026-11-24) and serves the default Angular starter page ("Hello,
PixCartWeb"). It contains no PixCart storefront/seller/admin UI. Screenshot evidence:
pixcartweb-skeleton-20261124.png (sent with the 08:13 report). Angular pixel parity at
390/768/1366 has not begun.

## Mobile state (Flutter) - NOT started

`mobile/` (partner-app, shop-app, shared) is the foundation-commit skeleton,
unmodified and unbuilt in this session. No Flutter SDK run has been attempted.

## Verification evidence NOT yet produced

- Full rebuilt-stack Playwright e2e run: not done.
- The 5 flow videos: not recorded.

## Known open risks

- Credit-note numbering collision quirk: the 16-char truncation collision is preserved
  temporarily but UNRESOLVED; it is not an accepted defect, and the reference numbering
  contract stays unchanged unless Harish decides otherwise.

## Recovery

Git bundles of the full branch history were captured after each verified slice
(pixcart-*recovery-20261124-*.bundle, sha256 recorded in the session log and reports).
Latest bundle at refresh: pixcart-rebuild-recovery-20261124-0841.bundle, sha256
626038b11450ccc5c230d7de04348af0fb67cf2b4d1d0558f3f759988d58f68d (covers HEAD 9cc5f4d).
