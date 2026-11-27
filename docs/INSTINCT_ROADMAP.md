# Advanced roadmap (Instinct, 27 Nov)

Rule: every item ships in BOTH versions (.NET/Angular on `instinct/continue`, Python on `instinct/python-advanced`), same options, same workflow, admin-configurable. No deploy, no live providers, `main` untouched.

## Benchmark basis
Marketplace feature checklist (rigbyjs.com/blog/b2c-marketplace-features): seller scorecards (order defect rate, late shipment, responsiveness), progressive penalties, loyalty tiers, referral, flash sales, bulk catalog tools, seller self-service for returns and disputes.

## Gap scan of the Python reference (grep of backend/app, 0 hits = absent)
Absent: abandoned-cart recovery, loyalty/points, referral, gift cards, customer segments, newsletter, flash-sale schedule, seller scorecard, bulk edit, COD verification, blocklist, sitemap.
Present: wallet (i18n only, no ledger), redirects, low stock, wishlist, compare, price drop, back in stock, fraud (1 file), SLA, cancel reasons.

## Priority list (each item: admin settings page + API + storefront/seller effect, both versions)
1. Payments steps 4-7 from docs/PAYMENT_GATEWAYS.md (order flow, endpoints, Angular, Flutter), simulators only.
2. Seller scorecard + progressive penalties (defect, late ship, response time; thresholds in admin).
3. Abandoned-cart recovery (timers and message templates in admin).
4. Loyalty points + tiers, referral codes (rates and tiers in admin).
5. Flash sales with schedule, gift cards, store credit.
6. Admin: bulk product edit, customer segments, blocklist/COD risk rules, SEO (sitemap, redirects UI).
7. End-to-end buy flow verification per version (cart, coupon, pay, ship, return, refund) and fixes.

## Order of work
Backend review slices continue first (next: customer-misc), then items 1 to 7. Slice log lives in CONTINUATION_NOTES_INSTINCT.md.
- 27 Nov 20:52 .NET payments step 1: V006 migration, BAL/PaymentRouting.cs (settings validation, eligibility, circuit, success-rate, failover, event recording), Tests/PaymentRoutingTests.cs. Same gaps as Python: no adapters, simulator, placement, endpoints or admin page yet.
- 27 Nov 20:55 .NET payments step 2: BAL/PaymentGateways.cs (Cashfree, PhonePe, PayU, Stripe adapters) tested against HTTP fakes only. Same gaps as Python: not wired to checkout, keys, endpoints or admin yet.
- 27 Nov 21:02 .NET payments step 3a: the 4 gateways on Admin Integrations (registry, settings, Test connection via adapters) with tests. Scoped tests only. Not done: checkout placement/failover, switch/callback/webhook endpoints, admin Payments page.
- Payments step 3b (.NET): routing/failover at checkout, switch, callback, webhook, admin routing API; 3 fake-gateway tests; Payment/Order/Integration/RouteGuard/Refund scoped runs green. Not wired: Admin Payments page, shopper UI modes, Flutter.
- Admin Payments page (Angular): same as Next.js version. Type-checked only.
- Shopper payment modes (Angular): same as Next.js (core/gateway-pay.ts, Pay another way). Type-checked only.
- Referral (.NET): V008__referrals.sql, BAL/ReferralRewards.cs, GET /api/referral, POST /api/referral/apply, admin GET /api/admin/growth/referrals; both sides get loyalty points on the friend's first delivered package. Test added; Growth, RouteGuard, Delivery, Parity scoped runs green. Not wired: shopper and admin screens, redeeming points at checkout.
- Loyalty redeem (.NET): POST /api/loyalty/redeem, same design as Python (single-use platform-funded flat coupon, points back if unused after 30 days). Test added; Growth, CheckoutRules, RouteGuard runs green. Caveat: coupon code not tied to one user.
- Abandoned-cart reminders (.NET): V009__cart_reminders.sql, BAL/CartReminders.cs, 'cart_reminders' job every 30 min in JobsWorker, 'abandoned_cart' template in-app and email. Same rules as Python (marketing opt-in only, stops after an order). Test added; CheckoutRules, Job, Notif, Parity, Growth runs green.
- Gift cards (.NET): V010__gift_cards.sql, BAL/GiftCards.cs, same endpoints and rules as Python. Test added; CheckoutRules, RouteGuard, Parity, Growth runs green. Not built: shoppers buying a card online, screens.

