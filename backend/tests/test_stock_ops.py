"""Sellers' stock stays true: "out of stock" cancellations zero the real warehouse stock of the items the seller
picks, switching a warehouse on or off moves its stock in or out of sale at once, product-form edits count only active
warehouses, and the owner sets what "low stock" means."""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.models import InventoryLevel, Product, StockMovement, Variant
from tests.conftest import add_address, login_phone, make_live_product
from tests.test_gallery import body_from
from tests.test_phase2_money import key, setup


async def _cod(client, phone: str, variant_ids: list[str]) -> dict:
    buyer = await login_phone(client, phone, name=f"Buyer {phone[-3:]}")
    addr = await add_address(buyer, state="33")
    for vid in variant_ids:
        await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    return (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]


async def test_out_of_stock_cancel_zeroes_only_the_chosen_items_for_good(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # 10 shirts in the main warehouse
    towel = await make_live_product(client, admin, tn, categories["shirts"], title="Cotton Bath Towel", gst_bps=500,
                                    variants=[{"sku": "TW-1", "options": {}, "mrp_paise": 60000, "price_paise": 50000, "stock": 8}])
    shirt_v, towel_v = shirt["variants"][0]["id"], towel["variants"][0]["id"]
    o = await _cod(client, "9600000901", [shirt_v, towel_v])
    sub = o["sub_orders"][0]
    detail = (await tn.get(f"/api/seller/orders/{sub['id']}")).json()
    shirt_item = next(i["id"] for i in detail["items"] if i["title"] == shirt["title"])

    r = await tn.post(f"/api/seller/orders/{sub['id']}/reject", {"reason": "out_of_stock", "out_of_stock_items": [str(uuid.uuid4())]})
    assert r.json()["error"]["code"] == "invalid_items"  # not an item of this order
    r = await tn.post(f"/api/seller/orders/{sub['id']}/reject", {"reason": "out_of_stock", "out_of_stock_items": [shirt_item]})
    assert r.status_code == 200, r.text
    async with SessionLocal() as s:
        sv, tv = await s.get(Variant, uuid.UUID(shirt_v)), await s.get(Variant, uuid.UUID(towel_v))
        assert sv.stock == 0 and tv.stock == 8  # the towel was not out of stock: its unit went back on sale
        lvl = (await s.execute(select(InventoryLevel).where(InventoryLevel.variant_id == sv.id))).scalar_one()
        assert lvl.quantity == 0  # the warehouse level itself, not only the total
        assert (await s.get(Product, uuid.UUID(shirt["id"]))).in_stock is False
        mv = (await s.execute(select(StockMovement).where(StockMovement.variant_id == sv.id).order_by(StockMovement.created_at.desc()))).scalars().first()
        assert mv.kind == "set" and "Out of stock" in mv.note
    # a later stock movement does not bring phantom units back
    wh = (await tn.get("/api/seller/warehouses")).json()[0]["id"]
    assert (await tn.post("/api/seller/inventory/adjust", {"variant_id": shirt_v, "warehouse_id": wh, "mode": "add", "quantity": 2, "note": "Found two"})).status_code == 200
    async with SessionLocal() as s:
        assert (await s.get(Variant, uuid.UUID(shirt_v))).stock == 2


async def test_switching_warehouses_and_product_form_stock(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    base = {"code": "CBE1", "name": "Coimbatore hub", "line1": "12 Avinashi Road", "city": "Coimbatore", "state_code": "33", "pincode": "641018"}
    whs = (await tn.post("/api/seller/warehouses", base)).json()
    cbe, main = next(w for w in whs if w["code"] == "CBE1"), next(w for w in whs if w["is_default"])
    await tn.post("/api/seller/inventory/transfer", {"variant_id": vid, "from_warehouse_id": main["id"], "to_warehouse_id": cbe["id"], "quantity": 4})

    async def stock() -> int:
        async with SessionLocal() as s:
            return (await s.get(Variant, uuid.UUID(vid))).stock

    assert (await tn.put(f"/api/seller/warehouses/{cbe['id']}", base | {"is_active": False})).status_code == 200
    assert await stock() == 6  # switched off: its 4 units stop selling
    assert (await tn.put(f"/api/seller/warehouses/{cbe['id']}", base | {"is_active": True})).status_code == 200
    assert await stock() == 10  # switched back on: they sell again at once

    # the product form sets the total of sellable stock: a switched-off warehouse does not count
    await tn.put(f"/api/seller/warehouses/{cbe['id']}", base | {"is_active": False})
    body = body_from((await tn.get(f"/api/seller/products/{shirt['id']}")).json())
    body["variants"][0]["stock"] = 9
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", body)).status_code == 200
    async with SessionLocal() as s:
        assert (await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(main["id"])))).quantity == 9
        assert (await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(cbe["id"])))).quantity == 4  # untouched
    assert await stock() == 9


async def test_owner_sets_what_low_stock_means(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # 10 in stock
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["variants"][0]["low_stock"] is False and page["variants"][0]["stock_left"] is None
    assert (await admin.put("/api/admin/settings", {"low_stock_threshold": 20})).status_code == 200
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["variants"][0]["low_stock"] is True and page["variants"][0]["stock_left"] == 10
    dash = (await tn.get("/api/seller/dashboard")).json()
    assert dash["low_stock_variants"] == 1 and dash["low_stock_threshold"] == 20
    grid = (await tn.get("/api/seller/inventory", params={"low_stock": True})).json()
    assert grid["total"] == 1 and grid["low_stock_threshold"] == 20
    assert (await tn.get("/api/seller/products", params={"low_stock": True})).json()["total"] == 1
    assert (await admin.put("/api/admin/settings", {"low_stock_threshold": 0})).status_code == 400
