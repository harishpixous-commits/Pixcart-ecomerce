"""Collections: staff make a page of chosen products (hand-picked or by rules); customers open it by its link name."""
from __future__ import annotations

import uuid

from tests.conftest import login_phone
from tests.test_phase2_money import setup


async def test_collection_hand_picked_and_by_rules(client, admin, categories):
    tn, _ka, shirt, phone = await setup(client, admin, categories)
    shirt_slug = shirt["slug"]
    r = await admin.post("/api/admin/collections", {"title": "Gifts for him", "product_slugs": [shirt_slug, "no-such-product"]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "product_not_found"
    assert (await admin.post("/api/admin/collections", {"title": "Empty one"})).status_code == 422   # nothing to pick by
    r = await admin.post("/api/admin/collections", {"title": "Gifts for him", "description": "Shirts and more", "product_slugs": [shirt_slug]})
    assert r.status_code == 201, r.text
    col = r.json()
    assert col["slug"] == "gifts-for-him" and col["product_slugs"] == [shirt_slug]
    page = (await client.get("/api/catalog/collections/gifts-for-him")).json()
    assert page["title"] == "Gifts for him" and [p["slug"] for p in page["products"]] == [shirt_slug]
    assert [c["slug"] for c in (await client.get("/api/catalog/collections")).json()["items"]] == ["gifts-for-him"]
    assert "/collections/gifts-for-him</loc>" in (await client.get("/api/seo/sitemap.xml")).text   # search engines are told about it
    # a home page row can show a collection; it needs a collection chosen, and disappears once the collection is hidden
    assert (await admin.post("/api/admin/storefront/sections", {"kind": "products", "title": "Picked", "config": {"source": "collection"}})).status_code == 400
    r = await admin.post("/api/admin/storefront/sections", {"kind": "products", "title": "Gifts row", "config": {"source": "collection", "collection_slug": "gifts-for-him"}})
    assert r.status_code == 201, r.text
    row_id = r.json()["id"]
    def row(home):
        return next(x for x in home["sections"] if x["id"] == row_id)
    assert [p["slug"] for p in row((await client.get("/api/home")).json())["products"]] == [shirt_slug]
    # a second one with the same title gets its own link name; price rules pick products without a list
    c2 = (await admin.post("/api/admin/collections", {"title": "Gifts for him", "min_price_paise": 1, "max_price_paise": 100_000_000})).json()
    assert c2["slug"] == "gifts-for-him-2"
    assert shirt_slug in [p["slug"] for p in (await client.get("/api/catalog/collections/gifts-for-him-2")).json()["products"]]
    none = (await admin.put(f"/api/admin/collections/{c2['id']}", {"title": "Too dear", "min_price_paise": 99_000_000})).json()
    assert (await client.get(f"/api/catalog/collections/{none['slug']}")).json()["products"] == []
    assert (await admin.put(f"/api/admin/collections/{c2['id']}", {"title": "Bad", "min_price_paise": 5, "max_price_paise": 1})).status_code == 422
    # hidden collections are not found; a delete removes the page
    await admin.put(f"/api/admin/collections/{col['id']}", {"title": "Gifts for him", "product_slugs": [shirt_slug], "is_active": False})
    assert (await client.get("/api/catalog/collections/gifts-for-him")).status_code == 404
    assert all(x["id"] != row_id for x in (await client.get("/api/home")).json()["sections"])   # an empty row is left out
    assert "/collections/gifts-for-him</loc>" not in (await client.get("/api/seo/sitemap.xml")).text
    assert (await admin.delete(f"/api/admin/collections/{col['id']}")).status_code == 200
    assert len((await admin.get("/api/admin/collections")).json()["items"]) == 1
    # a customer cannot manage them
    assert (await tn.post("/api/admin/collections", {"title": "Nope nope", "brand": "X"})).status_code == 403


async def test_product_tags_filter_search_and_collection_rule(client, admin, categories):
    tn, _ka, shirt, phone = await setup(client, admin, categories)
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert detail["tags"] == []
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"tags": ["  Gift ", "COTTON", "gift", "", "x" * 50]})
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["tags"] == ["gift", "cotton", "x" * 30]            # tidied: lower case, no repeats, 30 characters at most
    assert got["status"] == "approved"                              # labels never send a live product back for approval
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"tags": [f"t{i}" for i in range(11)]})).status_code == 422
    facet = (await client.get("/api/catalog/products")).json()["facets"]["tags"]
    assert {"name": "gift", "count": 1} in facet
    found = (await client.get("/api/catalog/products", params={"tag": "GIFT"})).json()
    assert [p["slug"] for p in found["items"]] == [shirt["slug"]]
    assert (await client.get("/api/catalog/products", params={"tag": "nothing"})).json()["items"] == []
    # a collection can pick by label
    c = await admin.post("/api/admin/collections", {"title": "Gifts", "tag": " Gift "})
    assert c.status_code == 201 and c.json()["tag"] == "gift"
    page = (await client.get("/api/catalog/collections/gifts")).json()
    assert [p["slug"] for p in page["products"]] == [shirt["slug"]]
    # a copy of the product keeps the labels
    dup = (await tn.post(f"/api/seller/products/{shirt['id']}/duplicate")).json()
    assert dup["tags"] == ["gift", "cotton", "x" * 30]


