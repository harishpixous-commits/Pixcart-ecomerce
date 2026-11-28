"""Automatic discounts: a coupon marked automatic applies at checkout with no code, only when the setting is on."""
from __future__ import annotations

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import CouponRedemption
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup


async def test_automatic_coupon_applies_without_a_code_only_when_switched_on(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    r = await admin.post("/api/admin/coupons", {"code": "AUTO10", "kind": "percent", "value": 1000, "max_discount_paise": 100000, "is_automatic": True, "show_on_checkout": False})
    assert r.status_code == 201 and r.json()["is_automatic"] is True
    await admin.post("/api/admin/coupons", {"code": "SMALLAUTO", "kind": "flat", "value": 1000, "is_automatic": True})
    a = await login_phone(client, "9770000301", name="Auto Buyer")
    addr = await add_address(a, state="33")
    await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    q = lambda: a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    assert (await q()).json()["coupon"] is None  # setting is off by default
    assert (await admin.put("/api/admin/growth/settings", {"auto_discounts": {"enabled": True}})).status_code == 200
    c = (await q()).json()["coupon"]
    assert c["code"] == "AUTO10" and c["automatic"] is True and c["discount"] == 100000 // 10 and c["error"] is None  # the bigger saving wins
    # a code the customer types wins over the automatic one
    typed = (await a.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "SMALLAUTO"})).json()["coupon"]
    assert typed["code"] == "SMALLAUTO" and "automatic" not in typed
    o = await a.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert o.status_code == 201
    async with SessionLocal() as s:
        n = (await s.execute(select(func.count()).select_from(CouponRedemption))).scalar_one()
    assert n == 1
