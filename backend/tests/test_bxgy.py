"""Buy X get Y: the cheapest Y of every X+Y units get a percent off."""
from __future__ import annotations

from tests.conftest import add_address, login_phone
from tests.test_phase2_money import setup


async def test_buy_two_get_one_free(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    bad = await admin.post("/api/admin/coupons", {"code": "BADBX", "kind": "bxgy", "value": 100, "buy_qty": 0, "get_qty": 1})
    assert bad.status_code == 400
    r = await admin.post("/api/admin/coupons", {"code": "B2G1", "kind": "bxgy", "value": 100, "buy_qty": 2, "get_qty": 1, "show_on_checkout": False})
    assert r.status_code == 201 and r.json()["buy_qty"] == 2 and r.json()["get_qty"] == 1
    a = await login_phone(client, "9770000401", name="Bxgy Buyer")
    addr = await add_address(a, state="33")
    vid = shirt["variants"][0]["id"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "B2G1"})
    assert (await q()).json()["coupon"]["discount"] == 0  # two units: nothing free yet
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    unit = shirt["variants"][0]["price_paise"]
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == unit


async def test_bundle_discount_needs_every_product_of_the_set(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    body = {"code": "SETDEAL", "kind": "bundle", "value": 10, "show_on_checkout": False}
    assert (await admin.post("/api/admin/coupons", body | {"product_slugs": [shirt["slug"]]})).status_code == 400   # one product is not a bundle
    assert (await admin.post("/api/admin/coupons", body | {"product_slugs": [shirt["slug"], phone_p["slug"]], "value": 95})).status_code in (400, 422)
    r = await admin.post("/api/admin/coupons", body | {"product_slugs": [shirt["slug"], phone_p["slug"]]})
    assert r.status_code == 201, r.text
    a = await login_phone(client, "9770000402", name="Bundle Buyer")
    addr = await add_address(a, state="33")
    sv, pv = shirt["variants"][0], phone_p["variants"][0]
    await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 2})
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "SETDEAL"})
    assert (await q()).json()["coupon"]["discount"] == 0          # the phone is missing: no offer
    await a.post("/api/cart/items", {"variant_id": pv["id"], "qty": 1})
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == (sv["price_paise"] + pv["price_paise"]) // 10   # one complete set, 10% off (the second shirt is not part of it)


async def test_volume_offer_needs_the_minimum_number_of_items(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    body = {"code": "BUY3SAVE", "kind": "volume", "value": 15, "show_on_checkout": False}
    assert (await admin.post("/api/admin/coupons", body | {"buy_qty": 1})).status_code == 400   # a minimum of one is not a volume offer
    assert (await admin.post("/api/admin/coupons", body | {"buy_qty": 3, "value": 95})).status_code in (400, 422)
    r = await admin.post("/api/admin/coupons", body | {"buy_qty": 3, "product_slugs": [shirt["slug"]]})
    assert r.status_code == 201 and r.json()["buy_qty"] == 3 and r.json()["get_qty"] == 0, r.text
    a = await login_phone(client, "9770000403", name="Volume Buyer")
    addr = await add_address(a, state="33")
    sv, pv = shirt["variants"][0], phone_p["variants"][0]
    await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 2})
    await a.post("/api/cart/items", {"variant_id": pv["id"], "qty": 5})                 # the phone is not in the offer
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "BUY3SAVE"})
    assert (await q()).json()["coupon"]["discount"] == 0                                  # two shirts: not enough
    await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == sv["price_paise"] * 3 * 15 // 100


