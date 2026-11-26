# Payment gateways: several providers with automatic failover

PixCart takes online payments through any of several payment gateways. The admin switches gateways on, enters their
keys and puts them in order. New payments go to the first healthy gateway; when a gateway is down, slow or failing,
the next one takes over automatically, and a shopper whose payment did not go through can pay again through another
gateway from the order page. Refunds, payment checks and webhooks always go to the gateway that took the payment.

This document is the contract: the API, the website, the apps and the tests follow it exactly.

## 1. Gateways

| Code | Name | Charge currencies | Client mode | Notes |
|---|---|---|---|---|
| `razorpay` | Razorpay | INR; others when the admin charges in the shopper's currency | `modal` (Razorpay Checkout) | saved cards (card-on-file tokens) |
| `cashfree` | Cashfree Payments | INR | `modal` (Cashfree JS SDK v3) | |
| `phonepe` | PhonePe Payment Gateway | INR | `redirect` | |
| `payu` | PayU | INR | `form` (POST to PayU) | |
| `stripe` | Stripe | INR and other currencies | `redirect` (Stripe Checkout) | cards from abroad |

Every gateway has a sandbox and a live mode, chosen by the keys the admin enters (section 7). Development and tests
never call a live provider: tests use HTTP fakes, and the local payment simulator answers for every gateway (and can
pretend a gateway is down, to show failover).

Adding a gateway means adding one adapter (section 6) and one entry in the integrations list; nothing else changes.

## 2. Data

`payments` (one row per payment attempt):
- `provider`: the gateway code (up to 12 characters).
- `provider_order_id`: the gateway's order, session or transaction reference (up to 100 characters, unique).
- `provider_payment_id`: the gateway's payment reference once paid (up to 100 characters, unique).
- `status`: `created`, `authorized`, `captured` or `failed`; `method` (upi, card, netbanking, wallet, ...), `error`,
  `amount_paise` (the order total), `currency` and `charge_amount` (what the gateway charges, as before).
- `client_data`: the mode fields of section 4 for this attempt (JSON; never a secret), so the order page can open the
  same payment again.

An order can have several payments: one per attempt (failover, "pay another way"). The order's first captured payment
is its payment; any other payment that is captured later is refunded in full to itself as a duplicate (reason
"Duplicate payment"). The order page shows the latest attempt.

`payment_gateway_events` (health; kept 7 days): `id`, `gateway`, `ok` (bool), `ms` (whole milliseconds),
`error` (up to 300 characters), `created_at`; index on (`gateway`, `created_at`). One row per call to a gateway that
creates a payment, checks it or refunds it.

Platform setting `payment_routing` (Admin → Payments → Routing), with these defaults:

```json
{"order": ["razorpay", "cashfree", "phonepe", "payu", "stripe"], "failover": true, "strategy": "priority",
 "timeout_seconds": 8, "circuit_failures": 3, "circuit_cooldown_seconds": 120, "window_minutes": 15, "min_samples": 5}
```

Limits: `timeout_seconds` 3-30, `circuit_failures` 1-20, `circuit_cooldown_seconds` 10-3600, `window_minutes` 5-1440,
`min_samples` 1-100, `strategy` `priority` or `success_rate`, `order` a list of known codes without repeats.

## 3. Routing and failover

**Eligible gateways** for a payment in currency `C`, in this order: the codes in `payment_routing.order`, then any
other enabled gateway in the table order of section 1. A gateway is eligible when:
1. it is enabled: its required keys are filled in and its switch is on;
2. it can charge `C`;
3. its circuit is not open: take its last `circuit_failures` events; the circuit is **open** when there are that many,
   all of them failed, and the newest is less than `circuit_cooldown_seconds` old. After the cool-down one attempt
   goes through (half-open); a success closes the circuit, a failure opens it again for another cool-down.

**Strategy** `priority` keeps that order. `success_rate` sorts the eligible gateways by their success rate over the
last `window_minutes` (ok events / all events), highest first; a gateway with fewer than `min_samples` events counts
as 1.0, so a new gateway gets traffic; ties keep the priority order (the sort is stable).

**Creating a payment** (placing an online order, or "pay another way"): try the eligible gateways in order. Each try
has `timeout_seconds`. A success records an ok event (with its time) and the payment row; a failure or time-out records
a failed event and, when `failover` is on, moves to the next gateway. When `failover` is off only the first eligible
gateway is tried. When every try fails: HTTP 502 `gateway_error` "Could not start the payment: <last gateway's
message>". When no gateway is eligible: HTTP 409 `payments_unavailable` "Online payments are not available right now.
Choose cash on delivery or try again in a few minutes."

