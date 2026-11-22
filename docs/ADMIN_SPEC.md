# Admin panel — reference requirements

> Source: "E-commerce Admin Panel — Complete Technical Specification", supplied by the owner as reference
> requirements (written with another AI tool). PixCart treats it as a checklist, not a contract: each section is
> marked done, partial, gap or not applicable, with evidence, in `docs/ADMIN_SPEC_STATUS.md`. Where it does not fit
> PixCart (one marketplace per install, India only, INR in paise), the status file says so and why.
>
> Ground rule kept from the spec: never remove, rename, hide or replace an existing sidebar item; existing behaviour
> stays backward compatible while capabilities are added.

## 1. Product goals

One operational workspace for marketplace operations, orders, customers, sellers, catalogue, delivery, money,
storefront content, marketing, AI, administration, security and reporting. Every module should support, where
applicable: search, filters, sorting, pagination, saved views, bulk actions, export, responsive layout; role-based
access at module, page, action and sensitive-field level; consistent loading, empty, error, permission-denied,
offline and success states; audit history for create, update, delete, publish, refund, payout, permission,
integration and configuration actions; deep links by stable IDs; confirmation for destructive or financial actions;
optimistic UI only for reversible low-risk actions (money, inventory, delivery and permission changes wait for the
server); idempotency for payments, refunds, payouts, delivery assignments, imports, exports, webhooks and bulk
operations; UTC in the API and local time in the UI; store scoping on every request.

## 2. Global application shell

**2.1 Sidebar** — keep this exact structure: Overview; Go-live checklist; Orders and customers (Orders, Returns,
Refunds, Support desk, Customers and accounts); Delivery fleet (Delivery overview, Live partners, Assign deliveries,
Delivery trips, Delivery partners, Partner payouts and cash, Delivery reports, Ratings and complaints, Delivery
zones, Delivery settings); Sellers and catalogue (Sellers, Listings, Categories, Reviews, Questions, Product
reports); Money and reports (Payouts, Reports, Exports); Store and marketing (Storefront, Product page, Checkout and
fees, Coupons, Deals, Advertising, Messages); AI (Shop assistant, AI assistant, AI studio, AI providers);
Administration (Marketplace settings, Sign-in and accounts, Integrations, Staff and roles, Audit log, My account).
Show the active route, breadcrumbs, unread counts, pending-action badges, failed-job badges and optional collapse.
Counts are permission-aware.

**2.2 Global header** — store switcher (if several stores); global search across orders, customers, sellers,
products, SKUs, delivery partners, payouts and tickets; date range where relevant; notifications centre with
read/unread and preferences; help entry; current-user menu; environment indicator (production, staging, sandbox);
system health for integrations, queues, payments, delivery and AI providers.

**2.3 List pages** — server pagination with page sizes; column choice remembered; debounced search and exact-ID
search; filters in the URL; sorting; saved views; bulk selection with a safe maximum, progress and an error report;
CSV/XLSX export as a background job; row actions and links to details; keyboard navigation and accessible tables.

**2.4 Record pages** — title, status, ID, timestamps, owner, primary action; overview, activity timeline and related
records; internal notes; audit-history link; sticky action bar on long forms; unsaved-changes guard; masking of
sensitive fields by permission.

## 3. Statuses and interactions

Stable machine statuses with labels (draft, pending, active, paused, blocked, cancelled, completed, failed,
archived, refunded, deleted); transitions validated by a backend state machine; never infer status from a nullable
field. Confirmation levels: low risk = inline or undo; medium = modal with impact; high = typed confirmation,
reason, permission check, audit, optional second approval; financial = show gross, fees, tax, net, currency,
destination, idempotency before confirming; destructive = archive first, permanent delete needs elevated
permission. Notifications: success, warning, failure, info; long work shows job status.

## 4. Overview and go-live

**Overview** — role-aware dashboard: GMV, net sales, orders, AOV, refunds, cancellations, conversion; pending and
late orders; open returns, refund queue, tickets; active, delayed and failed deliveries, partner availability;
seller onboarding and catalogue issues; pending payouts and reconciliation exceptions; storefront health, checkout
errors, coupon use, campaign results; integration health and recent errors; go-live progress. Date range with
previous-period comparison; filters; drill-down from every metric; saved layout and export; metric definitions in
tooltips; freshness time (never present stale data as live).

