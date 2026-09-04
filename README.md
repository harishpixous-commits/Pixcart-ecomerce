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

Slice 23 (requirements traceability): scripts/traceability.py GENERATES docs/TRACEABILITY.md
from the code - every source file cites the requirement ids it implements, and the
denominator is the requirement catalogue read straight out of the SRS volumes (98 FRs,
matching the suite). The honest result: 40 of 98 FRs (41%) have implementing code, 34 have
tests citing them, 11 BRUs are cited. The 58 unimplemented FRs are dominated by console and
UI-surface requirements - ADM 13 (admin dashboard, CMS, settings, reports), AI 12,
CUS 11 - not by the transactional core, which is where the 337 tests live. A generated
report cannot drift from the code or flatter it; --check enforces a coverage floor as a
ratchet in CI (currently 40, never lowered silently). Building the extractor also caught
that a 3-letter regex silently dropped the entire FR-AI family, which had understated the
catalogue as 83.

Slice 24 (catalogue governance): FR-ADM-005 + FR-ADM-006 (Java, catalogue-svc) - the first
bite out of the ADM gap the traceability report exposed. CategoryGovernance: tree depth
capped at 5 levels (unconstructible beyond), typed attribute schemas with mandatory/facet
flags, draft->publish versioning where publish is atomic and returns an ImpactPreview naming
the newly-mandatory attributes, affected live-listing count and the 14-day grace end; guards
that REFUSE rather than warn - no deleting a node with live listings (merge/move instead),
no attribute type change without a migration-plan reference, no enum-value removal while
referenced (and an enum can never be emptied); facets regenerate FROM the schema and appear
only at >=100 listings carrying values. BrandRegistry: normalised brand-name dedupe (case,
punctuation and spacing variants all collide), dated-and-expiring authorisations with expiry
ENFORCED by the mayListBrand gate that FR-ADM-004 calls to auto-block infringement, and the
takedown workflow with a 48h decision SLA, 1h execution window, mandatory counter-notice
path and an append-only case log. Both documented acceptance scenarios run verbatim - the
Sarees 'fabric' mandatory-attribute walk and the accepted-takedown execution. 18 new tests
(catalogue-svc 9 -> 27); repo total 355; FR coverage 41% -> 43%.

Slice 25 (vendor lifecycle & user administration): FR-ADM-003 + FR-ADM-002 (Java,
identity-svc). VendorLifecycle - the documented acceptance scenario proven END TO END against
the real Slice-14 AuditChain: a fraud-flagged application approved by an ordinary admin stops
at PENDING_SECOND_APPROVAL and only a Super Admin's confirmation activates it, with BOTH
actions appended to the tamper-evident chain and the chain still verifying. Same-person second
approval refused (SoD). KYC-not-green needs a documented override AND super-admin authority.
Rejection needs a template; a FRAUD_SIGNALS rejection starts the 30-day re-application
cooldown. Suspension freezes listings and payouts but PRESERVES the duty to service placed
orders; restriction freezes listings only. Off-boarding is financially safe - refused while
open orders, unsettled payables or unrecovered balances remain, each blocker named.
UserAdministration - PII masked by default with a reveal that carries its own audit entry (an
unaudited reveal is not expressible), ad-hoc customer deletion REFUSED in favour of the
privacy workflow, MFA reset requiring identity re-proof plus a second approver, staff email
domain allow-list, 60-day dormancy auto-disable, and the FR-ADM-017 SoD check expressed
against the Vol.2 §2.4 matrix. 17 new tests (identity-svc 48 -> 65); repo total 372;
FR coverage 43% -> 47%, ratchet raised to 46.

Slice 26 (CMS): FR-ADM-007 (TS, marketing-svc, which owns CMS_BANNERS per the Vol.2 §2.4
matrix). Publish is GATED and every gate names its violation: accessibility lint requiring alt
text on every image including variant images, image-slot dimension enforcement, an injected
link checker, a mandatory legal review on POLICY pages (not on help pages), A/B weights that
must sum to 100 and be positive, and no inverted schedule window - a failing gate blocks the
publish entirely, leaving nothing live and no version recorded. Versioned publish with rollback
that re-publishes a prior version as a NEW version, so history is append-only and v2 survives a
rollback to v1 - and rollback RE-RUNS the gates, so it cannot resurrect a page whose links have
since died. Emergency unpublish takes effect immediately and returns the <=1 min propagation
deadline. Deterministic A/B bucketing (same user, same variant; 70/30 split lands within
65-75% over 4,000 users). The documented acceptance scenario runs verbatim - a Fri 00:00 to
Sun 23:59 banner targeted at Tamil-language users, with Tamil alt text: invisible before the
window, visible ONLY to ta-* users during it (ta-LK matches on prefix), and auto-retiring
exactly at the window end with no publish, unpublish or mutation - because scheduling is
evaluated at read time. 25 new tests (marketing-svc 18 -> 43); repo total 397; FR coverage
47% -> 48%, ratchet raised to 47.

