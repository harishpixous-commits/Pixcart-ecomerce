"""A platform coupon limited to chosen products (by product link name)."""
from __future__ import annotations

from tests.conftest import add_address, login_phone
from tests.test_phase2_money import setup


async def test_coupon_only_counts_the_chosen_products(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    body = {"code": "ONLYSHIRT", "kind": "percent", "value": 1000, "show_on_checkout": False, "product_slugs": [shirt["slug"]]}
    r = await admin.post("/api/admin/coupons", body)
    assert r.status_code == 201 and r.json()["product_slugs"] == [shirt["slug"]]
    bad = await admin.post("/api/admin/coupons", {**body, "code": "NOSUCH", "product_slugs": ["no-such-product"]})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "product_not_found"
    a = await login_phone(client, "9770000601", name="Product Coupon Buyer")
    addr = await add_address(a, state="33")
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "ONLYSHIRT"})
    await a.post("/api/cart/items", {"variant_id": phone_p["variants"][0]["id"], "qty": 1})
    assert (await q()).json()["coupon"]["error"] is not None  # only a different product in the cart
    await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == shirt["variants"][0]["price_paise"] // 10
    listed = [x for x in (await admin.get("/api/admin/coupons")).json() if x["code"] == "ONLYSHIRT"][0]
    assert listed["product_slugs"] == [shirt["slug"]]
    # clearing the list takes the limit off
    cid = r.json()["id"]
    put = {**body, "product_slugs": []}
    assert (await admin.put(f"/api/admin/coupons/{cid}", put)).json()["product_slugs"] == []
