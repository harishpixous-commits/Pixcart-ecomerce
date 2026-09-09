# PixCart — Codebase Audit

**Audited:** 2026-09-09 · **HEAD at audit:** see `git log -1` · **Auditor:** engineering session

---

## 0. Scope finding — read this first

The audit brief asks for verification of a running full-stack application: "every page, module,
button, form, dropdown, modal, tab, navigation item", an executed production build, and end-to-end
UI tests.

**PixCart is not that yet, and no part of this document should be read as claiming otherwise.**

What was actually found in the repository, by scan rather than assumption:

| Audit question | Command run | Result |
|---|---|---|
| Is there frontend code? | `find . -name "*.tsx" -o -name "*.jsx" -o -name "*.vue" -o -name "index.html"` | **0 files** |
| Is there a wired HTTP layer? | `grep -rl "RestController\|@GetMapping\|express()\|fastify"` | **0 files** |
| How many Spring classes exist? | `grep -rl "org.springframework" --include=*.java` | **1 file** (`IdentityApplication.java`) |
| How many services have a `pom.xml`? | `ls services/*/pom.xml` | **1** (`identity-svc`) |
| Is Maven Central reachable? | `curl https://repo.maven.apache.org/maven2/` | **HTTP 403 — blocked** |

**Consequences for this audit, stated plainly:**

- There are **no pages, buttons, forms, modals or navigation items to audit.** The brief's §3
  checklist is not applicable to the current codebase, and I have not simulated it.
- There is **no application to start**, so "run the actual application and perform functional smoke
  tests" (§5) and "verify the production build" (§6) **were not done and are not claimed.**
- **No end-to-end UI test was written or run.** There is no UI and no browser in the environment.
- A correction to this repository's own history: earlier commit messages in this project referred to
  "Spring Boot shells" in the plural. That overstated it. There is exactly **one** Spring entry-point
  class, in one service. The phrase has been corrected in the README.

**What PixCart actually is:** a verified **domain-logic layer** — 98 requirements from the
Documentation Suite v1.0 implemented as framework-free Java and TypeScript modules, with 1,749
executing tests, a verified relational schema, and CI definitions. It is the part of a system where
the business rules live. The delivery layer (HTTP, UI, provider adapters) is not built.

This distinction is the single most important output of the audit. A reader who takes "1,749 tests
passing" as "the application works" would be badly misled: the tests prove the rules are right, not
that anything is deployed or reachable.

---

## 1. Requirements audit

Full per-requirement traceability is generated from FR citations in the source, not hand-maintained:

```
python3 scripts/traceability.py          # writes docs/TRACEABILITY.md
python3 scripts/traceability.py --check  # CI gate; fails below the coverage floor
```

**Result at audit:** `requirements: 98  implemented: 98 (100%)  tested: 88  BRUs cited: 13`

| Classification | Count | Meaning as used here |
|---|---:|---|
| **Completed (domain layer)** | 98 | Rules implemented, tests cite the FR, tests execute and pass |
| **Partially completed** | 0 | — |
| **Missing** | 0 | — |
| **Broken** | 0 | — |
| **Blocked (delivery layer)** | 98 | *Every* requirement is blocked from live operation by §2 below |

The last row is not a formality. Every requirement is implemented at the domain layer and **none of
them is reachable by a user**, because there is no HTTP layer or UI. "Completed" in the table above
means *the rule is correct and tested*, and nothing more.

The denominator (98) is the vendored catalogue at `docs/requirements/catalogue.json`, extracted from
the Documentation Suite PDF. It is the FR list the suite defines; it is not a claim that 98 FRs are
all a commercial marketplace needs.

One catalogue correction made during this project: FR-AI-006 was recorded as
`(name not captured from SRS — verify against Vol.3)` rather than invented. It was later recovered
from the suite as **Demand Forecasting Service** and the catalogue updated.

---

## 2. Blockers — what is unverified and why

Recorded in full in `docs/LIMITATIONS.md`. Summary:

| # | Blocker | Consequence | Needs |
|---|---|---|---|
| 1 | No payment provider chosen | `PaymentGatewayPort` / `PayoutGateway` proven against fakes only; **no live payment or payout has ever been executed** | A decision: Razorpay / Cashfree / PhonePe |
| 2 | Maven Central returns HTTP 403 in this sandbox | The one Spring service is **never compiled here**; the production build is **unverified** | A build environment with Maven access (CI has it) |
| 3 | AI key is an AWS-service key, and AWS hosts are egress-blocked | **No live model call has ever succeeded**; adapters tested against fakes | An `sk-ant-` key, or gateway URL + host allow-listed |
| 4 | Sarvam key supplied was the literal `YOUR_SARVAM_API_KEY` | Voice path **unverified** | A real key |
| 5 | No HTTP layer or UI exists | Nothing is user-reachable; no smoke test, no UI test | Building the delivery layer |

---

## 3. Placeholder / dead-code audit

