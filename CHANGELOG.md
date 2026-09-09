# PixCart — Change Log

Generated from `git log`. Each entry is a slice that closed one or more requirements from the
Documentation Suite v1.0. Defects found *during* a slice are recorded in that slice's commit
message, and the substantive ones are collected in the table below.

**Totals at time of writing:** 73 commits · 1,749 tests · 98/98 requirements at the domain layer.

## Defects found and fixed during development

These were found by testing, not reported by a user. They are listed because a change log that
shows only additions hides how the work actually went.

| Slice | Defect | Why it mattered |
|---|---|---|
| 43 | `contentWords()` stripped everything outside `[a-z0-9]`, so a Tamil review yielded zero content words and could never be grounded | Review summarisation would have been **silently unavailable for every Tamil locale** on a Tamil Nadu platform. It failed *closed*, so it would never have crashed or alerted — it would just have looked like the feature did not work |
| 48 | The general phone pattern matched a 12-digit Aadhaar and reported it as `PII_LITERAL_PHONE` | The literal was still caught, so nothing unsafe shipped — but misreporting an Aadhaar as a phone number understates what was found and sends the reader looking for the wrong thing |
| 55 | `marketing-svc` tsconfig declared `"types": []` while the source used `node:crypto` and `Buffer`; a `require()` and a stray `toBe()` argument that vitest ignored | 166 tests passed while the module **did not compile**. Led to slice 56 |
| 56 | `contracts/` had no tsconfig and had never been typechecked in its life | It holds the cross-service event schemas — the module where type drift is most damaging and least visible |
| 61 | Name validator allowed only `\p{L}`, rejecting Tamil combining marks | A name field that **refuses Tamil names**. Same silent-failure class as slice 43 |
| 63 | `CompetitorBand` test fixture invented a `categoryId` field the interface lacks | All 37 tests passed while the module did not compile — the typecheck gate catching its second real defect |
| 65 | Redirect chain check walked predecessors only one level back | Accepted `/c → /d` when `/a → /b → /c` existed, producing the 3-hop chain the limit exists to forbid. A forward-only check looks correct on every example you try first |
| 71 | Complaint rates were **rounded before** being compared to the threshold | A true rate of 0.0010049 rounds to 0.001, which is not `> 0.001` — so a channel that had genuinely breached would not have paused |
| Audit | `.env.example` absent | Required by the brief; the repo reads real env vars |
| Audit | Two test fixtures held literal `sk-ant-…` strings with no gitleaks allowlist present | Fixtures now assembled at runtime. **The scanner was not weakened** — an allowlist on that path could later hide a real key |

Corrections made to this project's own claims:

- **FR-AI-006** was recorded as `(name not captured from SRS)` rather than invented, then recovered
  from the suite as **Demand Forecasting Service** and the catalogue corrected. Looking it up also
  revealed it was the *platform* engine, distinct from FR-VEN-012's vendor view — without checking,
  a second vendor forecaster would have been built and the requirement called done.
- **"Spring Boot shells"** (plural) in earlier commit messages overstated reality: there is exactly
  one Spring class, in one service. Corrected in the README and `docs/LIMITATIONS.md`.
- A traceability generator replaced a hand-carried test total, correcting **353 → 337** at the time
  and revealing real coverage was 41% when 22 completed slices might have implied more.

## Slice history

- **Slice 0 — foundation**
  `328b735` · 2026-07-27
- **Slice 1 — identity**
  `261dab5` · 2026-07-27
- **Slice 2 — catalogue & approvals**
  `85fcf0b` · 2026-07-27
- **Slice 3 - checkout quote engine + AI provider ports**
  `dea0b67` · 2026-07-27
- **Slice 3.1 - Claude-on-AWS LLM adapter + credential resolver**
  `62282aa` · 2026-07-27
- **Slice 4 - payments domain (gateway-agnostic, idempotent, ledger-proven)**
  `9e54f10` · 2026-07-29
- **Slice 5 - order service (split assembly + UML-STM-01) & V004 state CHECK**
  `6108048` · 2026-07-30
