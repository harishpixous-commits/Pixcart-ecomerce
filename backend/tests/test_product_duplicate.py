"""Duplicate a listing: a new draft with fresh SKUs, no stock, and the original untouched."""
from __future__ import annotations

from tests.test_phase2_money import setup


async def test_duplicate_makes_a_draft_copy_with_fresh_skus_and_no_stock(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    before = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    r = await tn.post(f"/api/seller/products/{shirt['id']}/duplicate")
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["id"] != shirt["id"] and c["status"] == "draft" and c["title"] == "Copy of " + before["title"]
    assert [v["sku"] for v in c["variants"]] == [v["sku"] + "-COPY" for v in before["variants"]]
    assert all(v["stock"] == 0 for v in c["variants"])
    assert [v["price_paise"] for v in c["variants"]] == [v["price_paise"] for v in before["variants"]]
    assert c["category_id"] == before["category_id"] and c["description"] == before["description"] and c["images"] == before["images"]
    # a second copy gets the next free SKU; the original is untouched
    c2 = (await tn.post(f"/api/seller/products/{shirt['id']}/duplicate")).json()
    assert [v["sku"] for v in c2["variants"]] == [v["sku"] + "-COPY2" for v in before["variants"]]
    after = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert after["status"] == before["status"] and [v["stock"] for v in after["variants"]] == [v["stock"] for v in before["variants"]]
    # someone else's listing is not found
    assert (await tn.post("/api/seller/products/00000000-0000-0000-0000-000000000001/duplicate")).status_code == 404
