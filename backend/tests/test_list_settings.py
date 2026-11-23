"""Lists and results (Admin → Marketplace settings): how many results each shopper-facing list shows, with defaults,
validated ranges, and every list obeying its setting."""
from __future__ import annotations

from tests.conftest import make_live_product, make_seller

DEFAULTS = {
    "search_page_size": 24, "search_suggestions": 8, "recent_searches_max": 8, "brand_filter_max": 30, "similar_products": 12,
    "sponsored_on_product": 10, "highlights_shown": 5, "customer_photos_shown": 6, "reviews_page_size": 10, "questions_page_size": 10,
    "bestseller_badge_top": 10, "recently_viewed_max": 12, "compare_max": 4, "checkout_suggestions": 10,
}


async def products(client, admin, categories, n: int) -> list[dict]:
    seller = await make_seller(client, admin, "9400000011", name="Lists Test Store", pan="LISTS1234L", state="33")
    out = []
    for i in range(n):
        out.append(await make_live_product(client, admin, seller, categories["shirts"], title=f"Cotton Shirt Style {i}", gst_bps=500,
                                           variants=[{"sku": f"LS-{i}", "options": {}, "mrp_paise": 120000, "price_paise": 99900, "stock": 5}]))
    return out


async def test_defaults_reach_the_storefront(client):
    site = (await client.get("/api/site")).json()
    assert site["lists"] == DEFAULTS


async def test_ranges_are_validated(client, admin):
    for key, bad in (("search_page_size", 7), ("search_page_size", 61), ("compare_max", 1), ("compare_max", 7), ("reviews_page_size", 4),
                     ("similar_products", -1), ("highlights_shown", 0), ("recent_searches_max", 21)):
        r = await admin.put("/api/admin/settings", {key: bad})
        assert r.status_code == 400, (key, bad, r.text)
    r = await admin.put("/api/admin/settings", {"similar_products": 0, "recent_searches_max": 0, "checkout_suggestions": 0})
    assert r.status_code == 200, r.text
    lists = (await client.get("/api/site")).json()["lists"]
    assert lists["similar_products"] == 0 and lists["recent_searches_max"] == 0 and lists["checkout_suggestions"] == 0


async def test_lists_obey_their_settings(client, admin, categories):
    made = await products(client, admin, categories, 6)
    assert (await admin.put("/api/admin/settings", {"search_page_size": 8, "search_suggestions": 2, "compare_max": 2})).status_code == 200

    r = (await client.get("/api/catalog/products", params={"q": "cotton shirt"})).json()
    assert r["page_size"] == 8
    # a shopper's own page size still works within the allowed range
    assert (await client.get("/api/catalog/products", params={"q": "cotton shirt", "page_size": 3})).json()["page_size"] == 3

    sugg = (await client.get("/api/catalog/suggest", params={"q": "cotton"})).json()
    assert len(sugg["products"]) <= 2 and len(sugg["categories"]) <= 2

    ids = ",".join(p["id"] for p in made[:3])
    cmp = (await client.get("/api/catalog/compare", params={"ids": ids})).json()
    assert len(cmp["items"]) == 2

    slug = made[0]["slug"]
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["similar"]  # siblings in the same category
    assert (await admin.put("/api/admin/settings", {"similar_products": 0})).status_code == 200
    assert (await client.get(f"/api/catalog/products/{slug}")).json()["similar"] == []