The brief asks specifically about decorative buttons, placeholder functions, fake success messages,
hardcoded production data and unfinished TODOs. There is no UI, so the button question is moot; the
code-level checks were run:

| Check | Command | Result |
|---|---|---|
| TODO / FIXME / XXX / HACK in source | `grep -rn "TODO\|FIXME\|XXX\|HACK\b" --include=*.java --include=*.ts` (excluding tests) | **0** |
| `UnsupportedOperationException` / "not implemented" stubs | `grep -rn "UnsupportedOperationException\|not implemented"` | **0** |
| Source files not referenced by any test | symbol-reference scan across all test files | **2 of 97** |
| Hardcoded key-shaped literals | `grep -rInE "(sk-ant-[A-Za-z0-9]\|AKIA[0-9A-Z]{16}\|-----BEGIN.*PRIVATE)"` | **0** (after fix, §4) |

The 2 unreferenced source files, examined individually rather than reported as a bare number:

1. `identity-svc/.../IdentityApplication.java` — the Spring `main()` bootstrap. Untestable without
   the framework; legitimately uncovered.
2. `cart-checkout-svc/.../cart/money-cart.ts` — a **2-line type alias** (`export type Paise = number`),
   imported by `cart.ts`. A type alias has no runtime behaviour to test.

Neither is a defect. Reporting them as "37 untested files" — which a filename-matching scan first
suggested — would have been inaccurate in the opposite direction from over-claiming, and is
corrected here.

---

## 4. Defects found and fixed during this audit

| # | Defect | Severity | Fix |
|---|---|---|---|
| D1 | `.env.example` absent, though the brief requires it and the repo reads real env vars | Medium | Created, with each variable's actual consumer named so the list is verifiable |
| D2 | Two test fixtures contained literal `sk-ant-…` strings, and there is **no gitleaks allowlist**, so the CI security stage was at risk of failing on committed fake keys | Low | Fixtures now assembled from fragments at runtime. **The scanner was not weakened and no allowlist hole was added** — an exemption on that path could later hide a real key |
| D3 | `verify-migrations.sh` reported 12 failures | **Not a defect** | Cause was `mariadb: command not found` after a workspace reset. MariaDB installed and the script re-run: **all checks pass** (§5) |

On D2 I could not run gitleaks itself — it is not installed and the network is restricted — so I
cannot state whether its current Anthropic rule would have matched a 13-character token. The
fixtures were hardened regardless, which removes the question at no cost. **That it would have
failed CI is not claimed.**

Defects found and fixed in the slices preceding this audit are listed in `CHANGELOG.md`; the
substantive ones were a Unicode tokeniser that silently disabled Tamil-language summarisation, a
name validator that rejected Tamil names, a redirect chain check that only walked one level back,
and a complaint-rate comparison that rounded before thresholding.

---

## 5. Verification evidence

Every figure below came from a command executed in this session. Full output in
`docs/TEST-REPORT.md`.

| Gate | Command | Result |
|---|---|---|
| Tests | `./scripts/test-all.sh` | **1,749 passed**, 0 failed, 19 modules |
| Typecheck | `./scripts/typecheck-all.sh` | **12/12 TypeScript modules clean** |
| Migrations + DB invariants | `./scripts/verify-migrations.sh` | **25 tables, 7/7 invariants PASS** on MariaDB 10.11 |
| Traceability | `python3 scripts/traceability.py --check` | **98/98**, ratchet satisfied |
| Bundle integrity | `git clone pixcart.bundle && ./scripts/test-all.sh java` | **434 Java tests pass from a fresh clone** |

**Not run, and therefore not claimed:** `mvn verify` (Maven blocked), production build, application
startup, functional smoke test, end-to-end UI test, live payment, live model call, live voice call,
live notification send.

---

## 6. Acceptance against the brief

| Brief requirement | Status |
|---|---|
| Understand existing codebase, preserve working features | **Done** — nothing removed; existing architecture and conventions followed |
| Requirements traceability matrix | **Done** — generated from source, 98/98 |
| Verify every feature end-to-end (UI→API→DB) | **Not possible** — no UI or API layer exists (§0) |
| Implement missing requirements | **Done at domain layer** — 98/98 |
| Fix verified defects | **Done** — see §4 and `CHANGELOG.md` |
| Comprehensive testing | **Partial** — unit/integration/DB done and executed; **no UI or API tests, because neither layer exists** |
| Run the application, smoke test | **Not done** — nothing to run (§0, §2) |
| Database/config/deployment verification | **Partial** — schema and migrations verified live; production build and deploy **unverified** |
| Final bundle with docs | **Done** |
| Secrets excluded from bundle | **Verified** — 0 key-shaped literals; `.env`, `node_modules`, build output excluded |

**The brief's final acceptance criterion — "the application must build successfully and run in the
available environment" — is NOT met, and cannot be met in this environment.** The blockers are
listed in §2. The domain layer beneath it is complete and verified.
