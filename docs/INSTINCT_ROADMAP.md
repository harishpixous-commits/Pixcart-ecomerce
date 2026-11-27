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
