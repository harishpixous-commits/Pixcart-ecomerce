"""Online payments, from the admin side: "Check payment with Razorpay" on an order whose confirmation never arrived,
and the integrations page showing when the Razorpay webhook last reached the site."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

from tests.conftest import add_address, login_phone
from tests.test_orders import marketplace


async def online_order(client, admin, categories, phone: str):
    _, _, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 201, r.text
    return buyer, r.json()["order"], r.json()["payment"]


async def test_admin_finds_a_payment_the_shopper_never_confirmed(client, admin, categories, gateway):
    buyer, order, pay = await online_order(client, admin, categories, "9760000001")
    # nobody paid yet: Razorpay has no successful attempt
    r = await admin.post(f"/api/admin/orders/{order['id']}/check-payment")
    assert r.status_code == 200 and r.json()["result"] == "not_paid", r.text
    assert (await buyer.get(f"/api/orders/{order['id']}")).json()["status"] == "pending_payment"

    # the shopper pays, but the browser closes before our confirmation and no webhook comes
    gateway.auto_capture = False
    gateway.pay(pay["razorpay_order_id"])
    r = await admin.post(f"/api/admin/orders/{order['id']}/check-payment")
    assert r.status_code == 200, r.text
    assert r.json()["payment"]["status"] == "captured"  # authorised payments are captured, then recorded
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["status"] == "placed" and mine["payment_status"] == "paid"
    # checking again changes nothing
    assert (await admin.post(f"/api/admin/orders/{order['id']}/check-payment")).json()["result"] == "already_paid"
    # recorded in the audit log
    audit = (await admin.get("/api/admin/audit")).json()["items"]
    assert any(a["action"] == "payment.check" for a in audit)


async def test_cash_orders_and_permissions(client, admin, categories, gateway):
    buyer, order, _ = await online_order(client, admin, categories, "9760000002")
    assert (await buyer.post(f"/api/admin/orders/{order['id']}/check-payment")).status_code == 403
    r = await admin.post(f"/api/admin/orders/{uuid.uuid4()}/check-payment")
    assert r.status_code == 400 and r.json()["error"]["code"] == "no_online_payment"


async def test_integrations_show_the_last_webhook(client, admin, categories, gateway):
    def razorpay_item():
        return next(p for p in items if p["key"] == "razorpay")

    items = (await admin.get("/api/admin/integrations")).json()
    items = items["items"]
    assert razorpay_item()["last_webhook"] is None
    assert razorpay_item()["webhook_url"].endswith("/api/payments/razorpay/webhook")

    _, order, pay = await online_order(client, admin, categories, "9760000003")
    pid, _ = gateway.pay(pay["razorpay_order_id"])
    body = json.dumps({"event": "payment.failed", "payload": {"payment": {"entity": {"id": pid, "order_id": pay["razorpay_order_id"],
                                                                                   "status": "failed", "error_description": "Card declined"}}}}).encode()
    sig = hmac.new(b"whsec_test", body, hashlib.sha256).hexdigest()
    r = await client.post("/api/payments/razorpay/webhook", content=body, headers={"x-razorpay-signature": sig, "x-razorpay-event-id": "evt_1"})
    assert r.status_code == 200, r.text
    items = (await admin.get("/api/admin/integrations")).json()
    items = items["items"]
    last = razorpay_item()["last_webhook"]
    assert last and last["count"] == 1 and last["at"]


# ----------------------------------------------------------------------------- phones and the app: back from a UPI app


async def test_return_from_upi_app_success(client, admin, categories, gateway):
    """Razorpay posts to the callback URL after Google Pay/PhonePe; the shopper lands on the order, which is paid."""
    buyer, order, pay = await online_order(client, admin, categories, "9760000011")
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid,
                                                                   "razorpay_signature": sig})
    assert r.status_code == 303, r.text
    assert r.headers["location"] == f"/orders/{order['id']}?payment=success"
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["status"] == "placed" and mine["payment_status"] == "paid"
    assert mine["paid"]["reference"] == pid and mine["paid"]["method"] == "upi"
    # coming back twice (refresh, back button) changes nothing
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid,
                                                                   "razorpay_signature": sig})
    assert r.headers["location"].endswith("payment=success")


async def test_return_with_a_forged_signature_trusts_only_razorpay(client, admin, categories, gateway):
    buyer, order, pay = await online_order(client, admin, categories, "9760000012")
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": "pay_fake",
                                                                   "razorpay_signature": "0" * 64})
    assert r.status_code == 303 and "payment=failed" in r.headers["location"]
    assert (await buyer.get(f"/api/orders/{order['id']}")).json()["status"] == "pending_payment"


async def test_return_after_a_failed_payment_and_retry(client, admin, categories, gateway):
    buyer, order, pay = await online_order(client, admin, categories, "9760000013")
    pid, _ = gateway.pay(pay["razorpay_order_id"])
    gateway.payments[pid].update(status="failed", error_description="Payment declined by the bank", created_at=1)
    r = await client.post("/api/payments/razorpay/callback", data={
        "error[code]": "BAD_REQUEST_ERROR", "error[description]": "Payment declined by the bank", "error[source]": "customer",
        "error[metadata]": json.dumps({"payment_id": pid, "order_id": pay["razorpay_order_id"]})})
    assert r.status_code == 303
    loc = r.headers["location"]
    assert loc.startswith(f"/orders/{order['id']}?payment=failed") and "declined" in loc
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "failed" and "declined" in s["reason"] and s["order"]["status"] == "pending_payment"
    # Try again: the second attempt (same Razorpay order) succeeds
    pid2, sig2 = gateway.pay(pay["razorpay_order_id"])
    gateway.payments[pid2]["created_at"] = 2
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid2,
                                                                   "razorpay_signature": sig2})
    assert r.headers["location"].endswith("payment=success")
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "paid" and s["order"]["paid"]["reference"] == pid2


async def test_order_page_check_finds_a_payment_without_any_return(client, admin, categories, gateway):
    """The phone closed the browser while in the UPI app: no return, no webhook. Opening the order asks Razorpay."""
    buyer, order, pay = await online_order(client, admin, categories, "9760000014")
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "not_paid" and s["reason"] == ""
    # UPI request sent, not yet approved in the app
    gateway.payments["pay_open"] = {"id": "pay_open", "order_id": pay["razorpay_order_id"], "amount": pay["amount"], "status": "created", "method": "upi"}
    assert (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()["status"] == "waiting"
    gateway.payments["pay_open"]["status"] = "captured"
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "paid" and s["order"]["status"] == "placed"
    # other shoppers cannot ask about it
    other = await login_phone(client, "9760000015")
    assert (await other.post(f"/api/orders/{order['id']}/payment-status")).status_code == 404


async def test_return_when_razorpay_is_unreachable(client, admin, categories, gateway):
    buyer, order, pay = await online_order(client, admin, categories, "9760000016")
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    gateway.fail_next = "timeout"
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid,
                                                                   "razorpay_signature": sig})
    assert r.headers["location"] == f"/orders/{order['id']}?payment=checking"
    # the order page's next check records it
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "paid"


async def test_return_for_an_unknown_order(client, gateway):
    r = await client.post("/api/payments/razorpay/callback", data={"razorpay_order_id": "order_nope", "razorpay_payment_id": "pay_x", "razorpay_signature": "x"})
    assert r.status_code == 303 and r.headers["location"] == "/orders?payment=unknown"
    r = await client.get("/api/payments/razorpay/callback")
    assert r.status_code == 303


async def test_status_check_keeps_what_the_payment_window_needs(client, admin, categories, gateway):
    buyer, order, pay = await online_order(client, admin, categories, "9760000017")
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["order"]["payment"]["razorpay_order_id"] == pay["razorpay_order_id"]
    gateway.pay(pay["razorpay_order_id"])
    s = (await buyer.post(f"/api/orders/{order['id']}/payment-status")).json()
    assert s["status"] == "paid" and s["order"]["payment"] is None
