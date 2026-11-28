"""Money conservation: a customer who returns everything from an order paid with a platform coupon leaves each seller's ledger at zero,
and the refund total is what the items cost after the discount."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import LedgerEntry
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


async def test_returning_everything_zeroes_each_sellers_ledger(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "SAVE10", "kind": "percent", "value": 1000, "show_on_checkout": False})).status_code == 201
    buyer = await login_phone(client, "9500000321", name="Returner")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "SAVE10"})
    assert r.status_code == 201, r.text
    order = r.json()["order"]
    subs = order["sub_orders"]
    assert len(subs) == 2
    for sub in subs:
        seller = tn if sub["seller"]["name"] == "Kovai Textiles" else ka
        await ship_and_deliver(seller, sub["id"], marketplace_courier=True)
    returnable = (await buyer.get(f"/api/orders/{order['id']}/returnable")).json()["items"]
    refunds = 0
    for sub in subs:
        seller = tn if sub["seller"]["name"] == "Kovai Textiles" else ka
        items = [{"order_item_id": i["order_item_id"], "qty": i["qty_left"]} for i in returnable[sub["id"]]]
        assert items, sub
        r = await buyer.post("/api/returns", {"sub_order_id": sub["id"], "items": items, "reason": "size_fit", "refund_upi": "priya@okaxis"})
        assert r.status_code == 201, r.text
        refunds += r.json()["refund_amount"]
        rid = r.json()["id"]
        assert (await seller.post(f"/api/seller/returns/{rid}", {"action": "approve"})).status_code == 200
        assert (await seller.post(f"/api/seller/returns/{rid}", {"action": "received"})).status_code == 200
    items_paid = order["grand_total"] - order.get("shipping_total", 0) - order.get("cod_fee", 0)
    async with SessionLocal() as s:
        for who in (tn, ka):
            total = (await s.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.seller_id == uuid.UUID(who.seller_id)))).scalar_one()
            assert total == 0, (who.seller_id, total)
    assert refunds == items_paid == order["grand_total"] and order["discount_total"] > 0


async def test_returning_a_two_unit_line_one_at_a_time_refunds_the_discounted_total_once(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "SAVE10", "kind": "percent", "value": 1000, "show_on_checkout": False})).status_code == 201
    buyer = await login_phone(client, "9500000322", name="Partial Returner")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "SAVE10"})
    assert r.status_code == 201, r.text
    order = r.json()["order"]
    sub = order["sub_orders"][0]
    await ship_and_deliver(tn, sub["id"], marketplace_courier=True)
    refunds = 0
    for step in range(2):
        line = (await buyer.get(f"/api/orders/{order['id']}/returnable")).json()["items"][sub["id"]][0]
        assert line["qty_left"] == 2 - step
        r = await buyer.post("/api/returns", {"sub_order_id": sub["id"], "items": [{"order_item_id": line["order_item_id"], "qty": 1}], "reason": "size_fit", "refund_upi": "priya@okaxis"})
        assert r.status_code == 201, r.text
        refunds += r.json()["refund_amount"]
        rid = r.json()["id"]
        assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})).status_code == 200
        assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).status_code == 200
    async with SessionLocal() as s:
        total = (await s.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.seller_id == uuid.UUID(tn.seller_id)))).scalar_one()
    assert total == 0, total
    assert refunds == order["grand_total"] - order.get("shipping_total", 0) - order.get("cod_fee", 0)
