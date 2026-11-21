"""Goods that come back: a package the seller's own courier brought back (RTO) is cancelled with stock back and a
prepaid refund; a received return goes back on sale only when the seller says the item is fit to sell."""
from __future__ import annotations

import uuid

from sqlalchemy import select, update

from app.db import SessionLocal
from app.models import LedgerEntry, Refund, ReturnItem, SubOrder, Variant
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


async def _stock(vid: str) -> int:
    async with SessionLocal() as s:
        return (await s.get(Variant, uuid.UUID(vid))).stock


async def _ship(seller, sub_id: str) -> None:
    for step in ("confirm", "pack"):
        assert (await seller.post(f"/api/seller/orders/{sub_id}/{step}")).status_code == 200
    assert (await seller.post(f"/api/seller/orders/{sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "AWB55555"})).status_code == 200


async def test_returned_to_origin_by_the_sellers_courier(client, admin, categories, gateway):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # 10 shirts
    vid = shirt["variants"][0]["id"]
    buyer = await login_phone(client, "9600000971", name="Away From Home")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    assert (await tn.post(f"/api/seller/orders/{sub_id}/rto", {})).json()["error"]["code"] == "not_shipped"
    await _ship(tn, sub_id)
    assert await _stock(vid) == 8
    r = await tn.post(f"/api/seller/orders/{sub_id}/rto", {"note": "Customer refused the package"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled" and await _stock(vid) == 10
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert sub.cancelled_by == "seller" and sub.cancel_reason.startswith("Returned to the seller by the courier (RTO): Customer refused")
        assert (await s.execute(select(LedgerEntry).where(LedgerEntry.sub_order_id == sub.id))).first() is None  # no sale is ever posted
    assert any("cancelled" in n["title"].lower() for n in (await buyer.get("/api/notifications")).json()["items"])
    brief = (await admin.get(f"/api/admin/ai/briefs/seller/{(await tn.get('/api/seller/me')).json()['id']}")).json()
    assert any("RTO" in n for n in brief["notes"])

    # prepaid: the customer is refunded; a package with our delivery partners comes back through them instead
    buyer2 = await login_phone(client, "9600000972", name="Prepaid Away")
    addr2 = await add_address(buyer2, state="33")
    await buyer2.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    p = (await buyer2.post("/api/orders", {"address_id": addr2, "payment_method": "online", "idempotency_key": key()})).json()
    pid, sig = gateway.pay(p["payment"]["razorpay_order_id"])
    await buyer2.post("/api/payments/razorpay/verify", {"razorpay_order_id": p["payment"]["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    sub2 = p["order"]["sub_orders"][0]["id"]
    await _ship(tn, sub2)
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sub2)).values(shipping_provider="fleet"))
        await s.commit()
    assert (await tn.post(f"/api/seller/orders/{sub2}/rto", {})).json()["error"]["code"] == "not_own_courier"
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sub2)).values(shipping_provider="manual"))
        await s.commit()
    assert (await tn.post(f"/api/seller/orders/{sub2}/rto", {})).json()["status"] == "cancelled"
    async with SessionLocal() as s:
        refund = (await s.execute(select(Refund).where(Refund.sub_order_id == uuid.UUID(sub2)))).scalar_one()
        assert refund.amount_paise == p["order"]["grand_total"]


async def test_received_returns_go_back_on_sale_only_when_fit_to_sell(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    buyer = await login_phone(client, "9600000973", name="Three Returns")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 3})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    item_id = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    assert await _stock(vid) == 7

    async def ret(reason: str, condition: str | None = None) -> dict:
        r = await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item_id, "qty": 1}], "reason": reason,
                                              "refund_upi": "three@okaxis"})
        assert r.status_code == 201, r.text
        rid = r.json()["id"]
        await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})
        body = {"action": "received"} | ({"items": [{"order_item_id": item_id, "condition": condition}]} if condition else {})
        out = (await tn.post(f"/api/seller/returns/{rid}", body)).json()
        assert out["status"] == "received", out
        return out

    out = await ret("size_fit")  # a size return: back on sale by default
    assert out["items"][0]["condition"] == "sellable" and await _stock(vid) == 8
    pending = await ret("damaged")  # arrived damaged: kept out of stock unless the seller says otherwise
    assert pending["items"][0]["condition"] == "damaged" and pending["items"][0]["suggested_condition"] == "damaged" and await _stock(vid) == 8
    await ret("damaged", "sellable")  # the seller checked it: only the box was damaged
    assert await _stock(vid) == 9
    async with SessionLocal() as s:
        conds = sorted((await s.execute(select(ReturnItem.condition))).scalars())
    assert conds == ["damaged", "sellable", "sellable"]
