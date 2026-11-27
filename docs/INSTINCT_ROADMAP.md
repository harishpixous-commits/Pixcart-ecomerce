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

## Progress log
- 27 Nov 20:31 Python: Admin -> Growth settings (all modules, default OFF, validated) + seller scorecard. Endpoints: GET/PUT /api/admin/growth/settings, GET /api/admin/growth/scorecard. Files: services/growth.py, routers/growth.py, tests/test_growth.py. Settings are stored, the module behaviours (loyalty accrual, referral, cart reminders, flash sales, gift cards, COD checks) are NOT wired yet. .NET mirror: pending.
- 27 Nov 20:39 Python/Next.js: admin Growth page (frontend/src/app/admin/growth/page.tsx, menu "Growth"), type-checked with tsc, not run in a browser. Matches the Angular page.
- 27 Nov 20:41 Python: loyalty points EARN + balance + staff adjust. Table loyalty_ledger (alembic 0028), services/loyalty.py, hook in orders.transition(delivered), GET /api/loyalty, POST /api/admin/growth/loyalty/adjust. NOT done yet: redeem at checkout, reversal on return, expiry, storefront/account display. .NET mirror: pending (needs a V005 migration script).
- 27 Nov 20:44 Python: sitemap from the API, GET /api/seo/sitemap.xml (honours Growth -> Search engines). Note: the Next.js frontend already had its own sitemap.ts and robots.ts, so my earlier "sitemap absent" gap was only true for the .NET/Angular version. Mirror: .NET pending.
- 27 Nov 20:46 Python: COD risk rules at checkout (blocked pincodes, value cap, first-order cap) -> error code cod_risk, services/growth.cod_block_reason. NOT wired: block_after_refused (needs a refused-delivery record). .NET mirror pending.
- 27 Nov 20:49 Python: seller's own scorecard GET /api/seller/scorecard. Seller portal screen NOT built yet.
- 27 Nov 20:50 Next.js: Seller -> Quality page, type-checked with tsc, not run in a browser.
- 27 Nov 20:51 Python payments step 1 (docs/PAYMENT_GATEWAYS.md sections 2-3): migration 0029 (payments.provider refs to 100 chars, client_data, payment_gateway_events), services/payment_routing.py (settings validation, eligibility, circuit open/half-open/closed, success-rate strategy, failover on/off, event recording and 7-day pruning), tests/test_payment_routing.py. NOT done: adapters (Cashfree, PhonePe, PayU, Stripe), simulator, place-order routing, switch/callback/webhook endpoints, admin Payments page, Integrations entries, Angular/Flutter. .NET: pending from step 1.
- 27 Nov 20:54 Python payments step 2: services/gateways.py adapters (Cashfree, PhonePe, PayU, Stripe: create, attempts, refund, webhook and return verification) tested against HTTP fakes only (tests/test_gateways.py). Never run against real gateways. NOT done: key entry on Integrations, placement at checkout, endpoints, admin page.
- 27 Nov 21:00 Python payments step 3a: Cashfree, PhonePe, PayU, Stripe added to Admin Integrations (keys, enable switch, webhook URL, Test connection) in config, registry, checks. Tested with HTTP fakes. NOT done: checkout placement/failover, switch/callback/webhook endpoints, admin Payments page. Only integration, gateway and routing tests were run this block (full suite not re-run).
- 27 Nov 21:08 Python payments step 3b: placement with routing and failover (services/payment_gateways.py, used by place_order), payment object per section 4 incl. alternatives, POST /api/orders/{id}/payment/switch, GET|POST /api/payments/{code}/callback, POST /api/payments/{code}/webhook, admin GET gateways / PUT routing / POST test, migration 0030. Tested against fakes only; order/payment/refund/money suites pass (scoped runs). NOT done: admin Payments page, Angular/Next.js/Flutter handling of the new modes (redirect, form, cashfree modal) so the shopper UI still only opens Razorpay, the unpaid-order expiry check was not given its own multi-gateway test.
- Admin Payments page (Next.js): gateway order, failover and strategy settings, 24h health, Test connection. Type-checked only.
- Shopper payment modes (Next.js): redirect, form (PayU) and Cashfree modal via lib/gateway-pay.ts, plus 'Pay another way' on the order page. Type-checked only, never run against a gateway.
- Referral (Python): migration 0031, services/referral.py, GET /api/referral, POST /api/referral/apply, admin GET /api/admin/growth/referrals; both sides get loyalty points on the friend's first delivered package. Test added. Not wired: shopper screen, admin list screen, redeeming points at checkout.
- Loyalty redeem (Python): POST /api/loyalty/redeem turns points into a single-use platform-funded flat coupon (needs cart >= discount / max_redeem_percent, 30 days); unused expired coupons give the points back. Caveat: the coupon code is not tied to one user. Not wired: checkout UI button, reversal of earned points on return.
- Abandoned-cart reminders (Python): migration 0032, services/cart_reminders.py, job every 30 min, 'abandoned_cart' notification template (in-app and email, editable in admin). Only customers who opted in to marketing; stops after an order; coupon code named in the message. Test added. Not wired: admin view of reminders sent, SMS/WhatsApp templates.
- Gift cards (Python): migration 0033, services/gift_cards.py. Staff issue cards (admin POST/GET /api/admin/growth/gift-cards, void); holders check balance and redeem all or part into a single-use coupon (POST /api/gift-cards/balance, /redeem), unused expired coupons return the amount. Not built: shoppers buying a card online (needs a payment flow), screens.

