"""Sponsored products charge only genuine clicks. A click link is one served impression: it is charged once, only for
the visitor it was shown to, and a campaign pays for a limited number of clicks per internet address and network a
day, whatever the browser claims to be. Floods are rate limited. Every other click still opens the product, is free
and shows as invalid to the seller and the staff."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import func, select, update

from app.db import SessionLocal
from app.jobs import cleanup_job
from app.main import app
from app.models import AdImpression
from app.services import ads
from tests.test_phase2_money import setup


def shopper(ip: str = "127.0.0.1") -> httpx.AsyncClient:
    """A browser of its own (its own cookies) at this internet address."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(ip, 50000)), base_url="http://test")


async def running_campaign(client, admin, categories) -> tuple:
    tn, _, shirt, _ = await setup(client, admin, categories)
    camp = {"name": "Shirt push", "product_ids": [shirt["id"]], "placements": ["search", "product", "home"], "bid_paise": 500,
            "daily_budget_paise": 100000}
    c = (await tn.post("/api/seller/ads", camp)).json()
    assert (await admin.post(f"/api/admin/ads/{c['id']}/approve", {})).json()["status"] == "active"
    return tn, shirt, c


async def ad_link(s: httpx.AsyncClient) -> str:
    """Opens the home page's Sponsored row and returns the ad's click token."""
    items = (await s.get("/api/ads/serve", params={"placement": "home"})).json()["items"]
    return items[0]["href"].split("t=")[1]


async def follow(s: httpx.AsyncClient, token: str, agent: str = "Mozilla/5.0") -> str:
    r = await s.get("/api/ads/click", params={"t": token}, headers={"user-agent": agent}, follow_redirects=False)
    assert r.status_code == 302
    return r.headers["location"]


async def campaign(tn) -> dict:
    return (await tn.get("/api/seller/ads")).json()["campaigns"][0]


async def test_one_link_replayed_with_new_browsers_is_charged_once(client, admin, categories):
    tn, shirt, c = await running_campaign(client, admin, categories)
    product = f"/p/{shirt['slug']}"
    async with shopper() as s:
        r = await s.get("/api/ads/serve", params={"placement": "home"})
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"{ads.VISITOR_COOKIE}=") and "HttpOnly" in cookie and "Path=/api" in cookie and "samesite=lax" in cookie.lower()
        token = r.json()["items"][0]["href"].split("t=")[1]
        assert (await follow(s, token, "Phone")).startswith(f"{product}?sp=")
        for i in range(5):  # the same link from the same address with a new User-Agent each time
            assert await follow(s, token, f"Bot/{i}") == product
    async with shopper() as stranger:  # someone who was never shown the ad
        assert await follow(stranger, token) == product
    mine = await campaign(tn)
    assert mine["spend_paise"] == 500 and mine["stats"]["clicks"] == 1 and mine["stats"]["invalid_clicks"] == 6

    # the seller and the staff see the invalid clicks
    assert (await tn.get("/api/seller/ads")).json()["totals_30d"]["invalid_clicks"] == 6
    rep = (await tn.get(f"/api/seller/ads/{c['id']}/report")).json()
    assert rep["days"][-1]["invalid_clicks"] == 6 and rep["products"][0]["invalid_clicks"] == 6
    overview = (await admin.get("/api/admin/ads", params={"status": "all"})).json()
    assert overview["revenue_30d"]["invalid_clicks"] == 6 and overview["items"][0]["stats"]["invalid_clicks"] == 6
    assert overview["rules"]["paid_clicks_per_address"] == 3 and overview["rules"]["paid_clicks_per_network"] == 10


async def test_a_link_is_charged_only_for_the_visitor_it_was_shown_to(client, admin, categories):
    tn, shirt, _ = await running_campaign(client, admin, categories)
    product = f"/p/{shirt['slug']}"
    async with shopper() as a, shopper() as b:
        mine, theirs = await ad_link(a), await ad_link(b)
        assert await follow(b, mine) == product  # shown to someone else: free
        b.cookies.clear()
        assert await follow(b, theirs) == product  # no visitor cookie: free
        assert (await follow(a, await ad_link(a))).startswith(f"{product}?sp=")  # a's own link is charged
        assert (await follow(a, await ad_link(a))).startswith(f"{product}?sp=")  # a's repeat the same day: free, still valid
    mine = await campaign(tn)
    assert mine["spend_paise"] == 500 and mine["stats"]["clicks"] == 1 and mine["stats"]["invalid_clicks"] == 2


