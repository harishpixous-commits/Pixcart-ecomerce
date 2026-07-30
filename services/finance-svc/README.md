# finance-svc
Spring Boot 3.5 / Java 21 per C4-L2. Framework-free domain (SettlementEngine) compiled +
JUnit-tested in-sandbox; batch reconciliation proven against the live ledger (net vendor
payable accrues to the batch total and clears to zero after payout). Governing: FR-FIN-004
(settlement & payouts), BRU-09 (T+2 hold), FR-VEN-011 (payout failure -> hold). PayoutGateway
is the boundary for the gateway payout API. Fee/tax accrual (FR-FIN-001/002) and recon
(FR-FIN-005) are later slices.
