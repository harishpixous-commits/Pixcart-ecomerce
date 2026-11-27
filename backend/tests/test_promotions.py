"""Deals (lightning, deal of the day, limited time), sponsored products (seller advertising), the discovery pages
(Today's Deals, Bestsellers, Hot New Releases, Coupons, related, buy again) and the new storefront blocks."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text, update

from app.db import SessionLocal
from app.models import AdStat, Deal, LedgerEntry, OrderItem
from app.services import deals as deals_svc
from tests.conftest import add_address, login_phone
from tests.test_gallery import body_from
from tests.test_phase2_money import key, setup, ship_and_deliver


def iso(dt: datetime) -> str:
    return dt.isoformat()


async def order(client, product, phone, qty=1):
    buyer = await login_phone(client, phone, name=f"Shopper {phone[-2:]}")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": product["variants"][0]["id"], "qty": qty})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return buyer, o["sub_orders"][0]["id"]


async def test_lightning_deal_price_switch_and_quantity_limit(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)  # shirt: price ₹1,000, MRP ₹2,000, 10 in stock
    vid, slug = shirt["variants"][0]["id"], shirt["slug"]
    opts = (await tn.get("/api/seller/deals/options")).json()
    assert any(v["id"] == vid for p in opts["products"] for v in p["variants"])
    now = datetime.now(timezone.utc)
    base = {"variant_id": vid, "kind": "lightning", "deal_price_paise": 80000, "starts_at": iso(now - timedelta(minutes=1)),
            "ends_at": iso(now + timedelta(hours=2)), "qty_limit": 2}
    assert (await tn.post("/api/seller/deals", base | {"deal_price_paise": 95000})).json()["error"]["code"] == "discount_too_small"
    assert (await tn.post("/api/seller/deals", base | {"qty_limit": None})).json()["error"]["code"] == "qty_required"
    assert (await tn.post("/api/seller/deals", base | {"qty_limit": 50})).json()["error"]["code"] == "qty_above_stock"
    assert (await tn.post("/api/seller/deals", base | {"ends_at": iso(now + timedelta(hours=13))})).json()["error"]["code"] == "too_long"
    assert (await ka.post("/api/seller/deals", base)).json()["error"]["code"] == "invalid_variant"  # not their product
    r = await tn.post("/api/seller/deals", base)
    assert r.status_code == 201 and r.json()["status"] == "pending"
    deal_id = r.json()["id"]
    assert (await tn.post("/api/seller/deals", base)).status_code == 409  # one deal at a time per version
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"] == 100000  # waits for staff

    queue = (await admin.get("/api/admin/deals")).json()
    assert queue["items"][0]["id"] == deal_id and queue["items"][0]["discount_pct"] == 60
    assert "image" in queue["items"][0] and queue["items"][0]["stock"] == 10
    assert (await admin.get("/api/admin/dashboard")).json()["deals_pending"] == 1  # admin menu count
    assert (await admin.post(f"/api/admin/deals/{deal_id}/approve", {})).json()["status"] == "active"
    assert (await tn.get("/api/seller/badges")).json()["deals_running"] == 1
    page = (await client.get(f"/api/catalog/products/{slug}")).json()
    assert page["variants"][0]["price"] == 80000 and page["deal"]["kind"] == "lightning" and page["deal"]["claimed_pct"] == 0
    assert page["deal"]["show_countdown"] is True  # the clock shows unless admin switches it off (Growth > Flash sales)
    assert (await admin.put("/api/admin/growth/settings", {"flash_sales": {"show_countdown": False}})).status_code == 200
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["deal"]["show_countdown"] is False
    assert (await admin.put("/api/admin/growth/settings", {"flash_sales": {"show_countdown": True}})).status_code == 200
    live = (await client.get("/api/catalog/deals")).json()
    assert live["items"][0]["slug"] == slug and live["items"][0]["deal"]["label"] == "Lightning deal" and live["facets"]["kinds"]["lightning"] == 1
    assert (await client.get("/api/catalog/products", params={"deal": True})).json()["total"] == 1

    # the seller cannot change the price while the deal runs
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    body = body_from(detail)
    body["variants"][0]["price_paise"] = 70000
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", body)).json()["error"]["code"] == "deal_running"
    assert (await tn.patch(f"/api/seller/variants/{vid}", {"price_paise": 70000})).json()["error"]["code"] == "deal_running"

    # a shopper takes both deal units at the deal price; the deal closes and the regular price is back
    await order(client, shirt, "9600000041", qty=2)
    async with SessionLocal() as s:
        assert (await s.execute(select(OrderItem.unit_price))).scalars().all() == [80000]
    mine = (await tn.get("/api/seller/deals")).json()["items"][0]
    assert mine["status"] == "ended" and mine["sold_qty"] == 2 and "claimed" in mine["note"]
    page = (await client.get(f"/api/catalog/products/{slug}")).json()
    assert page["variants"][0]["price"] == 100000 and page["deal"] is None


async def test_deal_approval_schedule_cancel_and_switches(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    vid, slug = shirt["variants"][0]["id"], shirt["slug"]
    now = datetime.now(timezone.utc)
    limited = {"variant_id": vid, "kind": "limited", "deal_price_paise": 85000, "starts_at": iso(now - timedelta(minutes=1)),
               "ends_at": iso(now + timedelta(days=3))}
    rid = (await tn.post("/api/seller/deals", limited)).json()["id"]
    assert (await admin.post(f"/api/admin/deals/{rid}/reject", {"reason": ""})).json()["error"]["code"] == "reason_required"
    assert (await admin.post(f"/api/admin/deals/{rid}/reject", {"reason": "Price looks inflated"})).json()["status"] == "rejected"
    assert (await tn.get("/api/seller/deals", params={"status": "rejected"})).json()["items"][0]["note"] == "Price looks inflated"
    everything = (await admin.get("/api/admin/deals", params={"status": "all"})).json()  # the admin's "All" tab
    assert everything["total"] == 1 and everything["items"][0]["status"] == "rejected"
    assert (await admin.get("/api/admin/deals")).json()["total"] == 0  # default: waiting for approval

    # without approval a deal starts at once; cancelling restores the price
    await admin.put("/api/admin/settings", {"deals_need_approval": False})
    d = (await tn.post("/api/seller/deals", limited)).json()
    assert d["status"] == "active" and (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"] == 85000
    assert (await tn.post(f"/api/seller/deals/{d['id']}/cancel")).status_code == 200
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"] == 100000

    # a scheduled deal waits for its start time, runs, then ends on time
    later = (await tn.post("/api/seller/deals", limited | {"kind": "deal_of_day", "starts_at": iso(now + timedelta(hours=2)),
                                                            "ends_at": iso(now + timedelta(hours=20))})).json()
    assert later["status"] == "approved"
    upcoming = (await client.get("/api/catalog/deals", params={"tab": "upcoming"})).json()
    assert upcoming["items"][0]["slug"] == slug and upcoming["items"][0]["starts_at"]
    async with SessionLocal() as s:
        await s.execute(update(Deal).where(Deal.status == "approved").values(starts_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
        await deals_svc.sync(s, force=True)
        await s.commit()
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["deal"]["label"] == "Deal of the Day"
    async with SessionLocal() as s:
        await s.execute(update(Deal).where(Deal.status == "active").values(ends_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        await deals_svc.sync(s, force=True)
        await s.commit()
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"] == 100000

    # admin can stop a running deal; switching deals off blocks new ones
    d = (await tn.post("/api/seller/deals", limited | {"starts_at": iso(datetime.now(timezone.utc))})).json()
    assert (await admin.post(f"/api/admin/deals/{d['id']}/cancel", {"reason": "Brand complaint about pricing"})).json()["status"] == "cancelled"
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["variants"][0]["price"] == 100000
    await admin.put("/api/admin/settings", {"feature_deals": False})
    assert (await tn.post("/api/seller/deals", limited | {"starts_at": iso(datetime.now(timezone.utc))})).json()["error"]["code"] == "deals_off"
    assert (await admin.put("/api/admin/settings", {"deal_min_discount_pct": 0})).status_code == 400


async def test_sponsored_products_serving_clicks_budget_attribution_and_billing(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    slug = shirt["slug"]
    camp = {"name": "Shirt push", "product_ids": [shirt["id"]], "placements": ["search", "product", "home"], "bid_paise": 5000, "daily_budget_paise": 10000}
    assert (await tn.post("/api/seller/ads", camp | {"bid_paise": 100})).json()["error"]["code"] == "bid_too_low"
    assert (await tn.post("/api/seller/ads", camp | {"daily_budget_paise": 5000})).json()["error"]["code"] == "budget_too_low"
    assert (await tn.post("/api/seller/ads", camp | {"product_ids": [phone["id"]]})).json()["error"]["code"] == "invalid_products"
    assert (await tn.post("/api/seller/ads", camp | {"daily_budget_paise": 4000})).status_code == 422  # less than one click
    c = (await tn.post("/api/seller/ads", camp | {"keywords": ["Kurta ", "kurta"]})).json()
    assert c["status"] == "pending" and c["keywords"] == ["kurta"]
    assert (await admin.get("/api/admin/dashboard")).json()["ads_pending"] == 1
    assert (await client.get("/api/ads/serve", params={"placement": "search", "q": "handloom shirt"})).json()["items"] == []
    assert (await admin.post(f"/api/admin/ads/{c['id']}/approve", {})).json()["status"] == "active"

    # sponsored at the top of matching search results, labelled and linked through the click counter
    s = (await client.get("/api/catalog/products", params={"q": "handloom shirt"})).json()
    ad = s["sponsored"][0]
    assert ad["slug"] == slug and ad["sponsored"] is True and ad["href"].startswith("/api/ads/click?t=")
    assert (await client.get("/api/ads/serve", params={"placement": "search", "q": "kurta"})).json()["items"][0]["slug"] == slug  # keyword
    assert (await client.get("/api/ads/serve", params={"placement": "home"})).json()["items"][0]["slug"] == slug
    assert (await client.get("/api/ads/serve", params={"placement": "product", "product": slug})).json()["items"] == []  # not on itself
    token = ad["href"].split("t=")[1]
    r = await client.get("/api/ads/click", params={"t": token}, headers={"user-agent": "A"}, follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith(f"/p/{slug}?sp=")
    click_id = r.headers["location"].split("sp=")[1]
    for agent in ("A", "B"):  # the same link again, whatever the browser: opens the product, free, counted as invalid
        again = await client.get("/api/ads/click", params={"t": token}, headers={"user-agent": agent}, follow_redirects=False)
        assert again.headers["location"] == f"/p/{slug}"
    bad = await client.get("/api/ads/click", params={"t": token[:-3] + "xyz"}, follow_redirects=False)
    assert bad.headers["location"] == "/"
    client.cookies.clear()  # another shopper clicks the ad they were shown
    home = (await client.get("/api/ads/serve", params={"placement": "home"})).json()["items"][0]["href"].split("t=")[1]
    assert (await client.get("/api/ads/click", params={"t": home}, follow_redirects=False)).headers["location"].startswith(f"/p/{slug}?sp=")
    mine = (await tn.get("/api/seller/ads")).json()["campaigns"][0]
    assert mine["stats"]["clicks"] == 2 and mine["stats"]["invalid_clicks"] == 2
    assert mine["spend_paise"] == 10000 and mine["spent_today_paise"] == 10000
    # the daily budget is used up: no more ads today
    assert (await client.get("/api/ads/serve", params={"placement": "home"})).json()["items"] == []

    # the shopper who clicked buys within 7 days: an ad sale
    buyer = await login_phone(client, "9600000051", name="Ad Shopper")
    assert (await buyer.post(f"/api/ads/clicks/{click_id}/claim")).status_code == 200
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    stats = (await tn.get("/api/seller/ads")).json()["campaigns"][0]["stats"]
    assert stats["orders"] == 1 and stats["sales"] == 100000 and stats["acos"] == 10.0

    # once the day is over the spend plus GST goes to the seller's ledger, once
    async with SessionLocal() as s:
        await s.execute(text("UPDATE ad_stats SET day = day - 1"))
        await s.commit()
    assert (await admin.post("/api/admin/ads/bill")).json()["posted"] == 1
    assert (await admin.post("/api/admin/ads/bill")).json()["posted"] == 0
    async with SessionLocal() as s:
        entry = (await s.execute(select(LedgerEntry).where(LedgerEntry.kind == "ad_spend"))).scalar_one()
        assert entry.amount == -11800 and (await s.execute(select(AdStat.billed))).scalars().all() == [True]

    # controls
    assert (await tn.post(f"/api/seller/ads/{c['id']}/pause")).json()["status"] == "paused"
    assert (await tn.post(f"/api/seller/ads/{c['id']}/resume")).json()["status"] == "active"
    assert (await admin.post(f"/api/admin/ads/{c['id']}/reject", {"reason": "no"})).json()["error"]["code"] == "reason_required"
    assert (await admin.post(f"/api/admin/ads/{c['id']}/reject", {"reason": "Misleading product"})).json()["status"] == "rejected"
    assert (await ka.get(f"/api/seller/ads/{c['id']}/report")).status_code == 404
    rep = (await tn.get(f"/api/seller/ads/{c['id']}/report")).json()
    assert rep["products"][0]["clicks"] == 2
    overview = (await admin.get("/api/admin/ads")).json()
    assert overview["revenue_30d"]["spend"] == 10000 and overview["items"][0]["seller"] == "Kovai Textiles"
    assert (await admin.get("/api/admin/ads", params={"status": "all"})).json()["total"] == 1
    assert (await admin.get("/api/admin/ads", params={"status": "active"})).json()["total"] == 0  # it was rejected
    await admin.put("/api/admin/settings", {"feature_ads": False})
    assert (await tn.post("/api/seller/ads", camp)).json()["error"]["code"] == "ads_off"


async def test_discovery_pages_and_storefront_blocks(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer, sub = await order(client, shirt, "9600000061")
    await ship_and_deliver(tn, sub)
    top = (await client.get("/api/catalog/top")).json()
    fashion = next(sec for sec in top["sections"] if sec["category"]["slug"] == "fashion")
    assert fashion["items"][0]["slug"] == shirt["slug"]
    ranked = (await client.get("/api/catalog/top", params={"category": "mens-shirts"})).json()
    assert ranked["items"][0]["slug"] == shirt["slug"] and ranked["breadcrumbs"][0]["slug"] == "fashion"
    assert len((await client.get("/api/catalog/top", params={"list": "new"})).json()["sections"]) == 2
    await admin.put("/api/admin/settings", {"new_release_days": 7})

    await admin.post("/api/admin/coupons", {"code": "WELCOME10", "kind": "percent", "value": 1000, "max_discount_paise": 15000, "per_user_limit": 1})
    await tn.post("/api/seller/coupons", {"code": "KOVAI100", "kind": "flat", "value": 10000, "min_order_paise": 50000})
    mine = (await tn.get("/api/seller/coupons")).json()[0]
    assert (await tn.put(f"/api/seller/coupons/{mine['id']}", {"code": "KOVAI100", "kind": "flat", "value": 10000, "min_order_paise": 50000})).status_code == 200
    from sqlalchemy import select
    from app.db import SessionLocal
    from app.models import AuditLog
    async with SessionLocal() as s:
        rows = (await s.execute(select(AuditLog.action).where(AuditLog.entity_id == "KOVAI100"))).scalars().all()
    assert "coupon.create" in rows and "coupon.update" in rows  # a seller's change to a coupon is logged
    coupons = (await client.get("/api/catalog/coupons")).json()["items"]
    assert [x["code"] for x in coupons] == ["WELCOME10", "KOVAI100"] and coupons[1]["shop_link"] == "/search?seller=kovai-textiles"

    assert shirt["slug"] in [x["slug"] for x in (await buyer.get("/api/orders/buy-again")).json()["items"]]
    rel = (await client.get("/api/catalog/related", params={"ids": phone["id"]})).json()["items"]
    assert phone["slug"] not in [x["slug"] for x in rel]
    card = (await client.get("/api/catalog/products", params={"q": "handloom"})).json()["items"][0]
    assert card["variant_id"] == shirt["variants"][0]["id"] and card["variant_count"] == 1
    est = (await client.get("/api/catalog/products", params={"q": "handloom", "pincode": "600028", "delivery": 7})).json()
    assert est["total"] == 1 and est["items"][0]["delivery_by"]
    assert (await client.get("/api/catalog/products", params={"q": "handloom", "pincode": "600028", "delivery": 1})).json()["total"] == 0

    # new home blocks are validated
    bad_cards = {"kind": "cards", "config": {"cards": [{"title": "Picks", "mode": "tiles", "tiles": []}]}}
    assert (await admin.post("/api/admin/storefront/sections", bad_cards)).json()["error"]["code"] == "invalid_section"
    cards = {"kind": "cards", "config": {"cards": [
        {"title": "Under ₹999", "mode": "tiles", "tiles": [{"label": "Shirts", "link": "/c/mens-shirts", "badge": "Under ₹999"}]},
        {"title": "Top picks", "mode": "products", "source": "bestsellers", "link": "javascript:alert(1)"}]}}
    assert (await admin.post("/api/admin/storefront/sections", cards)).status_code == 400
    cards["config"]["cards"][1]["link"] = "/bestsellers"
    assert (await admin.post("/api/admin/storefront/sections", cards)).status_code == 201
    assert (await admin.post("/api/admin/storefront/sections", {"kind": "countdown", "config": {"ends_at": "soon"}})).status_code == 400
    future = iso(datetime.now(timezone.utc) + timedelta(days=1))
    assert (await admin.post("/api/admin/storefront/sections", {"kind": "countdown", "title": "Sale", "config": {"heading": "Big sale ends in", "ends_at": future}})).status_code == 201
    home = (await client.get("/api/home")).json()
    kinds = [s_["kind"] for s_ in home["sections"]]
    assert "cards" in kinds and "countdown" in kinds
    mine = next(s_ for s_ in home["sections"] if s_["kind"] == "cards" and s_["config"]["cards"][0]["title"] == "Under ₹999")
    assert mine["config"]["cards"][1]["products"][0]["slug"] == shirt["slug"]

    # navigation settings
    site = (await admin.get("/api/admin/storefront/site")).json()
    site["nav"]["promo"] = {"enabled": True, "text": "Diwali sale", "link": "javascript:alert(1)"}
    assert (await admin.put("/api/admin/storefront/site", site)).status_code == 400
    site["nav"]["promo"]["link"] = "/deals"
    site["nav"]["trending"] = ["kurta", " ", "earbuds"]
    assert (await admin.put("/api/admin/storefront/site", site)).status_code == 200
    public = (await client.get("/api/site")).json()
    assert public["nav"]["promo"]["text"] == "Diwali sale" and public["nav"]["trending"] == ["kurta", "earbuds"] and public["nav"]["links"][0]["href"] == "/deals"


async def test_save_for_later(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    buyer = await login_phone(client, "9600000071", name="Saver")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    r = (await buyer.post(f"/api/cart/items/{vid}/save-for-later")).json()
    assert r["cart"]["summary"]["item_count"] == 0 and r["saved"]["items"][0]["variant_id"] == vid and r["saved"]["items"][0]["in_stock"]
    r = (await buyer.post(f"/api/cart/saved/{vid}/move-to-cart")).json()
    assert r["cart"]["summary"]["item_count"] == 1 and r["saved"]["items"] == []
    await buyer.post(f"/api/cart/items/{vid}/save-for-later")
    assert (await buyer.delete(f"/api/cart/saved/{vid}")).json()["items"] == []
    assert (await buyer.post(f"/api/cart/items/{vid}/save-for-later")).status_code == 404
    assert (await client.get("/api/cart/saved")).status_code == 401