Slice 27 (platform administration): FR-ADM-014 + FR-ADM-017 (Java, identity-svc).
SystemSettings is EFFECTIVE-DATED, which is what makes the documented acceptance scenario true
by construction: with the Fashion return window changed 7->10 days, an order placed before the
change still resolves 7 for ever while a new order resolves 10 - retroactive mutation is not
expressible and nothing runs at the boundary. Critical keys in production require a change note
AND a second-person review who differs from the author; feature flags default OFF on create;
guard rules (COD cap <= Rs 50k, return window <= 90 days) and dependency checks (cannot disable
all, or the last, payment method) fire at save with every violation reported at once; rollback
re-asserts a prior value as a new version so history stays append-only and intermediate values
remain resolvable at their own moments. SecurityAdministration: console access requires an
allow-listed CIDR AND satisfied MFA - neither alone suffices - with real IPv4 CIDR matching
(/8, /24, /32, /0 and malformed input all covered); privileged roles cannot opt out of MFA;
break-glass demands two DISTINCT custodians plus a substantive justification and schedules its
own 24-hour auto-review at the moment of opening; permission changes preview their blast radius;
the last Super Admin cannot be removed; and the SoD ruleset is versioned, correctly flagging
FINANCE under SOD-01 and showing SUPER_ADMIN tripping both rules rather than hiding it. 14 new
tests (identity-svc 65 -> 79); repo total 411; FR coverage 48% -> 49%, ratchet raised to 48.

Slice 28 (API & integration management): FR-ADM-016 (Java, identity-svc). The revoked-key
acceptance scenario is met STRUCTURALLY: authorise() appends every decision - allowed or refused
- to the key's usage log in the same call, so a rejected request cannot fail to appear, and a
revoked key reports 401 KEY_REVOKED even after it would also have expired (revocation is the
honest reason). Scopes come from a published catalogue and are bounded upward by the plan tier,
so a SANDBOX key can never obtain write authority and SETTLEMENT_READ stays partner-only. Keys
auto-expire at 12 months with rotation reminders at exactly T-30 and T-7 (and stop nagging once
expired). Per-key sliding-window rate limits come from the tier (60/min sandbox), returning 429
RATE_LIMITED and recovering as the window slides. Webhooks require HTTPS, a >=32-char signing
secret, at least one event type and a challenge token, with ownership proven only by echoing the
EXACT token; the retry ladder is asserted against the documented 1m/5m/30m/2h/6h schedule delay
by delay, then dead-letters, and UI redrive clears the dead letter and restarts the ladder from
the top. 12 new tests (identity-svc 79 -> 91); repo total 423; FR coverage 49% -> 50%.

Slice 29 (platform promotions console): FR-ADM-008 (TS, marketing-svc - the operator superset of
the FR-MKT-001/002 engine already there). Budget approval required at or above Rs 1 lakh (below
it, none). EXCLUSIVE-EVENT CONFLICTS ARE DETECTED AT SAVE, not discovered later: an exclusive
campaign overlapping another exclusive one for the same audience is refused, adjacent windows are
allowed, distinct segments are allowed, and an ALL-audience exclusive still conflicts with a
segmented one. The 5% holdout is maintained by deterministic bucketing rather than stored state -
stable per user, lands within 3-7% over 5,000 users, and a held-out user is NOT eligible even
inside the window, which is what makes incrementality measurable. The price-integrity gate stops
fake discounts: a listing whose MRP was raised within 30 days before the event start cannot join,
while a stable or never-raised MRP can. Burn accumulates against the cap and is refused beyond
it; incremental ROI is measured treated-vs-holdout per user and returns NULL rather than a
fabricated number when spend is zero or a cohort is empty. 20 new tests (marketing-svc 43 -> 63);
FR coverage 50% -> 51%.

