"""Warehouses, coupons, returns, ledger/payouts and invoices."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select, update

from app.core.money import split_inclusive_gst
from app.db import SessionLocal, utcnow
from app.models import (
    InventoryLevel,
    LedgerEntry,
    OrderItem,
    Refund,
    SubOrder,
    Variant,
    Warehouse,
)
from app.services import ledger
from tests.conftest import (
    add_address,
    login_phone,
    make_live_product,
    make_seller,
    valid_gstin,
)


def key() -> str:
    return uuid.uuid4().hex


async def setup(client, admin, categories):
    tn = await make_seller(client, admin, "9400000001", name="Kovai Textiles", pan="KOVAI1234K", state="33")
    ka = await make_seller(client, admin, "9400000002", name="Mysuru Mart", pan="MYSUR1234M", state="29", city="Mysuru", pincode="570001")
    shirt = await make_live_product(client, admin, tn, categories["shirts"], title="Handloom Cotton Shirt Blue", gst_bps=500,
                                    variants=[{"sku": "HL-1", "options": {}, "mrp_paise": 200000, "price_paise": 100000, "stock": 10}])
    phone = await make_live_product(client, admin, ka, categories["mobiles"], title="Feature Phone Dual SIM", gst_bps=1800,
                                    variants=[{"sku": "FP-1", "options": {}, "mrp_paise": 150000, "price_paise": 120000, "stock": 10}])
    return tn, ka, shirt, phone


async def ship_and_deliver(seller, sub_id: str, *, marketplace_courier: bool = False) -> None:
    """Confirm, pack, ship and deliver. ``marketplace_courier``: booked on the marketplace's courier account, which
    remits cash on delivery to the marketplace (by default the seller's own courier collects it for the seller)."""
    for step in ("confirm", "pack"):
        r = await seller.post(f"/api/seller/orders/{sub_id}/{step}")
        assert r.status_code == 200, r.text
    r = await seller.post(f"/api/seller/orders/{sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "AWB12345"})
    assert r.status_code == 200, r.text
    if marketplace_courier:
        async with SessionLocal() as s:
            await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sub_id)).values(shipping_provider="shiprocket"))
            await s.commit()
    r = await seller.post(f"/api/seller/orders/{sub_id}/deliver")
    assert r.status_code == 200, r.text


async def test_warehouses_allocation_and_tax(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    whs = (await tn.get("/api/seller/warehouses")).json()
    assert len(whs) == 1 and whs[0]["is_default"] and whs[0]["units"] == 10
    base = {"code": "BLR1", "name": "Bengaluru hub", "line1": "5 Industrial Area", "city": "Bengaluru", "state_code": "29", "pincode": "560058"}
    r = await tn.post("/api/seller/warehouses", base)
    assert r.status_code == 400 and r.json()["error"]["code"] == "gstin_required"
    r = await tn.post("/api/seller/warehouses", {**base, "gstin": valid_gstin("29", "OTHER1234X")})
    assert r.status_code == 400 and r.json()["error"]["code"] == "gstin_mismatch"
    r = await tn.post("/api/seller/warehouses", {**base, "gstin": valid_gstin("29", "KOVAI1234K")})
    assert r.status_code == 201
    blr = next(w for w in r.json() if w["code"] == "BLR1")
    main = next(w for w in r.json() if w["is_default"])
    vid = shirt["variants"][0]["id"]

    # Move 4 units to Bengaluru; total stays 10.
    r = await tn.post("/api/seller/inventory/transfer", {"variant_id": vid, "from_warehouse_id": main["id"], "to_warehouse_id": blr["id"], "quantity": 4})
    assert r.status_code == 200 and r.json()["total"] == 10
    grid = (await tn.get("/api/seller/inventory")).json()
    assert grid["items"][0]["levels"] == {main["id"]: 6, blr["id"]: 4}

    # A Karnataka buyer is served from the Bengaluru warehouse → intra-state (CGST/SGST), not IGST.
    buyer = await login_phone(client, "9500000001")
    addr = await add_address(buyer, state="29", city="Bengaluru", pincode="560001")
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 2})
    order = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    async with SessionLocal() as s:
        sub = (await s.execute(select(SubOrder).where(SubOrder.number == order["sub_orders"][0]["number"]))).scalar_one()
        assert sub.warehouse_id == uuid.UUID(blr["id"]) and sub.is_interstate is False
        item = (await s.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalar_one()
        assert item.cgst > 0 and item.igst == 0
        lvl = await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(blr["id"])))
        assert lvl.quantity == 2

    # Cancelling puts the stock back into the same warehouse.
    await buyer.post(f"/api/orders/{order['id']}/cancel", {"reason": "Changed my mind"})
    async with SessionLocal() as s:
        lvl = await s.get(InventoryLevel, (uuid.UUID(vid), uuid.UUID(blr["id"])))
        assert lvl.quantity == 4
    mv = (await tn.get(f"/api/seller/inventory/{vid}/movements")).json()["items"]
    assert [m["kind"] for m in mv][:2] == ["release", "sale"]

    # CSV stock import with a bad row reported.
    csv_body = "sku,warehouse_code,quantity\nHL-1,MAIN,20\nNOPE,MAIN,1\nHL-1,BLR1,x\n"
    r = await client.post("/api/seller/inventory/import", headers=tn.h(), files={"file": ("s.csv", csv_body.encode(), "text/csv")})
    assert r.json()["updated"] == 1 and len(r.json()["errors"]) == 2
    async with SessionLocal() as s:
        assert (await s.get(Variant, uuid.UUID(vid))).stock == 24


