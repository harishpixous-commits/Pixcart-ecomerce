"""Collections: staff make a page of chosen products (hand-picked or by rules); customers open it by its link name."""
from __future__ import annotations

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
    assert (await admin.delete(f"/api/admin/collections/{col['id']}")).status_code == 200
    assert len((await admin.get("/api/admin/collections")).json()["items"]) == 1
    # a customer cannot manage them
    assert (await tn.post("/api/admin/collections", {"title": "Nope nope", "brand": "X"})).status_code == 403