- Flash sales: Growth flash_sales settings (max duration, max discount) now guard seller deal creation when enabled, on top of the existing Deals feature. show_countdown is a storefront flag, not yet wired.

- Segments: GET /api/admin/growth/segments[?segment=new|never_ordered|repeat|vip|lapsed], off by default, counts and lists (200 max) with spend. Read-only; no campaign send, no admin screen yet.

- Bulk edit: POST /api/seller/variants/bulk-edit (price percent, stock set/add, on/off), preview by default, row cap and on/off from Growth bulk_edit. Skips versions in a running deal. No screen yet.

- Review slice customer-misc (Python read in full for notifications, support tickets, events, privacy; .NET export/delete compared): data export (DPDP right to access) lacked support tickets, loyalty, referral and wishlist. Fixed in both versions (added them). Held, not changed: notifications read-all also marks email-channel rows read (harmless); account delete leaves loyalty rows and gift-card coupons of the anonymised user (owner decision). addresses.py and the .NET side of support/addresses not read line by line yet.

- Shopper Rewards page (/rewards) in Angular and Next.js: loyalty points to coupon, referral code and apply, gift card balance and redeem. Type-checked only, not run in a browser. Linked from Coupons.

- Admin Growth page: new Gift cards tab (issue, list, void) and Segments tab (counts, member list) in Angular and Next.js. Type-checked only, not run in a browser.

- Review slice seller-products-inventory (inventory.py read in full, product_import.py read, seller_products.py patch/bulk paths read): Python listing upload crashed (500) on prices written as NaN, Infinity or 1e999999. Fixed with row errors, test added. .NET import already handles these. Rest of seller_products.py (create/update form, lifecycle) not read line by line.

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

## Push 51: assistant double confirm fixed in both versions (Instinct)
Slice 18's held item is now fixed. Confirming an assistant action first marks it "running" (committed), then runs it; a second confirm gets 409 action_done. Failure handling covers running too. Python: migration 0034 (check constraint), routers/assistant.py, assistant/actions.py. .NET: script V011__assistant_action_running.sql, AssistantActionsBAL.DecideAsync (the permission check now sits inside the failure handler so a refused action ends failed, not stuck running). Tests: test_a_running_action_cannot_be_confirmed_again (Python, 8 assistant tests pass) and A_running_action_cannot_be_confirmed_again (.NET, 10 assistant action tests pass, which also applies V011). Not covered: an action left running if the server dies mid-run stays running (no timeout sweep yet), and the shop assistant's own confirm was not changed.

## Push 52: gift card purchase built, both versions (Instinct)
Shoppers can buy a gift card online. Off by default: needs gift_cards.enabled plus the new gift_cards.allow_purchase (Admin, Growth settings). Flow: POST /api/gift-cards/purchase {amount_paise} makes a gateway payment (first eligible gateway that is not Razorpay) and a purchase row; POST /api/gift-cards/purchase/{id}/check asks the gateway for its own records and issues the card once, only for a captured payment of exactly the full amount. Asking twice returns the same code; a different amount or a failed payment issues nothing; another shopper gets 404. Python: GiftCardPurchase model, migration 0035, services/gift_cards.py. .NET: V012 script, GiftCards.StartPurchaseAsync/CheckPurchaseAsync, IPaymentGatewayBAL.EligibleAsync. Tests use a fake gateway in both (Python test_buying_a_gift_card..., .NET GiftPurchaseTests); gift card tests pass in both. NOT built: a webhook branch (a shopper who pays and never returns gets the card only when check is called), the shopper screens (buy page, return page), void-and-refund of a bought card, email delivery of the code, Razorpay for card purchases. Real gateways were never contacted; Cashfree/PhonePe/PayU/Stripe adapters are only exercised by their existing fakes. Still the open question for Harish: guests vs signed-in only (built signed-in only).

## Push 53: shopper gift card screens and seller nav link (Instinct)
Rewards page (Next.js and Angular) now has a "Buy a gift card" section, shown only when staff switched gift cards and buying on (new GET /api/gift-cards/options in both backends). Buy opens the gateway's redirect page in a new tab and remembers the purchase; "I have paid, check now" calls the check endpoint and shows the code. Only redirect-mode gateways (PhonePe, Stripe) work from this page; Cashfree (modal) and PayU (form) show a "not supported for gift cards yet" message. Gateway return URLs still point at the order callback, so the shopper comes back by hand. Seller nav now has "Bulk edit" in both. Type-checked only, never run in a browser. Backend tests for options pass in both.