async def test_product_search_listing_text(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert detail["seo_title"] == "" and detail["seo_description"] == ""
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"seo_title": "  Cotton   shirt, made in Kovai ", "seo_description": "Soft  cotton."})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"                         # listing text never sends a live product back for approval
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["tags"] == []
    assert page["seo_title"] == "Cotton shirt, made in Kovai" and page["seo_description"] == "Soft cotton."
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"seo_title": "x" * 71})).status_code == 422
    dup = (await tn.post(f"/api/seller/products/{shirt['id']}/duplicate")).json()
    assert dup["seo_title"] == "Cotton shirt, made in Kovai"


async def test_scheduled_publish_hides_an_approved_product_until_its_time(client, admin, categories):
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import Product

    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9770000451", name="Schedule Buyer")
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert detail["publish_at"] is None
    soon = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"publish_at": soon})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved" and r.json()["publish_at"] is not None          # no new approval round
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).status_code == 404
    listed = (await client.get("/api/catalog/products")).json()
    assert shirt["slug"] not in [p["slug"] for p in listed["items"]]
    assert (await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})).status_code == 404
    # the time passes
    async with SessionLocal() as s:
        await s.execute(update(Product).where(Product.id == uuid.UUID(shirt["id"])).values(publish_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
        await s.commit()
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).status_code == 200
    assert shirt["slug"] in [p["slug"] for p in (await client.get("/api/catalog/products")).json()["items"]]
    assert (await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})).status_code in (200, 201)
    # the seller is told once that it is live
    from app import jobs

    await jobs.product_live_job()
    await jobs.product_live_job()
    notes = (await tn.get("/api/notifications")).json()["items"]
    assert len([x for x in notes if x["title"] == "Your product is live" and shirt["title"] in x["body"]]) == 1
    # too far ahead is refused, and an empty value clears it
    far = (datetime.now(timezone.utc) + timedelta(days=400)).isoformat()
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"publish_at": far})).status_code == 422
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"publish_at": None})
    assert r.json()["publish_at"] is None
    dup = (await tn.post(f"/api/seller/products/{shirt['id']}/duplicate")).json()
    assert dup["publish_at"] is None                                                       # a copy goes live on approval as usual


async def test_most_units_per_order_limits_the_cart_and_blocks_the_order(client, admin, categories):
    from tests.conftest import add_address
    from tests.test_phase2_money import key

    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9770000461", name="Limit Buyer")
    addr = await add_address(buyer, state="33")
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    vid = shirt["variants"][0]["id"]
    bad = detail | {"details": (detail.get("details") or {}) | {"min_qty": 3, "max_qty": 2}}
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", bad)).status_code == 422          # the limit cannot be below the minimum
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"details": (detail.get("details") or {}) | {"max_qty": 2}})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"                    # details are listing content, like the minimum order quantity
    assert (await admin.post(f"/api/admin/products/{shirt['id']}/approve")).status_code == 200
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["max_qty"] == 2
    r = await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 5})
    assert r.status_code == 200 and r.json()["notice"] and "limited to 2" in r.json()["notice"]
    assert r.json()["groups"][0]["lines"][0]["qty"] == 2
    # the seller lowers the limit after the item is in the cart: the cart shows it and the order is refused
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"details": (detail.get("details") or {}) | {"max_qty": 1}})
    assert r.status_code == 200, r.text
    assert (await admin.post(f"/api/admin/products/{shirt['id']}/approve")).status_code == 200
    cart = (await buyer.get("/api/cart")).json()
    assert "limited to 1" in (cart["groups"][0]["lines"][0].get("problem") or "")
    o = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "expected_total": cart["summary"]["grand_total"]})
    assert o.status_code >= 400
    # no limit again: back to the marketplace rule
    await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"details": (detail.get("details") or {}) | {"max_qty": 0}})
    assert (await admin.post(f"/api/admin/products/{shirt['id']}/approve")).status_code == 200
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["max_qty"] is None


async def test_staff_can_set_the_go_live_time_and_approval_says_when_it_goes_live(client, admin, categories):
    from datetime import datetime, timedelta, timezone

    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    path = f"/api/admin/products/{shirt['id']}/publish-at"
    soon = (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()
    r = await admin.put(path, {"publish_at": soon})
    assert r.status_code == 200 and r.json()["publish_at"] is not None and r.json()["status"] == "approved"
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).status_code == 404
    assert (await tn.get(f"/api/seller/products/{shirt['id']}")).json()["publish_at"] is not None     # the seller sees it
    assert (await admin.put(path, {"publish_at": (datetime.now(timezone.utc) + timedelta(days=400)).isoformat()})).status_code == 400
    r = await admin.put(path, {"publish_at": None})
    assert r.status_code == 200 and r.json()["publish_at"] is None
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).status_code == 200
    assert (await client.put(path, json={"publish_at": None})).status_code in (401, 403)             # staff only
    # a content change sends it back for approval; approving it tells the seller when it will go live
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    r = await tn.put(f"/api/seller/products/{shirt['id']}", detail | {"details": (detail.get("details") or {}) | {"max_qty": 4}, "publish_at": soon})
    assert r.json()["status"] == "pending"
    assert (await admin.post(f"/api/admin/products/{shirt['id']}/approve")).status_code == 200
    notes = (await tn.get("/api/notifications")).json()["items"]
    assert any("goes live on the store on" in n["body"] for n in notes)
