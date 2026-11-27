"""Admin -> Growth settings and the seller scorecard."""
from __future__ import annotations

from tests.test_orders import marketplace


async def test_settings_default_off_and_validate(client, admin):
    r = await admin.get("/api/admin/growth/settings")
    assert r.status_code == 200
    s = r.json()["settings"]
    assert s["loyalty"]["enabled"] is False and s["seo"]["sitemap_enabled"] is True
    r = await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True, "points_per_100": 2}, "cod_risk": {"blocked_pincodes": ["641001", "bad", "641001"]}})
    assert r.status_code == 200, r.text
    s = r.json()["settings"]
    assert s["loyalty"]["enabled"] is True and s["loyalty"]["points_per_100"] == 2
    assert s["cod_risk"]["blocked_pincodes"] == ["641001"]
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"points_per_100": -1}})).status_code == 400
    assert (await admin.put("/api/admin/growth/settings", {"nope": {}})).status_code == 400
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"tier_silver_points": 900, "tier_gold_points": 100}})).status_code == 400
    assert (await admin.put("/api/admin/growth/settings", {"scorecard": {"late_warn_percent": 50, "late_critical_percent": 10}})).status_code == 400


async def test_scorecard_flags_a_slow_seller(client, admin, categories):
    from sqlalchemy import update
    from app.db import SessionLocal
    from app.models import SubOrder
    from tests.conftest import add_address, login_phone

    _, _, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000001")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    import uuid
    assert (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).status_code == 201
    assert (await admin.put("/api/admin/growth/settings", {"scorecard": {"enabled": True, "min_orders": 1, "ship_within_hours": 1}})).status_code == 200
    async with SessionLocal() as s:
        from datetime import timedelta
        from app.db import utcnow
        await s.execute(update(SubOrder).values(created_at=utcnow() - timedelta(hours=5)))
        await s.commit()
    items = (await admin.get("/api/admin/growth/scorecard")).json()["items"]
    assert items and items[0]["late"] == 1 and items[0]["level"] == "critical"
    assert (await buyer.get("/api/admin/growth/scorecard")).status_code == 403


async def test_points_are_earned_once_when_a_package_is_delivered(client, admin, categories):
    import uuid
    from tests.conftest import add_address, login_phone
    from tests.test_phase2_money import ship_and_deliver
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000002")
    addr = await add_address(buyer)
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 0
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).json()["order"]
    sub = o["sub_orders"][0]
    # switched off: nothing is earned
    await ship_and_deliver(seller, sub["id"])
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 0

    # switched on: the next delivered package earns points, once
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True, "points_per_100": 2}})).status_code == 200
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    o2 = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).json()["order"]
    await ship_and_deliver(seller, o2["sub_orders"][0]["id"])
    me = (await buyer.get("/api/loyalty")).json()
    expect = (o2["sub_orders"][0]["items_total"] // 10000) * 2
    assert expect > 0 and me["balance"] == expect and me["tier"] == "member" and me["history"][0]["kind"] == "earn"

    # staff adjust, never below zero
    r = await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": buyer.user["id"], "points": 10, "note": "Goodwill"})
    assert r.status_code == 200 and r.json()["balance"] == expect + 10
    r = await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": buyer.user["id"], "points": -(expect + 11), "note": "Too much"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "balance_too_low"


async def test_sitemap_lists_live_pages_and_can_be_switched_off(client, admin, categories):
    from tests.test_orders import marketplace

    _, _, shirt, cable = await marketplace(client, admin, categories)
    r = await client.get("/api/seo/sitemap.xml")
    assert r.status_code == 200 and "xml" in r.headers["content-type"]
    assert f"/p/{shirt['slug']}" in r.text and f"/p/{cable['slug']}" in r.text and "/c/" in r.text and "/store/" not in r.text
    assert (await admin.put("/api/admin/growth/settings", {"seo": {"sitemap_include_sellers": True, "sitemap_include_categories": False}})).status_code == 200
    r = await client.get("/api/seo/sitemap.xml")
    assert "/store/" in r.text and "/c/" not in r.text
    assert (await admin.put("/api/admin/growth/settings", {"seo": {"sitemap_enabled": False}})).status_code == 200
    assert (await client.get("/api/seo/sitemap.xml")).status_code == 404


async def test_cod_risk_rules_refuse_cash_orders(client, admin, categories):
    import uuid
    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, _, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000003")
    addr = await add_address(buyer)

    async def cod():
        await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
        return await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})

    # off: allowed (this is the existing behaviour)
    r = await cod()
    assert r.status_code == 201, r.text
    total = r.json()["order"]["grand_total"]
    # first-order limit below the order value
    assert (await admin.put("/api/admin/growth/settings", {"cod_risk": {"enabled": True, "new_account_max_cod_paise": max(total - 1, 0) or 1}})).status_code == 200
    r = await cod()
    assert r.status_code == 400 and r.json()["error"]["code"] == "cod_risk", r.text
    # online payment is never blocked by these rules
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    # value cap
    assert (await admin.put("/api/admin/growth/settings", {"cod_risk": {"new_account_max_cod_paise": 0, "max_cod_paise": 1}})).status_code == 200
    r = await cod()
    assert r.status_code == 400 and r.json()["error"]["code"] == "cod_risk"
    # switching the module off lifts it
    assert (await admin.put("/api/admin/growth/settings", {"cod_risk": {"enabled": False}})).status_code == 200
    assert (await cod()).status_code == 201
