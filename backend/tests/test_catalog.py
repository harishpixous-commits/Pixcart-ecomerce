from __future__ import annotations

from tests.conftest import (
    login_phone,
    make_live_product,
    make_seller,
    png_bytes,
    upload_image,
)

SHIRT_VARIANTS = [
    {"sku": "SH-RED-M", "options": {"Size": "M", "Colour": "Red"}, "mrp_paise": 99900, "price_paise": 59900, "stock": 10},
    {"sku": "SH-RED-L", "options": {"Size": "L", "Colour": "Red"}, "mrp_paise": 99900, "price_paise": 64900, "stock": 0},
]


async def test_listing_lifecycle_and_visibility(client, admin, categories):
    seller = await make_seller(client, admin, "9100000001", name="Kavi Clothing", pan="KAVIS1234K")
    img = await upload_image(client, seller)
    assert img.startswith("/media/products/") and img.endswith(".webp")

    payload = {
        "category_id": categories["shirts"],
        "title": "Cotton Casual Shirt for Men",
        "brand": "Kavi",
        "description": "Breathable cotton shirt, regular fit, perfect for summer days.",
        "hsn_code": "6205",
        "gst_bps": 500,
        "images": [img],
        "variants": SHIRT_VARIANTS,
    }
    # Parent categories are refused; price above MRP refused; external images refused.
    r = await seller.post("/api/seller/products", {**payload, "category_id": categories["fashion"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "category_not_leaf"
    bad = [{**SHIRT_VARIANTS[0], "price_paise": 199900}]
    r = await seller.post("/api/seller/products", {**payload, "variants": bad})
    assert r.status_code == 422
    r = await seller.post("/api/seller/products", {**payload, "images": ["https://evil.example/x.jpg"]})
    assert r.status_code == 422

    r = await seller.post("/api/seller/products", payload)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["status"] == "draft" and p["price_from"] == 59900 and p["in_stock"] is True

    # Not public while draft/pending.
    r = await client.get(f"/api/catalog/products/{p['slug']}")
    assert r.status_code == 404
    r = await seller.post(f"/api/seller/products/{p['id']}/submit")
    assert r.json()["status"] == "pending"
    r = await client.get(f"/api/catalog/products/{p['slug']}")
    assert r.status_code == 404

    r = await admin.get("/api/admin/products?status=pending")
    assert r.json()["total"] == 1
    r = await admin.post(f"/api/admin/products/{p['id']}/approve")
    assert r.status_code == 200

    r = await client.get(f"/api/catalog/products/{p['slug']}")
    assert r.status_code == 200
    page = r.json()
    assert page["option_axes"] == {"Size": ["M", "L"], "Colour": ["Red"]}
    assert page["seller"]["gstin"] and page["seller"]["grievance_officer"]["email"]
    assert page["country_of_origin"] == "India"
    assert [v["in_stock"] for v in page["variants"]] == [True, False]
    assert page["breadcrumbs"][0]["slug"] == "fashion"

    # Price/stock edit keeps it live; content edit sends it back for review.
    vid = p["variants"][0]["id"]
    r = await seller.patch(f"/api/seller/variants/{vid}", {"price_paise": 54900})
    assert r.status_code == 200
    r = await client.get(f"/api/catalog/products/{p['slug']}")
    assert r.json()["price"] == 54900
    variants = [{**v, "id": x["id"]} for v, x in zip(SHIRT_VARIANTS, p["variants"], strict=True)]
    r = await seller.put(f"/api/seller/products/{p['id']}", {**payload, "title": "Cotton Casual Shirt for Men - New", "variants": variants})
    assert r.status_code == 200 and r.json()["status"] == "pending"
    r = await client.get(f"/api/catalog/products/{p['slug']}")
    assert r.status_code == 404

    # Suspending the seller hides their approved listings.
    await admin.post(f"/api/admin/products/{p['id']}/approve")
    assert (await client.get(f"/api/catalog/products/{p['slug']}")).status_code == 200
    await admin.post(f"/api/admin/sellers/{seller.seller_id}/suspend", {"reason": "Fake products reported"})
    assert (await client.get(f"/api/catalog/products/{p['slug']}")).status_code == 404


async def test_other_seller_cannot_touch_listing(client, admin, categories):
    a = await make_seller(client, admin, "9100000002", name="Store A", pan="STRAA1234A")
    b = await make_seller(client, admin, "9100000003", name="Store B", pan="STRBB1234B")
    p = await make_live_product(client, admin, a, categories["shirts"], title="Linen Formal Shirt Blue", variants=[SHIRT_VARIANTS[0]])
    assert (await b.get(f"/api/seller/products/{p['id']}")).status_code == 404
    assert (await b.patch(f"/api/seller/variants/{p['variants'][0]['id']}", {"stock": 0})).status_code == 404
    # SKU must be unique per seller, but two sellers may use the same SKU.
    img = await upload_image(client, b)
    r = await b.post(
        "/api/seller/products",
        {"category_id": categories["shirts"], "title": "Another Shirt Model X", "hsn_code": "6205", "gst_bps": 500, "images": [img], "variants": [SHIRT_VARIANTS[0]]},
    )
    assert r.status_code == 201


async def test_search_facets_and_sort(client, admin, categories):
    s = await make_seller(client, admin, "9100000004", name="Gadget Hub", pan="GADGT1234G")
    await make_live_product(client, admin, s, categories["mobiles"], title="Galaxy Phone 5G 128GB Black", brand="Samsung", gst_bps=1800,
                            variants=[{"sku": "G1", "options": {}, "mrp_paise": 2499900, "price_paise": 1999900, "stock": 5}])
    await make_live_product(client, admin, s, categories["mobiles"], title="Redmi Note Phone 4G 64GB", brand="Xiaomi", gst_bps=1800,
                            variants=[{"sku": "R1", "options": {}, "mrp_paise": 1299900, "price_paise": 999900, "stock": 5}])
    await make_live_product(client, admin, s, categories["shirts"], title="Printed Shirt Phone Pocket", brand="Kavi",
                            variants=[{"sku": "S1", "options": {}, "mrp_paise": 99900, "price_paise": 49900, "stock": 5}])

    r = await client.get("/api/catalog/products", params={"q": "phon"})  # prefix match
    assert r.json()["total"] == 3
    r = await client.get("/api/catalog/products", params={"q": "phone", "category": "electronics", "sort": "price_asc"})
    data = r.json()
    assert [i["brand"] for i in data["items"]] == ["Xiaomi", "Samsung"]
    assert {b["name"] for b in data["facets"]["brands"]} == {"Samsung", "Xiaomi"}
    assert data["breadcrumbs"] == [{"name": "Electronics", "slug": "electronics"}]
    r = await client.get("/api/catalog/products", params={"category": "electronics", "brand": ["Samsung"]})
    assert r.json()["total"] == 1
    r = await client.get("/api/catalog/products", params={"max_price": 1000000})
    assert r.json()["total"] == 2
    r = await client.get("/api/catalog/products", params={"q": "galxy"})  # typo tolerance via trigram
    assert any("Galaxy" in i["title"] for i in r.json()["items"])
    r = await client.get("/api/catalog/suggest", params={"q": "red"})
    assert r.json()["products"][0]["title"].startswith("Redmi")
    r = await client.get("/api/catalog/home")
    home = r.json()
    assert len(home["deals"]) == 3 and home["categories"][0]["product_count"] >= 1
    r = await client.get("/api/catalog/categories")
    tree = {c["slug"]: c for c in r.json()}
    assert tree["electronics"]["product_count"] == 2


async def test_image_validation(client, admin):
    s = await make_seller(client, admin, "9100000005", name="Pix Store", pan="PIXST1234P")
    r = await client.post("/api/seller/images", headers=s.h(), files={"file": ("x.png", b"not an image", "image/png")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_image"
    r = await client.post("/api/seller/images", headers=s.h(), files={"file": ("x.png", png_bytes((50, 50)), "image/png")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "image_too_small"
    customer = await login_phone(client, "9100000006")
    r = await client.post("/api/seller/images", headers=customer.h(), files={"file": ("x.png", png_bytes(), "image/png")})
    assert r.status_code == 403


async def test_oversized_upload_refused(client, admin):
    s = await make_seller(client, admin, "9100000007", name="Big Files", pan="BIGFL1234B")
    blob = b"\xff\xd8\xff" + b"0" * (5 * 1024 * 1024 + 10)
    r = await client.post("/api/seller/images", headers=s.h(), files={"file": ("big.jpg", blob, "image/jpeg")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "file_too_large"
    r = await client.post("/api/seller/documents/pan_card", headers=s.h(), files={"file": ("big.pdf", b"%PDF-" + b"0" * (5 * 1024 * 1024 + 10), "application/pdf")})
    assert r.status_code in (400, 409)  # 409 once approved: KYC is locked


async def test_wishlist_share_link(client, admin, categories):
    seller = await make_seller(client, admin, "9100000777", name="Share Seller", pan="SHARE1234K")
    shirt = await make_live_product(client, admin, seller, categories["shirts"], title="Shared Shirt", variants=SHIRT_VARIANTS)
    me = await login_phone(client, "9600000777", name="Meena Kumar")
    assert (await me.put(f"/api/wishlist/{shirt['id']}")).status_code == 200

    assert (await me.get("/api/wishlist/share")).json() == {"enabled": False, "token": None}
    off = await me.post("/api/wishlist/share")
    assert off.status_code == 400 and off.json()["error"]["code"] == "share_off"

    assert (await admin.put("/api/admin/growth/settings", {"wishlist_share": {"enabled": True}})).status_code == 200
    token = (await me.post("/api/wishlist/share")).json()["token"]
    assert len(token) >= 16 and (await me.post("/api/wishlist/share")).json()["token"] == token  # same link again
    shared = await client.get(f"/api/wishlist/shared/{token}")  # no sign-in needed
    assert shared.status_code == 200
    body = shared.json()
    assert body["owner"] == "Meena" and [i["title"] for i in body["items"]] == ["Shared Shirt"]
    assert (await client.get("/api/wishlist/shared/" + "x" * 24)).status_code == 404

    gone = await me.delete("/api/wishlist/share")
    assert gone.status_code == 200 and gone.json()["token"] is None, gone.text  # the old link dies
    assert (await client.get(f"/api/wishlist/shared/{token}")).status_code == 404
    new = (await me.post("/api/wishlist/share")).json()["token"]
    assert new != token
    await admin.put("/api/admin/growth/settings", {"wishlist_share": {"enabled": False}})  # switched off: every link stops
    assert (await client.get(f"/api/wishlist/shared/{new}")).status_code == 404


async def test_product_size_guide_beats_category_guide(client, admin, categories):
    from sqlalchemy import update as sa_update

    from app.db import SessionLocal
    from app.models import Product

    seller = await make_seller(client, admin, "9100000779", name="Own Guide", pan="OWNGD1234K")
    shirt = await make_live_product(client, admin, seller, categories["shirts"], title="Own Guide Shirt", variants=SHIRT_VARIANTS)
    cats = {c["id"]: c for c in (await admin.get("/api/admin/categories")).json()}
    r = await admin.put(f"/api/admin/categories/{categories['shirts']}", cats[categories["shirts"]] | {"size_guide": "Size|Waist\nL|34"})
    assert r.status_code == 200, r.text
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["size_guide"] == [["Size", "Waist"], ["L", "34"]]
    async with SessionLocal() as s:  # the product's own table wins over its category's
        await s.execute(sa_update(Product).where(Product.slug == shirt["slug"]).values(size_guide="Size | Chest\nM | 40"))
        await s.commit()
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["size_guide"] == [["Size", "Chest"], ["M", "40"]]
    mine = (await seller.get(f"/api/seller/products/{shirt['id']}")).json()
    assert mine["size_guide"] == "Size | Chest\nM | 40"


async def test_promo_popup_is_off_until_switched_on_and_keeps_links_on_site(client, admin):
    assert (await client.get("/api/promo-popup")).json() == {"enabled": False}
    r = await admin.put("/api/admin/growth/settings", {"promo_popup": {"enabled": True, "title": "Diwali sale", "body": "Up to 40% off", "button_label": "See deals", "link": "/search?sort=discount", "delay_seconds": 3}})
    assert r.status_code == 200, r.text
    got = (await client.get("/api/promo-popup")).json()
    assert got == {"enabled": True, "title": "Diwali sale", "body": "Up to 40% off", "button_label": "See deals", "link": "/search?sort=discount", "delay_seconds": 3}
    await admin.put("/api/admin/growth/settings", {"promo_popup": {"link": "https://evil.example/x"}})
    got = (await client.get("/api/promo-popup")).json()
    assert got["link"] == "" and got["button_label"] == ""  # an outside link is never offered
    await admin.put("/api/admin/growth/settings", {"promo_popup": {"link": "//evil.example"}})
    assert (await client.get("/api/promo-popup")).json()["link"] == ""
    assert (await admin.put("/api/admin/growth/settings", {"promo_popup": {"delay_seconds": 99}})).status_code == 400