async def test_coupons_platform_and_seller_funded(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    r = await admin.post("/api/admin/coupons", {"code": "WELCOME10", "kind": "percent", "value": 1000, "max_discount_paise": 15000, "per_user_limit": 1})
    assert r.status_code == 201
    r = await tn.post("/api/seller/coupons", {"code": "KOVAI100", "kind": "flat", "value": 10000, "min_order_paise": 50000})
    assert r.status_code == 201

    buyer = await login_phone(client, "9500000002")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    q = (await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "welcome10"})).json()
    assert q["coupon"]["discount"] == 15000  # 10% of 2200 = 220, capped at 150
    bad = (await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "NOPE"})).json()
    assert bad["coupon"]["error"]

    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "WELCOME10", "expected_total": q["summary"]["grand_total"]})
    assert r.status_code == 201, r.text
    o = r.json()["order"]
    assert o["grand_total"] == 100000 + 120000 - 15000  # both sellers ship free (>= ₹499)
    detail = (await admin.get(f"/api/admin/orders/{o['id']}")).json()
    # Platform-funded: each seller is still paid on the full price.
    for s in detail["sub_orders"]:
        assert s["total"] in (100000, 120000)
    # Discount split in proportion 1000:1200 → 6818 + 8182.
    async with SessionLocal() as s:
        subs = list((await s.execute(select(SubOrder).where(SubOrder.order_id == uuid.UUID(o["id"])))).scalars())
        assert sorted(x.platform_discount for x in subs) == [6818, 8182]
    # Used once per customer.
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    q2 = (await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "coupon_code": "WELCOME10"})).json()
    assert "already used" in q2["coupon"]["error"]

    # Seller-funded coupon lowers that seller's sale value and taxable value.
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "coupon_code": "KOVAI100"})
    assert r.status_code == 201, r.text
    async with SessionLocal() as s:
        sub = (await s.execute(select(SubOrder).where(SubOrder.order_id == uuid.UUID(r.json()["order"]["id"])))).scalar_one()
        assert sub.seller_discount == 10000 and sub.total == 90000
        assert sub.taxable_total == split_inclusive_gst(90000, 500, interstate=False).taxable

    # Cancelling the whole first order gives the coupon back.
    await buyer.post(f"/api/orders/{o['id']}/cancel", {"reason": "Ordered by mistake"})
    coupons = (await admin.get("/api/admin/coupons")).json()
    assert next(c for c in coupons if c["code"] == "WELCOME10")["used_count"] == 0