- **Slice 6 - finance settlement engine (FR-FIN-004, T+2 payouts)**
  `d822881` · 2026-07-30
- **Slice 7 - returns & refund orchestration (FR-CUS-017/018, BRU-06/07)**
  `c87daa3` · 2026-07-30
- **Slice 8 - fee & tax engines (FR-FIN-001 commission, FR-FIN-002 GST)**
  `28f56cc` · 2026-08-04
- **Slice 9 - end-to-end composition proof (aggregates interoperate)**
  `d2d5176` · 2026-08-04
- **Slice 10 - contracts (event schemas + OpenAPI for the money spine)**
  `cc55b7d` · 2026-08-04
- **Slice 11 - notification service (FR-CUS-022 policy + FR-CUS-016 timeline)**
  `6a8b577` · 2026-08-04
- **Slice 12 - inventory reservation (FR-VEN-004, no-oversell)**
  `248eaac` · 2026-08-04
- **Slice 13 - shopping cart (FR-CUS-007, feeds the quote engine)**
  `b45ebe1` · 2026-08-04
- **Slice 14 - audit hash-chain (FR-ADM-013, tamper-evident)**
  `dd0e861` · 2026-08-04
- **Slice 15 - logistics tracking normalisation (FR-LOG-004)**
  `7506b45` · 2026-08-04
- **Slice 16 - wallet & loyalty ledger (FR-CUS-019/020)**
  `22a3121` · 2026-08-04
- **Slice 17 - address book & serviceability (FR-CUS-005, FR-LOG-001)**
  `42c9086` · 2026-08-04
- **Slice 18 - vendor registration & KYC (FR-VEN-001, BRU-01 gate)**
  `31206a2` · 2026-08-05
- **Slice 19 - discovery: query understanding + hybrid rank fusion (FR-CUS-009/010)**
  `8d6bd07` · 2026-08-05
- **Slice 20 - recommendation serving (FR-AI-003 + FR-CUS-013 rules)**
  `e7d6f7e` · 2026-08-05
- **Slice 21 - risk & fraud decisioning (FR-AI-010)**
  `982ab3a` · 2026-08-05
- **Slice 22 - verification harness & CI pipeline (Vol.11 §11.4)**
  `79dbcab` · 2026-08-05
- **Slice 23 - generated requirements traceability (code -> FR matrix)**
  `b764546` · 2026-08-05
- **Slice 24 - catalogue governance (FR-ADM-005, FR-ADM-006)**
  `f91c6a0` · 2026-08-05
- **Slice 25 - vendor lifecycle & user administration (FR-ADM-003, FR-ADM-002)**
  `0131759` · 2026-08-05
- **Slice 26 - CMS pages, banners & content blocks (FR-ADM-007)**
  `d599f9b` · 2026-08-05
- **Slice 27 - platform administration (FR-ADM-014, FR-ADM-017)**
  `8331869` · 2026-08-05
- **Slice 28 - API & integration management (FR-ADM-016)**
  `c83bf6a` · 2026-08-05
- **Slice 29 - platform promotions console (FR-ADM-008)**
  `3aae5e1` · 2026-08-05
- **Slice 30 - operational reports (FR-ADM-009) + traceability made self-contained**
  `a3f21d3` · 2026-08-18
- **Slice 31 - invoicing & credit notes (FR-FIN-003)**
  `8388381` · 2026-08-31
- **Slice 32 - product reviews & ratings aggregation (FR-CUS-023, FR-CUS-024)**
  `23720bb` · 2026-09-03
- **Slice 33 - login, session management & MFA (FR-CUS-002, FR-CUS-003)**
  `3a25230` · 2026-09-03
- **Slice 34 - pickup management, manifest & handover (FR-LOG-002, FR-LOG-003)**
  `bd33823` · 2026-09-03
- **Slice 35 - vendor revenue & fee transparency (FR-VEN-010)**
  `14c9088` · 2026-09-03
- **Slice 36 - referral programme & operations (FR-CUS-025, FR-MKT-007)**
  `4bd94ef` · 2026-09-03
