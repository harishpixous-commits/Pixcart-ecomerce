# Instinct rebuild handover - refreshed 2026-11-24 09:55 IST

Branch: `instinct/port-commerce` (base: `dotnet-angular`). HEAD at refresh: `00ce370`.
This is a progress snapshot, not final acceptance and not a stopping point. Development
continues on the same branch after this snapshot.

Everything below was run on a local machine against a local MySQL 8.4 and loopback
mocks (Razorpay, MSG91, WhatsApp, SMTP sink). No production system, paid service, or
deployment of any kind was touched. The live `main` branch (FastAPI/Next/Vercel) was
used only as a read-only reference and was never modified.

Correction on provider contact, carried from the earlier reports: during an early
orders slice the rebuilt code made 3 requests to the real Razorpay API before the
fail-closed guard existed; all 3 failed unauthorized and this was disclosed at the
time. Since that fix every provider call is restricted to a loopback mock whenever
`App__ExternalProviderMode` is not `open` (it never is here), and the guard throws
before any egress is attempted. Do not describe this session as having had zero
live-provider contact; describe it as: 3 failed unauthorized Razorpay requests early
on, everything else isolated local mocks.

Statutory framing: where the reference implements statutory behavior (invoice
numbering/tax fields, DPDP privacy deadlines such as the erasure grace period), the
port copies those deadlines and formats as implementation behavior. That is reference
parity, NOT a verified legal-compliance conclusion.

## Local run prerequisites (what a fresh machine needs)

1. .NET 10 SDK.
2. MySQL 8.4 running locally (the session used port 3307, user/password
   `pixcart`/`pixcart`, schema `pixcart`). The schema comes from the branch's own
   migration files; the session database additionally carries hand-seeded test fixtures
   (test seller/products/orders/users/notification rows) that are NOT in the repo. A
   fresh database gets an empty but valid schema; fixture-dependent behavior needs its
   own seed data.
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
# App__JobsRunAtStartup=true runs every background job once at startup, then on
# schedule (local fakes / loopback mocks only).
# The notify dispatcher additionally uses App__Msg91ApiBase / App__WhatsappApiBase
# and the admin-saved SMTP settings; all must be loopback in this environment.

# Web skeleton (currently the untouched Angular starter, see "Frontend state"):
cd PixCartWeb && npm ci && npx ng build   # verified building 2026-11-24
npx ng serve                              # serves the default Angular starter page
```

## Backend state (.NET 10 + Dapper + MySQL)

Ported module by module from the live FastAPI reference: commerce, seller,
delivery/fleet, admin ops, refunds/returns, platform settings, assistant (sandbox ask
engine), AI scaffolding with fake providers only, background jobs, customer auth,
storefront catalog, addresses, wishlist, customer reviews, engagement
(Q&A/alerts/compare), promotions shopper + seller/admin deals, sponsored products
(shopper/seller/admin + billing), notifications inbox, invoices, support tickets,
privacy (DPDP), notification outbox dispatcher.

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
- Sponsored products (b5159b7, 9ffc3a3, 244ed92): shopper serve/click/claim with
  budget and frequency rules, related products, buy-again; seller campaign CRUD,
  pause/resume actions and report; admin oversight and billing (hourly ads_billing
  job via the same fail-closed gateway).
- Seller and admin deal management (ac8fefe): deal CRUD, status transitions, product
  linking on both surfaces.
- Customer extras (24f7060): notifications inbox + unread count + read-all,
  delivery estimate, checkout coupon application, product events beacon.
- Customer support tickets (ef6cc1f): create/list/detail with messages, status
  transitions, attachment metadata path.
- Invoice PDFs (6a4d860): GST tax invoice (multi-page item table with pagination),
  marketplace fee invoice, credit note; SkiaSharp renderer; rendered pages visually
  inspected. See "Known open risks" for the inherited totals-validation gap.
- Privacy / DPDP (7ef925d): marketing consent get/set, data export (JSON of the
  account's own data), account erasure request with the reference's grace-period
  behavior (statutory framing above); destructive paths verified fixture-only, no
  real data deleted beyond anonymized test fixtures.
- Notification outbox dispatcher (00ce370): pending email/SMS/WhatsApp rows claimed
  FOR UPDATE SKIP LOCKED, attempts++, per-channel send (SMTP via MailKit; MSG91 Flow
  API; WhatsApp Cloud API template messages), sent/sent_at on success, error[:500]
  recorded and failed after 5 attempts. Verified end-to-end against a loopback SMTP
  sink and HTTP mock (wire formats inspected), plus the fail-closed guard: with a
  non-loopback provider host in restricted mode the error is recorded and retried
  with zero egress. 30-second job, reference cadence.
- Commerce core (earlier slices): cart/checkout/orders, seller hub, delivery fleet +
  delivery admin (queue/partners/KYC/docs/zones/cash/payouts/reports/returns/app
  upload), returns/refunds end-to-end for COD incl. pickup trips and credit notes.
- Jobs: all 14 reference jobs wired on JobsWorker with reference cadences, each run
  under a MySQL named lock: delivery_sweep (10s), notify (30s), deals + delivery_alerts
  (1m), expire_unpaid (2m), retry_refunds (5m), alerts - stock + price-drop senders
  (10m), unconfirmed cancel (30m), ads_billing + review_summaries (1h), cleanup incl.
  ad-impression prune, expired assistant uploads and stale action proposals (6h),
  low_stock (daily 03:00 UTC), payouts (daily 10:00 IST), delivery_payouts (weekly
  Mon 10:15 IST).
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
- Notify dispatcher: real MSG91/WhatsApp/SMTP delivery untested by design (loopback
  mocks only); email is plain-text only, matching the reference.
- Ads billing job: exercised with seeded campaigns and impressions against the
  fail-closed gateway; no real invoicing path exists here.
- All provider calls (payments, LLM, SMS, WhatsApp, push) are mock/console-only by
  design; real integration needs Harish's approval plus test keys.

### Not yet ported (missing surfaces, not merely unverified)

- Shop assistant (customer-facing storefront chat) and admin shop assistant (its KB
  and settings management). Reference dumps exist in the session environment.
- Push notification dispatch channel. The legacy INotifyBAL interface (7 members:
  Notify/NotifySeller/NotifyStaff/FlushPush/MyNotifications/MarkAllRead/DispatchPending)
  has no implementing class and overlaps already-shipped surfaces (CatalogNotifyBAL,
  the notifications inbox, and the new dispatcher). It was deliberately left
  unimplemented rather than stubbed; the push channel inside it is the real gap.

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
- Inherited invoice totals-validation gap: the reference invoice issuer prints the
  totals stored on the order without re-checking them against the order items. An
  order whose stored totals disagree with its items produces a self-inconsistent PDF
  (observed with a hand-seeded fixture; the fixture, not the renderer, was at fault
  and the renderer was verified faithful). The port preserves this reference behavior;
  the missing issuance-time validation is recorded here as an inherited data-integrity
  risk, not treated as solved by parity.

## Recovery

Git bundles of the full branch history were captured after each verified slice
(pixcart-*recovery-20261124-*.bundle, sha256 recorded in the session log and reports).
Latest bundle at refresh: pixcart-rebuild-recovery-20261124-0951.bundle, sha256
cca02efaf1a4c8a08673fd2bdb4a870db43982b27864da82091618d317cdeb7a (covers HEAD 00ce370).
