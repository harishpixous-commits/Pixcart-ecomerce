"""Reviews, notifications, support desk, CMS, staff roles + 2FA, KPIs, privacy, AI and courier integration."""
from __future__ import annotations

import uuid

import httpx

from app.core import totp
from app.db import SessionLocal
from app.models import User
from app.services import shipping
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


async def buy_and_deliver(client, admin, categories, phone="9600000001"):
    tn, ka, shirt, ph = await setup(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return tn, ka, shirt, ph, buyer, o


async def test_reviews_only_after_delivery_and_moderation(client, admin, categories):
    tn, ka, shirt, ph, buyer, o = await buy_and_deliver(client, admin, categories)
    slug = shirt["slug"]
    r = await buyer.put(f"/api/catalog/products/{slug}/reviews", {"rating": 5, "title": "Great", "body": "Lovely fabric"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_purchased"
    await ship_and_deliver(tn, o["sub_orders"][0]["id"])
    r = await buyer.put(f"/api/catalog/products/{slug}/reviews", {"rating": 4, "title": "Good", "body": "Nice fabric, colour as shown"})
    assert r.status_code == 200
    data = (await client.get(f"/api/catalog/products/{slug}/reviews")).json()
    assert data["rating_count"] == 1 and data["rating_avg"] == 4.0 and data["distribution"]["4"] == 1
    page = (await client.get(f"/api/catalog/products/{slug}")).json()
    assert page["rating_count"] == 1
    # Seller replies; admin hides; aggregates update.
    rid = data["items"][0]["id"]
    assert (await tn.put(f"/api/seller/reviews/{rid}/reply", {"reply": "Thank you!"})).status_code == 200
    assert (await admin.post(f"/api/admin/reviews/{rid}/hide")).status_code == 200
    assert (await client.get(f"/api/catalog/products/{slug}/reviews")).json()["rating_count"] == 0
    # Notifications were recorded for both sides along the way.
    titles = [n["title"] for n in (await buyer.get("/api/notifications")).json()["items"]]
    assert "Order placed" in titles and "Delivered" in titles and "Package shipped" in titles
    seller_titles = [n["title"] for n in (await tn.get("/api/notifications")).json()["items"]]
    assert any(t.startswith("New order") for t in seller_titles)
    assert (await buyer.post("/api/notifications/read-all")).status_code == 200
    assert (await buyer.get("/api/notifications")).json()["unread"] == 0


async def test_support_ticket_sla_flow(client, admin, categories):
    buyer = await login_phone(client, "9600000002")
    r = await buyer.post("/api/support/tickets", {"category": "delivery", "subject": "Where is my parcel", "message": "It has been a week, please check.", "is_grievance": True})
    assert r.status_code == 201
    tid = r.json()["id"]
    queue = (await admin.get("/api/admin/tickets?status=open")).json()["items"]
    assert queue[0]["is_grievance"] and queue[0]["priority"] == "high" and not queue[0]["ack_overdue"]
    r = await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "Checking with the courier", "internal": True})
    assert r.json()["acknowledged_at"] is None  # internal notes do not count as a reply
    r = await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "It reaches you tomorrow."})
    assert r.json()["acknowledged_at"] and r.json()["status"] == "awaiting_customer"
    mine = (await buyer.get(f"/api/support/tickets/{tid}")).json()
    assert [m["author_role"] for m in mine["messages"]] == ["customer", "staff"]  # internal note hidden
    r = await buyer.post(f"/api/support/tickets/{tid}/messages", {"body": "Thanks"})
    assert r.json()["status"] == "open"
    other = await login_phone(client, "9600000003")
    assert (await other.get(f"/api/support/tickets/{tid}")).status_code == 404


