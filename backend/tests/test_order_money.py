"""Order money: a duplicate payment is refunded to itself and never replaces the order's payment; the cancel dialog
shows the exact refund; the tip always goes back when nothing is delivered; the marketplace issues its own tax invoice
for its fees."""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Order, Payment, Refund
from app.services import orders as orders_svc
from tests.conftest import add_address, login_phone, valid_gstin
from tests.test_phase2_money import key, setup, ship_and_deliver

FEES = {"handling_enabled": True, "handling_paise": 1200, "platform_enabled": True, "platform_paise": 500, "tip_enabled": True}


async def _paid_order(client, gateway, buyer, addr: str, *, tip: int = 0, coupon: str | None = None) -> dict:
    body = {"address_id": addr, "payment_method": "online", "idempotency_key": key(), "tip_paise": tip}
    if coupon:
        body["coupon_code"] = coupon
    r = (await buyer.post("/api/orders", body)).json()
    pid, sig = gateway.pay(r["payment"]["razorpay_order_id"])
    await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": r["payment"]["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    return r["order"] | {"_pid": pid, "_rzp_order": r["payment"]["razorpay_order_id"]}


async def test_a_duplicate_payment_is_refunded_to_itself_and_never_replaces_the_original(client, admin, categories, gateway):
    await admin.put("/api/admin/checkout", {"fees": FEES})
    _tn, _ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000951", name="Two Tabs")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    o = await _paid_order(client, gateway, buyer, addr)
    first, second = o["sub_orders"]
    # one package is cancelled (refund 1), then a second payment for the same gateway order arrives (another tab)
    await buyer.post(f"/api/orders/{o['id']}/cancel", {"reason": "Changed my mind", "sub_order_id": first["id"]})
    dup_pid, _ = gateway.pay(o["_rzp_order"])
    async with SessionLocal() as s:
        pay = (await s.execute(select(Payment).where(Payment.order_id == uuid.UUID(o["id"])))).scalar_one()
        assert await orders_svc.mark_paid(s, pay, dup_pid, "upi", pay.amount_paise) == "refund"
        assert await orders_svc.mark_paid(s, pay, dup_pid, "upi", pay.amount_paise) == "already"  # the webhook repeats
        await s.commit()
    async with SessionLocal() as s:
        pay = (await s.execute(select(Payment).where(Payment.order_id == uuid.UUID(o["id"])))).scalar_one()
        order = await s.get(Order, uuid.UUID(o["id"]))
        assert pay.provider_payment_id == o["_pid"]  # the original stays the order's payment
        assert order.status == "placed" and order.payment_status == "partially_refunded"  # a live order is not marked refunded
        dup = (await s.execute(select(Refund).where(Refund.provider_payment_id == dup_pid))).scalar_one()
        assert dup.amount_paise == pay.amount_paise and dup.reason == "Duplicate payment"
        ids = list((await s.execute(select(Refund.id).where(Refund.order_id == order.id))).scalars())
    async with SessionLocal() as s:
        for rid in ids:
            await orders_svc.process_refund(s, rid)
    by_payment: dict[str, int] = {}
    for r in gateway.refunds.values():
        by_payment[r["payment_id"]] = by_payment.get(r["payment_id"], 0) + r["amount"]
    assert by_payment[dup_pid] == o["grand_total"] and by_payment[o["_pid"]] < o["grand_total"]
    # the remaining package's cancellation refunds the original payment again, with the fees (switch on) and nothing else
    view = (await buyer.get(f"/api/orders/{o['id']}")).json()
    assert next(s for s in view["sub_orders"] if s["id"] == second["id"])["refund_if_cancelled"] == second["total"] + 1700


async def test_cancel_dialog_amount_tip_rule_and_the_fee_invoice(client, admin, categories, gateway):
    await admin.put("/api/admin/checkout", {"fees": FEES | {"fees_refund_on_cancel": False}})
    assert (await admin.put("/api/admin/checkout", {"fees": {"fees_sac_code": "12ab"}})).json()["error"]["code"] == "invalid_setting"
    assert (await admin.post("/api/admin/coupons", {"code": "TAKE100", "kind": "flat", "value": 10000})).status_code == 201
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000952", name="Gift Tipper")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = await _paid_order(client, gateway, buyer, addr, tip=2000, coupon="TAKE100")
    sub = o["sub_orders"][0]
    view = (await buyer.get(f"/api/orders/{o['id']}")).json()
    # ₹1,000 package − ₹100 marketplace coupon + ₹20 tip (the fees stay with the marketplace: switch off)
    assert view["sub_orders"][0]["refund_if_cancelled"] == 100000 - 10000 + 2000
    r = await buyer.post(f"/api/orders/{o['id']}/cancel", {"reason": "Ordered by mistake", "sub_order_id": sub["id"]})
    assert r.json()["refunded_total"] == 92000
    async with SessionLocal() as s:
        order = await s.get(Order, uuid.UUID(o["id"]))
        assert order.fee_invoice_number == ""  # no GSTIN for the marketplace yet: no tax invoice is issued

    # with the marketplace's GSTIN set, kept fees are invoiced, and a delivered order's fees too
    r = await admin.put("/api/admin/storefront/site", {"business": {"legal_name": "PixCart Retail Pvt Ltd", "gstin": valid_gstin("33", "PIXCA1234P"),
                                                                    "registered_address": "1 Mount Road, Chennai 600002"}})
    assert r.status_code == 200, r.text
    buyer2 = await login_phone(client, "9600000953", name="Fee Invoice")
    addr2 = await add_address(buyer2, state="29", city="Bengaluru", pincode="560001")
    await buyer2.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o2 = (await buyer2.post("/api/orders", {"address_id": addr2, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    assert (await buyer2.get(f"/api/orders/{o2['id']}/fee-invoice.pdf")).json()["error"]["code"] == "invoice_not_ready"
    await ship_and_deliver(tn, o2["sub_orders"][0]["id"])
    detail = (await buyer2.get(f"/api/orders/{o2['id']}")).json()
    assert detail["fee_invoice_number"].startswith("MKT/") and detail["fee_invoice_number"].endswith("/000001")
    pdf = await buyer2.get(f"/api/orders/{o2['id']}/fee-invoice.pdf")
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf" and pdf.content[:4] == b"%PDF"
    assert (await admin.get(f"/api/admin/orders/{o2['id']}/fee-invoice.pdf")).status_code == 200
    assert (await buyer.get(f"/api/orders/{o2['id']}/fee-invoice.pdf")).status_code == 404  # someone else's order
