# risk-svc
FR-AI-010 fraud detection & risk scoring. Producer of `risk.decision.v1` and of the
`fraudScore` that the FR-CUS-014 quote engine and the FR-LOG-001 COD gate consume — until
this slice, that arrived as a pre-computed input.

Per-flow velocity/heuristic rules (PAYMENT, COD_ORDER, PROMO_REDEMPTION, REFERRAL, RETURN,
VENDOR_BEHAVIOUR) produce interpretable reason codes; the ML model is INJECTED, so it can be
swapped or shadowed and every test here runs without one. Actions: allow / step-up /
hold-review / deny, with per-flow thresholds.

## Two structural safety invariants (not advisory)
1. **No black-box denial.** A denial requires the score to clear the threshold AND at least
   one interpretable rule hit. Proven in two layers: the model weight alone caps a
   rules-free score at 0.4 (below any deny threshold), and even under deliberately
   mis-configured permissive thresholds the invariant refuses the deny and escalates to
   human review.
2. **Monetary-cap escalation.** Above the per-flow amount cap an automatic decision may not
   deny; it becomes a human hold. Proven by showing the identical case denies at the cap and
   escalates one paisa above it.

A failing or out-of-range model degrades to rules-only and never fabricates a score.
18/18 vitest, including a cross-slice proof that a COD-abusing customer's score drives the
quote engine to refuse COD and force prepaid.