Slice 30 (operational reports + traceability made self-contained): FR-ADM-009 (TS,
reporting-svc). The documented acceptance scenario runs verbatim - a daily settlements report
completing at 07:00 IST delivers a signed, 24h-expiring link and records a REAL SHA-256 checksum
plus row count in the run log (identical rows hash identically; one changed cell or a re-ordered
column changes the hash). Reading the OLTP primary is refused structurally before any work
happens; replica and lakehouse are accepted, and every run is footnoted with source, replica
freshness, range and filters. Parameters are bounded per report kind (inventory 31 days,
settlements 366), inverted and future-ending ranges refused; recipients must be on the domain
allow-list with the offending domain named; PII columns are role-gated and named in the refusal;
and every violation is reported at once rather than one per attempt. The daily IST schedule is
COMPUTED, so a tick at the run instant resolves to tomorrow and cannot fire twice.
Also: the workspace was reset mid-slice, which exposed that the Slice-23 traceability generator
read its requirement catalogue from a path OUTSIDE the repo - so it could not run for anyone who
merely cloned it. The catalogue (all 98 FRs) is now VENDORED at docs/requirements/catalogue.json
and the script prefers it, with the SRS globs kept as a refresh path. 18 new tests; repo total
461; FR coverage 51% -> 52%.

Slices 38-40 (finance completion + first AI slice). Slice 38 FR-FIN-007 statutory deductions
closes the TCS/TDS dangling reference from Slice 35: rates are never constants in the arithmetic
but effective-dated config requiring an advisor sign-off, the two levies keep DIFFERENT bases (TCS
on net taxable, TDS 194-O on gross - conflating them is the classic error), a mid-month rate change
splits the period with both segments shown and segment bases that reconstruct the total EXACTLY,
PAN-missing applies the higher rate and raises the onboarding block, registers tie out to the
control ledger exactly, corrections route to a subsequent month with a trace, and certificates are
tamper-hashed. Slice 39 FR-FIN-008 period close COMPLETES THE FIN FAMILY (8/8): the lock is a GATE
every posting passes, the acceptance criterion is proven in all four directions including that
claiming to be a prior-period adjustment does NOT unlock the locked month, the close is blocked by
an incomplete checklist or a control imbalance (auto-generating the imbalance report), the lock is
dual SA+FIN by two different people, and the auditor workspace is read-only with refused writes
still recorded. Slice 40 FR-AI-008 dynamic pricing is the first AI slice, using the injected-model
pattern: BRU-10 floor/ceiling and the MRP ceiling are enforced IN THE ENGINE so a model suggesting
Rs 9,999 cannot produce a price above MRP, collusion-safety is structural (a competitor band
aggregating fewer than 5 sellers is refused as a coordination signal and blocks the change
entirely), low elasticity confidence forces suggest-only regardless of mode, event locks and the
1-per-24h rate limiter downgrade to suggestions, kill switch and category guard-trip stop the
engine, a throwing or nonsensical model never moves a price, every decision including refusals is
audited with model version and factors, and simulation never applies a price.

Slices 41-43 (AI family). Slice 41 FR-AI-002 conversational commerce actions closes the gap open
since Slice 3 - the LlmChain enforced a deny-by-default allowedTools list but no action catalogue
existed behind it. All eight documented tools registered; "no bypass path" is structural because a
tool cannot be REGISTERED without its owning service's validator and a security-review sign-off,
and cannot be registered twice (closing the validator-swap follow-on). Guests restricted to
read+cart with a narrower allow-list handed to the LLM; monetary tools capped at 3 attempts per
session where a FAILED coupon still consumes one; irreversible actions need a single-use 120s token
bound to session AND tool; multi-item actions report itemised outcomes with no silent partials.
Slice 42 FR-AI-007 inventory optimisation works the documented acceptance case arithmetically -
95% service level, lead time 7+/-2d, demand 10+/-3 gives sigma=sqrt(463)=21.52, safety stock
ceil(1.6449*21.52)=36, ROP=106 - and asserts that demand variance ALONE would give 7.94, so an
implementation dropping the lead-time term would look plausible but understate the buffer by half.
Advisory-only is structural (no export begins with execute/apply/commit/placeOrder), and markdown
ranges REUSE the Slice-40 BRU-10 clamp rather than reimplementing the floor/MRP rule. Slice 43
FR-AI-014 review summarisation enforces extractive groundedness as a real gate: a fabricating
summariser cannot publish because a claim citing a review that does not contain its substance is
REJECTED and the section hidden. Comparative claims refused even when grounded in a real review;
summaries suppressed below 5 eligible reviews; provider payloads PII-free by construction; a
moderated-out review changes the review-set hash so the stale summary is HIDDEN rather than shown.

