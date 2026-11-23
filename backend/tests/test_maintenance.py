"""Maintenance mode (Admin → Marketplace settings): shoppers see a "back soon" page and cannot place orders; staff,
sellers and delivery partners carry on."""
from __future__ import annotations

import uuid

from tests.conftest import add_address, login_phone, make_live_product, make_seller

DEFAULT_MESSAGE = "We are making a few improvements and will be back shortly. Thank you for your patience."


async def test_off_by_default_and_public(client, admin):
    site = (await client.get("/api/site")).json()
    assert site["maintenance"] == {"on": False, "message": DEFAULT_MESSAGE}
    s = (await admin.get("/api/admin/settings")).json()
    assert s["maintenance_mode"] is False and s["maintenance_message"] == DEFAULT_MESSAGE


async def test_switch_on_with_a_message(client, admin):
    r = await admin.put("/api/admin/settings", {"maintenance_mode": True, "maintenance_message": "  Back at  6 pm   after a stock update. "})
    assert r.status_code == 200, r.text
    assert r.json()["maintenance_message"] == "Back at 6 pm after a stock update."  # spaces tidied
    assert (await client.get("/api/site")).json()["maintenance"] == {"on": True, "message": "Back at 6 pm after a stock update."}
    audit = (await admin.get("/api/admin/audit")).json()
    assert any(row["action"] == "settings.update" for row in audit["items"])


async def test_validation(admin):
    for body in ({"maintenance_mode": "yes"}, {"maintenance_mode": 1}, {"maintenance_message": "short"},
                 {"maintenance_message": "x" * 301}, {"maintenance_message": 42}, {"maintenance_message": None}):
        r = await admin.put("/api/admin/settings", body)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_setting", (body, r.text)
    assert (await admin.get("/api/admin/settings")).json()["maintenance_mode"] is False


async def test_orders_wait_but_staff_can_test(client, admin, categories):
    seller = await make_seller(client, admin, "9700000001", name="Coimbatore Cottons", pan="COIMB1234C")
    p = await make_live_product(client, admin, seller, categories["shirts"], title="Handloom cotton shirt",
                                variants=[{"sku": "HL-1", "options": {}, "mrp_paise": 99900, "price_paise": 79900, "stock": 10}])
    buyer = await login_phone(client, "9700000002", "Kavya")
    addr = await add_address(buyer)
    assert (await buyer.post("/api/cart/items", {"variant_id": p["variants"][0]["id"], "qty": 1})).status_code == 200

    assert (await admin.put("/api/admin/settings", {"maintenance_mode": True})).status_code == 200
    order = {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex}
    r = await buyer.post("/api/orders", order)
    assert r.status_code == 503 and r.json()["error"]["code"] == "maintenance"
    # the cart is kept for later
    assert (await buyer.get("/api/cart")).json()["summary"]["item_count"] == 1
    # sellers keep working in their hub
    assert (await seller.get("/api/seller/products")).status_code == 200

    # switched off, the same order goes through
    assert (await admin.put("/api/admin/settings", {"maintenance_mode": False})).status_code == 200
    r = await buyer.post("/api/orders", order)
    assert r.status_code == 201, r.text


async def test_staff_order_during_maintenance(client, admin, categories):
    seller = await make_seller(client, admin, "9700000011", name="Madurai Malli", pan="MADUR1234M")
    p = await make_live_product(client, admin, seller, categories["shirts"], title="Jasmine print shirt",
                                variants=[{"sku": "JP-1", "options": {}, "mrp_paise": 89900, "price_paise": 69900, "stock": 10}])
    assert (await admin.put("/api/admin/settings", {"maintenance_mode": True})).status_code == 200
    addr = await add_address(admin)
    assert (await admin.post("/api/cart/items", {"variant_id": p["variants"][0]["id"], "qty": 1})).status_code == 200
    r = await admin.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})
    assert r.status_code == 201, r.text  # a test order by staff while shoppers wait