async def test_new_offer_kinds_flow_into_the_order_and_come_back_on_cancel(client, admin, categories):
    """Bundle and volume offers: the order total, the seller split and the cancel path agree with the quote."""
    import uuid

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import SubOrder
    from tests.test_phase2_money import key

    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    sv, pv = shirt["variants"][0], phone_p["variants"][0]
    assert (await admin.post("/api/admin/coupons", {"code": "SETDEAL2", "kind": "bundle", "value": 10, "per_user_limit": 1, "show_on_checkout": False,
                                                   "product_slugs": [shirt["slug"], phone_p["slug"]]})).status_code == 201
    assert (await admin.post("/api/admin/coupons", {"code": "VOL2", "kind": "volume", "value": 10, "buy_qty": 2, "per_user_limit": 1, "show_on_checkout": False})).status_code == 201
    for code, phone in (("SETDEAL2", "9770000411"), ("VOL2", "9770000412")):
        a = await login_phone(client, phone, name="Offer Buyer")
        addr = await add_address(a, state="33")
        await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})
        await a.post("/api/cart/items", {"variant_id": pv["id"], "qty": 1})
        q = (await a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": code})).json()
        off = q["coupon"]["discount"]
        assert q["coupon"]["error"] is None and off == (sv["price_paise"] + pv["price_paise"]) // 10
        r = await a.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": code, "expected_total": q["summary"]["grand_total"]})
        assert r.status_code == 201, r.text
        o = r.json()["order"]
        assert o["grand_total"] == q["summary"]["grand_total"]
        async with SessionLocal() as s:
            subs = list((await s.execute(select(SubOrder).where(SubOrder.order_id == uuid.UUID(o["id"])))).scalars())
            assert sum(x.platform_discount for x in subs) == off          # the split adds up to the paise
        used = lambda rows: next(c for c in rows if c["code"] == code)["used_count"]
        assert used((await admin.get("/api/admin/coupons")).json()) == 1
        await a.post(f"/api/orders/{o['id']}/cancel", {"reason": "Ordered by mistake"})
        assert used((await admin.get("/api/admin/coupons")).json()) == 0                                                  # cancelling gives the use back
        await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})
        await a.post("/api/cart/items", {"variant_id": pv["id"], "qty": 1})
        q2 = (await a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": code})).json()
        assert q2["coupon"]["error"] is None                                # and it can be used again


async def test_returning_one_unit_of_a_volume_offer_refunds_its_share_of_the_discount(client, admin, categories, gateway):
    import asyncio

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Refund
    from tests.test_phase2_money import key, ship_and_deliver

    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    sv = shirt["variants"][0]
    assert (await admin.post("/api/admin/coupons", {"code": "VOLRET", "kind": "volume", "value": 10, "buy_qty": 2, "per_user_limit": 1, "show_on_checkout": False})).status_code == 201
    a = await login_phone(client, "9770000413", name="Volume Return Buyer")
    addr = await add_address(a, state="33")
    await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 2})
    r = (await a.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key(), "coupon_code": "VOLRET"})).json()
    pay = r["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    await a.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    sub_id = r["order"]["sub_orders"][0]["id"]
    paid = r["order"]["grand_total"]
    assert paid == sv["price_paise"] * 2 - sv["price_paise"] * 2 // 10
    await ship_and_deliver(tn, sub_id)
    item_id = (await a.get(f"/api/orders/{r['order']['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    rid = (await a.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item_id, "qty": 1}], "reason": "defective"})).json()["id"]
    await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).json()["status"] == "refunded"
    await asyncio.sleep(0.05)
    async with SessionLocal() as s:
        refund = (await s.execute(select(Refund))).scalar_one()
        assert refund.amount_paise == paid // 2          # one of two units: half of what was paid, discount share included


async def test_a_coupon_for_chosen_products_is_offered_only_on_those_pages(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "SHIRTVOL", "kind": "volume", "value": 10, "buy_qty": 2, "product_slugs": [shirt["slug"]]})).status_code == 201
    assert (await admin.post("/api/admin/coupons", {"code": "ALLVOL", "kind": "volume", "value": 5, "buy_qty": 3})).status_code == 201
    on_shirt = {o["code"] for o in (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["offers"]}
    on_phone = {o["code"] for o in (await client.get(f"/api/catalog/products/{phone_p['slug']}")).json()["offers"]}
    assert "SHIRTVOL" in on_shirt and "ALLVOL" in on_shirt and "ALLVOL" in on_phone and "SHIRTVOL" not in on_phone


async def test_bundle_block_lists_the_set_with_price_and_saving(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "SETBLOCK", "kind": "bundle", "value": 10, "show_on_checkout": True,
                                                   "product_slugs": [shirt["slug"], phone_p["slug"]]})).status_code == 201
    for slug in (shirt["slug"], phone_p["slug"]):
        b = (await client.get(f"/api/catalog/products/{slug}/bundles")).json()["bundles"]
        assert len(b) == 1 and b[0]["code"] == "SETBLOCK" and b[0]["percent"] == 10
        assert [i["slug"] for i in b[0]["items"]] == [shirt["slug"], phone_p["slug"]]
        total = shirt["variants"][0]["price_paise"] + phone_p["variants"][0]["price_paise"]
        assert b[0]["total"] == total and b[0]["saving"] == total // 10 and b[0]["set_price"] == total - total // 10
    # a hidden (not listed) bundle code is not advertised, and a sold-out member hides the block
    assert (await admin.post("/api/admin/coupons", {"code": "QUIETSET", "kind": "bundle", "value": 20, "show_on_checkout": False,
                                                   "product_slugs": [shirt["slug"], phone_p["slug"]]})).status_code == 201
    assert [x["code"] for x in (await client.get(f"/api/catalog/products/{shirt['slug']}/bundles")).json()["bundles"]] == ["SETBLOCK"]
    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import Product
    async with SessionLocal() as s:
        await s.execute(update(Product).where(Product.slug == phone_p["slug"]).values(in_stock=False))
        await s.commit()
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}/bundles")).json()["bundles"] == []


