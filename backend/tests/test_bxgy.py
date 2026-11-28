"""Buy X get Y: the cheapest Y of every X+Y units get a percent off."""
from __future__ import annotations

from tests.conftest import add_address, login_phone
from tests.test_phase2_money import setup


async def test_buy_two_get_one_free(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    bad = await admin.post("/api/admin/coupons", {"code": "BADBX", "kind": "bxgy", "value": 100, "buy_qty": 0, "get_qty": 1})
    assert bad.status_code == 400
    r = await admin.post("/api/admin/coupons", {"code": "B2G1", "kind": "bxgy", "value": 100, "buy_qty": 2, "get_qty": 1, "show_on_checkout": False})
    assert r.status_code == 201 and r.json()["buy_qty"] == 2 and r.json()["get_qty"] == 1
    a = await login_phone(client, "9770000401", name="Bxgy Buyer")
    addr = await add_address(a, state="33")
    vid = shirt["variants"][0]["id"]
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "B2G1"})
    assert (await q()).json()["coupon"]["discount"] == 0  # two units: nothing free yet
    await a.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    unit = shirt["variants"][0]["price_paise"]
    c = (await q()).json()["coupon"]
    assert c["error"] is None and c["discount"] == unit
