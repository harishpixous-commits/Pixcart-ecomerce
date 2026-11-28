# Instinct build state, 28 Nov 2026

Read this first. Branches: `instinct/continue` (.NET API + Angular) and `instinct/python-advanced` (Python + Next.js). Rule: every feature is in both, same settings and workflow. `main` (live Python demo) and the company repos are untouched.

## Latest numbers (28 Nov, after Push 177)
- Single full runs: Python 349 passed, .NET 416 passed, 0 failed. Angular `ngc` and Next.js `tsc` clean. Anything older below is history.
- Since Push 137: collections, redirects, product tags, search listing text, bundle and volume coupon kinds, "Buy the set" block, tag filter on the search page, cart hints for volume, buy-X-get-Y and bundle offers, a fix so product-limited coupons only show on their own product pages, and money-path tests (totals, seller split, rounding, cancel, per-customer limits).
- Alembic 0060 to 0063 and .NET V037 to V040 were run on a real local Postgres/MySQL: upgrade, downgrade, upgrade again, clean.
- New browser screens since Push 137 (Tags block, Buy the set, cart hints) are type-checked only, never run in a browser. The tag block is missing from the small-screen filter bar.
- Not wired: a "volume price tiers" table on the product page (the Offers block shows the offer text instead), a tag facet in the mobile filter bar.
- Migrations: Alembic latest 0063, .NET latest V040. New settings are off by default.

## Validation (after Push 137, history)
- Python: 323 tests passed (full suite, 28 Nov after Push 145). .NET: 392 tests in one full run, all green after a route-guard fix (the earlier "579 (5 groups)" was a sum of overlapping filter groups, not a real count). Angular `ngc` and Next.js `tsc` clean.
- Python storefront viewed in headless Chrome (seeded demo data, Next.js dev server on the FastAPI backend): home, product page, search listing with the New badge, and the welcome popup all render correctly. Also driven with a scripted headless Chrome (puppeteer-core) on the seeded demo: OTP sign-in, add to cart, cart page, new address, checkout with cash on delivery, order confirmation page. No page or console errors. Pay online with test Razorpay keys returns a clean 502 (Razorpay rejects the fake key, as expected); the online payment path was not completed in a browser. All 44 admin pages were opened signed in as an admin in headless Chrome: each loaded with no page error, no console error and no failing request (one needed a re-run after a slow first compile). On the Growth page, a switch and a number field were changed in the browser and saved: the save worked, the values persisted, and an out-of-range number was rejected with a clear message. Seller side, scripted in the browser: all 11 seller pages loaded without errors, and the COD order was confirmed, packed, shipped with a courier and tracking number (an invoice number appeared), then marked delivered. Returns in the browser: the customer requested a return on the delivered order (quantity, reason, UPI id), the seller approved it and marked it received, a credit note number was issued, and the admin Returns page counts it under "Received, refund due" (cash-on-delivery refunds are recorded by staff by UPI, by design). The final "mark refunded" step by staff was not clicked. Other admin controls, delivery partner screens and online payment were not exercised.
- The Angular app has NOT been built for a browser: `ng build` exhausts the 2 GB build sandbox (tried twice, it froze the sandbox). It needs a machine with 4 GB or more. Angular is type-checked with `ngc` only.
- NOT run anywhere: the Angular app in a browser, Flutter apps, Windows publish, live payment gateways (simulators only), real email or SMS delivery.
- Python dependencies are unpinned because the pinned fastapi version was not on the index in the build sandbox. Run once on pinned versions.

## Held for the owner (not decided by Instinct)
- Account delete leaving loyalty rows.
- Refund or void of a gift card (money).
- Store credit and price history (money, not built).
- Questions: gift card purchase by guests or signed-in only; should the newsletter list feed real email once a provider is approved; should the delivery partner app show the delivery slot on the task (today it is in the drop note).

## How to run
- Python: `backend/` with Postgres, `python -m pytest tests -q` (about 5 minutes). Web in `frontend/`, `npx tsc --noEmit -p .`.
- .NET: `PixCartAPI/` with MySQL 8.4, `dotnet test Tests`. Web in `PixCartWeb/`, `npx ngc -p tsconfig.app.json --noEmit`.
- Migrations: Alembic latest 0050, .NET latest V027. New settings are off by default.

## Where the detail is
`docs/INSTINCT_ROADMAP.md` has one section per push with what works and what is not wired. Latest pushes:

- Push 112: staff can see and adjust a customer's loyalty points from the customer page
- Push 113: full-suite re-run
- Push 114: Referrals tab on admin Growth
- Push 115: gift card and referral exports
- Push 116: loyalty and coupon-use exports
- Push 117: review exports (admin and seller)
- Push 118: ticket satisfaction rating (backend, both versions)
- Push 119: ticket satisfaction screens (both web apps)
- Push 120: full-suite re-run
- Push 121: support staff are now told about tickets
- Push 122: staff alerts for seller and listing review
- Push 123: search synonyms (admin setting)
- Push 124: search synonyms in typing suggestions
- Push 125: photos with a return request (API only)
- Push 126: return photo screens
- Push 127: gift message on orders
- Push 128: size guide per category
- Push 129: newsletter box
- Push 131: share my wishlist
- Push 132: size guide per product
- Push 133: minimum order value
- Push 134: preferred delivery time
- Push 135: delivery time reaches the delivery partner
- Push 136: welcome popup
- Push 137: "New" badge on product tiles

## Full Python suite after Push 139 (28 Nov, 11:32 AM)
314 passed, 0 failed (pytest, Postgres 14, 4 min 21 s).
