# PixCart — Test Execution Report

Every block below is **captured output from a command executed in this session**, not a
reconstruction. The environment line records what was available, because two of the five gates
depend on it.

**Environment**

```
date:  2026-09-09T05:03:13Z
jdk:   openjdk version "21.0.12" 2026-07-21
node:  v22.22.2
db:    
maven: HTTP 403 — BLOCKED, so mvn verify was NOT run
```

---

## Gate 1 — Unit & integration tests (all modules)

```
COMMAND: ./scripts/test-all.sh
DATE:    2026-09-09T04:59:09Z
JDK:     openjdk version "21.0.12" 2026-07-21
NODE:    v22.22.2

PixCart — full test run
repo: /home/claude/pixcart

Java domain modules (JDK 21.0.12 + JUnit console)

TypeScript modules (vitest)

services/identity-svc                      218 passed
services/catalogue-svc                     48 passed
services/payment-svc                       13 passed
services/order-svc                         21 passed
services/finance-svc                       116 passed
services/inventory-svc                     15 passed
integration/e2e                            3 passed
ai/ml-serving                              406 passed
ai/orchestrator                            52 passed
contracts                                  9 passed
services/cart-checkout-svc                 67 passed
services/discovery-svc                     57 passed
services/finance-svc/tax                   19 passed
services/logistics-svc                     165 passed
services/marketing-svc                     330 passed
services/notification-svc                  59 passed
services/reporting-svc                     92 passed
services/risk-svc                          18 passed
services/support-svc                       41 passed

ALL GREEN — 1749 tests passed
```

---

## Gate 2 — TypeScript typecheck

This is a **separate gate from the tests on purpose**: vitest does not typecheck, so a module can
have every test passing while failing to compile. That is not hypothetical — it happened twice in
this project (marketing-svc's tsconfig omitted node types while the source used `Buffer`; a
`CompetitorBand` fixture invented a field the interface lacked). A module with **no** tsconfig is
treated as a failure rather than skipped, because skipping is how `contracts/` went unchecked for
its whole life.

```
COMMAND: ./scripts/typecheck-all.sh

PixCart — TypeScript typecheck
vitest does not typecheck; this is the gate that does


ai/ml-serving                      clean
ai/orchestrator                    clean
contracts                          clean
services/cart-checkout-svc         clean
services/discovery-svc             clean
services/finance-svc/tax           clean
services/logistics-svc             clean
services/marketing-svc             clean
services/notification-svc          clean
services/reporting-svc             clean
services/risk-svc                  clean
services/support-svc               clean

ALL 12 TYPESCRIPT MODULES TYPECHECK CLEAN
```

---

## Gate 3 — Migrations & database invariants

**First run in this session FAILED with 12 errors.** The cause was `mariadb: command not found`
after a workspace reset — an environment gap, not a schema defect. MariaDB was installed and the
script re-run. Both outcomes are shown, because reporting only the passing run would misrepresent
what happened.

```
COMMAND: ./scripts/verify-migrations.sh
DATE:    2026-09-09T05:01:54Z

PixCart — migration & invariant verification

1. apply migrations in order
  applied V001__core_schema.sql
  applied V002__identity_auth.sql
  applied V003__catalogue.sql
  applied V004__suborder_state_check.sql
  applied V005__wallet_loyalty.sql
  tables created: 25

2. constraint invariants
  PASS ck_inv_nonneg blocks overselling
  PASS ck_sub_order_state rejects an unknown state
  PASS ck_wal_nonneg blocks a wallet overdraft
  PASS ck_loy_nonneg blocks an over-redemption

3. double-entry ledger closure
  PASS every journal balances (Sigma debit == Sigma credit)
  PASS capture+refund closes all accounts to zero
  PASS uq_ledger_event_leg blocks a ledger replay

MIGRATIONS + INVARIANTS VERIFIED
```

---

## Gate 4 — Requirements traceability

```
COMMAND: python3 scripts/traceability.py --check

requirements: 98  implemented: 98 (100%)  tested: 88  BRUs cited: 13
written: docs/TRACEABILITY.md
exit: 0
```

---

## Gate 5 — Bundle integrity

The delivered bundle is verified by **cloning it and running the suite from the clone**, because
timestamps on the outputs mount are misleading and a bundle that cannot be cloned is not a delivery.

```
$ git clone pixcart.bundle && cd pixcart && ./scripts/test-all.sh java

Java domain modules (JDK 21.0.12 + JUnit console)

services/identity-svc                      218 passed
services/catalogue-svc                     48 passed
services/payment-svc                       13 passed
services/order-svc                         21 passed
services/finance-svc                       116 passed
services/inventory-svc                     15 passed
integration/e2e                            3 passed

ALL GREEN — 434 tests passed
```

---

## Not executed — and therefore not claimed

| Would-be gate | Why not run |
|---|---|
| `mvn verify` on the Spring service | Maven Central returns HTTP 403 in this sandbox. CI runs it; **this session did not.** |
| Production build | No build to run — one Spring entry point, no bundler, no frontend |
| Application startup / smoke test | Nothing to start (no HTTP layer) |
| End-to-end UI test | No UI exists; no browser in the environment |
| Live payment authorise/capture/payout | No provider chosen; port tested against fakes only |
| Live model inference | Supplied key is an AWS-service key and AWS hosts are egress-blocked |
| Live voice synthesis | Supplied key was the literal placeholder `YOUR_SARVAM_API_KEY` |
| Live notification send (email/SMS/push) | No provider adapter or credentials |

**No result in this report was inferred, extrapolated or reused from an earlier session.** Where a
gate could not run, it is listed above rather than estimated.