The check-out page and the cart offer online payment only when at least one gateway is eligible for INR.

## 4. What the browser and the apps receive

The order page and the order placement answer carry `payment` (null when nothing is due):

```json
{"provider": "cashfree", "mode": "modal", "amount": 49900, "currency": "INR", "name": "<brand>",
 "description": "Order PC-...", "prefill": {"name": "...", "contact": "+91...", "email": "..."},
 "expires_at": "...", "alternatives": [{"provider": "payu", "label": "PayU"}], ...mode fields}
```

Mode fields:
- `razorpay` (`modal`): `key_id`, `checkout_url`, `razorpay_order_id` (as before).
- `cashfree` (`modal`): `sdk_url` (`https://sdk.cashfree.com/js/v3/cashfree.js`), `env` (`sandbox` | `production`),
  `payment_session_id`.
- `phonepe` and `stripe` (`redirect`): `url` (the gateway's payment page).
- `payu` (`form`): `action` (PayU's payment URL) and `fields` (the form fields, posted as they are).

`alternatives`: the other eligible gateways for this currency, in routing order, for "Pay another way".

After paying, the gateway sends the shopper back to `/api/payments/<code>/callback`, which checks the payment with
the gateway and redirects to the order page (`?payment=success|failed|pending|unknown`, as for Razorpay today).

## 5. Endpoints

- `POST /api/orders/{order_id}/payment/switch` (the order's customer; body `{"provider": "<code>"}` optional): only
  while the order waits for payment; creates a new payment with that gateway, or with the next eligible gateway after
  the one of the latest attempt; answers `{"payment": {...}}` as in section 4. 409 `not_pending` when nothing is due.
- `GET|POST /api/payments/{code}/callback`: the return from the gateway's payment page (no sign-in; nothing in the
  request is trusted; the payment is looked up by the gateway's reference and checked with the gateway).
- `POST /api/payments/{code}/webhook`: the gateway's server-to-server events, verified with the gateway's signature
  scheme (section 6); duplicates are ignored (webhook_events, as today). A verified event only triggers a check with
  the gateway; the event body itself is never trusted for amounts or states.
- The Razorpay paths stay as they are (`/api/payments/razorpay/callback`, `/api/payments/razorpay/webhook`).
- Admin (permission `settings`): `GET /api/admin/payments/gateways` (each gateway: code, name, enabled, mode
  sandbox|live, currencies, client mode, circuit `closed|open|half_open`, and over the last 24 hours: attempts, ok,
  success rate, average and 95th percentile time, last error and when); `PUT /api/admin/payments/routing` (the
  `payment_routing` setting, validated with the limits above; audit `payments.routing`);
  `POST /api/admin/payments/gateways/{code}/test` (one harmless authenticated call to the gateway; records an event;
  answers `{"ok": bool, "ms": int, "message": "..."}`).

Gateway keys are entered on Admin → Integrations like every other provider (section 7).

## 6. Gateway adapters

Each adapter offers the same operations; amounts are in the smallest unit (paise for INR) unless noted.
- `create(amount, currency, receipt, customer, return_url, notify_url)` → the gateway's reference and the mode fields.
- `attempts(reference)` → the payment attempts the gateway knows for that reference: id, status (`created`,
  `pending`, `authorized`, `captured`, `failed`), method, amount, error.
- `capture(attempt)` (only where the gateway needs a separate capture).
- `refund(payment_id or reference, amount, refund_id, note)` → the gateway's refund reference and status.
- `verify_webhook(headers, body)` → the reference the event is about, or nothing when the signature is wrong.
- `reference_from_return(query and form)` → the reference the shopper came back with.

**Razorpay**: unchanged (Orders, Payments, Refunds APIs with key id/secret; `X-Razorpay-Signature` HMAC-SHA256 of the
body with the webhook secret; checkout handler signature HMAC-SHA256 of `order_id|payment_id` with the key secret).

**Cashfree** (PG API version `2023-08-01`; base `https://sandbox.cashfree.com/pg` or `https://api.cashfree.com/pg`;
headers `x-client-id`, `x-client-secret`, `x-api-version`): create `POST /orders` with `order_id` (the receipt),
`order_amount` (rupees, 2 decimals), `order_currency`, `customer_details`, `order_meta.return_url` and `notify_url` →
`payment_session_id`; attempts `GET /orders/{order_id}/payments` (`payment_status` SUCCESS → captured, PENDING →
pending, FAILED/USER_DROPPED/CANCELLED → failed; `payment_group` → method); refund `POST /orders/{order_id}/refunds`
(`refund_amount` rupees, `refund_id`, `refund_note`); webhook: `x-webhook-signature` = base64(HMAC-SHA256(timestamp +
raw body, client secret)) with `x-webhook-timestamp`. Sandbox when the client id starts with `TEST`.

**PhonePe** (standard checkout v2; OAuth client credentials: client id, client secret, client version; sandbox base
`https://api-preprod.phonepe.com/apis/pg-sandbox`, live `https://api.phonepe.com/apis/pg` with the token from
`https://api.phonepe.com/apis/identity-manager/v1/oauth/token`): token `POST /v1/oauth/token` (form) → `access_token`
used as `Authorization: O-Bearer <token>` until it expires; create `POST /checkout/v2/pay` with `merchantOrderId`,
`amount` (paise), `paymentFlow` `{type: PG_CHECKOUT, merchantUrls: {redirectUrl}}` → `redirectUrl`; attempts
`GET /checkout/v2/order/{merchantOrderId}/status` (`state` COMPLETED → captured, PENDING → pending, FAILED → failed;
`paymentDetails[].transactionId`, `paymentMode`); refund `POST /payments/v2/refund` (`merchantRefundId`,
`originalMerchantOrderId`, `amount`); webhook: the `Authorization` header equals SHA-256 hex of
`username:password` set on the PhonePe dashboard. Sandbox or live is a setting.

**PayU** (hosted checkout; key and salt; `https://test.payu.in` or `https://secure.payu.in`): create builds the form:
`key`, `txnid` (the receipt), `amount` (rupees, 2 decimals), `productinfo`, `firstname`, `email`, `phone`, `surl`,
`furl` (both the callback), `hash` = SHA-512 hex of `key|txnid|amount|productinfo|firstname|email|||||||||||salt`;
`action` = `<base>/_payment`; attempts: `POST <info base>/merchant/postservice.php?form=2` with `key`,
`command=verify_payment`, `var1=txnid`, `hash` = SHA-512 of `key|command|var1|salt` (`status` success → captured,
pending → pending, failure → failed; `mihpayid` → payment id, `mode` → method); refund `command=cancel_refund_transaction`
(`var1` mihpayid, `var2` refund id, `var3` amount in rupees); webhook and return: the posted `hash` must equal SHA-512 of
`salt|status|||||||||||email|firstname|productinfo|amount|txnid|key`. Sandbox when the base is the test one.

**Stripe** (secret key; `https://api.stripe.com/v1`, form-encoded, `Authorization: Bearer`): create
`POST /checkout/sessions` (`mode=payment`, one line item with `price_data[currency]`, `price_data[unit_amount]`,
`price_data[product_data][name]`, `success_url` and `cancel_url` = the callback with `session_id={CHECKOUT_SESSION_ID}`,
`client_reference_id` = receipt, `metadata[order_number]`) → `url`, reference = session id; attempts
`GET /checkout/sessions/{id}?expand[]=payment_intent` (`payment_status` paid → captured; `status` expired → failed;
otherwise pending; payment id = the payment intent id); refund `POST /refunds` (`payment_intent`, `amount`); webhook:
`Stripe-Signature` `t=...,v1=...`, v1 = HMAC-SHA256 hex of `t + "." + raw body` with the webhook secret, at most 5
minutes old. Sandbox when the key starts with `sk_test_`.

## 7. Admin

**Admin → Integrations**: one entry per gateway (group Payments) with its keys, test button, setup steps and the
webhook URL to paste in the gateway's dashboard (`/api/payments/<code>/webhook`):
- Razorpay: key id, key secret, webhook secret (as today).
- Cashfree: client id, client secret.
- PhonePe: client id, client secret, client version, webhook username, webhook password, sandbox or live.
- PayU: merchant key, merchant salt, sandbox or live.
- Stripe: secret key, webhook signing secret.

**Admin → Payments**: the gateways in routing order (drag to reorder), each with its switch, mode, health for the last
24 hours (success rate, attempts, average and p95 time, circuit state, last error) and a Test button; and the routing
settings (failover on or off, strategy, time-out, circuit thresholds, window). Saving writes the audit log.

## 8. Tests (both versions)

- Routing: priority order; disabled and currency-unsupported gateways skipped; circuit open after N failures, half-open
  after the cool-down, closed after a success; success-rate strategy with the optimistic default; failover on and off.
- Placement: the first gateway fails (time-out or error) and the second creates the payment; every gateway fails →
  502; none eligible → 409; the events are recorded.
- Each adapter against an HTTP fake: create (request shape, mode fields), attempts mapping, refund, webhook signature
  (good and bad), return reference.
- Pay another way: a new payment with the next gateway; a second capture on another payment is refunded as a duplicate.
- Refunds, payment checks and the unpaid-order expiry go to the payment's own gateway.
