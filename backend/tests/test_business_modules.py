"""Business details, contact and social modules: validation, upgrade of old settings, and every place that
uses them (public site, platform info, emails, invoices' operator line, payout files, go-live checklist)."""
from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Notification, Payout, PlatformSetting, Seller
from app.services import ledger
from app.services.cms import SITE_KEY, validate_site
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup

GOOD_GSTIN = "33AABCK1234M1Z"  # completed with its check digit below


def gstin() -> str:
    from app.core.validators import gstin_check_char

    return GOOD_GSTIN + gstin_check_char(GOOD_GSTIN)


def social(*links):
    return {"social": {"enabled": True, "title": "Follow us", "links": list(links)}}


async def test_social_links_are_validated(client, admin):
    put = lambda body: admin.put("/api/admin/storefront/site", body)  # noqa: E731
    bad = [
        {"label": "Insta", "url": "javascript:alert(1)", "icon": "instagram"},
        {"label": "Insta", "url": "http://instagram.com/x", "icon": "instagram"},  # not https
        {"label": "Insta", "url": "https://instagram.com/x\" onmouseover=\"x", "icon": "instagram"},
        {"label": "", "url": "https://instagram.com/x", "icon": "instagram"},
        {"label": "Moj", "url": "https://moj.example/x", "icon": "not-an-icon"},
        {"label": "Moj", "url": "https://moj.example/x", "icon": "custom"},  # custom icon needs an uploaded image
        {"label": "Moj", "url": "https://moj.example/x", "icon": "custom", "icon_url": "//evil.example/a.png"},
    ]
    for link in bad:
        r = await put(social(link))
        assert r.status_code == 400, link
    too_many = [{"label": f"L{i}", "url": f"https://site{i}.example", "icon": "website"} for i in range(13)]
    assert (await put(social(*too_many))).status_code == 400

    r = await put({**social(
        {"label": "Instagram", "url": "https://instagram.com/kadai", "icon": "instagram"},
        {"label": "ShareChat", "url": "https://sharechat.com/kadai", "icon": "custom", "icon_url": "/media/products/abc.webp"},
        {"label": "Old page", "url": "https://facebook.com/kadai", "icon": "facebook", "enabled": False},
    )})
    assert r.status_code == 200, r.text
    links = (await client.get("/api/site")).json()["social"]["links"]
    assert [x["label"] for x in links] == ["Instagram", "ShareChat", "Old page"]
    assert links[1]["icon_url"] == "/media/products/abc.webp" and links[0]["icon_url"] == ""
    assert links[2]["enabled"] is False and all(len(x["id"]) >= 6 for x in links)
    # Ids stay stable across saves, so the admin list keeps its order and keys.
    again = (await put({"social": {"enabled": False, "title": "", "links": links}})).json()["social"]
    assert [x["id"] for x in again["links"]] == [x["id"] for x in links] and again["enabled"] is False


async def test_contact_business_and_footer_validation(client, admin):
    put = lambda body: admin.put("/api/admin/storefront/site", body)  # noqa: E731
    for item in (
        {"type": "email", "label": "Email", "value": "not-an-email"},
        {"type": "phone", "label": "Phone", "value": "call me"},
        {"type": "whatsapp", "label": "WhatsApp", "value": "<script>"},
        {"type": "link", "label": "Map", "value": "javascript:alert(1)"},
        {"type": "fax", "label": "Fax", "value": "123"},
        {"type": "text", "label": "", "value": "x"},
    ):
        assert (await put({"contact": {"enabled": True, "title": "Contact", "items": [item]}})).status_code == 400, item
    wrong_check = gstin()[:14] + ("A" if gstin()[14] != "A" else "B")
    assert (await put({"business": {"legal_name": "Kadai Retail Pvt Ltd", "gstin": wrong_check}})).status_code == 400
    assert (await put({"business": {"legal_name": "Kadai Retail Pvt Ltd", "gstin": "NOTAGSTIN"}})).status_code == 400
    assert (await put({"business": {"legal_name": "Kadai", "cin": "NOT-A-CIN"}})).status_code == 400
    assert (await put({"business": {"legal_name": "Kadai", "grievance": {"email": "bad"}}})).status_code == 400
    assert (await put({"footer": {"copyright": "© {year} {secret_key}"}})).status_code == 400

    r = await put({
        "brand_name": "Kadai",
        "business": {
            "legal_name": "Kadai Retail Pvt Ltd", "registered_address": "12 Anna Salai, Chennai 600002", "gstin": gstin(),
            "cin": "U52100TN2024PTC123456", "grievance": {"name": "Meena R", "designation": "Grievance Officer", "email": "grievance@kadai.in", "phone": "+91 98400 12345", "hours": "Mon-Sat 10-6"},
        },
        "contact": {"enabled": True, "title": "Talk to us", "items": [
            {"type": "email", "label": "Customer care", "value": "care@kadai.in"},
            {"type": "phone", "label": "Call", "value": "+91 44 4000 1234"},
            {"type": "whatsapp", "label": "WhatsApp", "value": "+91 98400 12345", "enabled": False},
            {"type": "address", "label": "Store", "value": "12 Anna Salai, Chennai"},
        ]},
        "footer": {"show_gstin": False, "copyright": "© {year} {legal_name}, all rights reserved."},
    })
    assert r.status_code == 200, r.text
    site = (await client.get("/api/site")).json()
    assert site["business"]["gstin"] == gstin() and site["contact"]["items"][2]["enabled"] is False
    assert site["footer"]["show_gstin"] is False and site["footer"]["show_social"] is True
    info = (await client.get("/api/catalog/platform")).json()
    assert info["name"] == "Kadai" and info["legal_name"] == "Kadai Retail Pvt Ltd"
    assert info["registered_address"].startswith("12 Anna Salai") and info["grievance_officer"]["email"] == "grievance@kadai.in"

    status = (await admin.get("/api/admin/setup-status")).json()
    done = {i["key"]: i["done"] for i in status["items"]}
    assert done["business_name"] and done["registered_address"] and done["gstin"] and done["grievance"] and done["contact"]
    assert not done["terms"] and status["total"] == len(status["items"])


