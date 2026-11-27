import base64
import hashlib
import hmac
import json
import time

import httpx
import pytest

from app.services import gateways as g

CUST = {"id": "u1", "name": "Asha Rao", "contact": "+919800000000", "email": "a@x.in"}


def fake(handler):
    g.transport = httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def _reset():
    yield
    g.transport = None


async def test_cashfree():
    seen = {}

    def h(req):
        seen[req.url.path] = req
        if req.url.path.endswith("/orders") and req.method == "POST":
            return httpx.Response(200, json={"order_id": "PC-1", "payment_session_id": "sess_1"})
        if req.url.path.endswith("/payments"):
            return httpx.Response(200, json=[{"cf_payment_id": 7, "payment_status": "SUCCESS", "payment_group": "upi", "payment_amount": 499.0}])
        return httpx.Response(200, json={"cf_refund_id": "r1", "refund_status": "SUCCESS"})
    fake(h)
    a = g.Cashfree({"client_id": "TEST123", "client_secret": "sec"})
    out = await a.create(49900, "INR", "PC-1", CUST, "https://s/cb", "https://s/hook")
    assert out["mode"] == "modal" and out["fields"]["env"] == "sandbox" and out["fields"]["payment_session_id"] == "sess_1"
    req = seen["/pg/orders"]
    assert req.headers["x-api-version"] == "2023-08-01" and json.loads(req.content)["order_amount"] == 499.0
    at = await a.attempts("PC-1")
    assert at[0]["status"] == "captured" and at[0]["amount"] == 49900 and at[0]["method"] == "upi"
    assert (await a.refund("PC-1", "7", 1000, "rf1", "x"))["status"] == "processed"
    body = json.dumps({"data": {"order": {"order_id": "PC-1"}}}).encode()
    sig = base64.b64encode(hmac.new(b"sec", b"123" + body, hashlib.sha256).digest()).decode()
    assert a.verify_webhook({"x-webhook-timestamp": "123", "x-webhook-signature": sig}, body) == "PC-1"
    assert a.verify_webhook({"x-webhook-timestamp": "123", "x-webhook-signature": "bad"}, body) is None
    assert a.reference_from_return({"order_id": "PC-1"}) == "PC-1"


async def test_cashfree_error_is_gateway_error():
    fake(lambda r: httpx.Response(400, json={"message": "bad order"}))
    with pytest.raises(g.GatewayError, match="bad order"):
        await g.Cashfree({"client_id": "TESTx", "client_secret": "s"}).create(100, "INR", "A", CUST, "u", "n")


async def test_phonepe():
    calls = []

    def h(req):
        calls.append((req.method, req.url.path, req.headers.get("authorization")))
        if "oauth" in req.url.path:
            return httpx.Response(200, json={"access_token": "tok", "expires_at": time.time() + 600})
        if req.url.path.endswith("/pay"):
            assert json.loads(req.content)["amount"] == 49900
            return httpx.Response(200, json={"redirectUrl": "https://pp/pay"})
        if req.url.path.endswith("/refund"):
            return httpx.Response(200, json={"refundId": "R", "state": "PENDING"})
        return httpx.Response(200, json={"state": "COMPLETED", "amount": 49900, "paymentDetails": [{"transactionId": "T1", "paymentMode": "UPI"}]})
    fake(h)
    a = g.PhonePe({"client_id": "c", "client_secret": "s", "webhook_username": "u", "webhook_password": "p"})
    assert (await a.create(49900, "INR", "PC-2", CUST, "https://s/cb", ""))["fields"]["url"] == "https://pp/pay"
    at = await a.attempts("PC-2")
    assert at[0]["status"] == "captured" and at[0]["id"] == "T1"
    assert (await a.refund("PC-2", "T1", 100, "rf", ""))["status"] == "pending"
    assert sum(1 for c in calls if "oauth" in c[1]) == 1 and all(c[2] == "O-Bearer tok" for c in calls if "oauth" not in c[1])
    auth = hashlib.sha256(b"u:p").hexdigest()
    body = json.dumps({"payload": {"merchantOrderId": "PC-2"}}).encode()
    assert a.verify_webhook({"Authorization": auth}, body) == "PC-2"
    assert a.verify_webhook({"Authorization": "nope"}, body) is None


