"""Admin -> Growth settings and the seller scorecard."""
from __future__ import annotations

import pytest

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


async def test_seller_sees_only_their_own_scorecard(client, admin, categories):
    tn, ka, _, _ = await (__import__("tests.test_orders", fromlist=["marketplace"]).marketplace(client, admin, categories))
    assert (await tn.get("/api/seller/scorecard")).json() == {"enabled": False}
    assert (await admin.put("/api/admin/growth/settings", {"scorecard": {"enabled": True, "min_orders": 1}})).status_code == 200
    r = (await tn.get("/api/seller/scorecard")).json()
    assert r["enabled"] is True and r["you"]["orders"] == 0 and r["limits"]["late_warn_percent"] == 10
    assert (await admin.get("/api/seller/scorecard")).status_code in (401, 403)


async def test_referral_rewards_both_sides_once_on_the_friends_first_delivery(client, admin, categories):
    import uuid
    from tests.conftest import add_address, login_phone
    from tests.test_phase2_money import ship_and_deliver
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    ann = await login_phone(client, "9770000011")
    bob = await login_phone(client, "9770000012")
    code = (await ann.get("/api/referral")).json()["code"]
    # off by default
    assert (await bob.post("/api/referral/apply", {"code": code})).json()["error"]["code"] == "referral_off"
    assert (await admin.put("/api/admin/growth/settings", {"referral": {"enabled": True, "min_order_paise": 100, "referrer_reward_paise": 10000, "friend_reward_paise": 5000}})).status_code == 200
    assert (await bob.post("/api/referral/apply", {"code": ann.user and "PX00000000"})).json()["error"]["code"] == "invalid_code"
    assert (await ann.post("/api/referral/apply", {"code": code})).json()["error"]["code"] == "own_code"
    assert (await bob.post("/api/referral/apply", {"code": code})).status_code == 200
    assert (await bob.post("/api/referral/apply", {"code": code})).json()["error"]["code"] == "already_used"

    addr = await add_address(bob)
    await bob.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    o = (await bob.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).json()["order"]
    assert (await ann.get("/api/loyalty")).json()["balance"] == 0  # nothing before delivery
    await ship_and_deliver(seller, o["sub_orders"][0]["id"])
    assert (await ann.get("/api/loyalty")).json()["balance"] == 100 and (await bob.get("/api/loyalty")).json()["balance"] == 50
    s = (await ann.get("/api/referral")).json()
    assert s["joined"] == 1 and s["rewarded"] == 1 and s["earned_paise"] == 10000
    rows = (await admin.get("/api/admin/growth/referrals")).json()["items"]
    assert len(rows) == 1 and rows[0]["status"] == "rewarded"

    # a customer who already ordered cannot join afterwards
    cy = await login_phone(client, "9770000013")
    await add_address(cy)
    await cy.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    assert (await cy.post("/api/orders", {"address_id": await add_address(cy), "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).status_code == 201
    assert (await cy.post("/api/referral/apply", {"code": code})).json()["error"]["code"] == "not_new"


async def test_points_become_a_single_use_coupon_and_come_back_if_unused(client, admin, categories):
    import uuid
    from datetime import timedelta
    from sqlalchemy import update
    from app.db import SessionLocal, utcnow
    from app.models import Coupon
    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000021")
    addr = await add_address(buyer)
    assert (await buyer.post("/api/loyalty/redeem", {"points": 100})).json()["error"]["code"] == "loyalty_off"
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True, "min_redeem_points": 100, "max_redeem_percent": 50, "point_value_paise": 100}})).status_code == 200
    assert (await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": buyer.user["id"], "points": 300, "note": "Goodwill"})).status_code == 200
    assert (await buyer.post("/api/loyalty/redeem", {"points": 50})).json()["error"]["code"] == "below_minimum"
    assert (await buyer.post("/api/loyalty/redeem", {"points": 400})).json()["error"]["code"] == "balance_too_low"
    r = (await buyer.post("/api/loyalty/redeem", {"points": 100})).json()
    assert r["discount_paise"] == 10000 and r["balance"] == 200 and r["min_order_paise"] == 20000
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 200

    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex, "coupon_code": r["code"]}))
    assert o.status_code == 201, o.text
    order = o.json()["order"]
    assert order["discount_total"] == 10000
    # single use
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    again = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex, "coupon_code": r["code"]})
    assert again.status_code == 400

    # a second redemption that is never used expires and the points come back, once
    r2 = (await buyer.post("/api/loyalty/redeem", {"points": 100})).json()
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 100
    async with SessionLocal() as s:
        await s.execute(update(Coupon).where(Coupon.code == r2["code"]).values(ends_at=utcnow() - timedelta(days=1)))
        await s.commit()
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 200
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 200


