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

## Push 54: loyalty and gift card coupon codes belong to one user (Instinct)
Closes the known gap. A coupon now has an optional only_user_id; the codes made from loyalty points and from a gift card are tied to the person who made them. Anyone else who types the code gets the same "not valid" answer as an unknown code. Python: migration 0036, Coupon.only_user_id, services/coupons.evaluate, loyalty.py, gift_cards.py. .NET: script V013, CouponModel.OnlyUserId, CouponsBAL.EvaluateAsync, LoyaltyPoints.cs, GiftCards.cs. Tests: Python test_a_gift_card_coupon_works_only_for_the_person_who_made_it, .NET A_gift_card_coupon_works_only_for_the_person_who_made_it, plus the existing growth, coupon and promotion tests pass. Not changed: coupons already made before this change stay usable by anyone, and the loyalty coupon path is covered by the same code but has no test of its own.

## Buy-flow verification run, 27 Nov 10:55 PM (Instinct)
Python: tests/test_orders.py, test_order_money.py, test_phase2_money.py, test_order_rules.py: 21 passed (cart, quote, COD and online with the fake Razorpay, ship, deliver, return, refund money rules). .NET: CheckoutRules, Orders, OrderMoney, PaymentPlacement, Returns tests: 19 passed; Payment, CustomerDelivery, CheckoutAdmin, AdminOrders, Shipping tests: 26 passed. No failures, nothing changed. What this is not: every payment gateway is a fake, no browser or Flutter run, no real SMS or email, no full suite run, and the two stacks were verified separately, not compared against each other line by line.

## Push 56: assistant action stuck in "running" (Instinct)
Closes the gap noted in Push 51. Claiming an action now also stamps decided_at; when someone confirms again and the action has been "running" for more than 10 minutes, it is marked failed ("Interrupted while running, check the result by hand") and the call gets 409. It is checked lazily on the next confirm, not by a background job, so an abandoned action shows as running until someone touches it. Both versions; tests: Python test_an_action_stuck_running_ends_failed_after_ten_minutes (9 assistant tests pass), .NET An_action_stuck_running_ends_failed_after_ten_minutes (11 pass). No schema change.

## Push 57: seller coupon update is now audited (Instinct)
Held item from slice 9 fixed in both versions: a seller changing a coupon now writes a "coupon.update" audit row, like create already did. Python seller_extras.py plus an assertion in test_promotions; .NET SellerCouponsBAL plus the existing test, which had pinned the old count of 0 and now expects 1. Notifications read-all (slice 3) stays as is: it also marks email-channel rows read, which is harmless.

## Push 58: staff list of gift cards bought online (Instinct)
GET /api/admin/growth/gift-card-purchases (marketing permission) in both backends lists purchases with buyer, amount, gateway, status and note, and the Gift cards tab in Admin > Growth shows a "Bought online" table (Next.js and Angular). A purchase still "created" is waiting for payment or was paid and never checked; that is the one for support to look at. There is still no button to check or refund from here. Backend tests pass in both (Python gift tests, .NET GiftPurchase); screens type-checked only.

## Push 59: staff "Check payment" for a stuck gift card purchase (Instinct)
POST /api/admin/growth/gift-card-purchases/{id}/check (marketing permission) in both backends runs the same gateway check as the shopper's, for anyone's purchase, writes an audit row (gift_card.purchase_check) and does not return the card code to staff. Paid in full issues the card once; asking again changes nothing. "Check payment" button on created rows of the Bought online table (Next.js and Angular, type-checked only). Tests pass in both stacks (Python gift tests, .NET GiftPurchase). The seller bulk-edit CSV round trip is still only a plan: needs a download of current values and an upload that goes through the existing preview/apply, nothing built.

## Push 60: seller bulk edit by spreadsheet (Instinct)
Sellers can download their versions as a CSV (id, sku, product, price in rupees, stock, active), edit it and upload it back. GET and POST /api/seller/variants/bulk-edit.csv in both backends. Upload is a preview by default (dry_run=true); applying changes only the rows that pass. Blank cell = leave as is. Per-row reasons: bad_id, not_yours, duplicate_row, bad_number, bad_active, price_out_of_range, stock_out_of_range, deal_running, no_change. Same rules as the existing bulk edit: switched off by Admin > Growth > Bulk edit, row cap from the same setting, price never above MRP, versions in a running deal keep their price. Titles and SKUs starting with = + - @ are prefixed with ' in the download so spreadsheets do not run them. 1 MB file cap, 60 uploads an hour, one audit row variant.bulk_edit_csv per applied file. Section "Or edit in a spreadsheet" on the seller Bulk edit page in Next.js and Angular (type-checked only). Tests: Python 18 growth tests pass, .NET bulk edit tests pass (2). Not done: matching by SKU when the id column is missing, editing MRP, and no browser test of the file picker.

## Push 61: scorecard auto-suspend now works (Instinct)
The setting Admin > Growth > Seller scorecard > "auto_suspend" existed in both versions but did nothing. It now does. An hourly job (Python jobs.seller_auto_suspend_job, .NET job seller_auto_suspend) suspends approved sellers at the critical level with enough orders in the window, only when both the scorecard and auto_suspend are switched on (both off by default). At most 5 sellers per run. The seller is told why (late, cancel or return percent against the limit), the audit row seller.auto_suspend has no actor, and staff reinstate with the normal approve button. A seller approved again after an automatic suspension is not suspended again for one full window, so old orders cannot trigger it twice. Tests: Python 1 new, .NET 1 new, both pass with the scorecard tests. Not checked: the admin settings screen label for auto_suspend (not changed), and nothing ran against a scheduler clock, only the function was called directly.

## Push 62: loyalty tier bonus points (Instinct)
Design: two new Admin > Growth > Loyalty settings, silver_bonus_percent and gold_bonus_percent (0 to 500, default 0, so nothing changes until staff set them). When a delivered package earns points, the customer's tier at that moment (from lifetime points, as before) adds that percent on top of the normal points. The ledger note says "(+50% tier bonus)". Returns take back points in proportion to what was earned, so the bonus is taken back with the return. GET /api/loyalty returns bonus_percent; the Rewards page shows it next to the tier. Same in Python and .NET. Tests: Python 4 loyalty/tier tests pass, .NET GrowthTests 11 pass. Screens type-checked only. Not built: tier perks other than points (free shipping, early sales), and an admin screen label (the settings form comes from the same settings list; not opened in a browser).

