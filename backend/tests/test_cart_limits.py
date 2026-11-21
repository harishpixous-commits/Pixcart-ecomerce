"""What one order can hold: lines bigger than any one warehouse ship from several, the per-item limit set by the owner
reaches the shop, and a lightning deal never sells more units at the deal price than the seller offered."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Deal, InventoryLevel, OrderItem, SubOrder, Variant
from tests.conftest import add_address, login_phone, valid_gstin
from tests.test_phase2_money import key, setup


async def test_a_line_bigger_than_any_warehouse_ships_from_several(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # shirt ₹1,000, 10 units in the Tamil Nadu warehouse
    vid = shirt["variants"][0]["id"]
    whs = (await tn.post("/api/seller/warehouses", {"code": "BLR1", "name": "Bengaluru hub", "line1": "5 Industrial Area", "city": "Bengaluru",
                                                    "state_code": "29", "pincode": "560058", "gstin": valid_gstin("29", "KOVAI1234K")})).json()
    blr, main = next(w for w in whs if w["code"] == "BLR1"), next(w for w in whs if w["is_default"])
    await tn.post("/api/seller/inventory/transfer", {"variant_id": vid, "from_warehouse_id": main["id"], "to_warehouse_id": blr["id"], "quantity": 4})
    assert (await admin.post("/api/admin/coupons", {"code": "SPLIT10", "kind": "percent", "value": 1000, "max_discount_paise": 100000})).status_code == 201

    # 8 units: no warehouse holds them all (6 + 4), so the order ships in two packages, fullest warehouse first
    buyer = await login_phone(client, "9600000811", name="Split Buyer")
    addr = await add_address(buyer, state="29", city="Bengaluru", pincode="560001")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 8})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "SPLIT10"})
    assert r.status_code == 201, r.text
    o = r.json()["order"]
    assert o["discount_total"] == 80000 and len(o["sub_orders"]) == 2
    async with SessionLocal() as s:
        subs = list((await s.execute(select(SubOrder).where(SubOrder.order_id == uuid.UUID(o["id"])).order_by(SubOrder.number))).scalars())
        items = {sub.warehouse_id: (await s.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalar_one() for sub in subs}
        assert {str(w): it.qty for w, it in items.items()} == {main["id"]: 6, blr["id"]: 2}
        assert sum(it.platform_discount for it in items.values()) == 80000  # the coupon is shared by the two parts
        assert items[uuid.UUID(main["id"])].platform_discount == 60000 and items[uuid.UUID(blr["id"])].igst == 0  # Bengaluru ships intra-state
        assert [sub.shipping_fee for sub in subs][1:] == [0]  # the seller's delivery fee rides on the first package only
        assert (await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(main["id"])))).quantity == 0
        assert (await s.get(Variant, uuid.UUID(vid))).stock == 2

    # another shopper takes one of the 2 left while this one still wants 2: refused with a clear message
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    other = await login_phone(client, "9600000812", name="Quick Buyer")
    o_addr = await add_address(other, state="33")
    await other.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert (await other.post("/api/orders", {"address_id": o_addr, "payment_method": "cod", "idempotency_key": key()})).status_code == 201
    late = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert late.status_code == 409 and late.json()["error"]["code"] == "cart_changed" and "Only 1 left" in late.json()["error"]["message"]

    # cancelling the split order puts every part back in its own warehouse
    await buyer.post(f"/api/orders/{o['id']}/cancel", {"reason": "Changed my mind"})
    async with SessionLocal() as s:
        assert (await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(main["id"])))).quantity == 6
        assert (await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(blr["id"])))).quantity == 3


async def test_per_item_limit_set_by_the_owner_reaches_the_shop(client, admin, categories):
    _tn, _ka, shirt, _phone = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    buyer = await login_phone(client, "9600000821", name="Limit Buyer")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 4})  # allowed while the limit is 10

    assert (await admin.put("/api/admin/settings", {"max_qty_per_item": 2})).status_code == 200
    assert (await client.get("/api/site")).json()["max_qty_per_item"] == 2
    cart = (await buyer.get("/api/cart")).json()
    line = cart["groups"][0]["lines"][0]
    assert line["max_qty"] == 2 and line["problem"] == "You can buy at most 2 of this item in one order" and cart["summary"]["has_problems"]
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 409 and r.json()["error"]["code"] == "cart_changed"

    # lowering it in the cart clears the problem; asking for more is lowered with a note
    r = (await buyer.put("/api/cart/items", {"variant_id": vid, "qty": 5})).json()
    assert r["groups"][0]["lines"][0]["qty"] == 2 and r["notice"] == "You can buy at most 2 of this item in one order, so your cart has 2."
    assert not r["summary"]["has_problems"]
    assert (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).status_code == 201


async def test_lightning_deal_units_cap_every_order_and_come_back_on_cancel(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # 10 in stock
    vid, slug = shirt["variants"][0]["id"], shirt["slug"]
    now = datetime.now(timezone.utc)
    r = await tn.post("/api/seller/deals", {"variant_id": vid, "kind": "lightning", "deal_price_paise": 80000, "qty_limit": 3,
                                            "starts_at": (now - timedelta(minutes=1)).isoformat(), "ends_at": (now + timedelta(hours=2)).isoformat()})
    assert (await admin.post(f"/api/admin/deals/{r.json()['id']}/approve", {})).json()["status"] == "active"
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["deal"]["units_left"] == 3

    first = await login_phone(client, "9600000831", name="Deal First")
    a1 = await add_address(first, state="33")
    r = (await first.post("/api/cart/items", {"variant_id": vid, "qty": 5})).json()
    assert r["groups"][0]["lines"][0]["qty"] == 3 and r["notice"] == "Only 3 left at the deal price, so your cart has 3."
    await first.put("/api/cart/items", {"variant_id": vid, "qty": 2})
    second = await login_phone(client, "9600000832", name="Deal Second")
    a2 = await add_address(second, state="33")
    await second.post("/api/cart/items", {"variant_id": vid, "qty": 2})

    o1 = (await first.post("/api/orders", {"address_id": a1, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    assert o1["items_total"] == 160000  # two units at the deal price
    line = (await second.get("/api/cart")).json()["groups"][0]["lines"][0]
    assert line["problem"] == "Only 1 left at the deal price" and line["max_qty"] == 1
    late = await second.post("/api/orders", {"address_id": a2, "payment_method": "cod", "idempotency_key": key()})
    assert late.status_code == 409 and late.json()["error"]["code"] == "cart_changed"

    # the first shopper cancels while the deal still runs: their units are on offer again
    await first.post(f"/api/orders/{o1['id']}/cancel", {"reason": "Changed my mind"})
    async with SessionLocal() as s:
        d = (await s.execute(select(Deal).where(Deal.variant_id == uuid.UUID(vid)))).scalar_one()
        assert d.sold_qty == 0 and d.status == "active"
    o2 = await second.post("/api/orders", {"address_id": a2, "payment_method": "cod", "idempotency_key": key()})
    assert o2.status_code == 201 and o2.json()["order"]["items_total"] == 160000
