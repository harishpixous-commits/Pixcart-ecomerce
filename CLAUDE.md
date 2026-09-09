# CLAUDE.md — working instructions for this repository

Read this before changing anything. It exists so each session starts with accurate context instead
of rediscovering it.

---

## 1. What this repository is

PixCart: the **domain-logic layer** for the Pixous AI-Powered Multi-Vendor E-Commerce Platform,
built against `docs/Pixous_AI_ECommerce_Enterprise_Documentation_Suite_v1.0.pdf` (vendored — read
specs from it directly with `pdftotext -layout`, don't ask for them).

- All **98 functional requirements** are implemented as framework-free Java + TypeScript modules.
- **1,749 tests** pass. Schema verified against a live MariaDB.
- **It is NOT a running application.** No UI, no HTTP layer, no payment provider, no live
  integration. 13 of 14 services have no `pom.xml` at all.

Read `docs/LIMITATIONS.md` before making any claim about what works. Its §0 is the honest summary.

**A green suite means the rules are correct. It does not mean anything is deployed or reachable.**

---

## 2. Non-negotiable: how to report

The project owner was previously criticised for a document that over-claimed. Therefore:

- **Never say a test passed unless you ran it in this session.** Paste the command and its output.
- **Never say an integration works** if it ran against a fake, a mock or an injected stub. Say which.
- If something is blocked, name the blocker and what would unblock it. Don't soften it.
- Prefer "I could not verify X" over silence about X.
- When you find a defect in your own work, say so explicitly in the commit message. This codebase's
  history does that and it is a feature, not an embarrassment.

---

## 3. Verify the environment first — it differs from where this was built

The original build sandbox had **no Maven access** and **restricted egress**. Your machine probably
does. Check before assuming either way:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://repo.maven.apache.org/maven2/   # 200 = Maven works
mvn -v; java -version; node --version; mariadb --version
```

If Maven works, the first genuinely new thing you can do is **compile and run `identity-svc`**,
which has never been done. Report the result honestly — a first compile of untried code usually
surfaces something.

---

## 4. The four gates — run them before and after every change

```bash
./scripts/test-all.sh                      # every module; prints the authoritative total
./scripts/typecheck-all.sh                 # every TS module compiles; NO tsconfig = FAILURE
./scripts/verify-migrations.sh             # apply infra/db/migrations, re-run 7 DB invariants
python3 scripts/traceability.py --check    # FR coverage ratchet, wired into CI
```

`typecheck-all.sh` is separate from the tests **on purpose**: vitest does not typecheck. Twice in
this project a module had every test passing while failing to compile. Never fold it into the test
run, and never lower the traceability floor to make a change pass.

Java tests run via JDK 21 + a vendored `junit-platform-console-standalone.jar` — no Maven needed.

---

## 5. Do not

- **Do not rewrite the domain layer.** It is complete, tested, and specs are encoded verbatim.
- Do not change the tech stack, remove working features, or "simplify" a requirement.
- Do not duplicate a rule that already exists. BRU-10's price clamp, quiet hours, complaint
  thresholds, EXIF stripping and the censored-demand correction each live in **exactly one** module
  and are imported. A second implementation is a second behaviour wearing one name.
- Do not weaken a security check to make a build pass. If gitleaks flags a fixture, change the
  fixture, not the scanner.
- Do not add TODOs, placeholders, mock data in production paths, or fake success returns. The repo
  currently has **zero** and that is verified by scan.

---

## 6. Conventions that make the tests worth their count

Follow these when adding code:

- **Make safety properties structural, not checked.** Prefer unrepresentable over validated. Assert
  absences by reflection — e.g. "no export begins with `publish`/`execute`/`apply`".
- **Test each condition independently.** A conjunction-only check passes a combined test and leaks
  in production.
- **Refuse rather than silently filter or default**, and name what was refused.
- **Encode documented acceptance criteria verbatim**, with the arithmetic worked through. Example:
  FR-AI-007's reorder point is asserted as σ=√463=21.52 → SS=⌈1.6449×21.52⌉=36 → ROP=106, *and* the
  test proves demand variance alone would give 7.94.
- **Prefer integers for money and rates.** Paise, not floats; basis points, not fractions. Odds sum
  to exactly 10,000 bps precisely so the check needs no epsilon.
- **Compare exact, round only for display.** Rounding before a threshold comparison shifts the
  threshold.
- **Close dangling references.** If a rule cites something not yet built, build that next.

---

## 7. What is pending — build in this order

Everything below is category C from `docs/AUDIT.md`: not built at all. The suite specifies
**Expo** mobile, **React** web, a **BFF** layer, REST services, FastAPI for AI, Kubernetes.

**Step 1 — blocked on the owner.** Do not guess these:
1. Payment provider (Razorpay / Cashfree / PhonePe) — gates the money path
2. An `sk-ant-` AI key, or gateway URL + allow-listed host
3. A real Sarvam voice key
4. A GitHub PAT, or the owner pushes the bundle

**Step 2 — ONE thin vertical slice. Do this before anything else.**
Take `identity-svc` (already has the pom) and one flow — login → step-up → view profile — all the
way through: REST controller → BFF endpoint → one React screen. This validates the stack shape,
contract wiring and auth boundary at 1× cost instead of 14×. **Do not start 14 services at once.**

**Step 3 —** replicate the pattern in dependency order: identity → catalogue → cart/checkout →
payment → order → logistics → finance → the rest.

**Step 4 —** FastAPI host over `ai/ml-serving` + `ai/orchestrator`. Cheap: the modules already take
injected models.

**Step 5 —** React web first (operator/vendor surfaces have least UX ambiguity), then Expo.

**Step 6 —** edge security (session cookies, CSRF, rate limiting), Docker + K8s, observability,
then load testing.

Domain RBAC, step-up MFA, PII redaction and consent gating are **done and tested as logic**.
Transport security is **entirely unbuilt** — that is Step 6, not Step 2.

---

## 8. Repository map

```
services/*/          domain modules (Java + TypeScript), one dir per service
ai/orchestrator      LLM chain, tool catalogue, provider resolver + adapters
ai/ml-serving        recommendations, pricing, forecasting, sentiment, segmentation, churn, indexing
contracts/           event JSON Schemas + OpenAPI + validation harness
infra/db/migrations/ V001–V005 (25 tables)
scripts/             the four gates
docs/AUDIT.md        audit, requirement statuses, defects found
docs/LIMITATIONS.md  blockers and everything unverified — READ FIRST
docs/TEST-REPORT.md  captured gate output + what was NOT run
docs/TRACEABILITY.md per-requirement matrix, GENERATED — do not hand-edit
docs/CREDENTIALS.md  credential status
CHANGELOG.md         slice history + defects found during development
```

Commit style: a title line, then prose explaining *why* the design is what it is and what would
break under the obvious alternative. Look at `git log` for the pattern.
