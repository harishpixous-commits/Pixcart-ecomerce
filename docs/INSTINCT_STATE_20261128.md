# Instinct build state, 28 Nov 2026

Read this first. Branches: `instinct/continue` (.NET API + Angular) and `instinct/python-advanced` (Python + Next.js). Rule: every feature is in both, same settings and workflow. `main` (live Python demo) and the company repos are untouched.

## Validation (after Push 137)
- Python: 312 tests passed. .NET: 579 passed (5 groups). Angular `ngc` and Next.js `tsc` clean.
- Python storefront viewed in headless Chrome (seeded demo data, Next.js dev server on the FastAPI backend): home, product page, search listing with the New badge, and the welcome popup all render correctly. Also driven with a scripted headless Chrome (puppeteer-core) on the seeded demo: OTP sign-in, add to cart, cart page, new address, checkout with cash on delivery, order confirmation page. No page or console errors. Pay online with test Razorpay keys returns a clean 502 (Razorpay rejects the fake key, as expected); the online payment path was not completed in a browser. All 44 admin pages were opened signed in as an admin in headless Chrome: each loaded with no page error, no console error and no failing request (one needed a re-run after a slow first compile). Only loading was checked, not saving changes or using the controls.
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
