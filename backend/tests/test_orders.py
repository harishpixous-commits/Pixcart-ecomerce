from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import uuid
from datetime import timedelta

from sqlalchemy import select, update

from app.core.money import apply_bps, compute_settlement, split_inclusive_gst
from app.db import SessionLocal, utcnow
from app.jobs import expire_job, refunds_job
from app.models import Order, Refund, SubOrder, Variant
from tests.conftest import add_address, login_phone, make_live_product, make_seller


def key() -> str:
    return uuid.uuid4().hex


async def marketplace(client, admin, categories):
    """Two approved sellers (Tamil Nadu and Karnataka) with live products."""
    tn = await make_seller(client, admin, "9200000001", name="Chennai Silks", pan="CHENN1234C", state="33")
    ka = await make_seller(client, admin, "9200000002", name="Bengaluru Gadgets", pan="BENGA1234B", state="29", city="Bengaluru", pincode="560001")
    shirt = await make_live_product(client, admin, tn, categories["shirts"], title="Silk Blend Festive Shirt", gst_bps=500,
                                    variants=[{"sku": "SILK-M", "options": {"Size": "M"}, "mrp_paise": 149900, "price_paise": 99900, "stock": 5},
                                              {"sku": "SILK-L", "options": {"Size": "L"}, "mrp_paise": 149900, "price_paise": 99900, "stock": 1}])
    cable = await make_live_product(client, admin, ka, categories["mobiles"], title="Braided USB-C Cable 1m", gst_bps=1800,
                                    variants=[{"sku": "CBL-1", "options": {}, "mrp_paise": 59900, "price_paise": 29900, "stock": 50}])
    return tn, ka, shirt, cable


def test_money_math():
    s = split_inclusive_gst(99900, 500, interstate=False)
    assert s.taxable == 95143 and s.cgst + s.sgst == 4757 and s.igst == 0
    assert s.taxable + s.tax == 99900
    i = split_inclusive_gst(29900, 1800, interstate=True)
    assert i.taxable == 25339 and i.igst == 4561
    st = compute_settlement(gross=100000, taxable=95238, commission=12000, commission_gst_bps=1800, tcs_bps=50, tds_bps=10)
    assert (st.commission_gst, st.tcs, st.tds) == (2160, 476, 100)
    assert st.payout == 100000 - 12000 - 2160 - 476 - 100
    assert apply_bps(5, 5000) == 3  # half-up


