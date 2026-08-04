# logistics-svc
FR-LOG-004 tracking normalisation (TypeScript). Pure domain: per-carrier raw→canonical
status maps (Delhivery/Bluedart/DTDC/India Post) to the SubOrderLifecycle shipment subset;
webhook+polling dedup; POD required for delivered orders > ₹2,000; EDD recompute on NDR
(capped at 3) / cleared on delivery; 48 h stale-feed detection; unknown status HELD (ops
task) not dropped. Emits contracts/events shipment.status.v1. 14/14 vitest incl. cross-slice
schema + timeline proofs.
