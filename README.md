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
- **Deploying on Vercel?** The website goes on Vercel and the API on a server: `docs/DEPLOY_VERCEL.md`.
- **Changing code (person or AI agent)?** Read `AGENTS.md`.
- **AI assistant internals:** `docs/AI_ASSISTANT.md`.
- **Customer chat on the website (shop assistant):** `docs/SHOP_ASSISTANT.md`.
- **Own delivery fleet, checkout fees and push notifications:** `docs/DELIVERY.md`.
- **Storefront themes, admin layouts, loaders and home media:** `docs/THEMES.md`.

## What is included

- **Switchable storefront themes**: Classic (the original look), Bazaar (big store), Fresh (quick commerce) and Luxe
  (boutique), each with its own colours, fonts and layout on every screen, five colour presets plus the brand colours,
  editable colours with contrast checks, layout options the owner can change per theme, and a live preview on phone,
  tablet and desktop before applying (Admin → Storefront → Theme and layout). Switching is instant and reversible.
- **Admin layouts** each staff member picks: sidebar with quick find (Ctrl+K), top navigation, compact rail, or Glass
  (inspired by Apple's design guidelines); the owner sets the default.
- **Images or videos in any home block** (hero slides, banners, banner grids, card tiles, and an image or video block),
  from the media library; skeleton loaders on every screen so pages are never blank.
- **Lists and results** (Admin → Marketplace settings): how many results every shopper-facing list shows, each with
  its default: products per page, search suggestions, recent searches, brands in filters, "Customers also viewed",
  sponsored products, highlights before "See more", customer photos, reviews and questions per page, the best-seller
  badge, recently viewed, compare and checkout suggestions; 0 hides the lists that can be hidden.

- **Own delivery fleet** (like Instamart or Flipkart's own delivery): partner app on the web and Android (sign-up with
  KYC, online switch, request pop-up with countdown, navigation, pickup code, customer OTP, cash collection, photo
  proof, earnings and weekly payouts), zones, auto-assign to the nearest free partner or assignment by staff, live map of
  partners online, customer tracking with the partner on a map, ratings and complaints, reports. See `docs/DELIVERY.md`.
- **Checkout fees and the bill**: delivery, cash on delivery, handling, small cart and platform fees, a bad weather fee
  (switched on for a few hours or until switched off; partners can earn a bonus per trip meanwhile), a late night fee
  (a time window, India time), tip for the delivery partner, GSTIN for business purchases and "no bag", each switched on
  and priced in Admin → Checkout and fees, with a live preview of the bill.
- **Push notifications** (Firebase) to phones and browsers for every notification, and installable apps (home screen).
- **Shop assistant** (Help button on the storefront): customers chat or talk (English, Tanglish, Tamil, Hindi) to track
  orders, cancel before shipping (with a confirm button), check returns and refunds, find products, and raise a pre-filled
  support request with the chat attached. Works without AI (guided mode) and with any connected model. Fully separate
  from the admin assistant: own tables, knowledge base, tools and permissions; it only sees public data and the
  signed-in customer's own records. Admin → Shop assistant has the on/off switches, features, voice, limits, help
  articles, customer chats and statistics.
- **Admin AI assistant** (Ctrl+J): chat and hands-free voice in any language, exact live figures as tables and charts,
  file upload and comparison with live data, downloads of every answer (PDF, Excel, CSV), confirm-before-run changes,
  memory, any LLM provider with several keys and fallbacks, and a fast decision layer (built-in rules or Laya).
- **Integrations hub**: Razorpay, RazorpayX, MSG91, email, WhatsApp, Firebase (push), Shiprocket, AI and Sentry keys entered in the admin
  panel, encrypted, with Test connection; **Go-live checklist**; **roles and permissions** editor.
- **Exports**: every report as CSV, Excel or PDF with filters and column choice; several at once as one ZIP.
- **Razorpay simulator** (`tools/razorpay-sim`) to run online payments, webhooks and refunds end to end locally.

**Customers** — saved addresses with a map pin, a name (Home, Work or their own) and delivery instructions, live
tracking of own-fleet deliveries, search with typo tolerance, categories, product pages with delivery date by PIN code,
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
returns (staff can open one for a customer; return policy per category and a period in which damaged, faulty or
wrong items are always taken back), refunds, payouts (bank file + UTR, or RazorpayX), support desk with the 48-hour and 30-day limits,
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

**Deals.** Sellers propose a deal on one product version in *Seller hub → Deals*: a **Lightning deal** (a set number of
units for a few hours, with a "% claimed" bar), a **Deal of the Day** or a **Limited time deal** (up to two weeks). Staff
approve, reject or stop deals in *Admin → Deals*, where the rules live (minimum discount below the current price, the
longest each kind may run, approval on/off). While a deal runs the version's selling price *is* the deal price, so cart,
checkout, GST invoices, commission and payouts need no special case; the regular price comes back when it ends, when its
units are gone or when it is stopped, and sellers cannot change that version's price meanwhile. A job starts and ends
deals every minute, and checkout re-checks them. Shoppers see deal badges with live countdowns on every product card, the
product page and **Today's Deals** (`/deals`: lightning, deal of the day, limited, upcoming, top discounts, department,
discount, rating and price filters).

