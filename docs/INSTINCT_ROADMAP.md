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