async def test_cod_multi_seller_order_full_lifecycle(client, admin, categories):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000001", "Priya")
    addr = await add_address(buyer, state="33")

    r = await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    assert r.status_code == 200
    r = await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    cart = r.json()
    assert len(cart["groups"]) == 2
    by_seller = {g["seller"]["name"]: g for g in cart["groups"]}
    assert by_seller["Chennai Silks"]["shipping_fee"] == 0  # 1998 >= 499 free shipping
    assert by_seller["Bengaluru Gadgets"]["shipping_fee"] == 4000  # 299 < 499
    assert cart["summary"]["grand_total"] == 199800 + 29900 + 4000

    r = await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod"})
    assert r.status_code == 200 and r.json()["cod_allowed"] is True
    total = r.json()["summary"]["grand_total"]

    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "expected_total": total + 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "total_changed"

    k = key()
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": k, "expected_total": total})
    assert r.status_code == 201, r.text
    order = r.json()["order"]
    assert r.json()["payment"] is None
    assert order["status"] == "placed" and order["payment_status"] == "cod" and order["grand_total"] == total
    assert len(order["sub_orders"]) == 2

    # Same idempotency key returns the same order, no duplicate.
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": k})
    assert r.json()["order"]["id"] == order["id"]
    assert (await buyer.get("/api/cart")).json()["groups"] == []

    # Tax: Tamil Nadu seller -> Tamil Nadu buyer is CGST+SGST; Karnataka seller -> IGST.
    detail = (await admin.get(f"/api/admin/orders/{order['id']}")).json()
    subs = {s["seller"]["name"]: s for s in detail["sub_orders"]}
    tn_item = subs["Chennai Silks"]["items"][0]
    assert tn_item["cgst"] > 0 and tn_item["igst"] == 0 and tn_item["taxable_value"] + tn_item["cgst"] + tn_item["sgst"] == 199800
    ka_item = subs["Bengaluru Gadgets"]["items"][0]
    assert ka_item["igst"] > 0 and ka_item["cgst"] == 0
    tn_sub = subs["Chennai Silks"]
    assert tn_sub["commission"] == apply_bps(199800, 1200)  # Men's Shirts category rate
    assert tn_sub["seller_payout"] == tn_sub["total"] - tn_sub["commission"] - tn_sub["commission_gst"] - tn_sub["tcs"] - tn_sub["tds"]
    assert tn_sub["tcs"] == apply_bps(split_inclusive_gst(199800, 500, interstate=False).taxable, 50)

    # Stock was taken.
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["variants"][0]["stock_left"] == 3

    # Seller flow; each seller sees only their own part.
    tn_orders = (await tn.get("/api/seller/orders?status=placed")).json()
    assert tn_orders["total"] == 1
    tn_sub_id = tn_orders["items"][0]["id"]
    ka_sub_id = subs["Bengaluru Gadgets"]["id"]
    assert (await tn.get(f"/api/seller/orders/{ka_sub_id}")).status_code == 404
    assert (await tn.post(f"/api/seller/orders/{tn_sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "D1234567"})).status_code == 409
    assert (await tn.post(f"/api/seller/orders/{tn_sub_id}/confirm")).json()["status"] == "confirmed"
    assert (await tn.post(f"/api/seller/orders/{tn_sub_id}/pack")).json()["status"] == "packed"
    r = await tn.post(f"/api/seller/orders/{tn_sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "D1234567", "tracking_url": "https://track.example/D1234567"})
    assert r.json()["status"] == "shipped"
    # Customer cannot cancel a shipped part.
    r = await buyer.post(f"/api/orders/{order['id']}/cancel", {"sub_order_id": tn_sub_id, "reason": "No longer needed"})
    assert r.status_code == 400
    r = await tn.post(f"/api/seller/orders/{tn_sub_id}/deliver")
    assert r.json()["status"] == "delivered" and r.json()["settlement_status"] == "pending"

    # The other part: seller rejects as out of stock -> stock zeroed, customer sees reason.
    r = await ka.post(f"/api/seller/orders/{ka_sub_id}/reject", {"reason": "out_of_stock"})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    async with SessionLocal() as s:
        v = await s.get(Variant, uuid.UUID(cable["variants"][0]["id"]))
        assert v.stock == 0

    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    statuses = {s["seller"]["name"]: s["status"] for s in mine["sub_orders"]}
    assert statuses == {"Chennai Silks": "delivered", "Bengaluru Gadgets": "cancelled"}
    assert mine["payment_status"] == "paid"  # COD collected for every non-cancelled part
    assert "commission" not in mine["sub_orders"][0]  # settlement figures are not shown to customers

    dash = (await tn.get("/api/seller/dashboard")).json()
    # the seller's own courier collected the cash, so the ledger already nets it off the payout
    assert dash["orders"]["delivered"] == 1 and dash["earnings"]["in_return_window"] == tn_sub["seller_payout"] - tn_sub["total"]
    earn = (await tn.get("/api/seller/earnings")).json()
    assert earn["totals"]["payout"] == tn_sub["seller_payout"] and earn["items"][0]["eligible"] is False

    # Another customer cannot see this order.
    other = await login_phone(client, "9300000002")
    assert (await other.get(f"/api/orders/{order['id']}")).status_code == 404

    # TCS report picks up the delivered sub-order only (cancelled excluded).
    month = utcnow().astimezone().strftime("%Y-%m")
    rep = (await admin.get(f"/api/admin/reports/tcs?month={month}")).json()
    assert len(rep["items"]) == 1 and rep["items"][0]["cgst_tcs"] + rep["items"][0]["sgst_tcs"] == tn_sub["tcs"]


async def test_online_payment_verify_webhook_and_refund(client, admin, categories, gateway):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000003")
    addr = await add_address(buyer, state="29", city="Bengaluru", pincode="560034")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})

    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})
    assert r.status_code == 201, r.text
    order, pay = r.json()["order"], r.json()["payment"]
    assert order["status"] == "pending_payment" and pay["key_id"] == "rzp_test_key"
    assert pay["amount"] == order["grand_total"] == gateway.orders[pay["razorpay_order_id"]]["amount"]

    # Sellers do not see unpaid orders.
    assert (await tn.get("/api/seller/orders")).json()["total"] == 0

    pid, sig = gateway.pay(pay["razorpay_order_id"])
    r = await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": "0" * 64})
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_signature"
    r = await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    assert r.status_code == 200, r.text
    assert r.json()["result"] == "paid" and r.json()["order"]["payment_status"] == "paid"
    assert all(s["status"] == "placed" for s in r.json()["order"]["sub_orders"])

    # The webhook for the same payment is harmless; a replay of the same event is ignored.
    event = {"event": "payment.captured", "created_at": 1, "payload": {"payment": {"entity": gateway.payments[pid]}}}
    raw = json.dumps(event).encode()
    sig_wh = hmac.new(b"whsec_test", raw, hashlib.sha256).hexdigest()
    hdrs = {"X-Razorpay-Signature": sig_wh, "X-Razorpay-Event-Id": "evt_1", "Content-Type": "application/json"}
    assert (await client.post("/api/payments/razorpay/webhook", content=raw, headers=hdrs)).json() == {"ok": True}
    assert (await client.post("/api/payments/razorpay/webhook", content=raw, headers=hdrs)).json()["duplicate"] is True
    bad = {**hdrs, "X-Razorpay-Signature": "f" * 64, "X-Razorpay-Event-Id": "evt_2"}
    assert (await client.post("/api/payments/razorpay/webhook", content=raw, headers=bad)).status_code == 400

    # Customer cancels the cable part -> refund of that part only, sent to Razorpay.
    detail = (await buyer.get(f"/api/orders/{order['id']}")).json()
    cable_sub = next(s for s in detail["sub_orders"] if s["seller"]["name"] == "Bengaluru Gadgets")
    r = await buyer.post(f"/api/orders/{order['id']}/cancel", {"sub_order_id": cable_sub["id"], "reason": "Ordered by mistake"})
    assert r.status_code == 200
    body = r.json()
    assert body["payment_status"] == "partially_refunded" and body["refunded_total"] == cable_sub["total"]
    await asyncio.sleep(0.05)
    async with SessionLocal() as s:
        refund = (await s.execute(select(Refund))).scalar_one()
        assert refund.status == "processed" and refund.amount_paise == cable_sub["total"]
    assert list(gateway.refunds.values())[0]["amount"] == cable_sub["total"]

    # The cancelled cable stock is back.
    page = (await client.get(f"/api/catalog/products/{cable['slug']}")).json()
    assert page["in_stock"] is True