- Flash sales: Growth flash_sales settings (max duration, max discount) now guard seller deal creation when enabled, on top of the existing Deals feature. show_countdown is a storefront flag, not yet wired.

- Segments: GET /api/admin/growth/segments[?segment=new|never_ordered|repeat|vip|lapsed], off by default, counts and lists (200 max) with spend. Read-only; no campaign send, no admin screen yet.

- Bulk edit: POST /api/seller/variants/bulk-edit (price percent, stock set/add, on/off), preview by default, row cap and on/off from Growth bulk_edit. Skips versions in a running deal. No admin or seller screen yet, no CSV round trip.

- Review slice customer-misc (Python read in full for notifications, support tickets, events, privacy; .NET export/delete compared): data export (DPDP right to access) lacked support tickets, loyalty, referral and wishlist. Fixed in both versions (added them). Held, not changed: notifications read-all also marks email-channel rows read (harmless); account delete leaves loyalty rows and gift-card coupons of the anonymised user (owner decision). addresses.py and the .NET side of support/addresses not read line by line yet.

- Shopper Rewards page (/rewards) in Angular and Next.js: loyalty points to coupon, referral code and apply, gift card balance and redeem. Type-checked only, not run in a browser. Linked from Coupons.

- Admin Growth page: new Gift cards tab (issue, list, void) and Segments tab (counts, member list) in Angular and Next.js. Type-checked only, not run in a browser.

- Review slice seller-products-inventory: compared with Python. Python listing upload crashed on NaN, Infinity, huge prices (fixed on instinct/python-advanced). This .NET import already refuses them as row errors. Inventory allocate and warehouse code not re-read on the .NET side.

- Loyalty reversal on return: when a seller receives a return, the matching share of the package earned points is taken back (kind reverse), once per share, never below zero (spent points stay spent). Referral reward is not clawed back (held decision). Python has an end-to-end test; .NET tests the rule directly, the return path is wired but not run end to end with loyalty on.

- Cart reminders log: GET /api/admin/growth/cart-reminders (latest 100, sent in 30 days, ordered afterwards) and a Cart reminders tab on the admin Growth page. Tested in both backends, screens type-checked only.

## Review slice 9 of 20: seller-orders-onboarding (Instinct)
Read: routers/seller_orders.py in full, seller_onboarding.py validators, seller_extras.py inventory and coupon routes.
No crash or money defect found. Held, not changed: seller coupon update writes no audit row; reject uses SellerAccount (not ApprovedSeller), so a suspended seller can still cancel. Not read line by line: seller_extras returns, reviews, product-reports; .NET seller controllers not compared this pass.

## Seller bulk-edit screen (Instinct)
Page at /seller/bulk-edit in Angular (seller/pages/bulk-edit.page.ts, route added) and Next.js (seller/bulk-edit/page.tsx). Search, pick options, choose action, Preview, then Apply. Type-checked only, not run in a browser. Not in the seller nav yet and no CSV round trip. Gift card purchase flow is still to design (needs a payment flow).

## Gift card purchase flow: design (Instinct, not built)
Why not built yet: today's payment records hang off Order/SubOrder, so a card purchase needs its own small payment record and its own webhook branch in each gateway path. That is money code in two stacks; it should not be rushed.
Plan, both versions, off by default behind the existing gift_cards.enabled setting plus a new gift_cards.allow_purchase flag:
1. Table gift_card_purchases: id, user_id, amount_paise, recipient_email (optional), message, status (created, paid, issued, failed), gateway, gateway_ref, gift_card_id.
2. POST /api/me/gift-cards/purchase: validates amount against min_paise/max_paise, creates the row, creates a gateway intent through the same payment_routing used for orders. Simulator gateway only until Harish approves live use.
3. Gateway webhook / verify path: on a verified paid event for a purchase ref, call gift_cards.issue once (idempotent on gateway_ref), mark issued, show the code on the page. Email delivery of the code uses the existing mail queue, no real send in tests.
4. Refund: a purchased card with full balance can be voided and refunded through the gateway; a used card cannot.
5. Tests against the simulator: pay then issue once, duplicate webhook issues once, failed payment issues nothing, amount limits, setting off blocks purchase.
Open decision for Harish: whether purchased cards may be bought by guests or only signed-in users (plan assumes signed-in only).

