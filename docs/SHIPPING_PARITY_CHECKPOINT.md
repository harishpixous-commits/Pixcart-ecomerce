# Courier booking checkpoint

Reference: `backend/app/services/shipping.py` and `backend/app/routers/seller_extras.py` on unchanged `origin/main`.

`POST /api/seller/orders/{subId}/book-courier` requires an approved seller, owns and locks the packed package, respects the fleet route gate, and uses effective integration settings. ShippingBAL owns the request sequence; ShippingDAL holds transaction-scoped SQL. Successful bookings save provider identifiers and label, transition through existing order rules (including invoice and events), audit, and commit together.

Provider sequence: shared token cache (nine days, refresh within six hours), pickup registration if absent, create order, assign AWB, request pickup, get label. COD uses the existing collection amount rule for first-package fees/tip, marketplace discounts and item/weight inputs. A non-open provider mode permits only a literal loopback IP base. Redirect following is disabled. Tests inject a transport and use a loopback base, not a real provider.

## Evidence

The shipping HTTP test uses real synthetic MySQL data and an in-memory provider transport. It exercises owner/status/fleet/manual guards, blocking an external base, failed/malformed/tokenless login, AWB failure rollback, successful COD payloads and shipment/invoice/audit storage, token and pickup reuse, refresh within six hours, prepaid payloads, and audit failure after all six provider requests with local rollback. The audit rollback test deliberately demonstrates the inherited recovery gap described below. Test count alone does not establish parity.

## Retained risks and open verification

- Remote requests precede local commit, as in the reference. An AWB or audit failure can leave a provider-side pickup or order even though local token, pickup and shipment changes roll back. Retrying can create another remote order. No compensating cancel or new idempotency policy has been invented.
- No real Shiprocket credentials, production traffic, paid shipments or provider account changes were used. Vendor acceptance is not verified.
- Automatic refresh after a rejected but unexpired token is not part of the reference and is not added. Provider timeouts/cancellation, redirects, invalid nested response types, simultaneous token refresh across packages, extreme weights and Unicode length slicing do not have complete differential coverage.
- The reference's missing provider identifiers can flow through to later calls. This remains source behavior rather than a newly imposed validation rule.
- Route registration is presence evidence only. Backend contract-by-contract differential tests, all frontend/mobile screens and themes, live e2e, IIS, migration and flow videos remain separate incomplete work.
