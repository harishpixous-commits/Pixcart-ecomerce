"""Return policy: one line per item in a return request, the return window promised when the order was placed, and
returns of damaged, faulty, wrong or incomplete items."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import Order, ReturnItem, SubOrder
from app.shop_assistant.views import order_view
from tests.conftest import add_address, login_phone
from tests.test_gallery import body_from
from tests.test_phase2_money import key, setup, ship_and_deliver


async def place(buyer, addr: str, variant_id: str, qty: int = 1) -> dict:
    await buyer.post("/api/cart/items", {"variant_id": variant_id, "qty": qty})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 201, r.text
    return r.json()["order"]


async def delivered_order(client, admin, categories, *, qty: int = 1, phone: str = "9500000101"):
    """A cash-on-delivery order of `qty` shirts (7-day returns) from Kovai Textiles, delivered.
    Returns (seller, buyer, order, sub id, shirt listing, address id)."""
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer, state="33")
    o = await place(buyer, addr, shirt["variants"][0]["id"], qty)
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    return tn, buyer, o, sub_id, shirt, addr


async def returnable(buyer, order_id: str, sub_id: str) -> list[dict]:
    return (await buyer.get(f"/api/orders/{order_id}/returnable")).json()["items"][sub_id]


async def set_listing_window(tn, admin, product_id: str, days: int) -> None:
    """The seller changes the listing's return window and staff approve the edit."""
    detail = (await tn.get(f"/api/seller/products/{product_id}")).json()
    r = await tn.put(f"/api/seller/products/{product_id}", body_from(detail, return_window_days=days))
    assert r.status_code == 200 and r.json()["return_window_days"] == days, r.text
    assert (await admin.post(f"/api/admin/products/{product_id}/approve")).status_code == 200


async def test_an_item_named_twice_is_one_line(client, admin, categories):
    tn, buyer, o, sub_id, *_ = await delivered_order(client, admin, categories, qty=2)
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


async def test_return_window_is_the_one_promised_at_the_sale(client, admin, categories):
    # only the listing's own window here (no period for damaged or wrong items)
    assert (await admin.put("/api/admin/settings", {"defect_return_days": 0})).status_code == 200
    tn, buyer, o, sub_id, shirt, addr = await delivered_order(client, admin, categories)
    before = (await returnable(buyer, o["id"], sub_id))[0]
    assert before["eligible"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert sub.settlement_due_at - sub.delivered_at == timedelta(days=7)

    # After delivery the seller makes the listing non-returnable. The customer keeps the 7 days they were promised.
    await set_listing_window(tn, admin, shirt["id"], 0)
    after = (await returnable(buyer, o["id"], sub_id))[0]
    assert after["eligible"] and after["return_by"] == before["return_by"]
    async with SessionLocal() as s:
        view = await order_view(s, await s.get(Order, uuid.UUID(o["id"])))
        assert view["packages"][0]["items"][0]["return_window_days"] == 7 and view["packages"][0]["can_return"]

    # An order placed after the change gets the new window, and the seller is paid at delivery.
    o2 = await place(buyer, addr, shirt["variants"][0]["id"])
    sub2 = o2["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub2)
    assert not (await returnable(buyer, o2["id"], sub2))[0]["eligible"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub2))
        assert sub.settlement_due_at == sub.delivered_at

    # Raising the window later does not reopen returns on orders that were already delivered.
    await set_listing_window(tn, admin, shirt["id"], 30)
    assert not (await returnable(buyer, o2["id"], sub2))[0]["eligible"]


async def test_damaged_faulty_or_wrong_items_come_back_even_when_not_returnable(client, admin, categories):
    r = await admin.put("/api/admin/settings", {"defect_return_days": 31})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_setting"
    r = await admin.put("/api/admin/settings", {"defect_return_days": 10})
    assert r.status_code == 200 and r.json()["defect_return_days"] == 10
    reasons = (await client.get("/api/returns/reasons")).json()["reasons"]
    assert {x["code"] for x in reasons if x["defect"]} == {"damaged", "defective", "wrong_item", "missing_parts"}

    # The seller makes the listing non-returnable before the sale.
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    await set_listing_window(tn, admin, shirt["id"], 0)
    buyer = await login_phone(client, "9500000102")
    o = await place(buyer, await add_address(buyer, state="33"), shirt["variants"][0]["id"], 2)
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)

    # For 10 days after delivery the items can come back, but only when they arrived damaged, faulty, wrong or incomplete,
    # and the seller is paid after that period.
    item = (await returnable(buyer, o["id"], sub_id))[0]
    assert item["eligible"] and item["defects_only"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert datetime.fromisoformat(item["return_by"]) == sub.delivered_at + timedelta(days=10)
        assert sub.settlement_due_at == sub.delivered_at + timedelta(days=10)
    body = {"sub_order_id": sub_id, "items": [{"order_item_id": item["order_item_id"], "qty": 1}], "refund_upi": "priya@okaxis"}
    r = await buyer.post("/api/returns", {**body, "reason": "size_fit"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "reason_not_allowed"
    r = await buyer.post("/api/returns", {**body, "reason": "damaged"})
    assert r.status_code == 201, r.text

    # After the period nothing more can be returned.
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sub_id)).values(delivered_at=SubOrder.delivered_at - timedelta(days=11)))
        await s.commit()
    item = (await returnable(buyer, o["id"], sub_id))[0]
    assert item["qty_left"] == 1 and not item["eligible"] and not item["defects_only"]
    r = await buyer.post("/api/returns", {**body, "reason": "defective"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_returnable"