async def test_bundle_block_hides_expired_used_up_and_switched_off_bundles(client, admin, categories):
    from datetime import timedelta

    from sqlalchemy import update

    from app.db import SessionLocal, utcnow
    from app.models import Coupon

    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "EDGESET", "kind": "bundle", "value": 10, "product_slugs": [shirt["slug"], phone_p["slug"]]})).status_code == 201

    async def shown() -> bool:
        return bool((await client.get(f"/api/catalog/products/{shirt['slug']}/bundles")).json()["bundles"])

    async def change(**vals):
        async with SessionLocal() as s:
            await s.execute(update(Coupon).where(Coupon.code == "EDGESET").values(**vals))
            await s.commit()

    assert await shown()
    await change(ends_at=utcnow() - timedelta(minutes=1))
    assert not await shown()
    await change(ends_at=None, starts_at=utcnow() + timedelta(days=1))
    assert not await shown()
    await change(starts_at=None, usage_limit=1, used_count=1)
    assert not await shown()
    await change(usage_limit=None, is_active=False)
    assert not await shown()
    await change(is_active=True)
    assert await shown()


async def test_volume_offer_counts_units_across_variants_of_the_product(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    import uuid

    from sqlalchemy import select

    from app.db import SessionLocal
    from app.models import Variant
    v0 = shirt["variants"][0]
    async with SessionLocal() as s:   # a second variant of the same shirt, same price
        row = (await s.execute(select(Variant).where(Variant.id == uuid.UUID(v0["id"])))).scalar_one()
        clone = Variant(**{c.name: getattr(row, c.name) for c in Variant.__table__.columns if c.name not in ("id", "sku", "created_at", "updated_at")}, id=uuid.uuid4(), sku="VARMIX-2")
        s.add(clone)
        await s.commit()
        v1 = {"id": str(clone.id), "price_paise": clone.price_paise}
    assert (await admin.post("/api/admin/coupons", {"code": "VARMIX", "kind": "volume", "value": 10, "buy_qty": 2, "show_on_checkout": False, "product_slugs": [shirt["slug"]]})).status_code == 201
    a = await login_phone(client, "9770000431", name="Variant Mix Buyer")
    addr = await add_address(a, state="33")
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "VARMIX"})
    await a.post("/api/cart/items", {"variant_id": v0["id"], "qty": 1})
    await a.post("/api/cart/items", {"variant_id": phone_p["variants"][0]["id"], "qty": 1})   # another product does not count
    assert (await q()).json()["coupon"]["error"] is not None
    await a.post("/api/cart/items", {"variant_id": v1["id"], "qty": 1})                         # a second shirt variant does
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == (v0["price_paise"] + v1["price_paise"]) // 10