async def test_return_cod_and_ledger_and_payout(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9500000003")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = o["sub_orders"][0]["id"]

    # Not returnable before delivery.
    ret = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()
    assert ret["items"][sub_id] == []
    # booked on the marketplace's courier account, which remits the cash to the marketplace (a seller's own courier
    # would leave the cash with the seller: see test_ledger_fixes)
    await ship_and_deliver(tn, sub_id, marketplace_courier=True)

    # Invoice number assigned at shipping; customer and seller can open the PDF, others cannot.
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert sub.invoice_number.startswith("KOV/") and len(sub.invoice_number) <= 16
    r = await buyer.get(f"/api/invoices/{sub_id}.pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert (await tn.get(f"/api/seller/orders/{sub_id}/invoice.pdf")).status_code == 200
    stranger = await login_phone(client, "9500000099")
    assert (await stranger.get(f"/api/invoices/{sub_id}.pdf")).status_code == 404

    # Ledger: sale and deductions, available after the return window.
    bal = (await tn.get("/api/seller/payouts")).json()["balances"]
    assert bal["available"] == 0 and bal["upcoming"] > 0

    # Return one of two units (COD → UPI needed).
    item_id = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    r = await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item_id, "qty": 1}], "reason": "size_fit"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "upi_required"
    r = await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item_id, "qty": 1}], "reason": "size_fit", "refund_upi": "priya@okaxis"})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    assert r.json()["refund_amount"] == 100000
    # Seller must give a reason to reject; then approves and receives.
    r = await tn.post(f"/api/seller/returns/{rid}", {"action": "reject", "note": "no"})
    assert r.status_code == 400
    assert (await tn.post(f"/api/seller/returns/{rid}", {"action": "approve"})).json()["status"] == "approved"
    r = await tn.post(f"/api/seller/returns/{rid}", {"action": "received"})
    assert r.json()["status"] == "received" and r.json()["credit_note_number"].startswith("KOCN/")
    async with SessionLocal() as s:
        assert (await s.get(Variant, uuid.UUID(shirt["variants"][0]["id"]))).stock == 9  # 10 - 2 + 1
        kinds = [e.kind for e in (await s.execute(select(LedgerEntry).where(LedgerEntry.seller_id == uuid.UUID(tn.seller_id)))).scalars()]
        assert "return" in kinds and "commission_reversal" in kinds
    # Finance pays the COD refund by UPI and records the reference.
    admin_rets = (await admin.get("/api/admin/returns?status=received")).json()["items"]
    assert admin_rets[0]["refund_upi"] == "priya@okaxis"
    r = await admin.post(f"/api/admin/returns/{rid}", {"action": "mark_refunded", "reference": "UPI123456"})
    assert r.json()["status"] == "refunded"
    assert (await buyer.get(f"/api/credit-notes/{rid}.pdf")).content.startswith(b"%PDF")

    # GSTR-8: the month nets out the returned unit (half the taxable value and half the TCS).
    month = datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%Y-%m")
    rep = (await admin.get(f"/api/admin/reports/tcs?month={month}")).json()
    row = next(i for i in rep["items"] if i["seller_id"] == tn.seller_id)
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert row["returned_value"] == sub.taxable_total // 2
        assert row["net_taxable_value"] == sub.taxable_total - sub.taxable_total // 2
        assert row["cgst_tcs"] + row["sgst_tcs"] == sub.tcs_paise - round(sub.tcs_paise / 2)

    # Payout: nothing is due until the return window closes.
    assert (await admin.post("/api/admin/payouts/run")).json()["created"] == 0
    async with SessionLocal() as s:
        await s.execute(update(LedgerEntry).values(available_at=utcnow() - timedelta(minutes=1)))
        await s.commit()
        expected = sum(e.amount for e in (await s.execute(select(LedgerEntry))).scalars())
    run = (await admin.post("/api/admin/payouts/run")).json()
    assert run["created"] == 1 and run["items"][0]["amount"] == expected
    pid = run["items"][0]["id"]
    csv_text = (await admin.get("/api/admin/payouts/bank-file.csv")).text
    assert "123456789012" in csv_text and "HDFC0001234" in csv_text
    assert (await admin.post(f"/api/admin/payouts/{pid}/paid", {"utr": "UTR998877"})).json()["status"] == "paid"
    bal = (await tn.get("/api/seller/payouts")).json()["balances"]
    assert bal["available"] == 0 and bal["paid_out"] == expected
    notes = (await tn.get("/api/notifications")).json()["items"]
    assert any("Payout" in n["title"] for n in notes)


