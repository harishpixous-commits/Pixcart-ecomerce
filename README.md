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