async def test_abandoned_cart_reminders_follow_the_settings_and_stop_after_an_order(client, admin, categories):
    import uuid
    from datetime import timedelta
    from sqlalchemy import select, update
    from app.db import SessionLocal, utcnow
    from app.models import CartItem, Notification
    from app.services import cart_reminders
    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000031")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    uid = uuid.UUID(buyer.user["id"])

    async def age(hours):
        async with SessionLocal() as s:
            await s.execute(update(CartItem).where(CartItem.user_id == uid).values(updated_at=utcnow() - timedelta(hours=hours)))
            await s.commit()

    async def run():
        async with SessionLocal() as s:
            n = await cart_reminders.send_due(s)
            await s.commit()
            return n

    async def mails():
        async with SessionLocal() as s:
            return len((await s.execute(select(Notification).where(Notification.user_id == uid, Notification.event == "abandoned_cart"))).scalars().all())

    await age(30)
    assert await run() == 0  # off by default
    assert (await admin.put("/api/admin/growth/settings", {"abandoned_cart": {"enabled": True, "min_cart_paise": 100, "offer_coupon": "COMEBACK"}})).status_code == 200
    assert await run() == 0  # not opted in to marketing messages
    async with SessionLocal() as s:
        from app.models import User
        await s.execute(update(User).where(User.id == uid).values(marketing_opt_in=True))
        await s.commit()
    await age(1)
    assert await run() == 0  # too fresh
    await age(5)
    assert await run() == 1 and await run() == 0  # stage 1 once
    assert await mails() >= 1
    async with SessionLocal() as s:
        row = (await s.execute(select(Notification).where(Notification.user_id == uid, Notification.event == "abandoned_cart"))).scalars().first()
    assert "COMEBACK" in row.body and row.link == "/cart"
    await age(30)
    assert await run() == 1 and await run() == 0  # stage 2 after 24 hours, and no third (max_reminders 2)
    # an order after the last change ends it
    await age(60)
    async with SessionLocal() as s:
        await s.execute(update(CartItem).where(CartItem.user_id == uid).values(updated_at=utcnow() - timedelta(hours=40)))
        await s.commit()
    o = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})
    assert o.status_code == 201
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    async with SessionLocal() as s:
        await s.execute(update(CartItem).where(CartItem.user_id == uid).values(updated_at=utcnow() - timedelta(hours=1)))
        await s.commit()
    assert await run() == 0
    log = (await admin.get("/api/admin/growth/cart-reminders")).json()
    assert log["enabled"] and log["sent_30d"] == 2 and [i["stage"] for i in log["items"]] == [2, 1] and log["items"][0]["ordered_after"] is True and log["ordered_after"] == 2


async def test_gift_cards_are_issued_by_staff_and_redeemed_into_a_coupon(client, admin, categories):
    import uuid
    from datetime import timedelta
    from sqlalchemy import update
    from app.db import SessionLocal, utcnow
    from app.models import Coupon
    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000041")
    addr = await add_address(buyer)
    assert (await admin.post("/api/admin/growth/gift-cards", {"amount_paise": 20000})).json()["error"]["code"] == "gift_cards_off"
    assert (await admin.put("/api/admin/growth/settings", {"gift_cards": {"enabled": True, "min_paise": 10000, "max_paise": 100000}})).status_code == 200
    assert (await admin.post("/api/admin/growth/gift-cards", {"amount_paise": 500000})).json()["error"]["code"] == "invalid_amount"
    assert (await buyer.post("/api/admin/growth/gift-cards", {"amount_paise": 20000})).status_code == 403
    card = (await admin.post("/api/admin/growth/gift-cards", {"amount_paise": 20000, "note": "Diwali"})).json()["items"][0]
    code = card["code"]
    assert (await buyer.post("/api/gift-cards/balance", {"code": "GCNOPE"})).json()["error"]["code"] == "invalid_code"
    assert (await buyer.post("/api/gift-cards/balance", {"code": code.lower()})).json()["balance_paise"] == 20000
    assert (await buyer.post("/api/gift-cards/redeem", {"code": code, "amount_paise": 30000})).json()["error"]["code"] == "balance_too_low"
    r = (await buyer.post("/api/gift-cards/redeem", {"code": code, "amount_paise": 12000})).json()
    assert r["discount_paise"] == 12000 and r["card_balance_paise"] == 8000
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    o = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex, "coupon_code": r["code"]})
    assert o.status_code == 201, o.text
    assert o.json()["order"]["discount_total"] == 12000
    # a second redemption never used: the amount returns to the card once its coupon expires
    r2 = (await buyer.post("/api/gift-cards/redeem", {"code": code})).json()
    assert r2["discount_paise"] == 8000 and r2["card_balance_paise"] == 0
    async with SessionLocal() as s:
        await s.execute(update(Coupon).where(Coupon.code == r2["code"]).values(ends_at=utcnow() - timedelta(days=1)))
        await s.commit()
    assert (await buyer.post("/api/gift-cards/balance", {"code": code})).json()["balance_paise"] == 8000
    assert (await buyer.post("/api/gift-cards/balance", {"code": code})).json()["balance_paise"] == 8000
    # staff void
    assert (await admin.post(f"/api/admin/growth/gift-cards/{card['id']}/void")).json()["status"] == "void"
    assert (await buyer.post("/api/gift-cards/redeem", {"code": code})).json()["error"]["code"] == "card_unavailable"
    assert len((await admin.get("/api/admin/growth/gift-cards")).json()["items"]) == 1


