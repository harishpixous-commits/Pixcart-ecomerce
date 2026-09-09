# PixCart

Domain-logic implementation of the **Pixous AI-Powered Multi-Vendor E-Commerce Platform**,
built against the Documentation Suite v1.0 (vendored at
`docs/Pixous_AI_ECommerce_Enterprise_Documentation_Suite_v1.0.pdf`).

---

## What this is — and what it is not

**It is:** the business rules for all 98 functional requirements in the suite, implemented as
framework-free Java and TypeScript modules, with **1,749 executing tests**, a relational schema
verified against a live MariaDB, and CI definitions.

**It is not a running application.** Verified by scan, not assumption:

- **0** frontend files (`*.tsx`, `*.jsx`, `*.vue`, `index.html`)
- **0** HTTP handlers (`@RestController`, `@GetMapping`, `express()`, `fastify`)
- **1** Spring class in the whole repo (`IdentityApplication.java`), in **1** service

There is no UI, no API layer, no payment provider bound, and no live external integration. Nothing
here is currently reachable by a user. **Read [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) before
presenting this work to anyone** — and quote its §0 rather than the test count, which on its own
invites the wrong conclusion.

A green suite here means *the rules behave as the suite specifies*. It does not mean the platform is
deployable or commercially ready.

---

## Layout

```
services/          domain modules per service (Java + TypeScript)
  identity-svc       auth, RBAC, sessions/step-up, admin, vendor store, profile, dashboards
  catalogue-svc      listings, attributes, moderation
  order-svc          order + sub-order lifecycle
  payment-svc        payment ledger, gateway ports
  finance-svc        settlement, refunds, statutory deductions, period close, tax
  inventory-svc      stock, reservations
  cart-checkout-svc  cart, quote, wishlist
  discovery-svc      query understanding, rank fusion, image search
  logistics-svc      serviceability, fulfilment, tracking, warehouse, shipping, partner portal
  marketing-svc      promotions, CMS, referral, affiliate, email, push, SEO, rewards, automation
  notification-svc   notification policy, timeline, operator notification centre
  reporting-svc      operational reports, vendor analytics, BI workspace
  risk-svc           fraud signals and decisions
  support-svc        ticketing, SLA matrix, help centre
ai/
  orchestrator       LLM chain, tool catalogue, provider resolver + adapters
  ml-serving         recommendations, pricing, forecasting, sentiment, segmentation, churn, indexing
contracts/         event JSON Schemas + OpenAPI, with a validation harness
infra/db/migrations/      V001-V005 (25 tables)
scripts/           the four verification gates
docs/              audit, limitations, test report, traceability, credentials
```

---

## Setup

**Prerequisites**

| Need | Version | Why |
|---|---|---|
| JDK | 21 | Java domain modules |
| Node.js | 20+ | TypeScript modules (vitest) |
| MariaDB or MySQL | 10.11 / 8 | Migration + invariant verification |
| Maven | 3.9+ | **Only** for the one Spring service; not needed for the test suite |

```bash
# Java test runner (no Maven needed for domain tests)
apt-get install -y openjdk-21-jdk-headless junit5

# TypeScript module dependencies
for m in services/*/ ai/*/ contracts/; do
  [ -f "$m/package.json" ] && (cd "$m" && npm install)
done

cp .env.example .env    # then fill in; see the file for what each variable feeds
```

`.env.example` lists every variable with the file that reads it, so the list can be checked rather
than trusted.

---

## Verification gates

```bash
./scripts/test-all.sh                      # every module's tests; prints an authoritative total
./scripts/typecheck-all.sh                 # every TS module compiles; NO tsconfig = failure
./scripts/verify-migrations.sh             # apply V001-V005, re-run 7 DB invariants
python3 scripts/traceability.py --check    # FR coverage ratchet
```

**Last executed results** — full output in [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md):

| Gate | Result |
|---|---|
| Tests | 1,749 passed / 0 failed, 19 modules |
| Typecheck | 12/12 TypeScript modules clean |
| Migrations | 25 tables, 7/7 invariants PASS (MariaDB 10.11) |
| Traceability | 98/98 requirements |

### Why typecheck is a separate gate

vitest **does not typecheck**. A module can have every test passing while failing to compile — that
happened twice here (`marketing-svc` used `Buffer` with `"types": []`; a test fixture invented a
field its interface lacked). A module with **no tsconfig** is treated as a failure rather than
skipped, because skipping is how `contracts/` went unchecked for its whole life.

---

## Running

**There is no application to run.** The Spring service has one entry-point class and has never been
compiled in the development sandbox (Maven Central returns HTTP 403 there). To attempt it where
Maven is reachable:

```bash
cd services/identity-svc && mvn verify && mvn spring-boot:run
```

This is **unverified** — see `docs/LIMITATIONS.md` section 2. Everything else in the repository is
domain logic exercised through its tests.

---

## Deployment

The CI workflow (`.github/workflows/ci.yml`) defines runnable stages per suite Vol.11 section 11.4:

| Stage | Contents |
|---|---|
| `validate` | Java + TypeScript tests, typecheck, `mvn verify` |
| `security` | gitleaks, tracked-secret assertion, `npm audit` |
| `contract` | event-schema and OpenAPI validation |
| `integration` | migrations applied against MySQL 8 |

**No CI run has been observed from the development environment**, and there is no container image,
release pipeline or infrastructure definition. Deployment beyond this is not built.

Before any deployment: the payment provider must be chosen, the delivery layer built, and secrets
provisioned per `.env.example`. None of `.env`, `node_modules` or build output is committed.

---

## Documentation

| File | Contents |
|---|---|
| [`docs/AUDIT.md`](docs/AUDIT.md) | Codebase audit, requirement statuses, defects found and fixed |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | **Blockers and everything unverified — read first** |
| [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) | Captured output of every gate, plus what was *not* run |
| [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) | Per-requirement matrix, generated from FR citations in source |
| [`CHANGELOG.md`](CHANGELOG.md) | Slice history and the defects found during development |
| [`docs/CREDENTIALS.md`](docs/CREDENTIALS.md) | Credential status and what each unblocks |

---

## Engineering conventions

Consistent across the codebase, and the reason the tests are worth their count:

- **Safety properties are structural where possible** — made unrepresentable rather than checked,
  and absences asserted by reflection (no publish path, no auto-execute surface, no export surface).
- **Each condition is tested independently.** A conjunction-only check passes a combined test and
  leaks in production.
- **Refuse rather than silently filter or default.** A refusal names what was refused.
- **One definition per rule.** BRU-10's price clamp, quiet hours, complaint thresholds and the EXIF
  stripper each live in exactly one module and are imported — a second implementation is a second
  behaviour wearing one name.
- **Documented acceptance criteria are encoded verbatim** as tests, with the arithmetic worked
  through rather than asserted loosely.
