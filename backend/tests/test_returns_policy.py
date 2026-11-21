"""Return policy: one line per item in a return request."""
from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import ReturnItem
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


async def delivered_order(client, admin, categories, *, qty: int = 1, phone: str = "9500000101"):
    """A cash-on-delivery order of `qty` shirts from Kovai Textiles, delivered. Returns (seller, buyer, order, sub id)."""
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": qty})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    return tn, buyer, o, sub_id


async def returnable(buyer, order_id: str, sub_id: str) -> list[dict]:
    return (await buyer.get(f"/api/orders/{order_id}/returnable")).json()["items"][sub_id]


async def test_an_item_named_twice_is_one_line(client, admin, categories):
    tn, buyer, o, sub_id = await delivered_order(client, admin, categories, qty=2)
    item = (await returnable(buyer, o["id"], sub_id))[0]
    x, unit = item["order_item_id"], item["unit_refund"]
    body = {"sub_order_id": sub_id, "reason": "size_fit", "refund_upi": "priya@okaxis"}

    # Together the lines ask for more units than were bought: refused.
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 2}, {"order_item_id": x, "qty": 1}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_qty"
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 1}, {"order_item_id": x, "qty": 0}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_qty"

    # Within what is left, the lines become one line and the refund is counted once per unit.
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 1}, {"order_item_id": x, "qty": 1}]})
    assert r.status_code == 201, r.text
    ret = r.json()
    assert ret["refund_amount"] == 2 * unit
    assert [(i["qty"], i["amount"]) for i in ret["items"]] == [(2, 2 * unit)]
    assert (await returnable(buyer, o["id"], sub_id))[0]["qty_left"] == 0

    # The seller can receive it: it does not get stuck.
    assert (await tn.post(f"/api/seller/returns/{ret['id']}", {"action": "approve"})).json()["status"] == "approved"
    r = await tn.post(f"/api/seller/returns/{ret['id']}", {"action": "received"})
    assert r.status_code == 200 and r.json()["status"] == "received"

    # The database refuses a second line for the same item in the same return.
    async with SessionLocal() as s:
        line = (await s.execute(select(ReturnItem))).scalar_one()
        s.add(ReturnItem(return_id=line.return_id, order_item_id=line.order_item_id, qty=1, amount=unit))
        with pytest.raises(IntegrityError):
            await s.flush()
