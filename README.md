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

Slice 14 (audit hash-chain): FR-ADM-013 AuditChain SDK (Java, identity-svc) - append-only
(NO mutate/delete API, per RULES), each entry's this_hash = SHA-256(prev_hash ||
canonicalBytes(record)) chaining from a 32-byte genesis, matching the Vol.6
adm_audit_event columns. Deterministic injective canonicalisation (length-prefixed sorted
fields, null!=empty) so hashes reproduce byte-for-byte for the daily tamper check.
verify() re-derives every link and pinpoints the first broken index; search-by-entity
returns before/after payloads (ACCEPTANCE). 9 audit tests (24/24 identity-svc total incl.
the Slice-1 domain). LIVE-DB proof: a 3-entry chain built in SQL with the schema's exact
this_hash rule verifies intact (all links LINKED), then a fraudulent amount change
200->999 on entry 2 is DETECTED (that row's payload-hash check flips to BROKEN).

Slice 15 (logistics tracking): FR-LOG-004 courier status normalisation (TypeScript,
logistics-svc) - per-carrier raw->canonical maps (Delhivery/Bluedart/DTDC/India Post) onto
the SubOrderLifecycle shipment subset; webhook+polling de-duplication (idempotent by
provider event id or awb|status|time); POD required for delivered orders > Rs 2,000 (held
otherwise); EDD recompute on NDR (bumped per attempt, capped 3) and cleared on delivery;
48 h stale-feed detection; unknown courier status HELD as a mapping-needed ops task, never
dropped (VALIDATION). 14/14 vitest incl. cross-slice proofs that the emitted event
validates against the Slice-10 shipment.status.v1 schema and drives the Slice-11 timeline
to DELIVERED.

Slice 16 (wallet & loyalty): FR-CUS-019 closed-loop wallet + FR-CUS-020 loyalty (Java,
finance-svc) with V005 schema. Wallet: CASH bucket (never expires) + PROMO bucket (90-day
default expiry), spend consumes PROMO earliest-expiry-first then CASH, debit<=balance so
negative is impossible, idempotent on reference, refund-to-wallet credits CASH (BRU-06).
Loyalty: integer points (1pt=Rs1), accrual admitted only after the return window lapses,
redeem<=balance, returns claw back points floored at zero, tiers with immediate upgrade and
30-day downgrade grace (re-qualify cancels). 13 tests (finance-svc 23/23 incl. settlement).
LIVE-DB proof: V005 migrates; ck_wal_nonneg blocks a wallet overdraft; uq_wal_reference
blocks a refund replay; the promo-expiry query counts only the unexpired tranche;
ck_loy_nonneg blocks an over-redemption.

Slice 17 (address & serviceability): FR-LOG-001 serviceability/rate-shopping (TS,
logistics-svc) - PIN-master validation, courier eligibility (weight cap, COD capability),
allocation by cost x SLA-score(OTIF) x capability with per-zone configurable weights and
deterministic tie-break, EDD with risk-tier promise buffers, and the BRU-05 COD gate.
This is now the AUTHORITATIVE source of the serviceablePin fact the cart/quote previously
took as a pre-computed boolean - proven by cross-slice tests (serviceable PIN -> quote
prices; unserviceable -> quote rejects with PIN_NOT_SERVICEABLE). FR-CUS-005 AddressBook
(Java, identity-svc) - max 10 addresses, auto-default and promotion on delete, validation
(PIN in master, E.164 mobile, line1>=6, URL filter), and the immutable order-snapshot rule
proven: editing OR deleting the book entry afterwards leaves the order's snapshot
untouched. logistics-svc 29/29, identity-svc 32/32.

Slice 18 (vendor registration & KYC): FR-VEN-001 (Java, identity-svc). KycValidators -
GSTIN mod-36 check digit (verified against Pixous's own real published GSTIN
33AAMCP3151E1ZO, with tampered variants rejected), GSTIN structure + state code, PAN
extracted from the GSTIN for a free cross-check, PAN format + holder-type + 5th-char
name-initial check, IFSC structure, name similarity with corporate-suffix canonicalisation
(PVT LTD == PRIVATE LIMITED -> 1.0) gated at >=0.8, document type/size (pdf/jpg/png <=5MB).
VendorKycApplication - the BRU-01 transact gate requiring ALL THREE of verified KYC +
penny-drop + signed agreement; penny-drop must credit AND name-match; GSTIN must embed the
declared PAN; live-verify pending blocks verification; bank/GSTIN change forces re-KYC and
suspends selling; unregistered-GST vendors need a turnover self-declaration and are
restricted to exempt categories. identity-svc 48/48 JUnit.

Slice 19 (discovery: query understanding + hybrid fusion): FR-CUS-009/010 (TS,
discovery-svc). Query: sanitisation, banned-term policy message, constraint extraction
(under/above/between with k/lakh/comma/₹ notations, star rating) including TANGLISH
postpositions ("5k kku keela"), Tamil script preserved as free text (graceful fallback),
inverted price range dropped, and attribute-schema validation that drops constraints a
category does not declare. The doc's own example query "office chair for back pain under
8k" is a verbatim test. Fusion: reciprocal-rank fusion score = Σ weight/(K+rank) with
per-category weights (proven to change ordering), the approved-only index filter applied
AFTER fusion so a stale index cannot surface non-LIVE/out-of-stock/unserviceable listings
(fails closed on unknown ids), and sponsored blending capped at 2 of the top 10 with
mandatory "Sponsored" labels. 20/20 vitest. OpenSearch + vector store remain edge adapters
(not runnable in this sandbox) supplying the two ranked lists.

Slice 20 (recommendations): FR-AI-003 serving platform enforcing FR-CUS-013 rules (TS,
ai/ml-serving). Two-stage: candidate generation (co-visitation/embedding/popularity/
personalised, source-unioned) with personalised-only candidates DROPPED absent consent
(BRU-12) and attribution stripped so explanations cannot leak history; pre-ranking filters
(LIVE+in-stock+serviceable, no self-recommend of the seed, category exclusions, fail-closed
on unknown); ranking via an INJECTED learned ranker with the model->heuristic->curated
fallback chain that always yields a full slate; business re-rank with a per-vendor cap of
ceil(size/3) forcing >=3 distinct vendors in a 10-rail (backfilling to stay full and
reporting diversityMet honestly when the pool has fewer) and the FR-AI-003 top-1 EPSILON
GUARD so re-rank cannot depress the best relevance beyond epsilon; sponsored blend <=20%,
labelled, never at position 1. Every organic item carries a "why this". 21/21 vitest.

Slice 21 (risk & fraud decisioning): FR-AI-010 (TS, risk-svc) - closes the last
pre-computed input by PRODUCING the fraudScore the COD gate consumes. Per-flow velocity
rules (card-testing, instrument cycling, order/device velocity, COD-refusal history, promo
velocity, self-referral match, serial returner, repeat-offender strikes) emit interpretable
reason codes; the ML model is injected and a failing/out-of-range model degrades to
rules-only. Actions allow/step-up/hold-review/deny on per-flow thresholds. TWO STRUCTURAL
SAFETY INVARIANTS: (1) no black-box denial - proven in two layers, the model weight alone
caps a rules-free score below any deny threshold AND the invariant refuses to deny without
an interpretable reason even under deliberately permissive thresholds; (2) above the
per-flow monetary cap an automatic decision escalates to a human hold instead of denying
(proven: identical case denies AT the cap, escalates one paisa above). 18/18 vitest incl. a
cross-slice proof that a COD-abusing customer's score makes the quote engine refuse COD.

Slice 22 (verification & CI): the repo is now verifiable by anyone, not just asserted.
scripts/test-all.sh runs EVERY module (Java domains via JDK+JUnit console, TS via vitest),
auto-discovering TS packages, and prints an authoritative total: ALL GREEN - 337 tests.
(Writing it caught two bugs in itself: a filename exclusion pattern that wrongly skipped
VendorKycApplication.java, and a JUnit flag that suppressed the counts - and it corrected
the running total previously quoted by hand as 353. The per-module numbers were right; the
addition was not.) scripts/verify-migrations.sh applies V001-V005 in order (25 tables) and
re-runs 7 invariants on a live engine: ck_inv_nonneg blocks overselling, ck_sub_order_state
rejects unknown states, ck_wal_nonneg blocks a wallet overdraft, ck_loy_nonneg blocks an
over-redemption, every journal balances, capture+refund closes ALL accounts to 0.00, and
uq_ledger_event_leg blocks a ledger replay. .github/workflows/ci.yml implements the runnable
stages of Vol.11 §11.4 - validate (Java/TS/Spring-Boot mvn verify, which finally BUILDS what
the sandbox could only author), security (gitleaks + tracked-secret assertion + npm audit),
contract (event schema/OpenAPI validation), integration (migrations against real MySQL 8).
## Verifying this repository yourself

```bash
./scripts/test-all.sh            # every module; prints an authoritative total (337 tests)
./scripts/test-all.sh java       # Java domain layers only
./scripts/test-all.sh ts         # TypeScript modules only
./scripts/verify-migrations.sh   # apply V001-V005 and re-run the DB invariants
```

`test-all.sh` needs a JDK 21 and the JUnit console standalone (`apt-get install junit5`) for
the Java modules, and Node 20 for the TypeScript ones. `verify-migrations.sh` starts a
throwaway MariaDB by default, or point it at MySQL 8 with
`MYSQL_ARGS="-h 127.0.0.1 -P 3306 -u root -proot"`.

CI (`.github/workflows/ci.yml`) runs the same two scripts plus `mvn verify` for the Spring
Boot services, secret scanning, dependency audit and contract validation.