async def test_cms_site_sections_pages(client, admin, categories):
    r = await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai", "colors": {"primary": "red"}})
    assert r.status_code == 400
    r = await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai", "colors": {"primary": "#123456"}, "announcement": {"enabled": True, "text": "Diwali sale", "link": "javascript:alert(1)"}})
    assert r.status_code == 400
    r = await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai", "colors": {"primary": "#123456"}, "footer_columns": [{"title": "Help", "links": [{"label": "Bad", "href": "javascript:x"}, {"label": "FAQ", "href": "/pages/faq"}]}]})
    assert r.status_code == 200
    site = (await client.get("/api/site")).json()
    assert site["brand_name"] == "Kadai" and site["colors"]["primary"] == "#123456" and site["colors"]["accent"] == "#F5A524"
    assert site["footer_columns"][0]["links"] == [{"label": "FAQ", "href": "/pages/faq"}]
    secs = (await admin.get("/api/admin/storefront/sections")).json()["items"]
    assert len(secs) >= 5
    r = await admin.post("/api/admin/storefront/sections", {"kind": "text", "title": "Hello", "config": {"markdown": "## Welcome"}})
    assert r.status_code == 201
    new_id = r.json()["id"]
    await admin.put("/api/admin/storefront/sections-order", {"ids": [new_id] + [s["id"] for s in secs]})
    home = (await client.get("/api/home")).json()
    assert home["sections"][0]["kind"] == "text"
    assert (await admin.post("/api/admin/storefront/sections", {"kind": "products", "config": {"source": "category"}})).status_code == 400
    r = await admin.put("/api/admin/storefront/pages/faq", {"slug": "faq", "title": "FAQ", "body": "# Questions"})
    assert r.status_code == 200
    assert (await client.get("/api/pages/faq")).json()["title"] == "FAQ"
    assert (await client.get("/api/pages/privacy")).json()["title"] == "Privacy policy"  # default until edited