**Go-live checklist** — groups: identity; domain and storefront; sign-in; payments and payout account; tax, currency,
fees; shipping, delivery and serviceability; seller onboarding; catalogue; checkout and refund policy; legal pages;
notifications (email, SMS, push); security, roles, two-factor; test order, refund, delivery and webhook; backup,
monitoring, analytics, support. Each item: owner, status, blocking flag, explanation, action link, last verified,
manual override with reason. Launch = high-risk confirmation with final server-side validation.

## 5. Orders and customers

**Orders** — columns: ID, date, customer, items, sellers, payment, fulfilment, delivery status, total, channel, risk,
updated. Filters on all of those plus coupon and exception type. Actions: view, print/download invoice, resend
confirmation, edit permitted fields, cancel, hold/release, split, merge shipments, assign delivery, start return,
start refund, internal note, export. Detail: timeline, contact, masked addresses, items, tax, discounts, fees,
payment events, shipment events, seller allocation, delivery partner, messages, returns, refunds, audit. Rules: lock
totals after payment except through supported adjustments; record every transition with actor, reason, before and
after; prevent duplicate cancel, refund or fulfilment; partial fulfilment, cancellation, return and refund;
distinguish authorisation, capture, settlement, refund and chargeback.

**Returns** — queue with SLA; eligibility by product, date, condition, seller policy, reason; approve, reject, ask for
information, label, pickup, receive, inspect, restock, mark damaged, close; statuses requested to completed and
cancelled; photos, notes, serial numbers, condition, quantity, disposition; linked refund and inventory adjustment.

**Refunds** — queue and detail; full, partial, item, shipping fee, tax, coupon, original-payment refunds; reason,
source, approval, provider response, reconciliation, customer message; statuses requested to reversed and
cancelled; preview with breakdown and remaining refundable amount; retry only when the provider allows, with
idempotency.

**Support desk** — inbox with status, priority, SLA, assignee, category, channel, customer, seller, order; statuses
open, pending customer, pending internal, escalated, resolved, closed; assignment, internal notes, canned replies,
attachments, tags, merge, split, escalation, SLA pause; one timeline across channels; customer-visible and internal
messages clearly distinct; full-text search; collision-safe ticket numbers.

**Customers and accounts** — ID, name, verified contacts, orders, lifetime value, status, risk, last activity,
registered. Actions: profile, orders, addresses, verify contacts, reset sign-in, disable/enable, merge duplicates,
note, consent, export personal data, deletion request. Mask by default; privacy workflows, retention, consent
history, sessions, login history, lockout; deletion checks legal and financial retention first.

## 6. Delivery fleet

Overview (volume, on-time rate, active routes, unassigned, delayed, failed, utilisation, cost per delivery, cash
pending; map and list; date, zone, provider filters; drill-down). Live partners (latest location with "last
updated", availability, current task, connectivity; message or call, pause, reassign, report; never imply live
tracking on stale data). Assign deliveries (unassigned and exceptions; select; zone, constraints, promise,
pickup/drop, distance, COD; recommend partners by zone, capacity, availability, distance, vehicle, SLA; manual with
reason; notify; track accept, reject, expiry, reassignment; never assign inactive, out-of-zone, over-capacity or
unverified partners). Trips (stops, packages, times, proof, notes, status, distance, cost; create, start, pause,
resume, complete, cancel, re-sequence; failed delivery, customer unavailable, address issue, damage, cash
mismatch; optional provider route optimisation with preview). Partners (identity, vehicle, zones, documents,
verification, payout details, availability, performance, ratings, complaints, cash balance, history; invite,
verify, approve, reject, suspend, reactivate, zones, capacity, documents, reset access, payout history; sensitive
fields need elevated permission and audit). Payouts and cash (earnings by delivery, distance, zone, incentive,
penalty, adjustment; COD ledger; balances; payout batches with approval, failure, reversal, export; cash recording
with reference and optional dual control; lock a reconciled period). Reports (on-time, first-attempt success,
cancellations, delay reasons, productivity, zones, cost, cash, satisfaction; with definitions, filters, freshness,
source, download). Ratings and complaints (cases, categories, severity, evidence, partner response, resolution,
compensation, escalation; moderation with reason and audit). Zones (codes or polygons; serviceability, fee, time,
eligibility, minimum order, package size, COD, blackout periods; overlap validation and priority). Settings
(provider credentials encrypted and write-only, dispatch rules, timeouts, retries, status mapping, tracking,
templates, proof rules, fees, COD rules, hours, holidays, escalation).

## 7. Sellers and catalogue