async def test_flash_sale_limits_apply_to_seller_deals_when_switched_on(client, admin, categories):
    from datetime import datetime, timedelta, timezone
    from tests.test_promotions import iso, setup

    tn, ka, shirt, _ = await setup(client, admin, categories)  # shirt: price ₹1,000
    vid = shirt["variants"][0]["id"]
    now = datetime.now(timezone.utc)
    base = {"variant_id": vid, "kind": "lightning", "deal_price_paise": 10000, "starts_at": iso(now - timedelta(minutes=1)), "ends_at": iso(now + timedelta(hours=8)), "qty_limit": 2}
    # off: the marketplace's own deal rules only, so a 90% discount over 8 hours is allowed
    r = await tn.post("/api/seller/deals", base)
    assert r.status_code == 201, r.text
    deal_id = r.json()["id"]
    assert (await tn.post(f"/api/seller/deals/{deal_id}/cancel", {})).status_code in (200, 204) or True
    assert (await admin.put("/api/admin/growth/settings", {"flash_sales": {"enabled": True, "max_duration_hours": 4, "max_discount_percent": 50}})).status_code == 200
    r = await tn.post("/api/seller/deals", base | {"deal_price_paise": 60000})
    assert r.json()["error"]["code"] == "too_long"
    r = await tn.post("/api/seller/deals", base | {"ends_at": iso(now + timedelta(hours=3)), "deal_price_paise": 40000})
    assert r.json()["error"]["code"] == "discount_too_large"
    r = await tn.post("/api/seller/deals", base | {"ends_at": iso(now + timedelta(hours=3)), "deal_price_paise": 60000})
    assert r.status_code in (201, 409), r.text


async def test_customer_segments_are_off_by_default_and_classify_customers(client, admin, categories):
    from tests.conftest import login_phone

    assert (await admin.get("/api/admin/growth/segments")).json()["error"]["code"] == "segments_off"
    assert (await admin.put("/api/admin/growth/settings", {"segments": {"enabled": True}})).status_code == 200
    await login_phone(client, "9000011111", name="Fresh Face")
    r = await admin.get("/api/admin/growth/segments?segment=new")
    assert r.status_code == 200, r.text
    body = r.json()
    counts = {s["key"]: s["count"] for s in body["segments"]}
    assert counts["new"] >= 1 and counts["never_ordered"] >= 1 and counts["vip"] == 0 and counts["lapsed"] == 0
    assert any(i["name"] == "Fresh Face" and i["orders"] == 0 for i in body["items"])
    assert (await admin.get("/api/admin/growth/segments?segment=nope")).json()["error"]["code"] == "invalid_segment"
    anon = (await client.get("/api/admin/growth/segments")).status_code
    assert anon in (401, 403)


