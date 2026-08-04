# integration/e2e — end-to-end composition proof

This module proves the domain aggregates **interoperate**, not just that each works alone.

## What it does

`EndToEndJourneyTest` drives the real objects from four services through one customer
journey:

- **Payment** (payment-svc, Slice 4) — authorise + idempotent capture
- **Order** + **SubOrderLifecycle** (order-svc, Slice 5) — split assembly + fulfilment states
- **ReturnSaga** (order-svc, Slice 7) — admission + QC-driven refund
- **SettlementEngine** (finance-svc, Slice 6) — T+2 payout batch

Three scenarios: the happy path (pay → order split → both delivered → settle → payout),
the return branch (delivered → returned → QC-pass → the saga's refund executed by the
real Payment aggregate), and a negative (a failed capture yields no order).

A companion live-MariaDB ledger walk (in the slice's commit) posts the same journey's
capture, payout and refund journals and shows every journal balances and the net of all
accounts closes to 0.00.

## Boundary note (important)

This is a **test-only** harness. In production the microservice boundaries of C4-L2
stand: **no service imports another**. At runtime these services communicate via the
events in `contracts/events` and their HTTP APIs. Compiling their `domain` sources onto a
single test classpath here demonstrates only that the contracts line up — the quote
enters as a value object exactly as it would arrive over the wire from the (TypeScript)
cart-checkout service.

## Run

```
javac --release 21 -cp <junit-console> -d out \
  $(find ../../services/payment-svc/src/main \
         ../../services/order-svc/src/main \
         ../../services/finance-svc/src/main/java/com/pixous/pixcart/finance/domain \
         src/test -name '*.java')
java -jar <junit-console> --class-path out --scan-class-path
```