## Push 63: segment campaigns (Instinct)
Design: staff send one in-app message to a customer segment. Admin > Growth > Campaigns (settings: enabled, off by default; max_recipients per send, default 500; max_per_day sends in 24 hours, default 3). Needs Segments switched on. Only customers who opted in to marketing get it, in-app only (no email, SMS or push), biggest spenders first when capped. Preview is the default and sends nothing. The link must be a page on this store (starts with a single slash). Every send is logged (table segment_campaigns: Python migration 0037, .NET V014) and has an audit row campaign.send. Endpoints in both backends: POST /api/admin/growth/campaigns {segment,title,message,link,dry_run}, GET /api/admin/growth/campaigns, marketing permission. New notification event marketing_message (title and message are the two variables). Campaigns tab on the admin Growth page in Next.js and Angular (type-checked only). Tests: Python 21 growth tests pass, .NET GrowthTests 12 pass. Not built: scheduling a send for later, email or push for a campaign, customer opt-out per campaign, and a send is not undone (messages already in inboxes stay).

## Full-suite run after Push 63, 27 Nov 11:33 to 11:56 PM (Instinct)
Python (instinct/python-advanced, all 48 files in tests/, run in four chunks against Postgres 14): 270 passed, 0 failed. .NET (instinct/continue, whole Tests project, one run against MySQL 8.4): 341 passed, 0 failed, 0 skipped, 17 min 29 s. Both run on the commit with Push 63. Still not run by me: the browser suite, Flutter, Windows publish, pixel compare, and anything against live gateways, email or SMS. The Angular and Next.js screens were type-checked only.


## Push 64: saved searches with alerts
Admin > Growth > Saved searches (off by default): enabled, max_per_user 10, min_hours_between_alerts 24. A signed-in shopper follows a search (words, optional price limit) from the search page; every 30 minutes a job notes them in the app when a product approved since the last check matches every word in title or brand and is within the limit. One note per search per quiet window, with the match count. API: GET/POST /api/saved-searches, DELETE /api/saved-searches/{id}. Python migration 0038, .NET V015. UI: button on search page, list on the alerts page, both frontends. Tested: one test per stack passes; type-checks clean. Not wired: email delivery, matching by category or description.


## Push 65: remote-area shipping surcharge (shipping zones)
Admin > Growth > Shipping zones (off by default): remote_prefixes (pincode prefixes, comma separated), remote_surcharge_paise (default 6000), waive_when_free (default on). The surcharge is added once per seller package in the checkout quote and when the order is placed, so both always agree. With waive_when_free a package that already ships free pays nothing extra. The free-shipping nudge in the cart now depends on the item total only. The cart page has no address, so it shows the base fee; the quote shows the surcharge. Python growth.remote_surcharge, .NET ShippingZones.SurchargeAsync (CartBAL.GroupBySeller takes the surcharge). No schema change. Tests: one per stack; Python test_growth + test_orders pass (33); .NET Cart/CheckoutRules classes pass (18). Not built: per-state fees, per-seller zones, weight-based rates. Return reasons are still a fixed list, not admin-editable (candidate next).


## Push 66: admin-editable return reasons
Admin > Growth > Return reasons: label_<code> renames a reason, off_<code> switches it off (codes stay, defect rules stay, empty label keeps the built-in text, all stay if every one is switched off). Used by the customer reasons list, return validation, the seller note and the return view. New "label" setting kind keeps typed case (the text kind upper-cases). Python growth.return_reasons, .NET ReturnReasonsConfig. Tests: one per stack; Python growth, returns, delivery, ledger tests pass (42); .NET Growth + new test pass (13). Not wired: the shop assistant still quotes the built-in reason texts; the Python assistant knowledge base uses the renamed list.


## Push 67: bulk coupon codes
POST /api/admin/coupons/{id}/generate {count 1..200, prefix 2..10 letters or digits, single_use default true} (marketing permission). Copies a platform coupon into N copies with unique random codes (prefix + 6 characters, no 0/O/1/I). Single-use copies get usage_limit 1, per-user 1, and stay off the checkout list. Seller coupons and coupons made for one person cannot be copied. Audited. Python admin_extras.generate_coupons, .NET CouponBatch. No schema change. Tests: one per stack pass. Not built: an admin screen for it (API only), CSV export of the codes, expiry override per batch.


## Push 68: admin screen for bulk coupon codes
Admin > Coupons: open a platform coupon and use "Make copies with their own codes" (how many, prefix, single use each). The new codes show in a box to copy. Both frontends. No backend change. Type-checked only; not run in a browser.


## Push 69: scheduled campaigns
Admin > Growth > Campaigns: optional "Send later" time (2 minutes to 30 days ahead). The campaign is logged as scheduled and counts toward the daily cap; a job every 5 minutes sends due ones, working out the opted-in list again at send time (so people who opted out meanwhile are left out). Cancel works on scheduled ones only. Held, not lost, while campaigns or segments are switched off. Python migration 0039 (status, send_at), .NET V016; campaigns.send_due/cancel and SegmentCampaigns.SendDueAsync/CancelAsync. Tests: one per stack pass (with the existing campaign test). Known gap: a .NET campaign claimed as sending that crashes mid-send stays in "sending" and is not retried. Not built: recurring campaigns, per-send email.


## Push 70: staff notes on orders
- Private staff notes on an order: GET/POST /api/admin/orders/{id}/notes (Orders permission, up to 1000 chars each, 100 per order, audit "order.note"). Never shown to customers or sellers. Python migration 0040, .NET V017.
- "Staff notes" section on the admin order page in both frontends.
- Tested: one new Python test and one new .NET test pass. Screens type-checked only. Notes cannot be edited or deleted.


## Push 71: review reminders
- Admin Growth "Review reminders" (off by default): one in-app note per delivered package, after_days (5) after delivery, if the shopper reviewed nothing in it. max_age_days (30) stops old orders being messaged when it is switched on. Hourly job. Once per package (sub_orders.review_reminded_at). Python migration 0041, .NET V018.
- Tested: one new test each side. In-app only; no email or SMS reminder, and the note links to the order page, not the review form.


## Push 72: seller free-delivery amount
- Admin Growth "Seller free delivery" (off by default) with min_paise and max_paise. When on, a seller sets their own free-delivery amount in Settings (empty = the marketplace amount). It is kept inside the bounds when used, so tightening the bounds later takes effect at once. The cart gap hint, checkout quote and order placement all use it. Python migration 0042, .NET V019.
- Saving the form with an unchanged stored value is accepted even when the module is off; a changed value is checked against the bounds.
- Tested: one new test each side; Python orders, money, growth and seller test files pass (57). Screens type-checked only. The cart and product pages still show the marketplace amount in any static text.


## Push 73: delivery fee by destination state
- Growth "Shipping zones" has a new text setting state_fees ("33:3000, 29:5000": state code, then the fee in paise). While Shipping zones is on, a seller package that does not ship free pays that fee for an address in the listed state; other states use the marketplace fee. Used by the checkout quote and order placement. No schema change.
- Tested: one new test each side. The cart page (no address yet) shows the marketplace fee. Free-delivery thresholds are not changed by state.