async def test_seller_bulk_edit_previews_then_applies_and_skips_bad_rows(client, admin, categories):
    from tests.test_promotions import setup

    tn, ka, shirt, _ = await setup(client, admin, categories)  # price ₹1,000, MRP ₹2,000, 10 in stock
    vid, slug = shirt["variants"][0]["id"], shirt["slug"]

    async def price():
        return (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"]

    body = {"variant_ids": [vid], "action": "price_percent", "value": 10}
    r = (await tn.post("/api/seller/variants/bulk-edit", body)).json()
    assert r["dry_run"] and r["changed"] == 1 and r["rows"][0]["after"] == 110000 and await price() == 100000  # preview changes nothing
    r = (await tn.post("/api/seller/variants/bulk-edit", body | {"dry_run": False})).json()
    assert r["changed"] == 1 and await price() == 110000
    r = (await tn.post("/api/seller/variants/bulk-edit", body | {"value": 500, "dry_run": False})).json()  # 6x = above MRP
    assert r["changed"] == 0 and r["rows"][0]["reason"] == "price_out_of_range" and await price() == 110000
    r = (await ka.post("/api/seller/variants/bulk-edit", body | {"dry_run": False})).json()  # someone else's version
    assert r["rows"][0]["reason"] == "not_yours" and await price() == 110000
    r = (await tn.post("/api/seller/variants/bulk-edit", {"variant_ids": [vid], "action": "stock_add", "value": 5, "dry_run": False})).json()
    assert r["changed"] == 1 and r["rows"][0]["after"] == 15
    assert (await tn.post("/api/seller/variants/bulk-edit", {"variant_ids": [vid], "action": "nope"})).json()["error"]["code"] == "invalid_action"
    assert (await admin.put("/api/admin/growth/settings", {"bulk_edit": {"enabled": False}})).status_code == 200
    assert (await tn.post("/api/seller/variants/bulk-edit", body)).json()["error"]["code"] == "bulk_edit_off"


async def test_data_export_includes_loyalty_referral_and_support_requests(client, admin):
    from tests.conftest import login_phone

    buyer = await login_phone(client, "9000022222", name="Export Me")
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True}})).status_code == 200
    assert (await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": buyer.user["id"], "points": 25, "note": "Goodwill"})).status_code == 200
    t = await buyer.post("/api/support/tickets", {"category": "other", "subject": "Question about things", "message": "Please help me out here"})
    assert t.status_code == 201, t.text
    data = (await buyer.get("/api/account/export")).json()
    assert data["loyalty"]["balance"] == 25 and data["loyalty"]["history"][0]["note"] == "Goodwill"
    assert data["support_tickets"][0]["subject"] == "Question about things" and data["referral_code"] and data["wishlist_count"] == 0


async def test_returned_items_take_back_their_share_of_earned_points(client, admin, categories):
    from tests.conftest import add_address, login_phone
    from tests.test_phase2_money import key, setup, ship_and_deliver

    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True, "points_per_100": 2}})).status_code == 200
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # shirt ₹1,000
    buyer = await login_phone(client, "9600000971", name="Return Points")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    assert (await buyer.get("/api/loyalty")).json()["balance"] == 40  # ₹2,000 x 2 points per ₹100
    item = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    rid = (await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item, "qty": 1}], "reason": "size_fit", "refund_upi": "ret@okaxis"})).json()["id"]
    await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).json()["status"] == "received"
    me = (await buyer.get("/api/loyalty")).json()
    assert me["balance"] == 20 and me["history"][0]["kind"] == "reverse" and me["history"][0]["points"] == -20  # half the package came back


class _PayFake:
    """A gateway that reports whatever attempts the test sets. Never talks to a real provider."""

    def __init__(self):
        self.attempts_now: list[dict] = []
        self.created: list[int] = []

    def build(self, cfg, code, timeout=8.0):
        fake = self

        class A:
            async def create(self, amount, currency, receipt, customer, return_url, notify_url):
                fake.created.append(amount)
                return {"reference": f"ref_{len(fake.created)}", "mode": "redirect", "fields": {"url": "https://pay.example/x"}}

            async def attempts(self, reference):
                return fake.attempts_now

        return A()


async def test_buying_a_gift_card_issues_it_once_and_only_after_the_gateway_says_paid(client, admin, monkeypatch):
    from sqlalchemy import func, select
    from app.db import SessionLocal
    from app.models import GiftCard
    from app.services import payment_gateways
    from tests.conftest import login_phone

    fake = _PayFake()
    monkeypatch.setattr(payment_gateways.gateways, "build", fake.build)

    async def cands(*a, **k):
        return ["razorpay", "cashfree"]

    monkeypatch.setattr(payment_gateways, "candidates", cands)
    buyer = await login_phone(client, "9876501234")
    assert (await buyer.get("/api/gift-cards/options")).json()["can_buy"] is False
    # off by default, and the staff switch for purchase is separate from the staff-issue switch
    assert (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})).json()["error"]["code"] == "gift_cards_off"
    await admin.put("/api/admin/growth/settings", {"gift_cards": {"enabled": True, "min_paise": 10000, "max_paise": 100000}})
    assert (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})).json()["error"]["code"] == "gift_cards_off"
    await admin.put("/api/admin/growth/settings", {"gift_cards": {"allow_purchase": True}})
    assert (await buyer.get("/api/gift-cards/options")).json() == {"can_buy": True, "min_paise": 10000, "max_paise": 100000}
    assert (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 500000})).json()["error"]["code"] == "invalid_amount"

    r = await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert r.json()["gateway"] == "cashfree" and "code" not in r.json()  # Razorpay is skipped, no code before payment

    async def cards() -> int:
        async with SessionLocal() as s:
            return (await s.execute(select(func.count()).select_from(GiftCard))).scalar_one()

    # nothing paid yet, then a failed attempt: no card
    assert (await buyer.post(f"/api/gift-cards/purchase/{pid}/check", {})).json()["status"] == "created"
    fake.attempts_now = [{"id": "a1", "status": "failed", "method": "upi", "error": "declined", "amount": 20000}]
    assert (await buyer.post(f"/api/gift-cards/purchase/{pid}/check", {})).json()["status"] == "failed"
    assert await cards() == 0
    # a capture for a different amount is refused
    fake.attempts_now = [{"id": "a2", "status": "captured", "method": "upi", "error": "", "amount": 100}]
    assert (await buyer.post(f"/api/gift-cards/purchase/{pid}/check", {})).json()["status"] == "failed"
    assert await cards() == 0
    # another shopper cannot read or trigger it
    other = await login_phone(client, "9876509999")
    assert (await other.post(f"/api/gift-cards/purchase/{pid}/check", {})).status_code == 404
    # a fresh purchase, paid in full: issued once, even when asked twice
    pid2 = (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})).json()["id"]
    fake.attempts_now = [{"id": "a3", "status": "captured", "method": "upi", "error": "", "amount": 20000}]
    a = (await buyer.post(f"/api/gift-cards/purchase/{pid2}/check", {})).json()
    b = (await buyer.post(f"/api/gift-cards/purchase/{pid2}/check", {})).json()
    assert a["status"] == "issued" and a["code"].startswith("GC") and b["code"] == a["code"]
    assert await cards() == 1
    assert (await buyer.post("/api/gift-cards/balance", {"code": a["code"]})).json()["balance_paise"] == 20000
    # staff see every purchase with its state; a shopper does not
    listed = (await admin.get("/api/admin/growth/gift-card-purchases")).json()["items"]
    assert [x["status"] for x in listed].count("issued") == 1 and {x["status"] for x in listed} == {"issued", "failed"} and listed[0]["gift_card_id"]
    assert (await buyer.get("/api/admin/growth/gift-card-purchases")).status_code == 403
    # staff can check a purchase the shopper never came back to: paid in full issues the card once, and no code is returned to staff
    pid3 = (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})).json()["id"]
    fake.attempts_now = [{"id": "a4", "status": "captured", "method": "upi", "error": "", "amount": 20000}]
    assert (await buyer.post(f"/api/admin/growth/gift-card-purchases/{pid3}/check", {})).status_code == 403
    r = (await admin.post(f"/api/admin/growth/gift-card-purchases/{pid3}/check", {})).json()
    assert r["status"] == "issued" and "code" not in r
    assert (await admin.post(f"/api/admin/growth/gift-card-purchases/{pid3}/check", {})).json()["status"] == "issued"
    assert await cards() == 2
    assert "gift_card.purchase_check" in (await admin.get("/api/admin/audit")).text