async def test_gateway_failure_leaves_cart_and_stock_untouched(client, admin, categories, gateway):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000004")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][1]["id"], "qty": 1})
    gateway.fail_next = "Service unavailable"
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})
    assert r.status_code == 502
    cart = (await buyer.get("/api/cart")).json()
    assert cart["summary"]["item_count"] == 1
    async with SessionLocal() as s:
        assert (await s.get(Variant, uuid.UUID(shirt["variants"][1]["id"]))).stock == 1
        assert (await s.execute(select(Order))).first() is None


async def test_unpaid_order_expires_and_releases_stock_late_payment_is_refunded(client, admin, categories, gateway):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000005")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][1]["id"], "qty": 1})  # the last unit
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})
    order, pay = r.json()["order"], r.json()["payment"]
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["variants"][1]["in_stock"] is False

    async with SessionLocal() as s:
        await s.execute(update(Order).where(Order.id == uuid.UUID(order["id"])).values(payment_expires_at=utcnow() - timedelta(minutes=1)))
        await s.commit()
    await expire_job()
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["status"] == "cancelled" and mine["payment_status"] == "failed"
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["variants"][1]["in_stock"] is True

    # The customer pays anyway in a tab left open: the money goes back automatically.
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    r = await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    assert r.json()["result"] == "refund"
    await refunds_job()
    async with SessionLocal() as s:
        refund = (await s.execute(select(Refund))).scalar_one()
        assert refund.status == "processed" and refund.amount_paise == order["grand_total"]


async def test_expiry_job_detects_late_capture_instead_of_cancelling(client, admin, categories, gateway):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000006")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})
    order, pay = r.json()["order"], r.json()["payment"]
    gateway.auto_capture = False
    gateway.pay(pay["razorpay_order_id"])  # authorised but our verify call never arrived
    async with SessionLocal() as s:
        await s.execute(update(Order).where(Order.id == uuid.UUID(order["id"])).values(payment_expires_at=utcnow() - timedelta(minutes=1)))
        await s.commit()
    await expire_job()
    mine = (await buyer.get(f"/api/orders/{order['id']}")).json()
    assert mine["status"] == "placed" and mine["payment_status"] == "paid"
    assert list(gateway.payments.values())[0]["status"] == "captured"


async def test_no_overselling_under_concurrency(client, admin, categories):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyers = [await login_phone(client, f"93100000{i:02d}") for i in range(6)]
    addrs = [await add_address(b) for b in buyers]
    for b in buyers:
        r = await b.post("/api/cart/items", {"variant_id": shirt["variants"][1]["id"], "qty": 1})  # stock 1
        assert r.status_code == 200
    results = await asyncio.gather(
        *[b.post("/api/orders", {"address_id": a, "payment_method": "cod", "idempotency_key": key()}) for b, a in zip(buyers, addrs, strict=True)]
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(201) == 1 and codes.count(409) == 5, codes
    async with SessionLocal() as s:
        assert (await s.get(Variant, uuid.UUID(shirt["variants"][1]["id"]))).stock == 0


async def test_cod_limits_and_settings(client, admin, categories):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    r = await admin.put("/api/admin/settings", {"cod_max_order_paise": 50000})
    assert r.status_code == 200 and r.json()["cod_max_order_paise"] == 50000
    assert (await admin.put("/api/admin/settings", {"tcs_bps": 5000})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"bogus": 1})).status_code == 400
    buyer = await login_phone(client, "9300000007")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 400 and r.json()["error"]["code"] == "cod_limit"
    # Other user's address cannot be used.
    other = await login_phone(client, "9300000008")
    r = await other.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_address"