async def test_online_return_refunds_through_gateway(client, admin, categories, gateway):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9500000004")
    addr = await add_address(buyer, state="29", city="Mysuru", pincode="570002")
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    r = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})).json()
    pay = r["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    sub_id = r["order"]["sub_orders"][0]["id"]
    await ship_and_deliver(ka, sub_id)
    item_id = (await buyer.get(f"/api/orders/{r['order']['id']}/returnable")).json()["items"][sub_id][0]["order_item_id"]
    rid = (await buyer.post("/api/returns", {"sub_order_id": sub_id, "items": [{"order_item_id": item_id, "qty": 1}], "reason": "defective"})).json()["id"]
    await ka.post(f"/api/seller/returns/{rid}", {"action": "approve"})
    out = (await ka.post(f"/api/seller/returns/{rid}", {"action": "received"})).json()
    assert out["status"] == "refunded"
    import asyncio

    await asyncio.sleep(0.05)
    async with SessionLocal() as s:
        refund = (await s.execute(select(Refund))).scalar_one()
        assert refund.status == "processed" and refund.amount_paise == 120000


async def test_razorpayx_payout_and_webhook(client, admin, categories, monkeypatch):
    from app.config import settings

    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9500000005")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    await ship_and_deliver(tn, o["sub_orders"][0]["id"], marketplace_courier=True)
    async with SessionLocal() as s:
        await s.execute(update(LedgerEntry).values(available_at=utcnow() - timedelta(minutes=1)))
        await s.commit()
    monkeypatch.setattr(settings, "payout_mode", "razorpayx")
    monkeypatch.setattr(settings, "razorpayx_account_number", "7878780080316316")
    monkeypatch.setattr(settings, "razorpayx_webhook_secret", "rx_secret")
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.url.path, req.headers.get("x-payout-idempotency")))
        if req.url.path.endswith("/contacts"):
            return httpx.Response(200, json={"id": "cont_1"})
        if req.url.path.endswith("/fund_accounts"):
            return httpx.Response(200, json={"id": "fa_1"})
        return httpx.Response(200, json={"id": "pout_1", "status": "processing"})

    ledger.transport = httpx.MockTransport(handler)
    try:
        payout = (await admin.post("/api/admin/payouts/run")).json()["items"][0]
        r = await admin.post(f"/api/admin/payouts/{payout['id']}/send")
        assert r.status_code == 200 and r.json()["status"] == "processing"
        assert calls[-1] == ("/v1/payouts", payout["id"])
    finally:
        ledger.transport = None
    import hashlib
    import hmac
    import json

    body = json.dumps({"event": "payout.processed", "payload": {"payout": {"entity": {"id": "pout_1", "utr": "UTRX1"}}}}).encode()
    sig = hmac.new(b"rx_secret", body, hashlib.sha256).hexdigest()
    r = await client.post("/api/webhooks/razorpayx", content=body, headers={"X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": "evt_x1"})
    assert r.status_code == 200
    items = (await admin.get("/api/admin/payouts")).json()["items"]
    assert items[0]["status"] == "paid" and items[0]["utr"] == "UTRX1"


async def test_warehouse_default_created_from_migration_shape(client, admin, categories):
    """Every approved seller has a default warehouse holding their stock."""
    tn, *_ = await setup(client, admin, categories)
    async with SessionLocal() as s:
        whs = list((await s.execute(select(Warehouse).where(Warehouse.seller_id == uuid.UUID(tn.seller_id)))).scalars())
        assert len(whs) == 1 and whs[0].is_default and whs[0].state_code == "33"