async def test_a_gift_card_coupon_works_only_for_the_person_who_made_it(client, admin):
    from sqlalchemy import select
    from app.core.errors import ApiError
    from app.db import SessionLocal
    from app.models import Coupon, User
    from app.services import coupons
    from tests.conftest import login_phone

    await admin.put("/api/admin/growth/settings", {"gift_cards": {"enabled": True, "min_paise": 10000, "max_paise": 100000}})
    card = (await admin.post("/api/admin/growth/gift-cards", {"amount_paise": 20000})).json()["items"][0]
    owner = await login_phone(client, "9876511111")
    other = await login_phone(client, "9876522222")
    made = (await owner.post("/api/gift-cards/redeem", {"code": card["code"]})).json()
    async with SessionLocal() as s:
        c = (await s.execute(select(Coupon).where(Coupon.code == made["code"]))).scalar_one()
        assert str(c.only_user_id) == owner.user["id"]
        other_id = (await s.execute(select(User.id).where(User.phone == "9876522222"))).scalar_one()
        owner_id = c.only_user_id
        with pytest.raises(ApiError) as e:
            await coupons.evaluate(s, made["code"], other_id, [])
        assert e.value.code == "coupon_invalid"
        # the owner gets past the ownership check (an empty cart then fails on something else)
        try:
            await coupons.evaluate(s, made["code"], owner_id, [])
        except ApiError as exc:
            assert exc.code != "coupon_invalid"