## Fix: unpaid-order expiry only asked Razorpay (Instinct)
Defect (both versions): the expiry job asked Razorpay about every payment. An order paid through Cashfree, PhonePe, PayU or Stripe errored on that lookup, was treated as "cannot verify", and so never expired: stock stayed held. Fix: non-Razorpay payments are checked through their own gateway (Python check_with_gateway, .NET CheckWithGatewayAsync); a paid result keeps the order, an error still leaves it alone. Razorpay path unchanged. Tests use a fake gateway that reports no payment; I did not run the new Python test against the old code to prove it failed before.

## Review slice 10 of 20: delivery-fleet (Instinct)
Read in the Python version: fleet.py ready_for_pickup, offer, advance, deliver, staff_deliver, earnings, generate_payouts, plus fee_for. Checked: OTP and pickup code are rate limited and set before any path that can accept them; COD collected must equal the amount due; payout generation skips paid weeks, deducts only cash in hand and never goes negative. No defect found. Not read line by line: candidates/auto_assign, return pickups, fail/returned, stuck_check, push.py, routers/delivery.py. .NET side not compared this pass.
Hardening idea, not done (not reachable today): reject an empty expected code, so a missing pickup_code or delivery_otp could never match an empty entry.

## Review slice 11 of 20: delivery-admin (Instinct)
Read in Python: cash, deposits, payouts list/generate/paid, partner docs and bank view. Payout paid is locked and idempotent; bank view needs the payouts permission and is audited. Held, low severity, same in both versions: recording a cash deposit reads the partner's cash in hand without locking the partner, so two staff recording at the same instant could together exceed what the partner holds. Fix is a row lock (Python) and a new for-update read plus unit of work (.NET); not done this pass. Rest of the file (assign, zones, KYC, reports) not read line by line.

## Review slice 12 of 20: admin-ops (Instinct)
Read in Python: seller suspend/commission, admin cancel and deliver, refund retry and manual settle, customer block/unblock, and the refund worker they interact with. Checked that settle-by-hand and the refund worker cannot both pay: the worker holds the refund row lock across the gateway call and settle waits on the same lock. Gateway errors from every provider share one error class, so failed non-Razorpay refunds reach "failed" after 8 tries. No defect found. Not read line by line: dashboard, seller/product lists, product approve/reject, categories, customers list, reports. .NET side not compared this pass.

## Review slice 13 of 20: admin-extras (Instinct)
Read in Python: payouts (run, bank file, send, paid, cancel, use-current-bank), admin returns (open, actions), and the first half of admin_search. Good: payout creation fixes the bank account at creation and RazorpayX refuses to send if the seller's bank changed since; send is idempotent per payout id. Held, owner decision, same in both versions: "mark paid by UTR" is allowed on a payout that is still processing at RazorpayX, so staff who mark it paid by hand while RazorpayX also pays it would pay twice. Suggested rule: block manual mark-paid while status is processing and a provider payout id exists. Not changed. Not read line by line: coupons, reviews, tickets, storefront, media, go-live. .NET side not compared this pass.

## Review slice 14 of 20: exports-reports-integrations (Instinct)
Read in both versions: the spreadsheet formula guard on data exports (Python safe_cell, .NET ExportCsv.Encode, same rules, .NET has a test), the guard on the payout bank file (_csv_cell / Cell, same rules), and in Python the integration secret handling (secrets stored encrypted, an empty secret box keeps the saved value, audit log records field names only). No defect found. Not read line by line: reports.py, stats.py, analytics.py, checks.py, registry.py, the PDF writer.