## Push 74: gift card code by email
- When a bought gift card is issued (the gateway confirmed full payment), the buyer also gets an email with the code, amount and expiry (template gift_card_bought, editable under Admin notification templates). Sent only on the first issue, never when the buyer or staff re-check. Needs an email address on the account and SMTP set up; otherwise the buyer still sees the code on screen as before. Python and .NET (the .NET email goes out after the commit).
- Tested: the existing purchase test now covers the email (once, with the code and amount) on both sides. Not done: refund or void of a bought card, guests buying, Cashfree and PayU for card purchases.


## Push 75: repeating campaigns
- A scheduled segment campaign can repeat every 7, 14 or 30 days, 1 to 12 more times (needs a first send time). After each send the next one is created as its own scheduled row, never earlier than an hour ahead; cancelling that row ends the series. The list is worked out again at each send, so people who opted out are left out. Python migration 0043, .NET V020. Campaigns form has a Repeat control in both frontends.
- Tested: one new test each side (invalid combinations, two repeats, cancel ends it). Repeats are not counted against max_per_day when they run. Known gap unchanged: a .NET campaign claimed as "sending" that crashes mid-send is not retried.


## Push 76: CSV bulk edit matches by SKU
The seller CSV upload now accepts an id or sku column. A row with a blank id is matched on its SKU (case-insensitive, leading apostrophe ignored) among that seller own versions. New row reasons: unknown_sku, ambiguous_sku (SKU shared by two versions). An id still wins over a SKU; another seller SKU is never matched. The downloaded template is unchanged. Both versions, with tests (Python 2 bulk_edit tests, .NET Seller_bulk_edit_csv_round_trip). Screens type-checked only. The old "sku only file is invalid" assertion was flipped on purpose.