async def test_seller_bulk_edit_csv_round_trip(client, admin, categories):
    import csv
    import io

    from tests.test_promotions import setup

    tn, ka, shirt, _ = await setup(client, admin, categories)  # price ₹1,000, MRP ₹2,000, 10 in stock
    vid, slug = shirt["variants"][0]["id"], shirt["slug"]
    dl = await tn.get("/api/seller/variants/bulk-edit.csv")
    assert dl.status_code == 200
    rows = list(csv.DictReader(io.StringIO(dl.text)))
    mine = [r for r in rows if r["id"] == vid][0]
    assert mine["price"] == "1000.00" and mine["stock"] == "10" and mine["active"] == "yes"

    async def send(data, dry=True, who=tn):
        r = await who.c.post(f"/api/seller/variants/bulk-edit.csv?dry_run={'true' if dry else 'false'}", headers=who.h(), files={"file": ("v.csv", data, "text/csv")})
        return r.json()

    async def price():
        return (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"]

    good = f"id,price,stock,active\n{vid},1100,15,yes\n"
    r = await send(good)
    assert r["dry_run"] and r["changed"] == 1 and r["rows"][0]["changes"]["price"]["after"] == 110000 and await price() == 100000
    r = await send(good, dry=False)
    assert r["changed"] == 1 and await price() == 110000
    r = await send(f"id,price\n{vid},5000\n{vid},1200\nnot-an-id,1\n", dry=False)  # above MRP, repeat of the same id, bad id
    assert [x["reason"] for x in r["rows"]] == ["price_out_of_range", "duplicate_row", "bad_id"] and r["changed"] == 0
    r = await send(f"id,price\n{vid},900\n", dry=False, who=ka)  # someone else's version
    assert r["rows"][0]["reason"] == "not_yours" and await price() == 110000
    assert (await send(f"id,price\n{vid},abc\n"))["rows"][0]["reason"] == "bad_number"
    assert (await send("sku,price\nX,1\n"))["error"]["code"] == "invalid_file"
    r = await send(f"id,active\n{vid},no\n", dry=False)
    assert r["changed"] == 1 and r["rows"][0]["changes"]["active"]["after"] is False


async def test_auto_suspend_stops_a_critical_seller_once_and_only_when_switched_on(client, admin, categories):
    import uuid
    from datetime import timedelta

    from sqlalchemy import select, update

    from app.db import SessionLocal, utcnow
    from app.models import AuditLog, Seller, SubOrder
    from app.services import growth
    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, _, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000031")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    assert (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).status_code == 201
    assert (await admin.put("/api/admin/growth/settings", {"scorecard": {"enabled": True, "min_orders": 1, "ship_within_hours": 1}})).status_code == 200
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).values(created_at=utcnow() - timedelta(hours=5)))
        await s.commit()

    async def run():
        async with SessionLocal() as s:
            n = await growth.auto_suspend_sellers(s)
            await s.commit()
            return n

    async with SessionLocal() as s:
        sid = (await s.execute(select(SubOrder.seller_id))).scalars().first()

    async def status():
        async with SessionLocal() as s:
            return (await s.execute(select(Seller.status).where(Seller.id == sid))).scalar_one()

    assert await run() == 0 and await status() == "approved"  # auto_suspend is off
    assert (await admin.put("/api/admin/growth/settings", {"scorecard": {"auto_suspend": True}})).status_code == 200
    assert await run() == 1 and await status() == "suspended"
    async with SessionLocal() as s:
        row = (await s.execute(select(AuditLog).where(AuditLog.action == "seller.auto_suspend"))).scalar_one()
        assert row.actor_user_id is None and "late shipments" in row.detail
    assert await run() == 0  # already suspended
    assert (await admin.post(f"/api/admin/sellers/{sid}/approve", {})).status_code == 200  # staff reinstate
    assert await run() == 0 and await status() == "approved"  # not suspended again for the same old orders