Sellers (lifecycle draft to offboarded; onboarding, KYC and business documents, tax, bank, commission plan, zones,
catalogue count, performance, disputes, tickets, activity; invite, approve, reject, request changes, suspend,
reactivate, commission, users, offboard; one- or multi-step approval). Listings (all product data incl. variants,
SKU, barcode, tax class, dimensions, return policy, SEO, moderation, channels; create, edit, duplicate, bulk import
and update, preview, submit, approve, reject with reason, publish, unpublish, archive, restore; required attributes
by category; version history with draft and published kept apart). Categories (hierarchy, code, slug, image,
description, required attributes, filters, commission, tax mapping, order, visibility, seller eligibility; no
circular parents; warn before moving). Reviews (rating, text, media, verified purchase, status, reports, response;
publish, hide, restore, reply, flag, escalate, export; keep the original and the reason). Questions (unanswered
queue, SLA, assignment, draft and publish answers, reject, merge duplicates, flag abuse, notify). Product reports
(issue queue by type, severity, evidence, owner, status, SLA, resolution, audit; bulk triage and escalation).

## 8. Money and reports

Payouts (sellers and partners; ledger and periods; balances; batches with approval; failed retry with provider
response; holds, reserves, disputes, chargebacks, manual adjustments; reconciliation with provider settlement
reports; statements; never edit balances directly — immutable ledger entries with reason and approver). Reports
(sales to system operations; saved reports, filters, scheduling if supported, drill-down, definitions, freshness,
permissions, export; large reports in the background with a notification). Exports (job centre: requester,
dataset, filters, format, rows, status, progress, expiry, download, failure; CSV and XLSX; column masking and
permissions; signed expiring links; every export logged).

## 9. Store and marketing

Storefront (home, navigation, banners, collections, featured products, announcements, footer, content blocks, theme,
domains, SEO, preview, publishing with draft, scheduled, published and archived versions, responsive preview,
rollback). Product page (layout, gallery, variants, price, stock messages, delivery promise, reviews, questions,
recommendations, seller information, trust badges, SEO; preview by product and device). Checkout and fees (steps,
guest checkout, addresses, payment methods, taxes, shipping, platform, seller, COD and convenience fees, discounts,
rounding, minimum order, limits, fraud checks, confirmation; fee rules with dates, priority, scope, tax treatment;
calculation simulator before publishing). Coupons (code, type, value, minimum, maximum discount, scope, eligibility,
usage and per-customer limits, dates, stacking, channels, budget; conflicts, impact, pause, resume, archive, usage
report, fraud protection). Deals (flash, bundles, BOGO, tiers, free shipping, seller deals, campaigns; type,
products, reservation, discount, eligibility, dates, timezone, priority, channel, approval; overlaps never produce an
unintended price). Advertising (sponsored products, campaigns, placements, budgets, bids, targeting, creative,
schedule, billing, moderation; impressions, clicks, CTR, spend, CPC, conversions, sales, ROAS, pacing; campaign
status separate from creative moderation). Messages (templates for email, SMS, push, in-app, chat; variables,
locales, preview, test send, approval, scheduling, audience, history, delivery status, bounces, consent, rate limits;
no secrets in templates).

## 10. AI

Shop assistant (scope, tone, catalogue access, fresh stock and price, recommendation rules, escalation, prohibited
claims, logs, feedback, fallback; never invent stock, price, policy, delivery promise, refund or order status). AI
assistant (read-only analytics first, then confirmed actions; tool permissions, confirmation for changes, record
links, history, rate limits, prompt versions, redaction). AI studio (prompts, workflows, agents, knowledge,
evaluations, versions, tests, guardrails, publishing; owner, version, environment, status, model, schemas, tools,
permissions, cost limits, rollback). AI providers (providers, models, encrypted masked keys, default and fallback,
timeout, retry, token and cost limits, retention, routing, health, connection test, rate limits, usage, outage
handling; no personal or payment data to a provider without policy and consent).

## 11. Administration

