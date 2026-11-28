"""A size guide on a product: typed as lines of comma separated cells, shown as a table on the product page."""
from __future__ import annotations

import uuid

from app.db import SessionLocal
from app.models import Product, Variant
from app.services.product_info import ProductDetails, details_of, size_chart_rows
from tests.test_gallery import body_from
from tests.test_phase2_money import setup


def test_size_chart_is_cleaned_and_checked():
    d = ProductDetails(size_chart=" Size, Chest (cm), Waist (cm)\n\nS, 90, 76\nM,96 ,82\n")
    assert size_chart_rows(d) == [["Size", "Chest (cm)", "Waist (cm)"], ["S", "90", "76"], ["M", "96", "82"]]
    assert d.size_chart.splitlines()[0] == "Size, Chest (cm), Waist (cm)"
    assert size_chart_rows(ProductDetails()) == []
    for bad in ("Size, Chest\nS, 90, 76", "Size\nS", "\n".join(["a, b"] * 22), "a, " + "x" * 21):
        try:
            ProductDetails(size_chart=bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted: {bad!r}")
    assert details_of({"size_chart": "Size, Chest\nS, 90\nbad,row,extra"}).size_chart == ""  # a bad stored value never breaks a page


async def test_size_chart_is_saved_by_the_seller_and_shown_on_the_product_page(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    ragged = body_from(detail) | {"details": {"size_chart": "Size, Chest\nS, 90, 76"}}
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", ragged)).status_code == 422
    async with SessionLocal() as s:
        v = await s.get(Variant, uuid.UUID(shirt["variants"][0]["id"]))
        p = await s.get(Product, v.product_id)
        p.details = {**(p.details or {}), "size_chart": "Size, Chest\nS, 90\nM, 96"}
        await s.commit()
        slug = p.slug
    page = (await client.get(f"/api/catalog/products/{slug}")).json()
    assert page["size_chart"] == [["Size", "Chest"], ["S", "90"], ["M", "96"]]