async def test_staff_roles_and_totp(client, admin):
    r = await admin.post("/api/admin/staff", {"email": "help@kadai.in", "name": "Help Desk", "role": "support", "password": "weakpassword1"})
    assert r.status_code == 400
    r = await admin.post("/api/admin/staff", {"email": "help@kadai.in", "name": "Help Desk", "role": "support", "password": "Support@Desk2026"})
    assert r.status_code == 201
    login = await client.post("/api/auth/login", json={"email": "help@kadai.in", "password": "Support@Desk2026"})
    token = login.json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await client.get("/api/admin/tickets", headers=h)).status_code == 200
    assert (await client.get("/api/admin/payouts", headers=h)).status_code == 403
    assert (await client.get("/api/admin/settings", headers=h)).status_code == 403
    me = (await client.get("/api/admin/me", headers=h)).json()
    assert me["role"] == "support" and "payouts" not in me["permissions"]
    # Two-step sign-in
    setup_ = (await client.post("/api/auth/totp/setup", headers=h)).json()
    assert setup_["uri"].startswith("otpauth://totp/")
    assert (await client.post("/api/auth/totp/enable", json={"code": "000000"}, headers=h)).status_code == 400
    assert (await client.post("/api/auth/totp/enable", json={"code": totp.current(setup_["secret"])}, headers=h)).status_code == 200
    r = await client.post("/api/auth/login", json={"email": "help@kadai.in", "password": "Support@Desk2026"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "totp_required"
    r = await client.post("/api/auth/login", json={"email": "help@kadai.in", "password": "Support@Desk2026", "totp": totp.current(setup_["secret"])})
    assert r.status_code == 200
    # The last owner cannot demote themselves.
    owner_id = admin.user["id"]
    assert (await admin.patch(f"/api/admin/staff/{owner_id}", {"role": "support"})).status_code == 409


async def test_kpis_and_view_events(client, admin, categories):
    tn, ka, shirt, ph, buyer, o = await buy_and_deliver(client, admin, categories, phone="9600000004")
    r = await client.post("/api/events", json={"type": "view", "product_id": shirt["id"]})
    assert r.status_code == 204
    await client.post("/api/events", json={"type": "view", "product_id": shirt["id"]})  # deduplicated
    k = (await admin.get("/api/admin/analytics?days=30")).json()
    assert k["orders"] == 1 and k["gmv"] == 100000 and k["views"] == 1 and k["conversion_rate"] == 100.0
    assert k["payment_mix"] == {"cod": 1} and len(k["series"]) == 30
    sk = (await tn.get("/api/seller/analytics")).json()
    assert sk["orders"] == 1 and sk["products"][0]["views"] == 1


async def test_privacy_export_and_delete(client, admin, categories):
    tn, ka, shirt, ph, buyer, o = await buy_and_deliver(client, admin, categories, phone="9600000005")
    assert (await buyer.get("/api/account/export")).json()["orders"][0]["number"] == o["number"]
    r = await client.delete("/api/account", headers=buyer.h())
    assert r.status_code == 409 and r.json()["error"]["code"] == "open_orders"
    await ship_and_deliver(tn, o["sub_orders"][0]["id"])
    r = await client.delete("/api/account", headers=buyer.h())
    assert r.status_code == 200
    async with SessionLocal() as s:
        u = await s.get(User, uuid.UUID(buyer.user["id"]))
        assert u.phone is None and u.name == "Deleted user" and not u.is_active
    assert (await buyer.get("/api/auth/me")).status_code == 401
    # The same mobile number can sign up again as a new person (after the OTP resend cooldown).
    from sqlalchemy import delete

    from app.models import OtpChallenge, RateLimitEvent

    async with SessionLocal() as s:
        await s.execute(delete(OtpChallenge))
        await s.execute(delete(RateLimitEvent))
        await s.commit()
    again = await login_phone(client, "9600000005")
    assert again.user["id"] != buyer.user["id"]


async def test_shiprocket_booking_and_tracking(client, admin, categories, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "shipping_provider", "shiprocket")
    monkeypatch.setattr(settings, "shiprocket_email", "api@kadai.in")
    monkeypatch.setattr(settings, "shiprocket_password", "secret")
    monkeypatch.setattr(settings, "shiprocket_webhook_token", "hooktoken")
    paths = []

    def handler(req: httpx.Request) -> httpx.Response:
        paths.append(req.url.path)
        p = req.url.path
        if p.endswith("/auth/login"):
            return httpx.Response(200, json={"token": "jwt"})
        if p.endswith("/orders/create/adhoc"):
            return httpx.Response(200, json={"order_id": 111, "shipment_id": 222})
        if p.endswith("/courier/assign/awb"):
            return httpx.Response(200, json={"response": {"data": {"awb_code": "SR123456", "courier_name": "Delhivery"}}})
        if p.endswith("/courier/generate/label"):
            return httpx.Response(200, json={"label_url": "https://labels.example/1.pdf"})
        return httpx.Response(200, json={})

    shipping.transport = httpx.MockTransport(handler)
    try:
        tn, ka, shirt, ph, buyer, o = await buy_and_deliver(client, admin, categories, phone="9600000007")
        sub_id = o["sub_orders"][0]["id"]
        await tn.post(f"/api/seller/orders/{sub_id}/confirm")
        await tn.post(f"/api/seller/orders/{sub_id}/pack")
        r = await tn.post(f"/api/seller/orders/{sub_id}/book-courier")
        assert r.status_code == 200, r.text
        assert r.json() == {"courier_name": "Delhivery", "tracking_number": "SR123456", "label_url": "https://labels.example/1.pdf", "status": "shipped"}
        assert [x.split("/external")[-1] for x in paths] == ["/auth/login", "/settings/company/addpickup", "/orders/create/adhoc", "/courier/assign/awb", "/courier/generate/pickup", "/courier/generate/label"]
    finally:
        shipping.transport = None
    bad = await client.post("/api/webhooks/shiprocket", json={"awb": "SR123456", "current_status": "DELIVERED"}, headers={"x-api-key": "wrong"})
    assert bad.status_code == 401
    r = await client.post("/api/webhooks/shiprocket", json={"awb": "SR123456", "current_status": "DELIVERED", "current_timestamp": "x"}, headers={"x-api-key": "hooktoken"})
    assert r.status_code == 200
    detail = (await buyer.get(f"/api/orders/{o['id']}")).json()
    assert detail["sub_orders"][0]["status"] == "delivered"


async def test_delivery_estimate_and_holiday_mode(client, admin, categories):
    tn, ka, shirt, ph = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    same = (await client.get(f"/api/catalog/delivery-estimate?variant_id={vid}&pincode=600002")).json()
    far = (await client.get(f"/api/catalog/delivery-estimate?variant_id={vid}&pincode=110001")).json()
    assert same["zone"] == "city" and far["zone"] == "national" and far["days_min"] > same["days_min"]
    assert (await client.get(f"/api/catalog/delivery-estimate?variant_id={vid}&pincode=012345")).status_code == 400
    await tn.put("/api/seller/preferences", {"dispatch_days": 1, "holiday_mode": True, "invoice_prefix": "KT"})
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).status_code == 404


async def test_auto_cancel_unconfirmed(client, admin, categories):
    from datetime import timedelta

    from sqlalchemy import update

    from app.db import utcnow
    from app.models import SubOrder
    from app.services.orders import cancel_unconfirmed

    tn, ka, shirt, ph, buyer, o = await buy_and_deliver(client, admin, categories, phone="9600000008")
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).values(created_at=utcnow() - timedelta(hours=80)))
        await s.commit()
        assert await cancel_unconfirmed(s) == 1
    detail = (await buyer.get(f"/api/orders/{o['id']}")).json()
    assert detail["sub_orders"][0]["status"] == "cancelled" and detail["sub_orders"][0]["cancelled_by"] == "system"

