# PixCart Marketplace

A multi-seller marketplace for India: verified sellers list products and ship from their own warehouses,
customers pay online (Razorpay) or cash on delivery, and the platform collects commission, GST TCS and
income-tax TDS, issues GST invoices for each seller and pays sellers after the return window.

The whole storefront is run from the admin panel: brand, colours, logo, announcement bar, menus, footer,
the home page sections, information pages, business details, contact details, social media links, coupons and
customer messages. Nothing about the business is fixed in code: the brand name, legal name, address, GSTIN and
grievance officer flow from Admin → Storefront into the footer, the Contact us and grievance pages, emails,
invoices, payment screens, two-step sign-in and search-engine data. Changes show at once, with no rebuild.

## Start here

- **Launching?** Follow `docs/GO_LIVE.md` (staging → production, step by step; also at Admin → Go-live checklist).
- **Changing code (person or AI agent)?** Read `AGENTS.md`.
- **AI assistant internals:** `docs/AI_ASSISTANT.md`.
- **Customer chat on the website (shop assistant):** `docs/SHOP_ASSISTANT.md`.

## What is included

- **Shop assistant** (Help button on the storefront): customers chat or talk (English, Tanglish, Tamil, Hindi) to track
  orders, cancel before shipping (with a confirm button), check returns and refunds, find products, and raise a pre-filled
  support request with the chat attached. Works without AI (guided mode) and with any connected model. Fully separate
  from the admin assistant: own tables, knowledge base, tools and permissions; it only sees public data and the
  signed-in customer's own records. Admin → Shop assistant has the on/off switches, features, voice, limits, help
  articles, customer chats and statistics.
- **Admin AI assistant** (Ctrl+J): chat and hands-free voice in any language, exact live figures as tables and charts,
  file upload and comparison with live data, downloads of every answer (PDF, Excel, CSV), confirm-before-run changes,
  memory, any LLM provider with several keys and fallbacks, and a fast decision layer (built-in rules or Laya).
- **Integrations hub**: Razorpay, RazorpayX, MSG91, email, WhatsApp, Shiprocket, AI and Sentry keys entered in the admin
  panel, encrypted, with Test connection; **Go-live checklist**; **roles and permissions** editor.
- **Exports**: every report as CSV, Excel or PDF with filters and column choice; several at once as one ZIP.
- **Razorpay simulator** (`tools/razorpay-sim`) to run online payments, webhooks and refunds end to end locally.

**Customers** — search with typo tolerance, categories, product pages with delivery date by PIN code,
ratings and reviews (with an AI summary when many reviews exist), wishlist, recently viewed, cart that
survives sign-in, mobile OTP sign-in, saved addresses, coupons and an offers list at checkout, Razorpay or
cash on delivery, order tracking per package, cancellation, returns with UPI refunds for COD, GST invoices
and credit notes as PDF, notifications (in-app, SMS, email, WhatsApp), help centre tickets and grievances,
and DPDP tools: marketing consent, data download and account deletion.

**Sellers** — KYC onboarding (GSTIN, PAN, bank, documents), product editor with variants and an AI listing
writer, multiple warehouses with stock per warehouse, transfers, CSV import/export and a full stock history,
bulk listing upload from a spreadsheet (checked row by row before anything is saved), orders with packing
slip, GST invoice, courier booking through Shiprocket, returns, payouts with a running statement, analytics
(sales, conversion, ship time, product performance), own coupons, review replies (with AI drafts), holiday
mode, dispatch days, invoice prefix, and CSV exports from every list.

**Admin** — KPI overview with charts, seller verification, listing moderation with an AI check, orders,
returns, refunds, payouts (bank file + UTR, or RazorpayX), support desk with the 48-hour and 30-day limits,
storefront editor (including business, contact and social modules that can each be switched on or off),
coupons, message templates, GST TCS report for GSTR-8, an export centre, a go-live checklist, marketplace
settings and feature switches, integrations status, staff with six roles, two-step sign-in, audit log.

