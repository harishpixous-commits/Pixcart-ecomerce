"""A coupon with one use left cannot be used twice by two customers ordering at the same moment."""
from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Coupon
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup


async def test_last_use_of_a_coupon_goes_to_one_order(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    sv = shirt["variants"][0]
    assert (await admin.post("/api/admin/coupons", {"code": "ONLYONE", "kind": "flat", "value": 1000, "usage_limit": 1, "show_on_checkout": False})).status_code == 201
    buyers = [await login_phone(client, f"97700006{i:02d}", name=f"Racer {i}") for i in range(5)]
    addrs = [await add_address(b, state="33") for b in buyers]
    for b in buyers:
        assert (await b.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})).status_code == 200
    results = await asyncio.gather(*[
        b.post("/api/orders", {"address_id": a, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "ONLYONE"})
        for b, a in zip(buyers, addrs, strict=True)
    ])
    won = [r for r in results if r.status_code == 201]
    assert len(won) == 1, [r.status_code for r in results]
    assert all(r.status_code in (400, 409) for r in results if r.status_code != 201), [r.status_code for r in results]
    async with SessionLocal() as s:
        c = (await s.execute(select(Coupon).where(Coupon.code == "ONLYONE"))).scalar_one()
        assert c.used_count == 1
