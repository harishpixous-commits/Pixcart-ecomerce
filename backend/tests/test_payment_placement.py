"""Several gateways at checkout: first choice, failover, pay another way, the return and webhook of a second gateway."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

import httpx
import pytest

from app.config import settings
from app.services import gateways
from tests.test_payment_check import online_order


class FakeCashfree:
    def __init__(self):
        self.orders: dict[str, dict] = {}
        self.paid: set[str] = set()
        self.down = False

    def handler(self, req: httpx.Request) -> httpx.Response:
        if self.down:
            return httpx.Response(500, json={"message": "cashfree is down"})
        parts = req.url.path.split("/")
        if req.method == "POST" and req.url.path.endswith("/orders"):
            body = json.loads(req.content)
            self.orders[body["order_id"]] = body
            return httpx.Response(200, json={"order_id": body["order_id"], "payment_session_id": "sess_" + body["order_id"]})
        if req.method == "GET" and req.url.path.endswith("/payments"):
            oid = parts[-2]
            if oid in self.paid:
                return httpx.Response(200, json=[{"cf_payment_id": 901, "payment_status": "SUCCESS", "payment_group": "upi", "payment_amount": self.orders[oid]["order_amount"]}])
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"message": "unhandled"})


@pytest.fixture
def cashfree(monkeypatch):
    monkeypatch.setattr(settings, "cashfree_client_id", "TEST1234abcd")
    monkeypatch.setattr(settings, "cashfree_client_secret", "cf_secret")
    fake = FakeCashfree()
    gateways.transport = httpx.MockTransport(fake.handler)
    yield fake
    gateways.transport = None


async def place(client, admin, categories, phone):
    return await online_order(client, admin, categories, phone)


async def test_default_order_keeps_razorpay_first(client, admin, categories, gateway, cashfree):
    buyer, order, pay = await place(client, admin, categories, "9770000001")
    assert pay["provider"] == "razorpay" and pay["mode"] == "modal"
    assert [a["provider"] for a in pay["alternatives"]] == ["cashfree"]


async def test_failover_to_second_gateway_and_events(client, admin, categories, gateway, cashfree):
    from app.services import razorpay

    razorpay.transport = httpx.MockTransport(lambda r: httpx.Response(500, json={"error": {"description": "razorpay is down"}}))
    buyer, order, pay = await place(client, admin, categories, "9770000002")
    assert pay["provider"] == "cashfree" and pay["mode"] == "modal" and pay["payment_session_id"].startswith("sess_")
    assert [a["provider"] for a in pay["alternatives"]] == ["razorpay"]
    health = {g["code"]: g for g in (await admin.get("/api/admin/payments/gateways")).json()["gateways"]}
    assert health["razorpay"]["attempts"] == 1 and health["razorpay"]["ok"] == 0 and "down" in health["razorpay"]["last_error"]
    assert health["cashfree"]["attempts"] == 1 and health["cashfree"]["ok"] == 1 and health["cashfree"]["enabled"]


async def test_failover_off_and_all_failing(client, admin, categories, gateway, cashfree):
    from app.services import razorpay

    razorpay.transport = httpx.MockTransport(lambda r: httpx.Response(500, json={"error": {"description": "razorpay is down"}}))
    assert (await admin.put("/api/admin/payments/routing", {"failover": False})).status_code == 200
    _, _, _, cable = await __import__("tests.test_orders", fromlist=["marketplace"]).marketplace(client, admin, categories)
    from tests.conftest import add_address, login_phone
    import uuid
    buyer = await login_phone(client, "9770000003")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 502 and r.json()["error"]["code"] == "gateway_error"
    cashfree.down = True
    await admin.put("/api/admin/payments/routing", {"failover": True})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 502
    health = {g["code"]: g for g in (await admin.get("/api/admin/payments/gateways")).json()["gateways"]}
    assert health["razorpay"]["attempts"] == 2 and health["cashfree"]["attempts"] == 1  # events survive the rolled-back checkout


async def test_pay_another_way_then_return_marks_paid(client, admin, categories, gateway, cashfree):
    buyer, order, pay = await place(client, admin, categories, "9770000004")
    r = await buyer.post(f"/api/orders/{order['id']}/payment/switch", {})
    assert r.status_code == 200, r.text
    new = r.json()["payment"]
    assert new["provider"] == "cashfree" and new["amount"] == pay["amount"]
    ref = next(iter(cashfree.orders))
    # the shopper comes back before paying: still checking
    back = await client.get("/api/payments/cashfree/callback", params={"order_id": ref}, follow_redirects=False)
    assert back.status_code == 303 and "payment=success" not in back.headers["location"]
    assert (await buyer.get(f"/api/orders/{order['id']}")).json()["status"] == "pending_payment"
    cashfree.paid.add(ref)
    back = await client.get("/api/payments/cashfree/callback", params={"order_id": ref}, follow_redirects=False)
    assert back.status_code == 303 and "payment=success" in back.headers["location"]
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["status"] == "placed" and mine["payment_status"] == "paid"
    # nothing is due now
    assert (await buyer.post(f"/api/orders/{order['id']}/payment/switch", {})).status_code == 409


async def test_switch_unknown_and_unavailable(client, admin, categories, gateway, cashfree):
    buyer, order, _ = await place(client, admin, categories, "9770000005")
    assert (await buyer.post(f"/api/orders/{order['id']}/payment/switch", {"provider": "nope"})).status_code == 400
    assert (await buyer.post(f"/api/orders/{order['id']}/payment/switch", {"provider": "stripe"})).status_code == 409


async def test_webhook_signature_and_duplicate(client, admin, categories, gateway, cashfree):
    buyer, order, pay = await place(client, admin, categories, "9770000006")
    await buyer.post(f"/api/orders/{order['id']}/payment/switch", {})
    ref = next(iter(cashfree.orders))
    body = json.dumps({"data": {"order": {"order_id": ref}}}).encode()
    bad = await client.post("/api/payments/cashfree/webhook", content=body, headers={"x-webhook-timestamp": "1", "x-webhook-signature": "nope"})
    assert bad.status_code == 400
    cashfree.paid.add(ref)
    sig = base64.b64encode(hmac.new(b"cf_secret", b"1" + body, hashlib.sha256).digest()).decode()
    h = {"x-webhook-timestamp": "1", "x-webhook-signature": sig}
    ok = await client.post("/api/payments/cashfree/webhook", content=body, headers=h)
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert (await buyer.get(f"/api/orders/{order['id']}")).json()["payment_status"] == "paid"
    dup = await client.post("/api/payments/cashfree/webhook", content=body, headers=h)
    assert dup.json().get("duplicate") is True
    assert (await client.post("/api/payments/unknown/webhook", content=b"{}")).status_code == 404


async def test_routing_settings_admin(client, admin, gateway):
    r = await admin.put("/api/admin/payments/routing", {"order": ["stripe", "razorpay"], "strategy": "success_rate"})
    assert r.status_code == 200 and r.json()["routing"]["order"][0] == "stripe"
    assert (await admin.put("/api/admin/payments/routing", {"timeout_seconds": 1})).json()["error"]["code"] == "invalid_setting"
    assert (await admin.post("/api/admin/payments/gateways/nope/test")).status_code == 404
    t = await admin.post("/api/admin/payments/gateways/stripe/test")
    assert t.status_code == 200 and t.json()["ok"] is False
    audit = (await admin.get("/api/admin/audit")).json()["items"]
    assert any(a["action"] == "payments.routing" for a in audit)
