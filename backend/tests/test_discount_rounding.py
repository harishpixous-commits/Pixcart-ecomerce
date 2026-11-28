"""Odd discounts on a multi-line order: tax, discounts and totals still add up to the paise."""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.models import OrderItem, SubOrder
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup


async def _check(order_id: str, expect_platform: int, expect_seller: int) -> None:
    async with SessionLocal() as s:
        subs = list((await s.execute(select(SubOrder).where(SubOrder.order_id == uuid.UUID(order_id)))).scalars())
        assert sum(x.platform_discount for x in subs) == expect_platform
        assert sum(x.seller_discount for x in subs) == expect_seller
        for sub in subs:
            items = list((await s.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalars())
            assert sum(i.platform_discount for i in items) == sub.platform_discount
            assert sum(i.seller_discount for i in items) == sub.seller_discount
            for i in items:
                assert i.taxable_value + i.cgst + i.sgst + i.igst == i.line_total - i.seller_discount   # tax splits exactly
            assert sum(i.line_total - i.seller_discount for i in items) == sub.total


async def test_odd_discounts_on_a_multi_line_order_add_up_exactly(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    assert (await admin.post("/api/admin/coupons", {"code": "ODD3333", "kind": "flat", "value": 3333, "per_user_limit": 5, "show_on_checkout": False})).status_code == 201
    assert (await tn.post("/api/seller/coupons", {"code": "ODD3331", "kind": "flat", "value": 3331, "per_user_limit": 5})).status_code == 201
    a = await login_phone(client, "9770000421", name="Rounding Buyer")
    for state, extra in (("33", {}), ("29", {"city": "Mysuru", "pincode": "570002"})):     # inside the state (CGST+SGST) and outside (IGST)
        addr = await add_address(a, state=state, **extra)
        for code, plat, sell in (("ODD3333", 3333, 0), ("ODD3331", 0, 3331)):
            await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 3})
            await a.post("/api/cart/items", {"variant_id": phone_p["variants"][0]["id"], "qty": 1})
            r = await a.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": code})
            assert r.status_code == 201, r.text
            await _check(r.json()["order"]["id"], plat, sell)
