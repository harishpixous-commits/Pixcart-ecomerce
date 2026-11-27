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