async def test_old_settings_are_upgraded():
    site = validate_site({"social": {"instagram": "https://instagram.com/a", "x": "https://x.com/a", "facebook": ""},
                          "contact": {"email": "care@a.in", "phone": "+91 98765 43210", "address": "1 Main Road"}})
    assert [(x["icon"], x["label"]) for x in site["social"]["links"]] == [("instagram", "Instagram"), ("x", "X")]
    assert [x["type"] for x in site["contact"]["items"]] == ["email", "phone"]
    assert site["business"]["registered_address"] == "1 Main Road"


async def test_emails_carry_brand_and_business_footer(client, admin, categories):
    from app.config import settings

    await admin.put("/api/admin/storefront/site", {
        "brand_name": "Kadai",
        "business": {"legal_name": "Kadai Retail Pvt Ltd", "registered_address": "12 Anna Salai, Chennai"},
        "contact": {"enabled": True, "title": "", "items": [{"type": "email", "label": "Care", "value": "care@kadai.in"}]},
    })
    old = settings.smtp_host
    settings.smtp_host = "smtp.test"
    try:
        tn, ka, shirt, phone = await setup(client, admin, categories)
        buyer = await login_phone(client, "9700000001")
        await buyer.patch("/api/auth/me", {"email": "buyer@example.in"})
        addr = await add_address(buyer, state="33")
        await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
        r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
        assert r.status_code in (200, 201), r.text
    finally:
        settings.smtp_host = old
    async with SessionLocal() as s:
        mail = (await s.execute(select(Notification).where(Notification.channel == "email", Notification.event == "order_placed"))).scalars().first()
    assert mail is not None
    assert "Kadai" in mail.subject and "PixCart" not in mail.subject
    assert "Kadai Retail Pvt Ltd" in mail.body and "12 Anna Salai" in mail.body and "care@kadai.in" in mail.body
    assert mail.variables["brand"] == "Kadai"


async def test_bank_file_defuses_spreadsheet_formulas(client, admin, categories):
    tn, *_ = await setup(client, admin, categories)
    async with SessionLocal() as s:
        seller = (await s.execute(select(Seller))).scalars().first()
        seller.bank_holder_name = '=HYPERLINK("http://evil","x")'
        p = Payout(seller_id=seller.id, number="PO-TEST-1", amount=12345, status="pending", mode="manual", bank_snapshot={})
        s.add(p)
        await s.flush()
        text = ledger.bank_csv([(p, seller)], "Kadai & Co!")
        await s.rollback()
    row = text.splitlines()[1]
    assert "\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\"" in row
    assert row.endswith('"Kadai Co PO TEST 1"')


async def test_site_row_never_stores_unvalidated_fields(client, admin):
    await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai", "evil": "<script>", "business": {"legal_name": "K", "extra": 1}})
    async with SessionLocal() as s:
        row = await s.get(PlatformSetting, SITE_KEY)
    assert "evil" not in row.value and "extra" not in row.value["business"]