Slice 31 (invoicing & credit notes): FR-FIN-003 (Java, finance-svc) - closes the money story with
the statutory documents. Three properties are STRUCTURAL: (1) immutability - Document exposes no
setter, amend or update method (asserted by reflection), so corrections exist only as credit
notes; (2) GAPLESS NUMBERING - mandatory GST fields are validated BEFORE a sequence is allocated,
so three rejected attempts leave the next good invoice at 000002 rather than 000005, and the
series restarts per vendor+financial-year on the Indian April boundary; (3) EXACT PROPORTIONAL
REVERSAL - credit amounts are cumulative(returned) minus already-credited, so three successive
1-of-3 credit notes on an awkward amount (1000.01 taxable, 90.01 SGST) sum to EXACTLY the
original with no paisa leaked or created. The documented acceptance scenario runs verbatim: a
1-of-3 partial return produces a credit note referencing the original number, carrying one third
of the taxable value and of each tax component, with both documents in the customer's set.
Also: over-crediting refused, credit notes cannot themselves be credited, tamper-hash per
document, and the e-invoice lifecycle - pending-IRN when the GSP is down, hard alert at 20h, IRN
attach once only, and cancellation honouring the 24h window before directing the caller to a
credit note. 16 new tests (finance-svc 23 -> 39); repo total 477; FR coverage 52% -> 53%.

Slice 32 (reviews & ratings): FR-CUS-023 + FR-CUS-024 (Java, catalogue-svc). Both documented
acceptance scenarios run verbatim. (1) A non-purchaser attempting to review is REFUSED and
nothing is stored - and "bought but not yet delivered" is reported distinctly from "never
purchased", because they need different messages. (2) A listing with a single 1-star review must
NOT display 1.0: the Bayesian posterior (m=10, C=category mean) yields 3.727 -> 3.7, and the test
asserts the raw mean genuinely is 1.0 so the smoothing is doing real work rather than the data
being convenient. Smoothing is also shown to CONVERGE - 100 one-star reviews reach below 1.3 but
never quite 1.0. Reviews: one per delivered SKU per customer, 2000-char/5-photo/60-second limits,
URL/email/phone/profanity filters, AI screen where UNCERTAIN routes to a human queue with a 24h
SLA and is visible to the author only (and counts for nothing meanwhile), 30-day edit window with
every version retained, vendor reply with NO delete path anywhere in the API (asserted by
reflection), admin-only takedown with a logged reason, self-votes refused, and a per-customer
anti-brigading velocity cap that recovers after a day. Ratings: only PUBLISHED reviews count -
pending, rejected and taken-down are excluded - per-star histogram, 1-decimal display, vendor
composite on the documented 60/25/15 weighting with the weights asserted to sum to 1, payout-risk
tiering, and a recency trend that is positive for an improving listing and zero for a flat one.
21 new tests (catalogue-svc 27 -> 48); repo total 498; FR coverage 53% -> 55%.

Slice 33 (login, sessions & MFA): FR-CUS-002 + FR-CUS-003 (Java, identity-svc). The TOTP is a
REAL RFC 6238 implementation - HMAC-SHA1 over the big-endian time counter with RFC 4226 dynamic
truncation - and it is verified against the PUBLISHED TEST VECTORS in RFC 6238 Appendix B (all
six, at T=59 through T=20000000000). Verification against the standard rather than against
fixtures of our own is the assurance a primitive guarding payout-account edits deserves. The +/-1
step window accepts one step either side and refuses two; comparison is constant-time with no
early exit. Login: progressive lockout proven across the whole ladder (15/30/60/120/240/480/960
minutes, then capped at 24h), a correct credential still refused while a lock stands, and the
next lock doubling after the first lapses. NO ENUMERATION is asserted directly - the responses to
an unknown identifier and a wrong password are compared for EQUALITY, so the endpoint cannot be
used to discover which accounts exist. Suspended and deleted accounts refused even with correct
credentials; +/-60s clock-skew tolerance. Sessions: capped at 8 with the OLDEST evicted, new
devices flagged once then recognised, listable and revocable per device. Step-up grants are bound
to action type AND session AND ten minutes - a password-change grant cannot edit a payout account
and a laptop grant cannot be presented from a phone - consumed on use so they cannot be replayed,
and killed when their session is revoked or evicted. Recovery codes: exactly 10, single-use, and
spending them all forces identity re-verification. 25 new tests (identity-svc 91 -> 116); repo
total 523; FR coverage 55% -> 57%.

