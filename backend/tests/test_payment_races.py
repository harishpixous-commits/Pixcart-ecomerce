"""Two taps at once: the payment is confirmed once, and a paid sub-order cancelled twice at the same moment is refunded once."""
from __future__ import annotations

import asyncio

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import Payment, Refund
from tests.conftest import add_address, login_phone
from tests.test_orders import marketplace
from tests.test_phase2_money import key


async def test_double_verify_and_double_cancel_do_not_double_count(client, admin, categories, gateway):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000071")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})
    assert r.status_code == 201, r.text
    order, pay = r.json()["order"], r.json()["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    body = {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig}
    res = await asyncio.gather(*[buyer.post("/api/payments/razorpay/verify", body) for _ in range(4)])
    assert all(x.status_code == 200 and x.json()["result"] in ("paid", "already") for x in res), [(x.status_code, x.text[:80]) for x in res]
    assert sorted(x.json()["result"] for x in res).count("paid") == 1
    async with SessionLocal() as s:
        assert (await s.execute(select(func.count()).select_from(Payment).where(Payment.status == "captured"))).scalar_one() == 1
    sub = (await buyer.get(f"/api/orders/{order['id']}")).json()["sub_orders"][0]
    cancels = await asyncio.gather(*[buyer.post(f"/api/orders/{order['id']}/cancel", {"sub_order_id": sub["id"], "reason": "Ordered by mistake"}) for _ in range(3)])
    codes = sorted(x.status_code for x in cancels)
    assert codes.count(200) == 1 and all(c in (400, 409) for c in codes if c != 200), codes
    async with SessionLocal() as s:
        refunds = list((await s.execute(select(Refund))).scalars())
    assert len(refunds) == 1 and refunds[0].amount_paise == order["grand_total"], [(r.amount_paise, r.status) for r in refunds]


async def test_cancelling_one_order_three_times_at_once_gives_back_one_coupon_use_and_one_unit(client, admin, categories):
    from app.models import Coupon, Variant
    from tests.test_phase2_money import setup

    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    sv = shirt["variants"][0]
    assert (await admin.post("/api/admin/coupons", {"code": "CANCELRACE", "kind": "flat", "value": 1000, "usage_limit": 5, "per_user_limit": 5, "show_on_checkout": False})).status_code == 201
    import uuid as _u
    async with SessionLocal() as s:
        before = (await s.get(Variant, _u.UUID(sv["id"]))).stock
    buyer = await login_phone(client, "9300000072")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": sv["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "CANCELRACE"})
    assert r.status_code == 201, r.text
    oid = r.json()["order"]["id"]
    res = await asyncio.gather(*[buyer.post(f"/api/orders/{oid}/cancel", {"reason": "Ordered by mistake"}) for _ in range(3)])
    codes = sorted(x.status_code for x in res)
    assert codes.count(200) == 1 and all(c in (400, 409) for c in codes if c != 200), codes
    async with SessionLocal() as s:
        assert (await s.execute(select(Coupon).where(Coupon.code == "CANCELRACE"))).scalar_one().used_count == 0
        assert (await s.get(Variant, _u.UUID(sv["id"]))).stock == before
