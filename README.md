# PixCart AI — AI-Powered Multi-Vendor E-Commerce Platform

Source of truth: **Enterprise Software Documentation Suite v1.0** (16 volumes,
PIX-ECOM-DOCSUITE-2026-001). Every directory below maps to that suite; nothing in this
repository may contradict it, and changes flow through the RTM (Vol. 13 §13.3).

## Layout (per Vol. 11 §11.3 / Vol. 5 C4-L2)
services/   Spring Boot 3.5 / Java 21 core services + Node 22 services (discovery,
            marketing, notification) exactly as assigned in the container diagram
apps/       React 19 storefront, vendor portal, admin console, Expo mobile
ai/         FastAPI AI orchestrator (FR-AI-001) and ML serving (FR-AI-003/006/010)
contracts/  OpenAPI 3.1 /v1 bundle (Vol. 7) and event schemas (Vol. 5 SS5.5)
infra/      Terraform layout per IaC-01; db/migrations are Flyway-named and are the
            GENERATED Vol. 6 DDL — the document and the schema cannot drift
runbooks/   Inventory per Vol. 11 SS11.12

## Delivery model
Vertical slices per the release train (Vol. 15): each slice ships with its tests,
traceable FR ids, and passes the same automated audit discipline used on the suite.
Slice 0: repo skeleton · Vol. 6 schema proven on a live engine (7 proofs) ·
FR-MKT-010 promotions waterfall engine — 18/18 tests, p95 4.8 ms vs 80 ms budget.
Slice 1 (identity): V002 auth schema proven live (role/attempt CHECKs, token-hash
uniqueness, FK) · framework-free identity domain in Java 21 — ULID, OTP state machine
(5-min/3-attempt/30-s per FR-CUS-001), sliding-window budgets (5/h, 20/min per Vol. 7),
refresh-token family rotation with reuse-detection (TC-SEC-011), password rule
(≥10 chars, 3-of-4 classes), Vol. 2 §2.4 RBAC matrix — 15/15 JUnit tests in-sandbox.
Spring adapters (pom, app shell) authored for the CI build.
Slice 2 (catalogue + approvals): V003 schema proven live — 21 tables, coherent seed
graph, 7 negative proofs (FKs incl. retro-fitted inv_item→variant/location, slug/sku/
revision uniqueness, approval-state CHECK, category delete-restrict). Java 21 domain:
ListingLifecycle (FR-VEN-003/BRU-02 — exhaustive 63-pair matrix test) and ApprovalCase
(FR-ADM-004 — bulk ≤100 with ≥10% sampling, prohibited-item exclusion with the doc's
acceptance scenario verbatim, diff-view gate, fix-list on rejection) — 9/9 JUnit.

Slice 7 (returns & refund orchestration): ReturnSaga (FR-CUS-017/018, FR-LOG-005) over
the Slice-5 return states, Slice-4 refund engine and Slice-0 promo allocation. Admission:
BRU-07 window (default 7d, category override, non-returnable refused), photo evidence
required for DAMAGED/WRONG_ITEM. Resolution: QC-pass refunds the NET paid to original
instrument (BRU-06 default; wallet needs consent) within the <=24h SLA, and emits a
settlement reversal whose vendor + commission clawbacks sum EXACTLY to the refund. 21/21
JUnit (order-svc). LIVE-LEDGER proof: capture then QC-pass return nets every account
(gateway/vendor/commission) to 0.00 - no money leaks - both journals balanced.
Slice 8 (fee & tax engines): FR-FIN-001 commission (BRU-08 formula: category-slab
commission + payment fee + logistics-if-platform-shipped - platform-funded promo, from
versioned effective-dated schedules; deterministic replay; proportional fee reversal on
refund with configurable payment-fee retention; +/-30% override bound) and FR-FIN-002
GST/VAT (HSN->rate resolution effective-dated to order date, exactly-one-active-rate
validation, CGST/SGST vs IGST by vendor-vs-ship-to state, inclusive back-calc per BRU-04,
unregistered-vendor exempt path with category guard). The doc's tax acceptance runs
verbatim: TN vendor + KA ship-to at 18% -> IGST 18%, taxable = price x100/118, reconciled
to the paisa. 19/19 vitest, plus 2 cross-engine reconciliation tests proving the tax
engine and the Slice-3 quote engine agree to the paisa across rates.