Slice 34 (pickup, manifest & handover): FR-LOG-002 + FR-LOG-003 (TS, logistics-svc). The property
this slice guarantees is that LIABILITY NEVER TRANSFERS SILENTLY: a shipment reports SHIPPED and
its settlement risk flips to the carrier ONLY on a recorded handover carrying rider identity -
a manifest merely existing changes nothing, which the tests assert per-AWB. Pickup: slot-within-
location-hours, label required, same-day 14:00 cut-off (next-day slots still bookable after it),
inverted and past slots refused, Scheduled->Attempted->Completed/Failed with the documented
18:00-failure acceptance case auto-booking the next slot, and escalation on the SECOND CONSECUTIVE
failure - a success clears the streak, and couriers and locations are tracked independently.
Manifest: only labelled AND pickup-booked shipments manifestable, duplicate AWBs refused,
tamper-proof checksum that ignores line order but not content, DUPLICATE SCANS IDEMPOTENT keeping
the first evidence, offline OTP fallback requiring a photo, and 180-day evidence retention. The
documented acceptance scenario runs verbatim - 10 manifested, 9 scanned: closure is BLOCKED, a
late scan resolves it and closes cleanly, OR a substantive exception note by a NAMED operator
permits closure while shipping only the 9 actually handed over and RECORDING the gap rather than
erasing it; the unscanned shipment never gains carrier liability. 24 new tests (logistics-svc
29 -> 53); repo total 547; FR coverage 57% -> 59%.

Slice 35 (vendor revenue & fee transparency, FR-VEN-010): the statement is a PROJECTION over
ledger lines with no calculator surface at all (asserted by reflection), so the vendor-facing
number cannot drift from the ledger. The acceptance criterion is verified in BOTH halves and the
second half is a real cross-check: the statement's Rs 790 net and the Slice-6 SettlementEngine's
independently-computed Rs 790 payout are compared for equality, because both live in the same
module. Component signs enforced at construction, another vendor's or sub-order's line REFUSED
rather than silently filtered, repeated ledger line ids refused (the actual double-count
mechanism), SETTLING state with real figures never blank, rendersCompletely() catching an omitted
TCS or double-listed commission, disputes bound to line ids on the statement, watermarked
downloads, and fee-schedule changes refused unless forward-effective with 15 days' notice.

Slice 36 (referral programme, FR-CUS-025 + FR-MKT-007): resolves the dangling SELF_REFERRAL_MATCH
rule that Slice 21's risk engine had carried since it was written - a cross-slice test drives the
hand-off for real. Self-referral blocking tested on each signal INDEPENDENTLY (device, instrument,
address), first-touch-wins with the losing code AUDITED, per-referrer quarterly cap, suspected
rings held UNDER_REVIEW rather than rejected, vesting only after the return window lapses,
clawback on refund. The documented budget-cap acceptance scenario runs verbatim AND proves the
harder half: in-flight vesting is HONOURED because each attribution snapshots the reward it was
promised, so pausing stops new promises without reneging on existing ones.

Slice 37 (refund operations console, FR-FIN-006): the authority model is the substance - Support
is bounded to <= Rs 2,000 AND delivered-issue reasons only, so a support seat cannot be socially
engineered into a large payout; Finance is unbounded on amount but a manual refund ABOVE
Rs 10,000 needs a checker who is not the maker. Amount capped against captured net of prior
refunds, duplicate-refund guard per line that a FAILED refund does not permanently block, COD
requiring a verified beneficiary and no original instrument, goodwill requiring evidence and
tagged separately for P&L, every gateway reject code mapped to a remediation (asserted exhaustively
so an unmapped code cannot return null), success requiring an ARN/UTR proof, ordered gateway
transitions, 7-day stuck escalation with customer notice, the 24h initiation SLA, and analytics
separating goodwill from returns-driven leakage.

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