## Push 77: review reminder opens the review form
The review reminder note now links to the first unreviewed product page (#reviews) instead of the order page. Both versions, assertion added to the existing reminder test on each side. Still in-app only (email/SMS channel not built).


## Push 78: campaign that fails mid-send is retried (.NET)
.NET: a scheduled campaign claimed as "sending" that throws mid-send (for example a notify failure) is put back to scheduled and the error is rethrown, so the next 5-minute run sends it. People already notified may get it twice (at-least-once). Not covered: a process killed mid-send still leaves the row in "sending" (no claimed-at column to time it out). Python needed no change: it marks the campaign sent in the same transaction as the sends, so a failure rolls everything back. New .NET test with a failing notifier; the 4 campaign tests pass.


## Push 79: free-delivery amount by destination state
- Growth "Shipping zones" has a new text setting state_free_above ("33:80000, 29:150000": state code, then the item total in paise from which a seller package ships free there). While Shipping zones is on, it replaces the marketplace free-delivery amount for an address in a listed state; other states are unchanged. A seller own amount (Seller shipping) still wins. Used by the checkout quote, order placement and the cart view when an address is known. No schema change.
- Tested: one new test each side (listed and unlisted state, lower and higher amount, switched off). The cart page with no address still shows the marketplace amount.


## Push 80: "Order again" on an order
- New POST /api/cart/reorder/{order_id} (signed in; own orders only, others get 404). Puts every item of the order back in the cart through the normal cart rules (stock, per-item limit, deal units), adding to what is already there. Returns the cart view plus added, skipped (title and reason, for example out of stock) and notices. An "Order again" button on the order page calls it and opens the cart. No schema change, no setting (always on).
- Tested: one new test each side (cart refilled, out-of-stock line skipped with reason, another shopper and an unknown id get 404). Screens type-checked only; the button was not clicked in a browser.


## Push 81: ship reminders for sellers
- Admin > Growth > Ship reminders (off by default; after_hours 24, max_age_days 14). A job every hour sends the seller one in-app note ("Order X is waiting to ship") for each package that is confirmed or packed, not shipped after_hours since confirmation. Once per package. Packages confirmed longer ago than max_age_days are skipped, so switching it on does not message about old orders. In-app only (the seller email/SMS channels are not wired for this event). Python migration 0044 (sub_orders.ship_reminded_at), .NET V021; ship_reminders.send_due and ShipReminders.SendDueAsync, hourly job on both.
- Tested: one new test each side (off, too recent, once only, shipped package skipped). The admin screen entry is type-checked only.


## Push 82: full test run, one regression fixed
- Full Python suite (run in chunks, 48 files): 283 passed, 0 failed. Full .NET suite (run in 6 filter groups): 377 passed, 0 failed after the fix below.
- Regression found and fixed (.NET): the route-guard table test failed because the new POST /api/cart/reorder/{orderId} had no route rule. It now carries RouteGuard("signed_in"). Lesson: every new .NET route needs a RouteGuard attribute when the reference has no entry.
- Not run: browser suite, Flutter, Windows publish, live gateways.


## Push 83: product page shows the seller own free-delivery amount
- Defect fixed (both versions): the product page "Free when you buy X or more from this seller" always showed the marketplace amount, even when a seller had set their own (Push 72) and the cart used it. The product payload seller block now carries free_shipping_threshold_paise (the seller own amount kept inside the admin bounds when Seller shipping is on, else the marketplace amount), and the product page uses it. Not changed: the by-state amount (Push 79) needs a delivery address, so the product page still ignores it.
- Tested: assertions added to the existing seller-own-amount test on each side (own amount shown, marketplace amount when the module is off). Screens type-checked only.


## Push 84: pincode check follows the checkout delivery rules
- Defect fixed (both versions): the "check delivery" box on the product page (GET /api/catalog/delivery-estimate) showed the marketplace fee and amount only. It now uses the same rules as the checkout quote: the seller own free-delivery amount (kept in the admin bounds), the by-state amount and fee, and the remote-area surcharge (waived when the package ships free). delivery_fee_paise includes the surcharge; free_delivery_from_paise is the amount that applies for that pincode state.
- Tested: one new test each side (state fee plus surcharge, unlisted state, by-state amount, seller own amount winning). The shop assistant text and the home page announcement still quote the marketplace amount (they have no seller or address).


## Push 85: seller orders page flags late orders
- GET /api/seller/orders now also returns late_count (open packages: placed, confirmed or packed, created more than the seller own dispatch_days ago, at least 1 day) and late_after_days. The seller Orders page shows a note above the tabs ("N open orders are more than D days old. Ship them first."). No new route, no setting, no schema change; always on.
- Tested: one new test each side (0 when fresh, 1 when old, still 1 after confirm, 0 once shipped). Screens type-checked only.

## Push 86: admin dashboard "Orders late to ship"
Staff dashboard gets `orders_late_to_ship`: open packages (placed/confirmed/packed) older than their seller own dispatch days (min 1). Stat shown only when above zero, links to admin orders. Both versions. Tested in the late-orders tests on both sides.

## Push 87: review reminders also by email
New email template for `review_reminder` (editable in admin templates) and Python now sends it on the email channel as well as in-app (.NET already sent on every channel with a template). Email only leaves when the email integration is set up and the shopper has an email. Tested on both sides. Ship reminders stay in-app (seller side).

## Push 88: ship reminders also by email to the seller
New email template for `seller_ship_reminder` (editable in admin templates), both versions. Goes only when the email integration is set up and the seller account has an email. Tested on both sides.

## Push 89: full-suite re-run and fixes
Python: 285 passed (whole suite). .NET run in groups: all pass after two test fixes. The admin dashboard test pinned 18 keys (now 19 with `orders_late_to_ship`), and the two reminder tests counted email rows with the in-app ones (now count in-app only). Note: the .NET test runner script does not rebuild, so the Push 87 and 88 .NET tests had run against a stale build until now; they are rebuilt and pass. Not run: browser, Flutter, live gateways, deploy.

## Push 90: admin orders list can show only the late ones
`GET /api/admin/orders?late=1` lists orders with a package that is open (placed/confirmed/packed) and older than its seller dispatch days. The dashboard "Orders late to ship" number now links there, so the number and the list agree. Both versions, tested (list total 1 then 0 once shipped). The Orders page keeps the filter in the address bar like the other filters; there is no on-page control for it yet.

## Push 91: "Late to ship only" checkbox on admin Orders
Checkbox in the Orders filter bar, both frontends, sets the `late=1` filter from Push 90 (also counts as an active filter for Clear filters). Type-check only; not run in a browser.

## Push 92: "Bought together" row on the product page
New growth setting `bought_together` (off by default; `max_items` 1 to 12, default 4) in Admin → Growth. When on, the product payload carries `bought_together`: public in-stock products that were in the same live orders (placed to delivered; cancelled and unpaid orders ignored), most often first. A "Bought together" row shows above "Customers also viewed" on both storefronts. No schema change; computed from order history on each view (no cache yet, fine for a small catalog). Tested on both sides (two products in one order, off then on); frontends type-checked only.

## Push 93: loyalty tier perk, free delivery
Two new Loyalty settings in Admin → Growth, both off: `silver_free_delivery` and `gold_free_delivery`. When loyalty is on and the member tier has the perk (gold keeps silver perks), shipping and the remote-area surcharge are waived on the cart, the checkout quote and the placed order (the same figure in all three, so the total check at checkout matches). COD fee and other fees are not waived. Both versions; tested for member, silver, then gold-only. The product-page pincode estimate does not know the member (it works without a login), so it can still show a fee.

## Push 94: rewards page tells the member about the free-delivery perk
`GET /api/loyalty` now returns `free_delivery` (true when loyalty is on and the member tier carries the perk from Push 93). The Rewards page shows "free delivery on your orders" next to the tier. Both versions; tested in the tier test; screens type-checked only.

## Push 95: review bonus points
Two Loyalty settings in Admin → Growth: `review_points` (0 = off, default) and `review_min_chars` (30). When loyalty is on, a published review from someone who received the product earns that many points, once per delivered package (the ledger allows one "adjust" row per package, so editing or deleting and rewriting the review does not pay again). A review held for approval pays when staff publish it. Both versions; tested (off, too short, paid once, edit not paid again). The settings screen is the generic growth form, so no new screen. Not covered: points are not taken back if the review is later hidden.

## Push 96: review bonus is taken back when staff hide the review
Hiding a review (admin moderation) takes back its bonus once (never below a zero balance). Publishing it again does not pay twice. Both versions, tested. Not covered: a review the customer deletes keeps its bonus (rewriting does not pay again, so there is nothing to gain).

## Push 97: full-suite re-run after Pushes 90 to 96
Python: 288 passed (whole suite). .NET in groups on a fresh build: 102 + 85 + 82 + 114 passed, 0 failed. Not run: browser, Flutter, Windows publish, live gateways, deploy. Frontends are type-checked only.

## Push 98: first order bonus points
Loyalty setting `first_order_points` in Admin → Growth (0 = off, default). The first package a member has delivered earns that many extra points on top of the normal points, in the same ledger row, with a note on the history line. Later packages get no bonus. Both versions, tested. Only applies where the package already earns points (loyalty on, points per 100 above 0, goods worth at least 100 rupees).

## Push 99: Rewards page lists the ways to earn
`GET /api/loyalty` also returns `review_points` and `first_order_points` (the first one only until the member has earned anything). The Rewards page shows a line for each that is set. Both versions; tested in the first-order test; screens type-checked only.

## Push 100: admin Growth hint lists the Loyalty extras
The Loyalty section hint on the Growth admin page (both frontends) now names the optional settings added in Pushes 62, 93, 95, 96 and 98 so staff can find them. Text only; type-checked, not browser-run.

## Push 101: product-page delivery estimate knows the member tier

The pincode delivery-estimate on the product page now shows free delivery (fee 0, `member_free_delivery: true`) to a signed-in Silver/Gold member whose tier carries free delivery, matching the cart and checkout. Visitors still see the fee. Both versions; tests extended on each side. Not run: browser.

## Push 102: deleting a review takes its bonus points back

When a customer deletes their own review, the review bonus points are taken back (once, never below a zero balance), same as when staff hide it. Re-writing the review does not pay again. Both versions; the review-bonus test extended on each side. Not run: browser.

## Push 103: loyalty points now expire (expiry_days was a dead setting)

The Growth loyalty setting `expiry_days` (365 by default, 0 = never) was stored but never used. Now, while loyalty is on, points earned before the cut-off and not spent lapse (oldest spent first): one negative "Points expired" row, applied lazily when the member opens Rewards or redeems, and it lapses once. Both versions; a test on each side. Not wired: no advance warning message to members. Not run: browser.

## Push 104: COD risk `block_after_refused` now works (was a dead setting)

With the COD risk module on, a customer whose cash packages came back undelivered (every return-to-seller path: seller RTO, courier webhook, delivery partner) that many times (default 2) can no longer choose cash on delivery; online payment stays open. Checked at order placement. Both versions; a test on each side. Note: with the module on, the default of 2 is now live. Not run: browser.

## Push 105: full-suite re-run after Pushes 98 to 104

Python: whole suite ran to the end, no failures (run with -x, all dots). .NET: 391 tests across five groups, 0 failed (Growth+Seller 54, Admin/Cms/Account/Auth 54, Checkout/Assistant/Llm/Sms 87, Payment/Gateway/Delivery/Export/Report/Workbook/Fleet 82, everything else 114). No code changes in this push. Not run: browser, Flutter, Windows publish, live gateways.

## Push 106: Flash sales `show_countdown` now works (was a dead setting)

Admin → Growth → Flash sales → show_countdown (on by default) now decides whether the product page badge and the two theme tiles show the ticking clock. The deal object carries `show_countdown`; the web apps hide the clock when it is false. Both versions (React and Angular type-check clean); backend test on each side. Not wired: the home "deal of the day" strip and the deals list still show their own clock. Not run: browser.

## Push 107: Rewards page warns about points that expire soon

`GET /api/loyalty` now returns `expiring_soon` (points that lapse within `expiring_days`, fixed at 30) and the Rewards page shows "N points expire within 30 days. Use them at checkout." Computed from the same oldest-first rule as the expiry itself; 0 when expiry is off. Both versions (React and Angular type-check clean); a test on each side. Not wired: no email or push reminder before expiry. Not run: browser.

## Push 108: home "Today's deals" rail honours show_countdown

Completes Push 106: the home deals rail hides its ticking clock too when Admin → Growth → Flash sales → show_countdown is off. Web apps only (React and Angular type-check clean); the data was already served. Not run: browser.

## Push 109: points expiry reminder (in-app and email)

New loyalty setting `expiry_reminder` (off by default; needs loyalty on and expiry_days above 0). A job every 6 hours sends each member whose points lapse within 30 days one in-app note and one email ("N points expire soon", editable template `points_expiring`, links to Rewards), not again until 30 days have passed. Both versions; a test on each side. Not run: real email delivery, browser. Admin Growth page shows the new switch from the settings schema; its hint text is not updated.

## Push 110: Growth admin loyalty hint covers expiry and review deletion

Hint text on Admin → Growth → Loyalty now explains expiry_days, expiry_reminder and that deleting a review also takes its points back. Web text only, both apps.

## Push 111: admin Loyalty overview tab

New `GET /api/admin/growth/loyalty` (marketing permission) and a "Loyalty" tab on Admin → Growth: members holding points, points held and their rupee value (what the shop owes in rewards), and points earned, redeemed and expired in the last 30 days. Both versions (React and Angular type-check clean); a test on each side. Not wired: no per-member list or export. Not run: browser.

## Push 112: staff can see and adjust a customer's loyalty points from the customer page

The admin adjust-points API existed in both versions but no screen used it. New `GET /api/admin/growth/loyalty/{user_id}` (marketing permission) and a "Loyalty points" card on Admin → Customers → a customer: balance, rupee value, tier, latest history, and a form to add points or take them back (minus number) with a reason the customer sees. The balance never goes below zero (existing rule). Both versions (React and Angular type-check clean); backend test on each side. Not run: browser.

## Push 113: full-suite re-run
Python 293 passed. .NET 395 passed, 0 failed (5 groups, after clean rebuild). An earlier Python run stalled on leftover DB state from an aborted run; a clean rerun finished in under 6 minutes. Not run: browser, Flutter, live gateways.

## Push 114: Referrals tab on admin Growth
Both web apps now show the referrals list (referrer, friend, status, reward, joined) from GET /api/admin/growth/referrals, which already existed with the same shape in Python and .NET. No backend change. Validated: type-check clean in both apps. Not run: browser.

## Push 115: gift card and referral exports
Two new admin exports (CSV, Excel, PDF) in both versions, needing the marketing permission: Gift cards (code shown as last 4 only, value, balance, used, expiry, status) and Referrals (referrer, friend, joined, status, reward). The Exports page lists them from the API, so no screen change. Hunt result: every admin GET with no literal caller was a false positive; no dead growth settings remain. Tests: Python exports 8 passed; .NET export tests 17 passed (count pins updated deliberately). Not run: browser.

## Push 116: loyalty and coupon-use exports
Two more admin exports (CSV, Excel, PDF), marketing permission, both versions: Loyalty points (every ledger entry with customer, type filter) and Coupon use (coupon, customer, order, discount, released). Tests: Python exports 9 passed; .NET export tests 18 passed (count pins updated deliberately). Coupon-use rows are only checked for headers and that the query runs, not with sample data. Not run: browser.

## Push 117: review exports (admin and seller)
Seller hunt: every seller API has a caller; GET /api/seller/earnings is intentionally replaced by Payouts. Added a Reviews export in both scopes and both versions (date, product, seller, rating, text, verified, status, seller reply, helpful votes, open reports; no customer names). Seller scope shows only their own products. Admin needs the catalog permission and can filter by seller and search text. Tests: Python exports 10 passed; .NET export tests 19 passed (count pins updated deliberately). Not run: browser.

## Push 118: ticket satisfaction rating (backend, both versions)
Hunt: no orphan delivery or support APIs. Gap found: customers could not rate how a request was handled. New columns on support_tickets (csat_rating 1-5, csat_comment, csat_at; Alembic 0045, .NET V022). POST /api/support/tickets/{id}/rating: owner only, only when resolved or closed, once. Ticket JSON now carries csat_rating, csat_comment, csat_at for the customer and staff. GET /api/admin/tickets/satisfaction (support permission): rated count, average, 1-5 spread, resolved-but-unrated count, latest 10 comments. Always on, no setting (it only collects feedback). Tests: Python 10 passed (support + platform), .NET 6 passed (satisfaction + route guards). Screens (customer rating form, admin summary) come in Push 119. Not run: browser.

## Push 119: ticket satisfaction screens (both web apps)
Customer ticket page: once a request is resolved or closed and unrated, a 1-5 rating with optional comment; after rating it says "You rated this N/5". Admin ticket page shows the customer rating and comment. Admin Support desk has a Customer satisfaction card (average, rated count, unrated resolved count, 5-to-1 spread, latest comments). Validated: type-check clean in both apps (tsc, ngc). Not run: browser.

## Push 120: full-suite re-run
Python 297 passed, 0 failed. .NET 400 passed, 0 failed (5 groups after a clean rebuild). Covers Alembic 0045 / V022 and the exports and satisfaction work of Pushes 115 to 119. Not run: browser, Flutter, live gateways.

## Push 121: support staff are now told about tickets
Gap: nobody on the support desk was notified of a new request, a customer reply, or a bad rating, even though replies are due within 48 hours. New staff event staff_ticket (in-app and push, to everyone with the support permission): New support request or grievance, Customer replied on TKxxxx, and Low rating on TKxxxx (rating 2 or less). Always on, like the delivery staff alerts. Both versions. Tests: Python support/accounts/admin-prefs 16 passed; .NET satisfaction/notification tests passed. Not run: email or SMS for staff (in-app and push only), browser.

## Push 122: staff alerts for seller and listing review
New staff event `staff_review` (in-app, no setting, always on). Fires when a seller submits onboarding (sellers permission) and when a seller submits a listing (catalog permission), with a link to the admin page. Both versions. Tests: Python test_support, .NET SellerOnboarding and SellerProducts assertions. Not run: email/push delivery, browser.
## Push 123: search synonyms (admin setting)
New setting `search_synonyms` (off when empty): groups like "tee = t-shirt; sneakers = shoes", single words only, in Admin Settings. A search for one word also finds products using the others (up to 6 query variants; relevance is the best match). Both versions plus admin screens. Applies to the product search page; the typing suggestions do not use it yet. Full-suite re-run after Push 122/123: Python 301 passed; .NET all groups green (A 87, C-E 122, G-T 187, S 144). Flipped deliberately: AdminFeedbackTests notification counts ignore `staff_review`. Not run: browser.
## Push 124: search synonyms in typing suggestions
The suggestion dropdown now uses `search_synonyms` too (both versions, tests extended). Sandbox was reset mid-run; test tools (Python deps, Postgres 14, MySQL 8.4, .NET 10) were rebuilt. Python deps were installed unpinned because the pinned fastapi version is not on the package index here, so a later run on pinned versions is still worth doing. Frontend type-check not re-run yet after the reset.
## Push 125: photos with a return request (API only)
New growth section `return_photos` (off by default): enabled, required_for_defects (damaged, defective, wrong item, missing parts), max_photos 1-6. New `POST /api/returns/photos` (signed in) and `photos` on `POST /api/returns`; `photos` is returned on every return view (customer, seller, staff). Photos are checked to come from our `return-photos` folder. Alembic 0046, .NET V023. `GET /api/returns/reasons` now also returns the photo settings. Photo checks run before the item checks. Both versions. Not wired yet: the customer return form, the seller and admin return screens, the admin Growth settings card (next push). Note: photos are served from the public media folder under random file names, like review photos. Tested: Python end to end including the seller view; .NET settings, validation and upload (the .NET save of a return carrying photos is not covered by a delivered-order test).
## Push 126: return photo screens
Customer return form: photo picker when enabled (up to the admin max, thumbnails with remove, submit blocked when a photo is required for a defect reason and none added). Seller and admin returns screens show the photos. Admin Growth has a Return photos card. Both web apps. Type-check clean (tsc, ngc). Not run: browser, so the upload flow is untested in a real page. The staff Open a return form does not take photos.
## Push 127: gift message on orders

Admin → Checkout has a "Gift message" switch (off) and a longest length (20 to 300, default 150). When on, checkout shows a gift message box. The text is kept on the order address (`ship_to.gift_message`, no migration) and shown to the customer, the seller (with a pack-it-without-the-price note, and on the packing slip in .NET/Angular and Python web) and staff. Refused with `gift_off` when switched off and `gift_too_long` over the limit. Tests in both versions; tsc and ngc clean. Not run in a browser. Open question for Harish: may guests buy gift cards, or signed-in users only.

## Push 128: size guide per category

Admin → Categories has a "Size guide" box: one line per size, columns split with "|", first line is the heading (up to 30 lines, 8 columns). Product pages show it as an expandable table above the size choices. A sub-category uses the nearest parent guide when it has none. Empty means no guide. Bad tables (one line, uneven columns) are refused. Alembic 0047, .NET V024. Tests in both versions; tsc and ngc clean. Not run in a browser. Not built: a guide per product, or size recommendations.

## Push 129: newsletter box

Admin → Growth → Settings has "Newsletter box" (off, with a heading). When on, the shop shows an email box above the footer (all themes). The address is checked, lower-cased and kept once; asking again gives the same answer. 10 sign-ups per hour per visitor address. Admin → Growth → Newsletter lists the latest 200 and lets staff remove an address. Alembic 0048, .NET V025. Tests in both versions; tsc and ngc clean. Not run in a browser. NOT wired: nothing is emailed, no unsubscribe link, campaigns do not use this list (they send in-app notes to customers). Open question for Harish: should this list feed real email once an email provider is approved.

## Push 131: share my wishlist

Admin → Growth → Settings has "Share wishlist" (off). When on, the wishlist page has "Share my wishlist": it makes a private link (`/wishlist/shared/<secret>`), with Copy link and Stop sharing. Anyone with the link, signed in or not, sees the shopper first name and the saved products that are live. Stop sharing kills the link, and a new one is made next time. Switching the setting off stops every link. Alembic 0049, .NET V026 (users.wishlist_share_token). Tests in both versions; tsc and ngc clean. Not run in a browser. Python route order matters: the share routes sit before /api/wishlist/{product_id}.

## Push 132: size guide per product

A seller can type a size guide on one product (seller product form, "Size guide (optional)"). It shows on that product page ahead of the category guide. Empty means the category guide (nearest parent) as before. Same "a | b" table rules, cleaned and refused when it cannot be shown. Editing it counts as a content change, so an approved listing goes back to review like other content. Alembic 0050, .NET V027 (products.size_guide). Tests in both versions, tsc and ngc clean. Not run in a browser. Checked first: product compare, recently viewed, order notes and bulk coupons already exist.

## Push 133: minimum order value

Admin → Checkout has "Minimum order" (fees key `min_order_paise`, 0 means none, default 0). A cart below it shows a note ("Minimum order is ₹X. Add items worth ₹Y to place your order") and the order is refused with error code `min_order`. It tests the item total before shipping, fees and coupons. No migration (fees live in the settings store). Tests in both versions, tsc and ngc clean. Not run in a browser. Dead-settings scan: every Growth and Fees setting is read somewhere; none dead.

## Push 134: preferred delivery time

Admin → Checkout → Checkout options: "Preferred delivery time" (off) with 2 to 6 choices split with ; (default Morning, Afternoon, Evening). When on, checkout shows the choices plus "No preference". The pick is stored in `ship_to.delivery_slot` (no migration) and shown to the customer, seller and admin as a request. Plainly NOT wired: nothing in couriers, delivery partner assignment or shipping rules reads it, so it is not a promise and the screens say so. Error codes `slot_off`, `slot_unknown`. Tests in both versions, tsc and ngc clean. Not run in a browser. Open question for Harish: should the delivery partner app show it on the task.

## Push 135: delivery time reaches the delivery partner

Wiring for Push 134. The delivery partner trip screen (and admin trip view) now leads the drop instructions with "Customer would like delivery: <time>." when the customer picked one, only while the partner is allowed to see customer details. No UI change, no migration. Still a request: assignment, routing and ETAs do not use it. Unit tests in both versions (drop_note / DropNote); not run against a live trip in a browser.

## Push 136: welcome popup

Admin → Growth → Settings → "Welcome popup" (off): title, text, button label, link, delay (0 to 60 seconds). The storefront opens it once per browser after the delay (stored in the browser, so it shows again only when the title or text changes). Close by button, Escape or clicking outside. The link is only offered when it starts with / (a page on this shop); outside links are dropped by the public endpoint `GET /api/promo-popup`. No migration. Tests in both versions, tsc and ngc clean. Not run in a browser, so timing and focus handling are unchecked. Not wired: no targeting by page, device or new/returning shopper.

## Push 137: "New" badge on product tiles
Growth section `new_badge` (off by default, window of 1 to 90 days, default 14). Product cards carry `is_new`; bazaar, luxe, classic and fresh tiles show a "New" line. Same on wishlist cards in .NET. Python: tests/test_catalog.py. .NET: New_badge test. No migration. Not run in a browser.

## Browser smoke test, Python storefront (28 Nov)
Seeded demo data, ran FastAPI plus Next.js dev, screenshots from headless Chrome: home, product page, search with New badges, welcome popup after switching both on through the admin API. All rendered without errors. Not covered: clicking through cart, checkout, admin pages; Angular app.

## Held items: groundwork notes (Instinct, 28 Nov, design only, nothing changed, no money moved)

### 1. Account delete and loyalty points
Today `delete_account` (Python `routers/customer.py`; .NET equivalent in the customer BAL) anonymises the user, keeps orders for GST, and leaves `loyalty_ledger` rows and their balance in place. They are tied to a deactivated login, so nobody can spend them, but the rows still count toward any "points outstanding" total.
Options for the owner: (a) leave as is and exclude deleted users from the outstanding-points report; (b) write one `adjust` row that zeroes the balance with note "account deleted" (keeps the ledger honest, no money moves); (c) warn on the delete screen that unused points are lost.
Recommendation: (b) plus (c). It is a small change in both stacks, no migration (`adjust` is an allowed kind). Needs the owner's yes because it removes customer value.

### 2. Gift card void and refund
Model: `gift_cards.status` is `active` or `void`; `gift_card_uses` records balance moved into single-use coupons; `gift_card_purchases` records online buys with `gateway_ref` and stays `created` until the gateway reports capture.
Open cases: (1) void a card that still has balance: today it just stops working, with no refund path; (2) void a card whose coupon was already partly used; (3) refund a purchase back to the gateway.
Proposal, not built: void sets balance to 0 and writes an audit row; a refund is only offered when the card is unused (balance equals initial), is a purchase (has a gateway ref), and goes through the same gateway refund call orders use, simulators only until the owner approves live use. Partly used cards are void-only, no refund. Any refund is staff-initiated, never automatic, and logged. Needs the owner's decision on refund policy before code.

## Browser click-through, Python storefront (28 Nov)
Scripted headless Chrome on seeded demo: sign-in by OTP, add to cart, cart, address form, checkout, cash on delivery, order page. All worked, no console or page errors. Online payment with fake test keys fails cleanly with 502 from the gateway. Not covered: online payment success, admin pages, Angular app.

## Browser load check, all Python admin pages (28 Nov)
Signed in as admin, opened every admin route in headless Chrome on the seeded demo. No page errors, console errors or failing requests. Loading only, controls were not exercised.

## Browser check, Growth settings save (28 Nov)
In headless Chrome as admin: switched on Share wishlist, set New badge days to 21, saved. Values persisted (confirmed through the API). A value of 1421 was rejected with "new_badge.days must be a whole number between 1 and 90", correct behaviour.

## Browser check, seller order handling (28 Nov)
As the seller (Chennai Silks & Co): 11 seller pages loaded clean. Confirmed, packed, shipped (courier plus tracking) and delivered the demo COD order; the invoice number was issued on shipping. No errors. Not covered: returns and refunds, delivery partner app screens, online payment.

## Browser check, return flow (28 Nov)
Customer requested a return on the delivered COD order, seller approved and marked received, credit note issued, admin Returns shows it as refund due. The staff step that records the UPI refund was not clicked. No errors.

## Push 138: Minimum order quantity per product (Python done, .NET/Angular pending)
Seller or admin sets "Minimum order quantity" (0 to 100, 0/1 = none) in the product info editor. Stored in `Product.details.min_qty`, so no migration. Adding to cart raises the quantity to the minimum with a notice; it fails if stock is below the minimum. Checkout flags a line under the minimum as a cart problem. The product page shows "Minimum order: N" and the quantity picker starts there. Test: `tests/test_cart_limits.py`. Not wired: .NET `ProductInfo.cs`/cart and Angular UI (pending, see state doc).

## Push 139: Pre-order ship date per product
Seller/admin can set "Pre-order: ships from" (a date up to a year ahead) in the product info editor, stored in `Product.details.ships_on` (no migration). While the date is ahead, the product page and cart line show "Ships from <date>"; once it passes the listing is normal. Not wired: it does not move the seller's dispatch deadline or tell the buyer by email; the order itself is placed as usual (COD or simulator payment). Test: `tests/test_cart_limits.py`.

## Push 140: Both held policies built, chosen by the owner in Admin (Python done; .NET/Angular pending)
1. Account delete and loyalty points: Admin > Growth > Loyalty "on_account_delete" = keep (default, rows stay as before) or zero (an "adjust" row takes the whole balance to 0 at delete, audit note says how many). The shopper sees a warning with their point count before confirming (GET /api/account/delete-info, shown in the delete dialog). 
2. Refund of a bought gift card nobody used: Admin > Growth > Gift cards "staff_refund" (off by default). On: staff get a Refund button on the Bought online table, enter the payment reference; the card is voided, balance zeroed, purchase shows "refunded" with the reference, buyer is told in-app and by email, audit row. A card with any use is refused (409). Staff send the money from the gateway dashboard; no gateway is called (nothing live). Migration 0051. Tests: tests/test_policies.py (both branches of both policies).
Not wired: automatic gateway refund call.

## Push 141: AI agents framework and the delivery agent (Python)
- New: `agent_proposals` table (alembic 0052), `app/agents/` (core, executors, delivery), `/api/admin/agents` (overview, settings, proposals, run, approve, reject), job every 30 minutes, Admin -> AI agents page, `agents` growth section, notification `seller_tracking_reminder`.
- Delivery agent: seller reminder, cancel and refund, ask for tracking. Owner approval always. Tests: `tests/test_agents.py` (2). Status doc: `docs/AI_AGENTS_STATUS.md`. .NET port next.

## Push 142: Order update agent (Python)
- `app/agents/orderupdate.py`: shipped packages past the promised delivery date by N hours get a proposal to tell the customer (event `order_delay`, in-app and email). Approve sends it; a package delivered meanwhile is skipped. Settings `orderupdate_*`. Test added to `tests/test_agents.py`. .NET port next.

## Push 143: Sourcing and reorder agent (Python)
- `app/agents/reorder.py`: stock versus recent sales rate; proposes asking the seller to restock with a suggested quantity (event `seller_restock`). Settings `reorder_*`. Stale check if stock was topped up. Test added. .NET port next.

## Push 147: Automatic discounts (Python and .NET/Angular done)
- Admin, Coupons: a platform coupon can be marked "Apply automatically". Admin, Growth, "Automatic discounts" (off by default) switches the feature on. With it on, a cart with no typed code gets the automatic coupon that saves the most; every normal coupon rule still applies, a typed code replaces it. Reuses the existing coupon engine (no new price maths), so the redemption, limits and seller payout rules are the same. The checkout quote shows `coupon.automatic = true`.
- New column `coupons.is_automatic` (Alembic 0053; .NET V030 pending). Test: `tests/test_auto_discounts.py` (setting off, on, bigger saving wins, typed code wins, one redemption recorded). Next.js type-check clean; not run in a browser.

## Push 148: Buy X get Y discount (Python done; .NET/Angular pending)
- Admin, Coupons: new type "Buy X get Y" (platform coupons only): customer buys X, the cheapest Y of every X+Y items get N% off (100 = free). Columns coupons.buy_qty, get_qty (Alembic 0054, kind check widened). Works with codes and with Automatic discounts. Test: tests/test_bxgy.py. Not covered: limiting it to chosen products (category limit works). Alembic 0054 not run against a real upgrade, only the test schema. Next.js type-check only.

## Push 149: Customer staff notes and tags (Python and .NET/Angular done)
- Admin, Customers, a customer's page: private "Staff note" (up to 1000 characters) and up to 10 "Tags" (VIP, wholesale ...), edited in the Edit form, saved with the customer edit audit line. Never shown to the customer (the sign-in/me output does not carry them). Columns users.staff_note, users.staff_tags (Alembic 0055; .NET V032). Tests: tests/test_customer_notes.py and the .NET Staff_note test. Not wired: filtering the customer list or segments by tag, tag-based coupons. Alembic 0055 not run as a real upgrade. Next.js and Angular forms type-checked only.

## Push 150: Customer list finds staff tags (Python and .NET done)
- Admin, Customers: the search box also matches staff tags, and the list API takes ?tag= for an exact tag (any letter case). Each row carries its tags. Tests: tests/test_customer_notes.py, .NET Customer_list_filters_and_searches_by_staff_tag. Full suites at this point: Python 328 passed; .NET 397 passed, 0 failed (single full runs).

## Push 151: Coupon limited to chosen products (Python and .NET done)
- Admin, Coupons: "Only these products" takes product link names (last part of the product page address), comma separated. Only those products count towards the discount and the minimum; empty means the whole cart. An unknown name is refused. Platform coupons only (seller coupons are unchanged). Column coupons.product_ids (Alembic 0056; .NET V033). Tests: tests/test_coupon_products.py and the .NET Coupon_limited test. Not wired: a product picker (names are typed). Forms type-checked only.

- Push 152 was withdrawn: a per-product size guide (and category one) already existed (size_guide, shown in the buy box). My duplicate size_chart was reverted by new commits, nothing deleted from history.

- Push 153: Order tags (Python done; .NET/Angular next): staff can add up to 10 private tags to an order (Admin > Order page > Tags), see them under the order number in the list, and filter the list by an exact tag (?tag=); the search box finds tags too. Alembic 0057 orders.staff_tags. Test: tests/test_order_tags.py. Next.js type-check clean; not run in a browser.

- Push 154: Duplicate a product (Python done; .NET/Angular next): seller product page, Duplicate button makes a new draft "Copy of ..." with the same content, images, videos and prices, fresh SKUs (-COPY, -COPY2 ...) and zero stock; original untouched. Test: tests/test_product_duplicate.py. Next.js type-check clean; not run in a browser.

- Push 155: Collections (Python done; .NET/Angular next): Admin > Collections makes a page of chosen products at /collections/<link name>: hand-picked by product link names (in order) or by rules (category, brand, price range); can be hidden, edited, deleted. Public API /api/catalog/collections and /{slug}. Alembic 0058. Test: tests/test_collections.py. Not wired: links to collections in menus or home sections (add the address by hand in Storefront menus). Next.js type-check clean; not run in a browser.

- Push 156: Collections in the sitemap (Python and .NET): active collection pages are listed in sitemap.xml for search engines. New switch in Admin > Growth > Search engines "sitemap_include_collections", on by default. Hidden or deleted collections drop out. Tested in both versions (collections and sitemap tests). Still not wired: collection links in menus and home sections.

- Push 157: Collection links in menus (Python/Next.js and .NET/Angular): in Admin > Storefront > Navigation, every links list (bar links, All menu extra links) has an "Add a collection link" dropdown that fills in the label and /collections/<name>. Screens only, no new API; type-checked clean in both, not run in a browser. Home page sections still need their address typed by hand.

- Push 158: URL redirects (Python/Next.js done; .NET/Angular next): Admin > Redirects maps an old address (/old-shirt) to a new one (/p/new-shirt or https://...), permanent 301 or temporary 302, on/off, hit count. Only used when the shop has no page there: the page-not-found screen asks GET /api/catalog/redirect?path= and follows the rule. Refuses reserved areas, unsafe addresses, same-address and circles; 500 rules max. Alembic 0059. Test: tests/test_redirects.py. Not wired: no automatic redirect when a product link name changes (staff add the rule by hand); not-found follow is in the browser, so search engines see a 404 first. Next.js type-check clean, not run in a browser.

- Push 159: Home page row from a collection (Python/Next.js done; .NET/Angular next): in Admin > Storefront > Home sections, a Products row can now "Show: One of your collections" and pick a collection; the row shows that collection's products (up to "How many") and disappears while the collection is hidden or empty. Test: tests/test_collections.py. Next.js type-check clean, not run in a browser.

- Push 160: Product tags (Python/Next.js done; .NET/Angular next): a seller adds up to 10 short tags to a product (Product editor > Tags), tidied to lower case. Shoppers/search can filter /api/catalog/products?tag=gift; a collection can pick by tag ("Rule: product tag"); Duplicate keeps tags. Changing tags never sends a live product back for approval. Alembic 0060 (products.tags, product_collections.tag). Test: tests/test_collections.py. Not wired: no tag chips on the product page or a tag box on the shop search page yet. Next.js type-check clean, not run in a browser.

- Push 161: Search listing text per product (Python/Next.js and .NET/Angular): sellers can write a search title (70 characters) and description (160) in the product editor; empty means the product title and description are used as before. Edits never send a live product back for approval. The product page sends them as the page title and description (Next.js). Next.js and Angular screens are type-checked only. Not wired: the Angular product page does not set page title or description from these (it never set per-product ones), and no search-result preview in the editor.

- Push 162: Tag chips on the product page and a tag filter on the shop search (Python/Next.js and .NET/Angular): the public product API returns tags; the product page shows them as links to /search?tag=; the search page passes the tag to the catalog and shows a removable "Tag: x" chip. Screens are type-checked only, never run in a browser. Not wired: a tag facet list on the search page (you reach it from a product page or a typed link).

- Push 163: Bundle offers (Python/Next.js and .NET/Angular): a new coupon kind "Bundle" in Admin > Coupons. Pick 2 to 10 products and a percent off (1 to 90); when the cart holds every product of the set, each complete set gets that percent off (extra units of one product are not discounted). Works as a normal or automatic coupon, so every usual rule (dates, limits, first order) still applies. Not wired: a "buy the set" block on the product page and a one-click add-all button.

- Push 164: Volume offers (Python/Next.js and .NET/Angular): a new coupon kind "Volume" in Admin > Coupons: "buy N or more, get P% off" (N at least 2, P 1 to 90), optionally limited to chosen products. Counted over the eligible units in the cart; all of them get the percent off once the minimum is reached. Reuses coupon rules and can be automatic. Forms type-checked only. Not wired: price tiers on the product page.

- Push 165: Money-path tests for the new offers (bundle, volume): order total equals the quote, the seller split adds up to the paise, cancelling gives the coupon use back (Python and .NET); a partial return of a volume-offer order refunds its share of the discount (Python only so far). No bug found, tests only.