async def test_charged_clicks_per_address_and_network_are_capped_whatever_the_browser(client, admin, categories):
    tn, _, _ = await running_campaign(client, admin, categories)
    assert (await admin.put("/api/admin/settings", {"ads_paid_clicks_per_address": 0})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"ads_paid_clicks_per_address": 2, "ads_paid_clicks_per_network": 3})).status_code == 200
    for i in range(4):  # one address: a new visitor and browser each time, two clicks charged
        async with shopper("49.36.12.7") as s:
            await follow(s, await ad_link(s), f"Phone {i}")
    for host in ("49.36.12.8", "49.36.12.9"):  # the same /24 network: one more, then the network limit
        async with shopper(host) as s:
            await follow(s, await ad_link(s))
    for n in (1, 2, 3):  # IPv6: addresses within one /64 (one home or phone) count as one address
        async with shopper(f"2401:4900:1c2a:4d5e::{n}") as s:
            await follow(s, await ad_link(s))
    async with shopper("106.51.0.5") as s:  # another network: charged as usual
        await follow(s, await ad_link(s))
    mine = await campaign(tn)
    assert mine["stats"]["clicks"] == 6 and mine["stats"]["invalid_clicks"] == 4 and mine["spend_paise"] == 6 * 500


async def test_expired_unknown_and_forged_links_open_the_product_for_free(client, admin, categories):
    tn, shirt, _ = await running_campaign(client, admin, categories)
    product = f"/p/{shirt['slug']}"
    async with shopper() as s:
        token = await ad_link(s)
        nonce, cid, pid, placement, _ = ads.verify(token)
        now = datetime.now(timezone.utc)
        assert await follow(s, ads.sign(nonce, cid, pid, placement, now - timedelta(hours=49))) == product  # expired
        assert await follow(s, ads.sign(uuid.uuid4(), cid, pid, placement, now)) == product  # never served
        assert await follow(s, token[:-3] + "xyz") == "/"  # not one of our links
        assert (await follow(s, token)).startswith(f"{product}?sp=")  # the real link still works, once
    mine = await campaign(tn)
    assert mine["spend_paise"] == 500 and mine["stats"]["clicks"] == 1 and mine["stats"]["invalid_clicks"] == 2


async def test_floods_from_one_address_get_no_ads_and_no_charges(client, admin, categories, monkeypatch):
    tn, shirt, _ = await running_campaign(client, admin, categories)
    product = f"/p/{shirt['slug']}"
    monkeypatch.setattr(ads, "SERVE_PER_MINUTE", 3)
    monkeypatch.setattr(ads, "CLICKS_PER_MINUTE", 2)
    async with shopper("49.36.12.7") as s:
        links = [await ad_link(s) for _ in range(3)]
        assert (await s.get("/api/ads/serve", params={"placement": "home"})).json()["items"] == []  # no more ads this minute
        assert (await s.get("/api/catalog/products", params={"q": "handloom shirt"})).json()["sponsored"] == []
        assert (await follow(s, links[0])).startswith(f"{product}?sp=")
        assert await follow(s, links[0]) == product  # reused: invalid
        assert await follow(s, links[1]) == product  # over the click limit: opens the product, nothing recorded
    async with shopper("49.36.99.1") as other:  # another address still gets ads
        assert (await other.get("/api/ads/serve", params={"placement": "home"})).json()["items"]
    stats = (await campaign(tn))["stats"]
    assert stats["impressions"] == 4 and stats["clicks"] == 1 and stats["invalid_clicks"] == 1
    async with SessionLocal() as db:  # the links not yet clicked can still be used
        assert (await db.execute(select(func.count()).select_from(AdImpression).where(AdImpression.clicked_at.is_(None)))).scalar_one() == 3


async def test_cleanup_deletes_impressions_whose_links_have_expired(client, admin, categories):
    await running_campaign(client, admin, categories)
    async with shopper() as s:
        await ad_link(s)
        await ad_link(s)
    async with SessionLocal() as db:
        old, fresh = (await db.execute(select(AdImpression.id))).scalars().all()
        await db.execute(update(AdImpression).where(AdImpression.id == old).values(created_at=datetime.now(timezone.utc) - timedelta(hours=49)))
        await db.commit()
    await cleanup_job()
    async with SessionLocal() as db:
        assert (await db.execute(select(AdImpression.id))).scalars().all() == [fresh]
