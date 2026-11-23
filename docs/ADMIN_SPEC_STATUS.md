# Admin spec status

Where the codebase stands against `docs/ADMIN_SPEC.md` (the reference requirements). **Done** = built and tested;
**Partial** = the core is there, named parts are missing; **Gap** = not built yet; **N/A** = does not fit this product.
The "Next" list at the end is ranked by value for effort, with the setting or endpoint each item needs.

## 2. Global application shell

| Item | Status | Where |
|---|---|---|
| 2.1 Sidebar structure, active route, breadcrumbs, badges, collapse, permission-aware counts | Done | `components/admin-shell/` (four layouts: sidebar, top navigation, compact rail, glass), `nav.ts` |
| 2.2 Global search (orders, customers, sellers, products/SKU, partners, payouts, tickets) | Done | Quick find (Ctrl+K), `routers/admin_search.py`, permission-aware, `tests/test_admin_search.py` |
| 2.2 Environment indicator | Done | Header badge outside production (`/api/admin/me/preferences` → `environment`) |
| 2.2 Notifications centre | Done | Bell with unread count; message templates in Messages |
| 2.2 Store switcher, system health panel | N/A / Partial | One store per install; integration checks in Integrations and the Go-live checklist |
| 2.3 List pages: pagination, filters, search, export of what is on screen | Done | Each list page; exports in `services/exports.py` |
| 2.3 Saved views, column choice, bulk selection | Gap | See Next |
| 2.4 Record pages: overview, timeline, related records, masking | Done | Order, seller, customer, partner pages |
| 2.4 Internal notes on orders, customers, sellers | Gap | Tickets, product reports and complaints have notes; see Next |

## 3. Statuses and interactions

State machine for orders and packages (`services/orders.TRANSITIONS`), confirmations before destructive actions,
password re-entry for sensitive actions (`core/step_up`), audit of every write: **Done**. Second approver for
high-risk actions: **Gap**.

## 4. Overview and go-live — Done

Dashboard KPIs and pending tasks; Go-live checklist with checks for business details, keys and policies.

## 5. Orders and customers

| Item | Status | Notes |
|---|---|---|
| Orders list, detail, cancel, invoices, risk brief, AI message | Done | |
| Customer cancel window | Done | `customer_cancel_until` (Marketplace settings) |
| Hold and release an order | Gap | See Next |
| Returns: request → pickup → receive with condition → refund | Done | Fleet pickups; photos on returns are a gap |
| Refunds: retry, manual UPI/bank, breakdown | Done | |
| Support desk: SLA due times, AI drafts, grievances | Done | Canned replies and SLA times are fixed in code (see Next) |
| Customers: search, block, add, personal data export, deletion | Done | |
| Sessions and sign-out of other devices | Done | Account page and My account, `tests/test_sessions.py` |

## 6. Delivery fleet — Done

Overview, live map, assignment queue, trips, partners with KYC (last 4 digits of Aadhaar only), payouts and cash,
reports, ratings and complaints, zones, settings (`docs/DELIVERY.md`).

## 7. Sellers and catalogue

Sellers (KYC, approve, suspend, commission), listings approval, categories with commission/GST/return rules,
reviews, questions, product reports: **Done**. Listing approval as a switch, image limits as settings: **Gap**.

## 8. Money and reports

Payouts with TCS/TDS, bank files, automatic payouts; reports; exports (CSV, Excel, PDF, ZIP): **Done**. Manual
ledger adjustments and a per-seller payout hold: **Gap**.

## 9. Store and marketing — Done

Themes and layouts with live preview, home page blocks with images and video, brand, navigation, pages, media
library, product page switches, checkout fees with preview, coupons, deals, advertising, message templates,
error and "page not found" pages, maintenance mode.

## 10. AI — Done

AI assistant (live figures, confirm-before-change), AI studio, shop assistant, AI providers with fallback.

## 11. Administration — Done

Marketplace settings (incl. list sizes, order rules, maintenance, error pages), Sign-in and accounts (code rules,
lockout, password policy, session lengths, sign-in alerts, required two-step for staff), integrations, staff and
roles, audit log, My account.

## 12–14. Backend, frontend, testing

Every admin endpoint declares a permission; money in paise; IST display; secrets encrypted; Alembic migrations;
pytest (196+ tests), Playwright end-to-end suite, type-check, lint and production build in the definition of done.

## Next (ranked)

1. Internal staff notes on orders, customers and sellers (`StaffNote` table, `/api/admin/notes`).
2. Support desk settings: SLA hours, open-ticket limit, auto-close, admin-managed canned replies.
3. Listing review rules: `listings_need_approval`, `listing_edits_need_approval`, image limits, minimum description.
4. Admin download of sellers' tax invoices and credit notes from the order page.
5. Order hold and release (blocks seller steps and auto-assign; refunds stay possible).
6. Seller response deadline for returns; photos on return requests.
7. Message log with retry and a test send.
8. Manual seller ledger adjustments; per-seller payout hold.
9. COD risk controls (block after repeated courier returns, first-order limit).
10. Order number prefix as a setting; bulk approve for listings and reviews; saved views on lists.
