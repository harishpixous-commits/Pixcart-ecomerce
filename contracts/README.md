# contracts — service boundary specifications

Formalises the boundaries the Slice-9 end-to-end harness exercises. These are the
connective tissue for wiring the tested domain libraries into running services.

## events/ (Vol.5 §5.5 EDA Contract)
JSON Schema (draft 2020-12) for the money-spine domain events, each with producer/
consumers and semantics from the doc:
- envelope.v1 — common envelope; consumers dedup by (topic, eventId); outbox-written.
- payment.captured.v1, payment.refunded.v1 — Producer Payment.
- order.confirmed.v1 — Producer Order.
- shipment.status.v1 — Producer Logistics (delivery-confirm feeds Finance).
- rma.qc.completed.v1 — Producer Logistics/WH (drives refund).
- settlement.batch.executed.v1 — Producer Finance (lines→UTR).

## openapi/ (Vol.7 conventions)
money-spine.v1.yaml — OpenAPI 3.1 for checkout → payment → order (Bearer JWT,
Idempotency-Key UUID/48h, integer paise).

## Live, not paper
`test/contracts.spec.ts` proves: every schema compiles under Ajv; a payload shaped exactly
as the corresponding domain object emits it validates, and a wrong one is rejected; every
event validates against the envelope; the OpenAPI doc resolves; and the event sub-order
states are a subset of the OpenAPI Order state enum (which mirrors SubOrderLifecycle).
Run: `npm test`. 9/9.