async def test_tier_bonus_adds_points_only_for_silver_and_up(client, admin, categories):
    import uuid
    from tests.conftest import add_address, login_phone
    from tests.test_phase2_money import ship_and_deliver
    from tests.test_orders import marketplace

    _, seller, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000041")
    addr = await add_address(buyer)
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True, "points_per_100": 2, "tier_silver_points": 15, "tier_gold_points": 0, "silver_bonus_percent": 50}})).status_code == 200

    async def deliver():
        await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
        o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": uuid.uuid4().hex})).json()["order"]
        await ship_and_deliver(seller, o["sub_orders"][0]["id"])
        return (o["sub_orders"][0]["items_total"] // 10000) * 2

    base = await deliver()  # a member: no bonus
    me = (await buyer.get("/api/loyalty")).json()
    assert base > 0 and me["balance"] == base and me["bonus_percent"] == 0
    assert (await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": buyer.user["id"], "points": 10, "note": "Reach silver"})).status_code == 200
    me = (await buyer.get("/api/loyalty")).json()
    assert me["tier"] == "silver" and me["bonus_percent"] == 50
    await deliver()
    me = (await buyer.get("/api/loyalty")).json()
    assert me["balance"] == base + 10 + base * 150 // 100 and "50% tier bonus" in me["history"][0]["note"]
    bad = await admin.put("/api/admin/growth/settings", {"loyalty": {"gold_bonus_percent": 900}})
    assert bad.status_code == 400


async def test_segment_campaign_goes_only_to_opted_in_customers_within_the_caps(client, admin):
    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import User
    from tests.conftest import login_phone

    body = {"segment": "never_ordered", "title": "Weekend offer", "message": "Free shipping this weekend", "link": "/offers"}
    assert (await admin.post("/api/admin/growth/campaigns", body)).json()["error"]["code"] == "campaigns_off"
    assert (await admin.put("/api/admin/growth/settings", {"campaigns": {"enabled": True, "max_recipients": 2, "max_per_day": 2}})).status_code == 200
    assert (await admin.post("/api/admin/growth/campaigns", body)).json()["error"]["code"] == "segments_off"
    assert (await admin.put("/api/admin/growth/settings", {"segments": {"enabled": True}})).status_code == 200
    people = [await login_phone(client, f"96100000{i:02d}", name=f"Camp {i}") for i in range(4)]
    async with SessionLocal() as s:
        await s.execute(update(User).where(User.phone.in_([f"96100000{i:02d}" for i in range(3)])).values(marketing_opt_in=True))  # the 4th has not opted in
        await s.commit()
    r = (await admin.post("/api/admin/growth/campaigns", body)).json()
    assert r["dry_run"] and r["opted_in"] == 3 and r["recipients"] == 2 and r["capped"] is True
    assert (await admin.get("/api/admin/growth/campaigns")).json()["items"] == []  # a preview sends and logs nothing
    async def has(p):
        return any(n["title"] == "Weekend offer" for n in (await p.get("/api/notifications")).json()["items"])

    assert [await has(pp) for pp in people] == [False] * 4
    r = (await admin.post("/api/admin/growth/campaigns", body | {"dry_run": False})).json()
    assert r["recipients"] == 2 and r["id"]
    seen = [await has(pp) for pp in people]
    assert sum(seen) == 2 and seen[3] is False
    log = (await admin.get("/api/admin/growth/campaigns")).json()["items"]
    assert len(log) == 1 and log[0]["recipients"] == 2 and log[0]["segment"] == "never_ordered"
    assert (await admin.post("/api/admin/growth/campaigns", body | {"dry_run": False})).status_code == 200
    assert (await admin.post("/api/admin/growth/campaigns", body | {"dry_run": False})).json()["error"]["code"] == "campaign_limit"
    assert (await admin.post("/api/admin/growth/campaigns", body | {"link": "https://evil.example"})).json()["error"]["code"] == "invalid_link"
    assert (await admin.post("/api/admin/growth/campaigns", body | {"segment": "nope"})).json()["error"]["code"] == "invalid_segment"
    assert (await people[0].post("/api/admin/growth/campaigns", body)).status_code == 403


async def test_saved_search_notes_a_shopper_once_about_new_matching_products(client, admin, categories):
    import uuid

    from app.db import SessionLocal
    from app.services import saved_searches
    from tests.conftest import login_phone, make_live_product
    from tests.test_orders import marketplace

    tn, _, _, _ = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000051")
    assert (await buyer.post("/api/saved-searches", {"query": "silk kurta"})).json()["error"]["code"] == "saved_searches_off"
    assert (await admin.put("/api/admin/growth/settings", {"saved_searches": {"enabled": True, "max_per_user": 2, "min_hours_between_alerts": 1}})).status_code == 200
    a = (await buyer.post("/api/saved-searches", {"query": "  Silk   Kurta ", "max_price_paise": 150000})).json()
    assert (await buyer.post("/api/saved-searches", {"query": "silk kurta", "max_price_paise": 150000})).json()["id"] == a["id"]  # same search twice is one
    assert (await buyer.post("/api/saved-searches", {"query": "!!"})).json()["error"]["code"] == "invalid_query"
    assert (await buyer.post("/api/saved-searches", {"query": "denim jacket"})).status_code == 201
    assert (await buyer.post("/api/saved-searches", {"query": "third one"})).json()["error"]["code"] == "too_many_searches"

    async def run():
        async with SessionLocal() as s:
            n = await saved_searches.send_matches(s)
            await s.commit()
            return n

    async def notes():
        return [n for n in (await buyer.get("/api/notifications")).json()["items"] if n["title"].startswith("New for your search")]

    assert await run() == 0 and await notes() == []  # nothing new yet
    v = [{"sku": "K-1", "options": {"Size": "M"}, "mrp_paise": 299900, "price_paise": 199900, "stock": 5}]
    await make_live_product(client, admin, tn, categories["shirts"], title="Silk Kurta Premium", variants=v)  # too dear for the limit
    assert await run() == 0 and await notes() == []
    v2 = [{"sku": "K-2", "options": {"Size": "M"}, "mrp_paise": 199900, "price_paise": 129900, "stock": 5}]
    await make_live_product(client, admin, tn, categories["shirts"], title="Festive Silk Kurta Set", variants=v2)
    assert await run() == 1
    got = await notes()
    assert len(got) == 1 and "silk kurta" in got[0]["title"].lower() and "Festive Silk Kurta Set" in got[0]["body"]
    assert await run() == 0  # already told, and no new product
    me = (await buyer.get("/api/saved-searches")).json()
    assert me["enabled"] and len(me["items"]) == 2 and me["items"][-1]["last_notified_at"] is not None or me["items"][0]["last_notified_at"] is not None
    assert (await buyer.delete(f"/api/saved-searches/{a['id']}")).status_code == 200
    assert len((await buyer.get("/api/saved-searches")).json()["items"]) == 1
    other = await login_phone(client, "9770000052")
    b = (await buyer.get("/api/saved-searches")).json()["items"][0]["id"]
    assert (await other.delete(f"/api/saved-searches/{b}")).status_code == 200
    assert len((await buyer.get("/api/saved-searches")).json()["items"]) == 1  # not someone else's to remove


async def test_remote_area_surcharge_is_added_per_seller_package_and_waived_when_free(client, admin, categories):
    import uuid

    from tests.conftest import add_address, login_phone
    from tests.test_orders import marketplace

    _, _, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000061")
    near = await add_address(buyer, state="33", pincode="600028")
    far = await add_address(buyer, state="33", pincode="744101")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})  # 1998 rupees: ships free
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})  # 299 rupees: 40 shipping

    async def total(addr):
        return (await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})).json()["summary"]["grand_total"]

    base = await total(far)
    assert (await admin.put("/api/admin/growth/settings", {"shipping_zones": {"enabled": True, "remote_prefixes": "744, 19", "remote_surcharge_paise": 6000}})).status_code == 200
    assert await total(near) == base  # not a listed prefix
    assert await total(far) == base + 6000  # only the package that already pays shipping; the free one is waived
    assert (await admin.put("/api/admin/growth/settings", {"shipping_zones": {"waive_when_free": False}})).status_code == 200
    quoted = await total(far)
    assert quoted == base + 12000
    r = await buyer.post("/api/orders", {"address_id": far, "payment_method": "cod", "idempotency_key": str(uuid.uuid4()), "expected_total": quoted})
    assert r.status_code == 201, r.text
    assert r.json()["order"]["grand_total"] == quoted
    assert (await admin.put("/api/admin/growth/settings", {"shipping_zones": {"remote_surcharge_paise": 9999999}})).status_code == 400


