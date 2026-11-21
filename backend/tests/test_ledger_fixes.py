"""Seller money: returns reverse exactly the returned lines' deductions; a failed payout touches only its own orders;
payouts go to the bank account Finance saw; cash a seller's own courier collected comes off the payout."""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select, update

from app.core.money import apply_bps
from app.db import SessionLocal, utcnow
from app.models import LedgerEntry, OrderItem, Payout, SubOrder
from app.services import ledger
from tests.conftest import add_address, login_phone, make_live_product
from tests.test_phase2_money import key, setup, ship_and_deliver


async def _entries(seller_id: str, kind: str) -> list[int]:
    async with SessionLocal() as s:
        return list((await s.execute(select(LedgerEntry.amount).where(LedgerEntry.seller_id == uuid.UUID(seller_id), LedgerEntry.kind == kind))).scalars())


async def test_return_reverses_the_returned_lines_own_commission(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)  # shirt ₹1,000 in Men's Shirts (12% commission)
    radio = await make_live_product(client, admin, tn, categories["mobiles"], title="Pocket FM Radio", gst_bps=1800,
                                    variants=[{"sku": "RD-1", "options": {}, "mrp_paise": 1200000, "price_paise": 1000000, "stock": 5}])  # Mobiles: 5%
    buyer = await login_phone(client, "9600000961", name="Return One")
    addr = await add_address(buyer, state="33")
    for v in (shirt, radio):
        await buyer.post("/api/cart/items", {"variant_id": v["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    items = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()["items"][sub_id]
    shirt_item = next(i for i in items if i["title"] == shirt["title"])["order_item_id"]
    rid = (await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": shirt_item, "qty": 1}], "reason": "size_fit",
                                             "refund_upi": "ret@okaxis"})).json()["id"]
    await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})).json()["status"] == "received"
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        it = await s.get(OrderItem, uuid.UUID(shirt_item))
    assert it.commission_paise == apply_bps(100000, 1200) == 12000
    assert await _entries(tn.seller_id, "commission_reversal") == [12000]  # the shirt's own 12%, not a share of the 5% radio
    assert await _entries(tn.seller_id, "commission_gst_reversal") == [round(sub.commission_gst_paise * 12000 / sub.commission_paise)]
    assert await _entries(tn.seller_id, "tcs_reversal") == [round(sub.tcs_paise * it.taxable_value / sub.taxable_total)]
    assert await _entries(tn.seller_id, "tds_reversal") == [round(sub.tds_paise * 100000 / sub.total)]


async def test_failed_payout_bank_snapshot_and_seller_courier_cash(client, admin, categories, gateway):
    assert (await admin.post("/api/admin/coupons", {"code": "STORE50", "kind": "flat", "value": 5000})).status_code == 201
    await admin.put("/api/admin/checkout", {"fees": {"platform_enabled": True, "platform_paise": 500}})
    tn, ka, shirt, phone = await setup(client, admin, categories)
    # a COD order the seller ships with their own courier: the slip and the ledger know the cash they collected
    buyer = await login_phone(client, "9600000962", name="Cash Buyer")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "STORE50"})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]
    collect = 100000 - 5000 + 500  # the marketplace's coupon comes off, its platform fee is added
    assert (await tn.get(f"/api/seller/orders/{sub_id}")).json()["cod_to_collect"] == collect == o["grand_total"]
    await ship_and_deliver(tn, sub_id)
    assert await _entries(tn.seller_id, "cod_collected") == [-collect]
    # the other seller's prepaid order, delivered and paid out first
    buyer2 = await login_phone(client, "9600000963", name="Other Buyer")
    addr2 = await add_address(buyer2, state="29", city="Mysuru", pincode="570002")
    await buyer2.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    r2 = (await buyer2.post("/api/orders", {"address_id": addr2, "payment_method": "online", "idempotency_key": key()})).json()
    pid, sig = gateway.pay(r2["payment"]["razorpay_order_id"])
    await buyer2.post("/api/payments/razorpay/verify", {"razorpay_order_id": r2["payment"]["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    o2 = r2["order"]
    await ship_and_deliver(ka, o2["sub_orders"][0]["id"])
    async with SessionLocal() as s:
        await s.execute(update(LedgerEntry).values(available_at=utcnow() - timedelta(minutes=1)))
        await s.commit()
    run = (await admin.post("/api/admin/payouts/run")).json()["items"]
    # Kovai's ledger nets to the ₹50 coupon the marketplace funded minus its fees (the cash is with them), so only Mysuru is paid
    assert [p["seller_name"] for p in run] == [""] and len(run) == 1
    ka_payout = run[0]
    async with SessionLocal() as s:
        ka_sub = await s.get(SubOrder, uuid.UUID(o2["sub_orders"][0]["id"]))
        assert ka_sub.settlement_status == "paid"

    # Mysuru changes bank details (by staff) after the payout was made: it is held until Finance confirms the account
    ka_id = (await ka.get("/api/seller/me")).json()["id"]
    r = await admin.put(f"/api/admin/sellers/{ka_id}/bank", {"holder_name": "Mysuru Mart LLP", "account_number": "555566667777",
                                                             "confirm_account_number": "555566667777", "ifsc": "ICIC0004321", "password": "Admin@12345"})
    assert r.status_code == 200, r.text
    listed = next(p for p in (await admin.get("/api/admin/payouts")).json()["items"] if p["id"] == ka_payout["id"])
    assert listed["bank_changed"] is True and "account_enc" not in listed["bank"]
    assert "555566667777" not in (await admin.get("/api/admin/payouts/bank-file.csv")).text
    sent = await admin.post(f"/api/admin/payouts/{ka_payout['id']}/send")
    assert sent.status_code == 409 and sent.json()["error"]["code"] == "bank_changed"
    confirmed = (await admin.post(f"/api/admin/payouts/{ka_payout['id']}/use-current-bank")).json()
    assert confirmed["bank_changed"] is False and confirmed["bank"]["account_last4"] == "7777"
    assert "555566667777" in (await admin.get("/api/admin/payouts/bank-file.csv")).text

    # a failed (cancelled) payout puts back only its own orders: another payout's paid orders stay paid
    async with SessionLocal() as s:
        other = Payout(number="PO-OTHER-1", seller_id=uuid.UUID(tn.seller_id), amount=100, mode="manual", status="pending", bank_snapshot={})
        s.add(other)
        await s.flush()
        await ledger.fail_payout(s, other, "Bank rejected")
        await s.commit()
        assert (await s.get(SubOrder, uuid.UUID(o2["sub_orders"][0]["id"]))).settlement_status == "paid"
