# PixCart — Known Limitations & External Blockers

This document exists so that nobody reads "1,749 tests passing" and concludes the platform is
operating. It states what has **not** been verified, with the evidence for each claim.

If you are presenting this work to anyone, read §0 first and quote it rather than the test count.

---

## 0. The one-paragraph honest summary

PixCart is a **verified domain-logic layer**: the business rules for 98 requirements from the
Documentation Suite v1.0, implemented as framework-free Java and TypeScript modules with 1,749
executing tests, a live-verified relational schema, and CI definitions. **It is not a running
application.** There is no user interface, no HTTP layer, no payment provider, and no live external
integration of any kind. Nothing in it is currently reachable by a customer, a vendor or an
operator. The rules are right; the system around them is not built.

---

## 1. No payment provider is bound

**Status:** blocked on a decision, not on engineering.

`PaymentGatewayPort` and `PayoutGateway` are implemented, and the money spine around them —
authorise, capture, refund, settlement, double-entry ledger, statutory deductions, period close —
is tested to 116 tests in `finance-svc` plus 13 in `payment-svc`.

**What is unverified:** every one of those tests runs against a fake gateway. **No live payment,
refund or payout has ever been executed by this codebase.** Provider-specific behaviour — webhook
signature schemes, idempotency semantics, settlement file formats, error taxonomies, per-provider
rounding — is by definition untested.

**To resolve:** choose Razorpay, Cashfree or PhonePe. The adapter then implements an existing,
tested port; no domain change is expected, though provider quirks routinely surface at that point.

---

## 2. The production build has never been executed

**Status:** environment limitation.

```
$ curl -sS -o /dev/null -w "%{http_code}" https://repo.maven.apache.org/maven2/
403
```

Maven Central is blocked in this sandbox. Consequences:

- `services/identity-svc` — the **only** service with a `pom.xml` and the **only** file in the repo
  that references Spring (`IdentityApplication.java`) — has **never been compiled here.**
- `mvn verify` has never run in this environment. The CI workflow defines it; CI has not been
  observed running.
- Java domain tests are executed with JDK 21 plus a vendored `junit-platform-console-standalone.jar`,
  which is why 434 Java tests do run. That path does not exercise Spring, JPA, or any wiring.

**Correction to this project's own history:** earlier commit messages referred to "Spring Boot
shells" in the plural. That overstated it — there is exactly one Spring class in one service.

**To resolve:** build in an environment with Maven access.

---

## 3. No live AI model call has ever succeeded

**Status:** blocked on a credential.

The key supplied during development decodes to `AeaApiKey-…` — a **Claude-on-AWS long-term key**,
not an Anthropic first-party `sk-ant-` key. It was rejected 401 by `api.anthropic.com` (wrong
service), and every AWS host is refused by the sandbox egress allow-list ("Host not in allowlist").

The resolver in `ai/orchestrator/src/adapters/llm-config.ts` handles both key shapes and **refuses
rather than guessing** when a key is neither — that refusal path is tested. The adapters are built.

**What is unverified:** any actual inference. Every AI slice — recommendations, pricing, review
summarisation, sentiment, segmentation, forecasting, content generation, churn — is tested against
**injected fake models**. That is deliberate and it is the right design (the safety gates hold
regardless of model behaviour, which is the point), but it means **no model output has ever passed
through this system.**

**To resolve:** an `sk-ant-` key, or the Console → Quickstart gateway URL with that host
allow-listed. Either drops into the existing resolver with no code change.

---

## 4. Voice is unverified

The Sarvam key supplied was the literal placeholder string `YOUR_SARVAM_API_KEY`. The adapter
awaits a real key. No speech has been synthesised or recognised.

---

## 5. There is no delivery layer

**Status:** not built. This is scope, not a defect.

Verified by scan, not assumption:

```
$ find . -name "*.tsx" -o -name "*.jsx" -o -name "*.vue" -o -name "index.html"   # → 0 files
$ grep -rl "RestController\|@GetMapping\|express()\|fastify"                      # → 0 files
```

**Absent:** any UI (web, mobile, admin, vendor, partner), any HTTP/REST/GraphQL layer, request
authentication middleware, session cookies, CSRF handling, rate limiting at the edge, an API
gateway, observability wiring, container images, and deployment automation beyond the CI definition.

**Consequences that must not be glossed:**

- The brief's UI audit checklist — pages, buttons, forms, modals, navigation, pagination, uploads,
  exports — **was not performed, because there is nothing to perform it on.**
- No functional smoke test, and no end-to-end UI test, has been written or run.
- Security verification is **domain-level only**: RBAC decisions, step-up MFA gating, PII redaction,
  row-level scoping and consent gating are implemented and tested as *logic*. **Transport security,
  header hardening, session fixation, CSRF and edge rate limiting are untested because there is no
  transport.**

---

## 6. What "tested" means in this repository

Worth stating precisely, because the number is large enough to mislead:

- **1,749 tests** exercise domain rules — arithmetic, state machines, authority boundaries,
  refusal paths, boundary conditions.
- **7 database invariants** are verified against a live MariaDB 10.11: constraint enforcement,
  double-entry closure, replay protection.
- **95 of 97 source files** are referenced by at least one test. The 2 that are not are a Spring
  `main()` bootstrap and a 2-line type alias.
- **Nothing is tested through a network boundary, a browser, or a real external provider.**

A green suite here means *the rules behave as the Documentation Suite specifies*. It does not mean
the platform is deployable, reachable, or commercially ready.

---

## 7. Residual risks worth naming

| Risk | Why it is real |
|---|---|
| Provider quirks will surface during payment integration | Every gateway has undocumented behaviour; a port tested against fakes cannot anticipate it |
| Domain/HTTP boundary mismatches | Contracts are defined in `contracts/` and schema-validated, but no client has ever consumed them |
| The 98-FR catalogue is the suite's list, not a market requirement | Extracted from the PDF; completeness against the suite ≠ completeness against a real marketplace |
| Performance is unmeasured except one hook | Only the FR-MKT-010 promotions waterfall has a measured p95 (≈6 ms against an 80 ms budget). No load test exists |
| CI has never been observed running | The workflow is defined and its stages are runnable in principle; no run has been seen from here |