async def test_payu():
    a = g.PayU({"key": "K", "salt": "S"})
    out = await a.create(49900, "INR", "PC-3", CUST, "https://s/cb", "")
    f = out["fields"]["fields"]
    assert out["mode"] == "form" and out["fields"]["action"] == "https://test.payu.in/_payment" and f["amount"] == "499.00"
    want = hashlib.sha512(("K|PC-3|499.00|Order PC-3|Asha|a@x.in" + "|" * 11 + "S").encode()).hexdigest()
    assert f["hash"] == want
    post = {"status": "success", "email": "a@x.in", "firstname": "Asha", "productinfo": "Order PC-3", "amount": "499.00", "txnid": "PC-3", "key": "K"}
    post["hash"] = hashlib.sha512(("S|success|||||||||||a@x.in|Asha|Order PC-3|499.00|PC-3|K").encode()).hexdigest()
    assert a.reference_from_return(post) == "PC-3"
    assert a.reference_from_return({**post, "status": "failure"}) is None

    def h(req):
        form = dict(x.split("=") for x in req.content.decode().split("&"))
        if form["command"] == "verify_payment":
            return httpx.Response(200, json={"status": 1, "transaction_details": {"PC-3": {"mihpayid": "99", "status": "success", "mode": "UPI", "amt": "499.00"}}})
        return httpx.Response(200, json={"status": 1, "request_id": "q1"})
    fake(h)
    at = await a.attempts("PC-3")
    assert at[0]["status"] == "captured" and at[0]["id"] == "99" and at[0]["amount"] == 49900
    assert (await a.refund("PC-3", "99", 500, "rf", ""))["id"] == "q1"


async def test_stripe():
    def h(req):
        if req.method == "POST" and req.url.path.endswith("/checkout/sessions"):
            form = req.content.decode()
            assert "unit_amount%5D=49900" in form and "client_reference_id=PC-4" in form
            assert req.headers["authorization"] == "Bearer sk_test_1"
            return httpx.Response(200, json={"id": "cs_1", "url": "https://stripe/pay"})
        if req.url.path.endswith("/refunds"):
            return httpx.Response(200, json={"id": "re_1", "status": "succeeded"})
        return httpx.Response(200, json={"payment_status": "paid", "amount_total": 49900, "payment_intent": {"id": "pi_1"}})
    fake(h)
    a = g.Stripe({"secret_key": "sk_test_1", "webhook_secret": "whsec"})
    out = await a.create(49900, "USD", "PC-4", CUST, "https://s/cb", "")
    assert out["reference"] == "cs_1" and out["fields"]["url"] == "https://stripe/pay"
    at = await a.attempts("cs_1")
    assert at[0]["status"] == "captured" and at[0]["id"] == "pi_1"
    assert (await a.refund("cs_1", "pi_1", 100, "rf", ""))["status"] == "processed"
    body = json.dumps({"data": {"object": {"id": "cs_1"}}}).encode()
    t = str(int(time.time()))
    sig = hmac.new(b"whsec", t.encode() + b"." + body, hashlib.sha256).hexdigest()
    assert a.verify_webhook({"Stripe-Signature": f"t={t},v1={sig}"}, body) == "cs_1"
    assert a.verify_webhook({"Stripe-Signature": f"t={t},v1=bad"}, body) is None
    old = str(int(time.time()) - 1000)
    sig2 = hmac.new(b"whsec", old.encode() + b"." + body, hashlib.sha256).hexdigest()
    assert a.verify_webhook({"Stripe-Signature": f"t={old},v1={sig2}"}, body) is None
