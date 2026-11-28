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


async def test_paid_order_one_part_cancelled_the_other_returned_refunds_exactly_what_was_paid(client, admin, categories, gateway):
    from app.models import Refund
    tn, ka, shirt, phone = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "SAVE10", "kind": "percent", "value": 1000, "show_on_checkout": False})).status_code == 201
    buyer = await login_phone(client, "9500000323", name="Mixed Returner")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key(), "coupon_code": "SAVE10"})
    assert r.status_code == 201, r.text
    order, pay = r.json()["order"], r.json()["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    v = await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    assert v.status_code == 200, v.text
    subs = (await buyer.get(f"/api/orders/{order['id']}")).json()["sub_orders"]
    keep = next(s for s in subs if s["seller"]["name"] == "Kovai Textiles")
    drop = next(s for s in subs if s["id"] != keep["id"])
    c = await buyer.post(f"/api/orders/{order['id']}/cancel", {"sub_order_id": drop["id"], "reason": "Ordered by mistake"})
    assert c.status_code == 200, c.text
    await ship_and_deliver(tn, keep["id"], marketplace_courier=True)
    line = (await buyer.get(f"/api/orders/{order['id']}/returnable")).json()["items"][keep["id"]]
    r = await buyer.post("/api/returns", {"sub_order_id": keep["id"], "items": [{"order_item_id": i["order_item_id"], "qty": i["qty_left"]} for i in line], "reason": "size_fit", "refund_upi": "priya@okaxis"})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})).status_code == 200
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).status_code == 200
    async with SessionLocal() as s:
        refunded = (await s.execute(select(func.coalesce(func.sum(Refund.amount_paise), 0)))).scalar_one()
        ledger_total = (await s.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.seller_id == uuid.UUID(tn.seller_id)))).scalar_one()
    assert refunded == order["grand_total"], (refunded, order["grand_total"])
    assert ledger_total == 0, ledger_total


async def test_returning_an_order_with_a_seller_funded_coupon_refunds_what_was_paid_and_zeroes_the_ledger(client, admin, categories):
    from app.models import Refund
    tn, ka, shirt, phone = await setup(client, admin, categories)
    assert (await tn.post("/api/seller/coupons", {"code": "KOVAI100", "kind": "flat", "value": 10000, "min_order_paise": 50000})).status_code == 201
    buyer = await login_phone(client, "9500000324", name="Seller Coupon Returner")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "KOVAI100"})
    assert r.status_code == 201, r.text
    order = r.json()["order"]
    sub = order["sub_orders"][0]
    await ship_and_deliver(tn, sub["id"], marketplace_courier=True)
    line = (await buyer.get(f"/api/orders/{order['id']}/returnable")).json()["items"][sub["id"]]
    r = await buyer.post("/api/returns", {"sub_order_id": sub["id"], "items": [{"order_item_id": i["order_item_id"], "qty": i["qty_left"]} for i in line], "reason": "size_fit", "refund_upi": "priya@okaxis"})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})).status_code == 200
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).status_code == 200
    assert r.json()["refund_amount"] == order["grand_total"] - order.get("shipping_total", 0) - order.get("cod_fee", 0)
    async with SessionLocal() as s:
        total = (await s.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.seller_id == uuid.UUID(tn.seller_id)))).scalar_one()
    assert total == 0, total