- **Slice 37 - refund operations console (FR-FIN-006)**
  `62f589f` · 2026-09-03
- **Slice 38 - statutory deductions & filings support (FR-FIN-007)**
  `3714337` · 2026-09-03
- **Slice 39 - financial reports & period close (FR-FIN-008)**
  `6d06791` · 2026-09-03
- **Slice 40 - dynamic pricing engine (FR-AI-008)**
  `3f56855` · 2026-09-03
- **Slice 41 - conversational commerce actions (FR-AI-002)**
  `cb1bfc4` · 2026-09-03
- **Slice 42 - inventory optimisation (FR-AI-007)**
  `655f66a` · 2026-09-04
- **Slice 43 - AI review summarisation (FR-AI-014)**
  `209ae00` · 2026-09-04
- **Slice 44 - AI content generation, listing & marketing copilot (FR-AI-013)**
  `9f274a4` · 2026-09-07
- **Slice 45 - sentiment analysis & review intelligence (FR-AI-009)**
  `d19128a` · 2026-09-07
- **Slice 46 - store creation & settings (FR-VEN-002)**
  `b863859` · 2026-09-07
- **Slice 47 - admin overview dashboard (FR-ADM-001)**
  `c3537d2` · 2026-09-07
- **Slice 48 - customer segmentation service (FR-AI-012)**
  `517cd73` · 2026-09-07
- **Slice 49 - email marketing channel (FR-MKT-003)**
  `f299819` · 2026-09-07
- **Slice 50 - wishlist (FR-CUS-006)**
  `37987e9` · 2026-09-07
- **Slice 51 - warehouse operations, operator fulfilment (FR-LOG-006)**
  `c0154c0` · 2026-09-07
- **Slice 52 - vendor analytics (FR-VEN-009)**
  `6abf8e4` · 2026-09-07
- **Slice 53 - push notification channel (FR-MKT-005)**
  `8c94612` · 2026-09-08
- **Slice 54 - customer support & help centre (FR-CUS-026)**
  `4c61d93` · 2026-09-08
- **Slice 55 - affiliate programme (FR-MKT-006) + latent marketing-svc defects fixed**
  `df149e1` · 2026-09-08
- **Slice 56 - typecheck gate across every TypeScript module**
  `d607fa6` · 2026-09-08
- **Slice 57 - AI demand forecasting, vendor (FR-VEN-012)**
  `16d4914` · 2026-09-08
- **Slice 58 - Demand Forecasting Service (FR-AI-006) + recovered its name in the catalogue**
  `76d017b` · 2026-09-08
- **Slice 59 - semantic & multimodal indexing pipeline (FR-AI-004)**
  `acc11e6` · 2026-09-08
- **Slice 60 - image search (FR-CUS-012)**
  `c661e84` · 2026-09-08
- **Slice 61 - profile management (FR-CUS-004)**
  `e89a0b2` · 2026-09-08
- **Slice 62 - churn prediction & win-back targeting (FR-AI-011)**
  `65df010` · 2026-09-08
- **Slice 63 - AI pricing assistant, vendor (FR-VEN-013)**
  `fde5480` · 2026-09-08
- **Slice 64 - shipping execution, vendor-side (FR-VEN-008)**
  `66a00f9` · 2026-09-08
- **Slice 65 - SEO management (FR-MKT-008)**
  `3af2df4` · 2026-09-08
- **Slice 66 - vendor dashboard, home (FR-VEN-014)**
  `7738103` · 2026-09-08
- **Slice 67 - rewards & gamification (FR-CUS-021)**
  `1c0ebd6` · 2026-09-08
- **Slice 68 - delivery partner portal (FR-LOG-007)**
  `da118c1` · 2026-09-08
- **Slice 69 - AI marketing automation (FR-MKT-009)**
  `be94503` · 2026-09-08
- **Slice 70 - analytics & BI workspace (FR-ADM-010)**
  `6196a95` · 2026-09-09
- **Slice 71 - operator notification centre (FR-ADM-015) + threshold de-duplication**
  `6e4098e` · 2026-09-09