**AI studio** — one pipeline for every AI feature (pattern taken from the Metanic platform's AI core):
listing writer for sellers, listing checks for moderators (rule-based checks always run, AI adds judgement),
review summaries, support reply drafts, customer messages about an order (drafted, edited, then sent in the
app and by email), review reply drafts for sellers, and a business brief on the admin overview. Prompts are
layered for Claude's prompt caching (fixed safety rules | brand block | request), the model sees only the
facts a task needs, every draft is reviewed by a person, and every run is recorded with tokens, cache use,
latency, cost and outcome. Admins switch features on or off, pick the model, set a brand voice, extra
instructions per feature and a monthly token budget. Without an API key the studio runs in a clearly marked
sandbox mode so every screen can be tried. Explainable risk briefs (no AI call) score each order (COD and
fraud signals) and each seller (cancellations, late shipping, returns, ratings).

**Exports** — admins (by role) and sellers (only their own data) download CSV files: orders, GST line items
(HSN, taxable value, CGST/SGST/IGST, place of supply), returns, payouts, ledger, catalogue, stock, sellers,
customers, support tickets and GSTR-8. Files stream from the database in batches (no row limits, flat
memory), open cleanly in Excel (UTF-8 with BOM, Indian time, rupees with two decimals), neutralise
spreadsheet formulas, and every download is rate-limited and written to the audit log.

## Run it locally

Fastest is Docker: `docker compose up --build`, then open http://localhost:3000. The `migrate` service
creates the schema, loads demo data and creates the admin `admin@pixcart.in` / `PixCart@Admin2026`.

Without Docker (Python 3.12, Node 22 or 24, PostgreSQL 16):

```bash
# API
cd backend
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                       # edit DATABASE_URL if needed
createdb pixcart
alembic upgrade head
python -m scripts.seed --demo              # categories + demo sellers/products/coupons (omit --demo in production)
python -m scripts.create_admin --email admin@yourdomain.in
uvicorn app.main:app --port 8000 --reload

# Web (second terminal)
cd frontend
npm ci
API_ORIGIN=http://localhost:8000 npm run dev
```

**Signing in.** Customers and sellers use their mobile and a one-time code. **Sign in** (`/login`) is for existing
accounts; a number without one is offered **Create account** (`/signup`: name, mobile, optional email, terms).
Sellers start at **Become a seller** → *Create your seller account* → business, PAN/GST, pickup, bank, grievance
officer, documents → *Submit*, and an admin approves them in Sellers. Until SMS (MSG91) is connected, the code is
shown **on the screen under the code box** with a *Fill in* button, and also printed in the API log
(`DEV OTP for 98xxxxxxxx: 123456`). Switch the on-screen code off in **Admin → Sign-in and accounts**; it never
appears in production or once real SMS is connected. The same page pauses new customer or seller sign-ups and sets
whether the email is asked. Demo sellers sign in with 9000000001 to 9000000003, the demo customer with 9999900001.
Staff sign in with email and password at `/admin/login`. Demo coupons: `WELCOME10` (first order) and `FESTIVE250`.

**Product photos and videos.** On a computer, hovering a thumbnail shows that photo and hovering the photo opens a
magnified view beside it; clicking opens a full-screen viewer with **Videos** and **Images** tabs (arrow keys,
click to zoom, Esc to close). On phones the photos swipe and a tap opens the viewer. Sellers add MP4/WebM videos
in the product editor (the browser takes the poster frame and length; nothing is re-encoded), staff in Admin →
Listings → a listing → Videos. Admin → Marketplace settings → *Product page* switches zoom and videos on or off
and sets the zoom strength, the largest video and the number of videos per listing.

**Product page.** Gallery | details | buy box, like the large marketplaces, plus:
- **Price and buying:** unit price (₹ per 100 g, kg, litre or piece, from each version's net quantity); the coupons this product
  qualifies for, with copy-code; service icons (free delivery, pay on delivery, returns, top seller, verified seller, GST
  invoice, secure payment).
- **Delivery:** a "Deliver to PIN" chooser in the header that every page follows, delivery date and charge for that PIN, and
  "Order within 2 hrs 10 mins" when the seller sets a daily dispatch cut-off.
- **Social proof:** "300+ bought in the past month" and a "#1 Best seller in <category>" badge.
- **Product details:** key specifications beside the price, "About this item", Important information (ingredients,
  directions, safety, disclaimer) and Item details (generic name, manufacturer, packer, importer, consumer care, FSSAI
  licence, best before, warranty, in the box, dimensions, best sellers rank).
- **Seller:** a seller snapshot (positive ratings, orders in 3 months, on-time dispatch, time on the store, Top seller).
- **Customers and help:** customer photos under the gallery, Ask a question (opens the shop assistant), Share,
  "Report an issue with this product", "Customers also viewed" and the shopper's browsing history.
- **Phones:** a buy bar stays at the bottom while scrolling.

Admin → **Product page** switches every block on or off (with the numbers that tune them); Admin → **Categories** sets the
product information each category requires before a listing can be submitted (net quantity, manufacturer, FSSAI licence
and so on; sub-categories inherit). Sellers fill it in under *Product information* in the product editor and set the
dispatch cut-off in Store settings. `scripts/demo_details.json` holds the demo listings' information
(`python -m scripts.apply_demo_details` updates an existing database). A thin loading bar and skeleton pages show while pages load.

**Reviews.** Anyone can read reviews; writing, "helpful" votes and reports need a signed-in account, and by default only
customers whose order was delivered can write (badge "Verified purchase"). Reviews carry up to 5 photos and a video,
shown in the review and in a gallery that opens each photo beside its review. Shoppers filter by stars, photos,
verified purchases and topics ("Quality (12)", counted from the review text, positive or negative), sort, vote helpful
(one vote, can be taken back), report, and edit or delete their own review. Reviews with phone numbers, emails or links
wait for a check; enough reports hide a review until staff look. Admin → **Reviews** has the queues (waiting, reported,
photos to check, published, hidden) and **Settings**: who can review, photos and videos and their limits, approval of
photos, whether visitors who are not signed in see customer photos, the report threshold, seller reports, minimum
length, topics and the review guidelines. Admin → **Product reports** handles "report an issue" (resolve, dismiss or take
the listing down); sellers see reports about their listings without the customer's details under *Customer reports*,
and can answer, reply to reviews and ask staff to check a review.

**Accounts in the admin panel.** *Customers and accounts* lists everyone (filter customers, sellers, staff, blocked);
open one to see profile, consent, addresses, orders, returns, support requests, signed-in devices and staff
history, and to edit name/mobile/email, sign out everywhere, block or unblock. *Add customer* creates an account
for phone orders; *Sellers → Add seller* opens a seller account the seller then completes. Staff can correct a
seller's business, pickup, bank (the seller is told) and grievance details at any time.

**Demo product photos** are real, openly licensed photos in `backend/scripts/demo_images/` (credits and
licences in `CREDITS.md` there; keep that file with the photos). `manifest.json` maps each demo product title
to its photos: change a `file`, or add a `url` to download a new photo, then run
`python -m scripts.apply_demo_images` to update an already-seeded database (a fresh `seed --demo` uses them
automatically). One listing at a time, photos can be changed in Admin → Products → open a listing → Photos
(add, remove, reorder; the first is the main photo), or by the seller in the seller panel.

**Test logins**: add extra admin logins in Admin → Staff → Add staff. Use **Remove access** to switch a login
off (it is signed out at once) and **Restore** to switch it back on.

Every integration is optional and switches on when its keys are set: Razorpay, RazorpayX, MSG91, SMTP,
WhatsApp, Shiprocket, Anthropic (AI), S3 and Sentry. Admin → Integrations shows which are connected.

## Tests

```bash
cd backend && python -m pytest -q          # 97 API tests against a real PostgreSQL (creates pixcart_test)
cd frontend && npm run typecheck && npm run lint && npm run build
cd e2e && npm ci && npx playwright test    # browser journeys against a running stack (see below)
```

The API tests cover the money path end to end: OTP and session rotation, KYC validation, moderation, search,
COD and online orders across sellers in different states (CGST/SGST vs IGST), the order state machine,
webhook replay, partial refunds, payment expiry and late captures, concurrent checkout of the last unit,
coupons funded by the platform and by sellers, warehouse allocation, invoice numbering, the seller ledger
and payouts, returns with credit notes, support SLAs, staff roles and two-step sign-in, the business/contact/
social modules (validation, unsafe links refused, old settings upgraded, emails carrying the business footer),
exports (formats, seller scoping, role permissions, formula safety, a 5,000-row streamed file), the AI
pipeline (sandbox and live modes, cached prompt layers, switches, budget, retries, permissions, human review,
customer messages, risk briefs) and bulk listing upload.

**End-to-end tests** (`e2e/`, Playwright) run a full journey in a real browser: a new customer buys with a
coupon and cash on delivery, the seller confirms, packs, ships and delivers, the customer opens the invoice
and requests a return, the seller receives it, and the admin records the UPI refund. They also rebrand the
storefront, edit business details, contact and social links and check the shop follows, switch the social
module off, download exports from the export centre and from list pages, use AI studio, draft and send a
support reply and a customer message with AI, bulk-upload listings, and open every seller and admin screen. They expect the API on port 8000
with `SMS_PROVIDER=console` writing its log to `$API_LOG` (default `/tmp/api.log`), demo data, and the web
on port 3000. CI runs them on every push.

## Layout

```
backend/
  app/
    core/        config, security (JWT, bcrypt, Fernet), validators (GSTIN/PAN/IFSC), money, roles, TOTP, logging
    models/      users, sellers, catalogue, orders, extended (warehouses, returns, coupons, ledger, CMS, ...)
    services/    orders, inventory, coupons, ledger, invoices, returns, notify, shipping, exports, product_import, analytics, cms, ...
  ai/            AI pipeline: client (caching, retries), task registry, settings, service, risk briefs
    routers/     auth, storefront, customer, catalog, cart, orders, seller_*, admin, admin_extras, exports, ai, webhooks
    jobs.py      scheduled work (advisory-locked, safe with many instances)
  alembic/       migrations
  scripts/       seed.py, create_admin.py
  tests/
frontend/src/
  app/(shop)/    storefront
  app/seller/    seller hub
  app/admin/     admin panel (storefront editor in admin/storefront)
  components/    UI kit, home sections, charts, media library, coupons, returns, reviews
  lib/           API client, session, site settings and theme, wishlist, formatting
e2e/             Playwright browser tests
infra/terraform/ AWS: VPC, RDS, ECS Fargate, ALB + WAF, S3 + CloudFront, ECR, Secrets Manager, alarms
.github/         CI (tests, audits, E2E, Terraform checks) and the deploy pipeline
docs/            DEPLOY.md, BUSINESS_RULES.md
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for AWS deployment, integrations and the go-live checklist, and
[docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) for the order, money and compliance rules.
