"""Order rules set in Admin → Marketplace settings: how far a customer can cancel by themselves, and how long an
unpaid online order waits for payment."""
from __future__ import annotations

import uuid
from datetime import timedelta

from app.db import SessionLocal
from app.models import Order
from tests.conftest import add_address, login_phone, make_live_product, make_seller


async def shop(client, admin, categories, phone: str):
    seller = await make_seller(client, admin, "9730000001", name="Erode Weaves", pan="ERODE1234E")
    p = await make_live_product(client, admin, seller, categories["shirts"], title="Erode cotton shirt",
                                variants=[{"sku": "ER-1", "options": {}, "mrp_paise": 99900, "price_paise": 79900, "stock": 20}])
    buyer = await login_phone(client, phone, "Kumar")
    addr = await add_address(buyer)
    return seller, p, buyer, addr


async def place(buyer, p, addr, method: str = "cod") -> dict:
    assert (await buyer.post("/api/cart/items", {"variant_id": p["variants"][0]["id"], "qty": 1})).status_code == 200
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": method, "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 201, r.text
    return r.json()["order"]


async def test_cancel_only_before_the_seller_confirms(client, admin, categories):
    seller, p, buyer, addr = await shop(client, admin, categories, "9730000002")
    assert (await admin.get("/api/admin/settings")).json()["customer_cancel_until"] == "packed"
    assert (await admin.put("/api/admin/settings", {"customer_cancel_until": "placed"})).status_code == 200

    order = await place(buyer, p, addr)
    sub_id = (await seller.get("/api/seller/orders?status=placed")).json()["items"][0]["id"]
    assert (await buyer.get(f"/api/orders/{order['id']}")).json()["sub_orders"][0]["can_cancel"] is True
    assert (await seller.post(f"/api/seller/orders/{sub_id}/confirm")).status_code == 200

    # confirmed: no longer cancellable by the customer under this rule
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["sub_orders"][0]["can_cancel"] is False
    r = await buyer.post(f"/api/orders/{order['id']}/cancel", {"reason": "Changed my mind"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_cancellable"

    # the owner allows it up to packing again: the same package can be cancelled
    assert (await admin.put("/api/admin/settings", {"customer_cancel_until": "packed"})).status_code == 200
    r = await buyer.post(f"/api/orders/{order['id']}/cancel", {"reason": "Changed my mind"})
    assert r.status_code == 200, r.text


async def test_validation(admin):
    for body in ({"customer_cancel_until": "shipped"}, {"customer_cancel_until": ""}, {"payment_window_minutes": 5},
                 {"payment_window_minutes": 121}, {"payment_window_minutes": "30"}):
        assert (await admin.put("/api/admin/settings", body)).status_code == 400, body


async def test_payment_window(client, admin, categories, gateway):
    _, p, buyer, addr = await shop(client, admin, categories, "9730000003")
    assert (await admin.put("/api/admin/settings", {"payment_window_minutes": 15})).status_code == 200
    order = await place(buyer, p, addr, "online")
    async with SessionLocal() as s:
        o = await s.get(Order, uuid.UUID(order["id"]))
        assert o.payment_expires_at is not None
        assert abs((o.payment_expires_at - o.created_at) - timedelta(minutes=15)) < timedelta(seconds=5)
