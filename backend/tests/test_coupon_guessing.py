"""A customer cannot brute-force coupon codes at checkout: after 30 wrong codes an hour, typed codes are refused."""
from __future__ import annotations

from tests.conftest import add_address, login_phone
from tests.test_phase2_money import setup


async def test_wrong_coupon_codes_are_limited_but_the_quote_still_works(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    sv = shirt["variants"][0]
    assert (await admin.post("/api/admin/coupons", {"code": "REALCODE", "kind": "flat", "value": 1000, "show_on_checkout": False})).status_code == 201
    a = await login_phone(client, "9770000551", name="Guesser")
    addr = await add_address(a, state="33")
    await a.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})
    quote = lambda code: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": code})
    assert (await quote("REALCODE")).json()["coupon"]["error"] is None   # a right code costs nothing
    for i in range(30):
        r = await quote(f"WRONG{i:03d}")
        assert r.status_code == 200 and r.json()["coupon"]["error"]
    blocked = await quote("REALCODE")
    assert blocked.status_code == 200, blocked.text   # the bill still shows, only the typed code is refused
    assert "Too many" in blocked.json()["coupon"]["error"]
    plain = await a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    assert plain.status_code == 200