**Sponsored products.** Sellers run cost-per-click campaigns in *Seller hub → Advertising*: products, placements (search
results, other product pages, home page), optional keywords (otherwise automatic targeting), bid, daily and total
budget, dates. Ads are ranked by bid and rating, shown only while there is budget, and labelled "Sponsored". Only genuine
clicks are charged: every ad shown is an impression whose signed click link works once, only for the shopper it was
shown to (a first-party visitor cookie), for 48 hours; a shopper's repeat clicks within 24 hours are free; and a campaign
pays for at most a set number of clicks a day from one internet address and from one network, whatever the browser.
Other clicks still open the product, cost nothing and show as *invalid clicks*; ad requests and clicks are rate limited
per address. Sellers see impressions, clicks, invalid clicks, CTR, spend, orders and sales attributed within 7 days of a
click, and ACoS. Each finished day's spend plus GST goes to the seller ledger (hourly job, or *Bill now*) and comes off
the next payout. *Admin → Advertising* approves, pauses or ends campaigns, shows ad revenue and invalid clicks, and sets
minimum bid and budget, placements, how many ads appear and the paid-click limits per address and network.

**Discovery pages and header.** **Bestsellers** and **Hot new releases** (`/bestsellers`, `/new-releases`, ranked by units
sold in the last 30 days, per department and category), **Coupons** (`/coupons`, every offer with copy-code) and a **Help**
centre (`/help`). The header has a category picker in the search box with recent and trending searches, an **All** side
menu (categories, popular pages, programmes, help), *Returns & Orders*, and a second bar of links with an optional
promotion; the home page adds Amazon-style card rows, a deals rail with a timer, sponsored products, countdown banners,
"Inspired by your browsing history", "Buy it again", a sign-in prompt for visitors and *Back to top*. All of it is edited in
*Admin → Storefront* (Navigation tab and home sections). `python -m scripts.demo_promotions` adds demo deals and campaigns
(`seed --demo` does it too; `--clear` removes them).

**Questions, alerts, compare and bundles.** Product pages have **Questions and answers**: signed-in shoppers ask, and the
seller (badge "Seller"), verified buyers and other shoppers answer; the asker is told when an answer arrives, posts with
contact details, or reported by the set number of different shoppers (*Admin → Product page*, default 3, 0 = never; each
shopper counts once per post), wait for staff (*Admin → Questions*), and sellers answer from *Seller hub → Questions*.
**Notify me** on an out-of-stock version sends one alert when it is back; products saved to the wishlist send a
**price-drop alert** when they get cheaper by the set percentage (*Your alerts*, `/alerts`; a job checks every 10 minutes).
**Compare** puts up to 4 products side by side (`/compare`, with "show only differences"), and **Frequently bought
together** comes from real orders with "Add all to cart". The cart has **Save for later**. Each of these has a switch in
*Admin → Product page* (plus "only the seller and buyers may answer" and "hold questions for a check"). The seller hub
and admin menus show counts of what needs attention: orders to confirm, unanswered questions and open customer reports
for sellers; deals, ad campaigns and questions waiting for a check for staff.

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
WhatsApp, Shiprocket, Firebase (push notifications), Anthropic (AI), S3 and Sentry. Admin → Integrations shows which
are connected.

## Tests

```bash
cd backend && python -m pytest -q          # 119 API tests against a real PostgreSQL (creates pixcart_test)
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
customer messages, risk briefs), bulk listing upload, the delivery fleet (registration and KYC, zones, manual
and auto assignment with expiry and fallback, pickup code, OTP, photo and cash checks, failures and returns, payouts,
cash deposits, stuck alerts, reports, ratings), checkout fees and push notifications.

**End-to-end tests** (`e2e/`, Playwright) run a full journey in a real browser: a new customer buys with a
coupon and cash on delivery, the seller confirms, packs, ships and delivers, the customer opens the invoice
and requests a return, the seller receives it, and the admin records the UPI refund. They also rebrand the
storefront, edit business details, contact and social links and check the shop follows, switch the social
module off, download exports from the export centre and from list pages, use AI studio, draft and send a
support reply and a customer message with AI, bulk-upload listings, deliver an order with an own delivery partner
(request pop-up, pickup code, OTP, cash, photo, rating, admin live map), and open every seller and admin screen. They expect the API on port 8000
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
mobile/partner-app/  Android partner app (Capacitor shell around /delivery), built by GitHub Actions
infra/terraform/ AWS: VPC, RDS, ECS Fargate, ALB + WAF, S3 + CloudFront, ECR, Secrets Manager, alarms
.github/         CI (tests, audits, E2E, Terraform checks) and the deploy pipeline
docs/            DEPLOY.md, DEPLOY_VERCEL.md, ADMIN_SPEC_STATUS.md, BUSINESS_RULES.md, DELIVERY.md, GO_LIVE.md, AI_ASSISTANT.md, SHOP_ASSISTANT.md
```

See [docs/DEPLOY.md](docs/DEPLOY.md) for AWS deployment, integrations and the go-live checklist, and
[docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md) for the order, money and compliance rules.