async def test_admin_cancel_and_deliver(client, admin, categories):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000009")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 3})
    order = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    sub_id = order["sub_orders"][0]["id"]
    r = await admin.post(f"/api/admin/sub-orders/{sub_id}/deliver")
    assert r.status_code == 409  # placed -> delivered is not a legal edge
    r = await admin.post(f"/api/admin/sub-orders/{sub_id}/cancel", {"reason": "Fraud check failed"})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert sub.settlement_status == "void" and sub.cancelled_by == "admin"
    audit = (await admin.get(f"/api/admin/audit?entity_id={sub_id}")).json()["items"]
    assert audit[0]["action"] == "suborder.admin_cancel"


async def test_guest_cart_merge(client, admin, categories):
    tn, ka, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9300000010")
    r = await buyer.post(
        "/api/cart/merge",
        {"items": [{"variant_id": shirt["variants"][0]["id"], "qty": 2}, {"variant_id": str(uuid.uuid4()), "qty": 1}, {"variant_id": cable["variants"][0]["id"], "qty": 99 if False else 10}]},
    )
    assert r.status_code == 200
    lines = [line for g in r.json()["groups"] for line in g["lines"]]
    assert sorted(line["qty"] for line in lines) == [2, 10]


async def test_order_again_puts_the_items_of_a_past_order_back_in_the_cart(client, admin, categories):
    import uuid

    from sqlalchemy import update

    from app.db import SessionLocal
    from app.models import Variant
    from tests.conftest import add_address, login_phone

    _, _, shirt, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000130")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 2})
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": str(uuid.uuid4())})
    assert r.status_code == 201, r.text
    oid = r.json()["order"]["id"]
    assert (await buyer.get("/api/cart")).json()["groups"] == []  # placing the order emptied the cart
    out = (await buyer.post(f"/api/cart/reorder/{oid}")).json()
    assert out["added"] == 2 and out["skipped"] == []
    qtys = sorted(i["qty"] for g in out["groups"] for i in g["lines"])
    assert qtys == [1, 2]
    async with SessionLocal() as s:  # the cable goes out of stock
        await s.execute(update(Variant).where(Variant.id == uuid.UUID(cable["variants"][0]["id"])).values(stock=0))
        await s.commit()
    await buyer.put("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 0})
    await buyer.put("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 0})
    out = (await buyer.post(f"/api/cart/reorder/{oid}")).json()
    assert out["added"] == 1 and len(out["skipped"]) == 1 and out["skipped"][0]["reason"] == "This item is out of stock"
    other = await login_phone(client, "9770000131")
    assert (await other.post(f"/api/cart/reorder/{oid}")).status_code == 404  # not their order
    assert (await buyer.post(f"/api/cart/reorder/{uuid.uuid4()}")).status_code == 404


async def test_seller_orders_list_counts_open_orders_older_than_the_dispatch_time(client, admin, categories):
    import uuid
    from datetime import timedelta

    from sqlalchemy import update

    from app.db import SessionLocal, utcnow
    from app.models import SubOrder
    from tests.conftest import add_address, login_phone

    tn, _, shirt, _ = await marketplace(client, admin, categories)
    buyer = await login_phone(client, "9770000150")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": str(uuid.uuid4())})).json()["order"]
    sid = o["sub_orders"][0]["id"]
    r = (await tn.get("/api/seller/orders")).json()
    assert r["late_count"] == 0 and r["late_after_days"] >= 1
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sid)).values(created_at=utcnow() - timedelta(days=r["late_after_days"] + 1)))
        await s.commit()
    assert (await tn.get("/api/seller/orders")).json()["late_count"] == 1
    assert (await admin.get("/api/admin/dashboard")).json()["orders_late_to_ship"] == 1  # staff see it too
    assert (await tn.post(f"/api/seller/orders/{sid}/confirm")).status_code == 200  # still open, still late
    assert (await tn.get("/api/seller/orders")).json()["late_count"] == 1
    assert (await tn.post(f"/api/seller/orders/{sid}/pack")).status_code == 200
    assert (await tn.post(f"/api/seller/orders/{sid}/ship", {"courier_name": "DTDC", "tracking_number": "AWB9"})).status_code == 200
    assert (await tn.get("/api/seller/orders")).json()["late_count"] == 0  # shipped: no longer waiting on the seller
    assert (await admin.get("/api/admin/dashboard")).json()["orders_late_to_ship"] == 0
