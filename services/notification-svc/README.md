# notification-svc
FR-CUS-022 notifications + FR-CUS-016/FR-LOG-004 order timeline. Provider-agnostic:
dispatch is a port (SMS/email/WhatsApp/push adapters attach at the edge, like the AI
orchestrator ports). Pure domain, TypeScript.

- policy.ts — the decision gate: transactional (order/payment/security/shipping/refund)
  cannot be opted out (only channel choice); promotional requires active consent (BRU-12)
  and respects quiet hours 22:00–08:00 local; SMS to India requires a DLT template id
  (FR-MKT-004); legal STOP wins. Template-variable completeness check (VALIDATION).
- timeline.ts — pure fold of the contracts/events (Slice 10) into a per-sub-order status
  timeline; idempotent by (eventType, eventId) so replays are no-ops.

Tests (19/19 vitest) include a cross-slice proof that the events the projector consumes
validate against the Slice-10 JSON Schemas — read model and contracts cannot drift.