Slice 9 (end-to-end composition proof): integration/e2e drives the REAL aggregates from
four services - Payment (S4), Order + SubOrderLifecycle (S5), ReturnSaga (S7),
SettlementEngine (S6) - through one customer journey, proving they interoperate. Three
scenarios (happy path pay->split->deliver->settle->payout; return branch delivered->
QC-pass->refund executed by the real Payment aggregate; failed-capture->no-order): 3/3
JUnit. Companion live-ledger walk of the same journey balances every journal and closes
the net of ALL accounts to 0.00. Test-only harness; services never import each other in
prod (boundary note in integration/e2e/README.md).

Slice 10 (contracts): contracts/events JSON Schemas (Vol.5 §5.5 EDA) for the money-spine
events (envelope + payment.captured/refunded, order.confirmed, shipment.status,
rma.qc.completed, settlement.batch.executed) and contracts/openapi money-spine.v1.yaml
(OpenAPI 3.1, Vol.7 conventions: Bearer JWT, Idempotency-Key). A validation harness proves
they are LIVE: every schema compiles under Ajv, a payload shaped as the real domain object
emits validates (wrong ones rejected), each event validates against the envelope, the
OpenAPI doc resolves, and event sub-order states are a subset of the OpenAPI Order state
enum (mirrors SubOrderLifecycle). 9/9 vitest.

Slice 11 (notification service): FR-CUS-022 policy gate + FR-CUS-016/LOG-004 timeline
projector, provider-agnostic (dispatch is a port). Policy: transactional cannot be opted
out (channel choice only); promotional needs active consent (BRU-12) and respects quiet
hours 22:00-08:00 local; SMS needs a DLT template id (FR-MKT-004); legal STOP wins.
Timeline: pure fold of the Slice-10 events into a per-sub-order status timeline, idempotent
by (eventType,eventId). 19/19 vitest incl. a cross-slice proof that the projector's event
inputs validate against the Slice-10 JSON Schemas (read model and contracts cannot drift).

Slice 12 (inventory reservation): FR-VEN-004 InventoryItem (Java) - ATP = on_hand -
reserved - safety_stock; reserve at order-confirm (idempotent on holdRef, refused past
ATP = the anti-oversell gate), commit on manifest (decrement on_hand+reserved), release
on cancel/RTO/QC-pass, restock on GRN inbound; mirrors inv_item + ck_inv_nonneg and uses
row_version for optimistic locking. 15/15 JUnit. LIVE-DB proof: ck_inv_nonneg rejects
over-reservation, and an optimistic row_version race proves no lost update and no oversell
(winner commits 1 row, stale writer 0 rows, loser's re-checked over-ATP retry refused;
final reserved<=on_hand, zero oversold rows).

Slice 13 (shopping cart): FR-CUS-007 multi-vendor cart (TypeScript, cart-checkout-svc) -
pure/immutable: add/update/remove with the 1-10 per-line cap (add combines+clamps, update
rejects over-cap), saved-for-later + move-back, per-vendor grouping, suspended-vendor
auto-quarantine to saved-for-later with notice (RULES), guest-cart merge on login (union
by listing, sum+clamp qty, no saved/active dup), 90-day TTL, and a read-only revalidation
preview (price deltas per BRU-04, out-of-stock, qty-over-stock/cap, suspended) that never
mutates. Emits checkout lines at the current approved price for the quote engine. 13/13
vitest incl. a cross-slice proof that the cart feeds the Slice-3 FR-CUS-014 quote engine
(grand total Rs 2,600, BRU-03 two-vendor split; suspended lines excluded).