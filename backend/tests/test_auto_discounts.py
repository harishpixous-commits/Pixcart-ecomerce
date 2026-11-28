"""Automatic discounts: a coupon marked automatic applies at checkout with no code, only when the setting is on."""
from __future__ import annotations

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import CouponRedemption
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup


async def test_automatic_coupon_applies_without_a_code_only_when_switched_on(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    r = await admin.post("/api/admin/coupons", {"code": "AUTO10", "kind": "percent", "value": 1000, "max_discount_paise": 100000, "is_automatic": True, "show_on_checkout": False})
    assert r.status_code == 201 and r.json()["is_automatic"] is True
    await admin.post("/api/admin/coupons", {"code": "SMALLAUTO", "kind": "flat", "value": 1000, "is_automatic": True})
    a = await login_phone(client, "9770000301", name="Auto Buyer")
    addr = await add_address(a, state="33")
    await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    assert (await q()).json()["coupon"] is None  # setting is off by default
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    c = (await q()).json()["coupon"]
    assert c["code"] == "AUTO10" and c["automatic"] is True and c["discount"] == 100000 // 10 and c["error"] is None  # the bigger saving wins
    # a code the customer types wins over the automatic one
    typed = (await a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "SMALLAUTO"})).json()["coupon"]
    assert typed["code"] == "SMALLAUTO" and "automatic" not in typed
    o = await a.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert o.status_code == 201
    async with SessionLocal() as s:
        n = (await s.execute(select(func.count()).select_from(CouponRedemption))).scalar_one()
    assert n == 1


async def test_automatic_volume_offer_competes_with_other_automatic_coupons(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    await admin.post("/api/admin/coupons", {"code": "AUTO10B", "kind": "percent", "value": 1000, "is_automatic": True, "show_on_checkout": False})
    r = await admin.post("/api/admin/coupons", {"code": "AUTOVOL20", "kind": "volume", "value": 20, "buy_qty": 2, "is_automatic": True, "show_on_checkout": False})
    assert r.status_code == 201 and r.json()["is_automatic"] is True
    a = await login_phone(client, "9770000302", name="Auto Volume Buyer")
    addr = await add_address(a, state="33")
    vid = shirt["variants"][0]["id"]
    price = shirt["variants"][0]["price_paise"]
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert (await q()).json()["coupon"]["code"] == "AUTO10B"                 # one unit: the volume offer does not apply yet, the plain one does
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    c = (await q()).json()["coupon"]
    assert c["code"] == "AUTOVOL20" and c["discount"] == price * 2 * 20 // 100   # two units: the bigger saving wins


async def test_automatic_coupon_with_a_per_user_limit_stops_after_the_customers_first_order(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    assert (await admin.post("/api/admin/coupons", {"code": "ONCEAUTO", "kind": "percent", "value": 1000, "per_user_limit": 1, "is_automatic": True, "show_on_checkout": False})).status_code == 201
    vid = shirt["variants"][0]["id"]
    q = lambda c: c.post("/api/checkout/quote", {"address_id": addr_of[c], "payment_method": "cod"})
    first, other = await login_phone(client, "9770000321", name="Once Buyer"), await login_phone(client, "9770000322", name="Other Buyer")
    addr_of = {first: await add_address(first, state="33"), other: await add_address(other, state="33")}
    for c in (first, other):
        await c.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert (await q(first)).json()["coupon"]["code"] == "ONCEAUTO"
    o = await first.post("/api/orders", {"address_id": addr_of[first], "payment_method": "cod", "idempotency_key": key()})
    assert o.status_code == 201
    await first.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert (await q(first)).json()["coupon"] is None                  # used once: no longer applied to this customer
    assert (await q(other)).json()["coupon"]["code"] == "ONCEAUTO"    # another customer still gets it


async def test_cart_hint_says_how_many_more_items_unlock_an_automatic_volume_offer(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    assert (await admin.post("/api/admin/coupons", {"code": "NUDGE15", "kind": "volume", "value": 15, "buy_qty": 3, "is_automatic": True, "show_on_checkout": False})).status_code == 201
    a = await login_phone(client, "9770000341", name="Nudge Buyer")
    addr = await add_address(a, state="33")
    vid = shirt["variants"][0]["id"]
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert "Add 2 more items to get 15% off" in (await q()).json()["hints"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert "Add 1 more item to get 15% off" in (await q()).json()["hints"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    r = (await q()).json()
    assert r["coupon"]["code"] == "NUDGE15" and not any("15% off" in h for h in r["hints"])    # unlocked: no hint left
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": False}})).status_code == 200
    assert not any("15% off" in h for h in (await q()).json()["hints"])                          # switched off: no hint


async def test_cart_hint_also_covers_an_automatic_buy_x_get_y_offer(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    assert (await admin.post("/api/admin/coupons", {"code": "AUTOB2G1", "kind": "bxgy", "value": 100, "buy_qty": 2, "get_qty": 1, "is_automatic": True, "show_on_checkout": False})).status_code == 201
    a = await login_phone(client, "9770000351", name="Bxgy Nudge Buyer")
    addr = await add_address(a, state="33")
    vid = shirt["variants"][0]["id"]
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert "Add 2 more items to get 1 free" in (await q()).json()["hints"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    assert "Add 1 more item to get 1 free" in (await q()).json()["hints"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    r = (await q()).json()
    assert r["coupon"]["code"] == "AUTOB2G1" and not any("free" in h for h in r["hints"])


async def test_cart_hint_names_the_missing_product_of_an_automatic_bundle(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    assert (await admin.post("/api/admin/coupons", {"code": "AUTOSET", "kind": "bundle", "value": 10, "is_automatic": True, "show_on_checkout": False,
                                                   "product_slugs": [shirt["slug"], phone_p["slug"]]})).status_code == 201
    a = await login_phone(client, "9770000361", name="Set Nudge Buyer")
    addr = await add_address(a, state="33")
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    assert f"Add {phone_p['title']} to get 10% off the set" in (await q()).json()["hints"]
    await a.post("/api/cart/items", {"variant_id": phone_p["variants"][0]["id"], "qty": 1})
    r = (await q()).json()
    assert r["coupon"]["code"] == "AUTOSET" and not any("the set" in h for h in r["hints"])