## Review slice 15 of 20: promotions-ads-engagement (Instinct)
Read in Python: ads.click (charging), the running-campaign budget test, and ads.bill (daily ledger posting). Checked: each click link is charged once (impression row locked), only the visitor the ad was shown to is charged, repeat clicks in 24 hours are free, daily and total budgets cap the cost, per-address and per-network paid-click caps apply, billing posts only finished days and adds GST. No defect found. Very small held risk, not changed: a paid click landing in the last seconds of a day can add spend between billing's read and its "mark billed" update, so that spend would be marked billed without being charged; the click link window is short, so the loss is a click or two. Not read line by line: deals.py, promotions.py, engagement.py, review_settings.py. .NET side not compared this pass.

## Review slice 16 of 20: notify-jobs-settings (Instinct)
Read: storage.py in full (images re-encoded, videos and documents checked by magic bytes, private keys refuse ".."; app package names are sanitised by both callers) and sms.py. Defect fixed in both versions: an OTP SMS call answered 200 with a non-JSON body (a proxy or maintenance page) was treated as sent in .NET, and crashed with a 500 in Python. Both now treat it as a failed send. Tests: Python tests/test_sms_errors.py, .NET Tests/SmsAnswerTests.cs, run and passing. Not read line by line: notify.py, jobs.py, platform_settings.py.

## Review slice 17 of 20: assistant-core (Instinct)
Read in Python: tools.py permission gating and masking, the tool executor, sandbox.py (no-model mode) and the system prompt rules. Good: every tool declares the permission it needs and is re-checked when it runs; contact details and addresses are masked before text goes to the model; the model can only propose actions (a person confirms), text in listings, reviews, tickets and files is declared data, never instructions. No defect found. Not read line by line: queries.py, decision.py, agent.py loop, periods.py. No live model was used, so injection resistance is by design only, not tested against a real model. .NET side not compared this pass.

## Review slice 18 of 20: assistant-actions-files (Instinct)
Read in Python: the confirm flow (decide_action, actions.execute) and the .NET DecideAsync. Good: only the person who asked can confirm (others get "not found"), 30-minute expiry, role re-checked at confirm, an audit row on success and on failure. Held, low severity, same flaw in both versions: the action row stays "pending" while the action runs, and the admin endpoints it calls commit on their own, which drops the row lock. Two confirm clicks in the same moment could run the action twice. Most actions are idempotent or refuse a repeat (cancel, refund retry, coupon code), but "reply to ticket" and "moderate review" could post twice. I tried the obvious fix (a "running" status set before executing) and the database check constraint on assistant_actions.status rejected it; it needs a migration in both stacks (Alembic and a V00x script) so I reverted and left it as a held item with that plan. Upload parsing (uploads.py) only skimmed: 5 MB and 50,000 row caps, extension allow-list, xlsx read through openpyxl; not read line by line.

## Review slices 19 and 20 of 20: shop-assistant and llm-ai (Instinct)
Read in Python: shop assistant order, ticket and refund lookups (every query filters by the signed-in user's id), the cancel confirm (owner re-checked on the order, 30 minute expiry, only the cancel action exists), and LLM key storage (keys stored encrypted, screens get a short hint only, a key that no longer decrypts shows "add again"). No defect found. Same confirm-while-running pattern as the admin assistant (held item above) but a repeat cancel is refused by the order rules. Not read line by line: replies, intents, kb, starter, adapters, router, the briefs and tasks in ai/. No live model was used. .NET side not compared this pass.

## Review summary (20 of 20 slices touched, Instinct)
Fixed with tests in both versions: Python listing upload crash on NaN/Infinity prices (Python only, .NET already safe), data export missing tickets/loyalty/referral/wishlist, unpaid orders on non-Razorpay gateways never expiring, non-JSON 200 from the SMS gateway counted as sent. Held owner decisions: see slices 3 (notifications read-all, account delete leftovers), 11 (cash deposit race), 13 (manual mark-paid while RazorpayX is processing), 15 (midnight billing race), 18 (double confirm of assistant actions, needs migration). Coverage is partial: money and permission paths read closely, many files only skimmed; the .NET side was compared only where stated. Nothing here was run in a browser or against live providers.