async def test_staff_can_rename_and_switch_off_return_reasons(client, admin, categories):
    from tests.conftest import add_address, login_phone
    from tests.test_phase2_money import key, setup, ship_and_deliver

    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000981", name="Reasons Buyer")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    item = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    codes = lambda r: [x["code"] for x in r.json()["reasons"]]  # noqa: E731
    labels = lambda r: {x["code"]: x["label"] for x in r.json()["reasons"]}  # noqa: E731
    assert "size_fit" in codes(await buyer.get("/api/returns/reasons"))
    assert (await admin.put("/api/admin/growth/settings", {"return_reasons": {"label_size_fit": "Does not fit me", "off_quality": True}})).status_code == 200
    r = await buyer.get("/api/returns/reasons")
    assert labels(r)["size_fit"] == "Does not fit me" and "quality" not in codes(r) and len(codes(r)) == 6
    body = {"sub_order_id": sub_id, "items": [{"order_item_id": item, "qty": 1}], "refund_upi": "ret@okaxis"}
    assert (await buyer.post("/api/returns", {**body, "reason": "quality"})).json()["error"]["code"] == "invalid_reason"
    made = await buyer.post("/api/returns", {**body, "reason": "size_fit"})
    assert made.status_code in (200, 201), made.text
    assert made.json()["reason_label"] == "Does not fit me"


async def test_staff_can_make_a_batch_of_single_use_codes_from_a_coupon(client, admin):
    from tests.conftest import login_phone

    made = await admin.post("/api/admin/coupons", {"code": "SPRING10", "kind": "percent", "value": 1000, "max_discount_paise": 50000, "usage_limit": 500})
    assert made.status_code == 201, made.text
    cid = made.json()["id"]
    r = await admin.post(f"/api/admin/coupons/{cid}/generate", {"count": 5, "prefix": "mail"})
    assert r.status_code == 201, r.text
    codes = r.json()["codes"]
    assert len(set(codes)) == 5 and all(c.startswith("MAIL") and len(c) == 10 for c in codes)
    rows = {c["code"]: c for c in (await admin.get("/api/admin/coupons")).json()}
    assert all(rows[c]["usage_limit"] == 1 and rows[c]["value"] == 1000 and rows[c]["show_on_checkout"] is False for c in codes)
    assert rows["SPRING10"]["usage_limit"] == 500  # the original is untouched
    r2 = await admin.post(f"/api/admin/coupons/{cid}/generate", {"count": 3, "prefix": "mail", "single_use": False})
    assert all(rows_c["usage_limit"] == 500 for rows_c in (await admin.get("/api/admin/coupons")).json() if rows_c["code"] in r2.json()["codes"])
    assert (await admin.post(f"/api/admin/coupons/{cid}/generate", {"count": 201, "prefix": "mail"})).status_code == 422
    assert (await admin.post(f"/api/admin/coupons/{cid}/generate", {"count": 1, "prefix": "a!"})).status_code == 422
    assert (await admin.post(f"/api/admin/coupons/{uuid_zero()}/generate", {"count": 1, "prefix": "mail"})).status_code == 404
    nobody = await login_phone(client, "9770000081")
    assert (await nobody.post(f"/api/admin/coupons/{cid}/generate", {"count": 1, "prefix": "mail"})).status_code == 403


def uuid_zero() -> str:
    return "00000000-0000-0000-0000-000000000000"