Marketplace settings (identity; currency, locale, timezone, tax, formats; order, return, refund and cancellation
policies; commission and rules; delivery defaults; notifications and legal; inventory and SKU rules; feature flags
and maintenance mode; data retention and privacy; analytics — each setting with description, type, validation,
default, scope, effective date, preview, reset and audit). Sign-in and accounts (methods, password policy,
verification, MFA, SSO if supported, session lifetime, trusted devices, login alerts, recovery, CAPTCHA and rate
limits, lockout; customer and staff settings separate; security events; forced logout). Integrations (directory and
details for payment, shipping, tax, analytics, email, SMS, storage, search, fraud, accounting, CRM, support, AI; setup,
credentials, scopes, environment, test, webhooks, events, retry logs, dead letters, sync, mapping, health,
disconnect with data-impact warning). Staff and roles (least privilege; roles, permissions, scopes, approval
policies; invite, role, scope, activate, reset MFA, force logout, approval limits, separation of duties, last
activity; second approver for sensitive actions; no self-approval). Audit log (immutable, searchable: time, actor,
type, IP/device where permitted, action, resource, before/after, reason, request ID, source, result; filters; export
needs permission and is audited; no passwords, card data, secrets or unnecessary personal data). My account
(profile, contact, avatar, locale, timezone, notification preferences, password, MFA, sessions, trusted devices,
tokens, connected accounts, own activity, sign out everywhere).

## 12. Backend and data

Server-side tenant, role, scope and record permissions; stable error codes, messages, field errors, request IDs;
cursor pagination for large data; optimistic concurrency on editable records; idempotency keys; public IDs over
internal ones; rate limits. Core entities as listed in the source (Store to Notification) with relational
constraints; soft delete only where history must remain. Background jobs (exports, imports, reports, payouts, route
optimisation, campaigns, AI evaluation, reconciliation) with ID, type, requester, progress, status, retries,
errors, times, expiry; resumable or safely retryable. Money in integer minor units or decimals with the currency;
immutable ledger; balances from the ledger. Security: secure cookies or short-lived tokens, CSRF, validation,
output encoding, encryption, secret storage, least privilege, dependency scanning, audit, tested backups.

## 13. Frontend

Shared design system (type, spacing, forms, tables, tabs, badges, alerts, modals, drawers, maps, charts, date
pickers, empty states); filters in the URL; drafts kept where sensible; unsaved-changes warning; skeletons for
primary content; actionable errors with retry; accessible labels, focus, contrast and announcements; tablet and
desktop layouts (condensed on phones); never colour alone; server permissions decide (hiding is not security).

## 14. Testing and acceptance

Functional (every route, filter, detail, create/edit, bulk action, export, permission boundary, transition,
notification, error state); security (isolation, escalation, IDOR, CSRF, XSS, injection, secrets, audit integrity,
uploads, rate limits, session invalidation, MFA recovery, masking); financial (duplicates, partial amounts,
rounding, tax, provider failures, retries, reversals, reconciliation, immutable ledger); operational (webhook retries,
duplicate and out-of-order events, queue failures, provider downtime, stale locations, export expiry, large data,
partial batch failures); accessibility (WCAG 2.1 AA) and performance (keyboard, screen readers, large tables, slow
networks, loading states).

## 15. Order of work (from the source)

1. Preserve and stabilise: routes and sidebar; auth, roles, permissions, scoping, audit; shared layout, tables,
   filters, forms, notifications, errors; orders, customers, returns, refunds, support.
2. Marketplace operations: sellers and catalogue; delivery; payouts, ledger, reports, exports, reconciliation.
3. Store growth: storefront, product page, checkout and fees, coupons, deals, advertising, messages; go-live.
4. AI and advanced administration: assistants, studio, providers; integrations, sign-in, feature flags, retention,
   operational analytics.

After every phase: migration checks, permission tests, regression tests, route-by-route acceptance.

## 16. Rules for anyone implementing

1. Preserve every sidebar item and existing behaviour unless a change is approved. 2. No placeholders in place of
working features. 3. Inspect a route's UI, API calls, data model, permissions and tests before changing it. 4. Put
risky capabilities behind feature flags. 5. Keep URLs and deep links working. 6. Never silently change financial,
refund, payout, inventory, delivery, authentication or permission behaviour. 7. Build shared components instead of
copies. 8. Loading, empty, error, retry, permission-denied, stale-data and success states for every new operation.
9. Backend validation and audit for every change. 10. This document's acceptance criteria are the definition of
done. 11. Summarise preserved options, new options, changed APIs, migrations, tests and assumptions.

## 17. Definition of done for a sidebar option

Reachable and highlighted; role-aware access; list, detail, create and edit work end to end; data scoped and
validated server-side; transitions and edge cases done; loading, empty, error, retry and permission states; important
actions audited and idempotent; safe, permission-aware exports and bulk actions; responsive and accessible; API,
database changes and migrations documented; automated tests for success, failure, authorisation and duplicate
requests.
