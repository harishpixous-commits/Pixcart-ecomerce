"""The bill at checkout: delivery and COD fees, the marketplace's handling, small cart and platform fees, the delivery
tip, business purchases (GSTIN), delivery instructions; refunds and cash collection with fees."""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Order, Refund, SubOrder
from app.services.orders import collect_amount
from tests.conftest import add_address, login_phone, valid_gstin
from tests.test_phase2_money import key, setup

FEES = {
    "handling_enabled": True, "handling_paise": 1200, "handling_list_paise": 1285, "handling_free_above_paise": 500000,
    "small_cart_enabled": True, "small_cart_paise": 2360, "small_cart_below_paise": 150000,
    "platform_enabled": True, "platform_paise": 500, "tip_enabled": True, "tip_presets": [1000, 2000, 3000],
}


async def test_fee_settings_and_bill(client, admin, categories):
    # validation
    bad = await admin.put("/api/admin/checkout", {"fees": {"handling_paise": 1500, "handling_list_paise": 1000}})
    assert bad.json()["error"]["code"] == "invalid_setting"
    assert (await admin.put("/api/admin/checkout", {"fees": {"surprise_fee": 1}})).json()["error"]["code"] == "invalid_setting"
    assert (await admin.put("/api/admin/checkout", {"marketplace": {"shipping_fee_paise": -5}})).json()["error"]["code"] == "invalid_setting"
    r = (await admin.put("/api/admin/checkout", {"fees": FEES, "marketplace": {"shipping_fee_paise": 4000, "free_shipping_threshold_paise": 49900}})).json()
    assert r["fees"]["handling_paise"] == 1200 and r["marketplace"]["shipping_fee_paise"] == 4000
    pv = (await admin.post("/api/admin/checkout/preview", {"items_total": 10000, "cod": True})).json()
    assert [f["code"] for f in pv["fees"]] == ["handling", "small_cart", "platform"] and pv["total"] == 10000 + 4000 + 1200 + 2360 + 500
    # GST is inside the fee: ₹23.60 small cart fee = ₹20.00 + ₹3.60 at 18%
    sc = next(f for f in pv["fees"] if f["code"] == "small_cart")
    assert sc["taxable"] == 2000 and sc["gst"] == 360 and sc["list_amount"] == 0
    assert next(f for f in pv["fees"] if f["code"] == "handling")["list_amount"] == 1285

    tn, ka, shirt, phone = await setup(client, admin, categories)  # shirt ₹1,000 from Kovai Textiles
    buyer = await login_phone(client, "9600000601", name="Fee Shopper")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    cart = (await buyer.get("/api/cart")).json()
    s = cart["summary"]
    assert s["fees_total"] == 1200 + 2360 + 500 and s["fee_savings"] == 85
    assert s["grand_total"] == 100000 + 0 + s["fees_total"]  # ₹1,000 ≥ ₹499: free delivery
    assert any("small cart fee" in h for h in cart["hints"]) and cart["checkout"]["tip_enabled"] is True

    q = (await buyer.post("/api/checkout/quote", {"address_id": addr, "payment_method": "cod", "tip_paise": 2000})).json()
    expected = 100000 + q["summary"]["cod_fee"] + 4060 + 2000
    assert q["summary"]["tip"] == 2000 and q["summary"]["grand_total"] == expected

    # business purchase: a wrong GSTIN is refused; the right one goes on the order (and the seller's invoice)
    order_body = {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "tip_paise": 2000, "expected_total": expected,
                  "buyer_gstin": "33ABCDE1234F1Z0", "buyer_business": "Fee Traders", "instructions": "Leave with the security, call first"}
    assert (await buyer.post("/api/orders", order_body)).json()["error"]["code"] == "invalid_gstin"
    gstin = valid_gstin("33", "ABCDE1234F")
    o = (await buyer.post("/api/orders", order_body | {"buyer_gstin": gstin, "idempotency_key": key()})).json()["order"]
    assert o["fees_total"] == 4060 and o["tip"] == 2000 and o["grand_total"] == expected and o["buyer_gstin"] == gstin
    assert o["ship_to"]["instructions"] == "Leave with the security, call first"
    assert [f["code"] for f in o["fees"]] == ["handling", "small_cart", "platform"]
    sub_id = o["sub_orders"][0]["id"]
    for step in ("confirm", "pack"):
        assert (await tn.post(f"/api/seller/orders/{sub_id}/{step}")).status_code == 200
    assert (await tn.post(f"/api/seller/orders/{sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "AWB777"})).status_code == 200
    inv = await buyer.get(f"/api/invoices/{sub_id}.pdf")  # the seller's tax invoice, now billed to the business
    assert inv.status_code == 200 and inv.headers["content-type"] == "application/pdf"

    # prices changed (the shopper saw an old total): refused
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    stale = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "expected_total": expected})
    assert stale.json()["error"]["code"] == "total_changed"

    # tips only when switched on
    await admin.put("/api/admin/checkout", {"fees": {"tip_enabled": False}})
    off = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "tip_paise": 1000})
    assert off.json()["error"]["code"] == "invalid_tip"


async def test_fees_collected_once_and_refunded_when_everything_is_cancelled(client, admin, categories, gateway):
    await admin.put("/api/admin/checkout", {"fees": FEES})
    tn, ka, shirt, phone = await setup(client, admin, categories)

    # cash on delivery, two sellers: the fees and the tip ride with the first package only
    buyer = await login_phone(client, "9600000602", name="Two Packages")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "tip_paise": 1000})).json()["order"]
    first, second = o["sub_orders"][0], o["sub_orders"][1]
    async with SessionLocal() as s:
        order = await s.get(Order, uuid.UUID(o["id"]))
        sub1, sub2 = await s.get(SubOrder, uuid.UUID(first["id"])), await s.get(SubOrder, uuid.UUID(second["id"]))
        fees = order.fees_total + order.tip_paise
        assert fees == 1200 + 500 + 1000  # ₹2,200 of items: no small cart fee
        assert await collect_amount(s, sub1, order) == sub1.total + fees
        assert await collect_amount(s, sub2, order) == sub2.total
    # the first package is cancelled: the second one now collects the fees
    await buyer.post(f"/api/orders/{o['id']}/cancel", {"reason": "Ordered by mistake", "sub_order_id": first["id"]})
    async with SessionLocal() as s:
        order = await s.get(Order, uuid.UUID(o["id"]))
        sub2 = await s.get(SubOrder, uuid.UUID(second["id"]))
        assert await collect_amount(s, sub2, order) == sub2.total + fees

    # paid online: cancelling one package refunds that package; cancelling the last one refunds the fees and tip too
    buyer2 = await login_phone(client, "9600000603", name="Online Payer")
    addr2 = await add_address(buyer2, state="33")
    await buyer2.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer2.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    r = (await buyer2.post("/api/orders", {"address_id": addr2, "payment_method": "online", "idempotency_key": key(), "tip_paise": 1000})).json()
    pay = r["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    await buyer2.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    oid = r["order"]["id"]
    a, b = r["order"]["sub_orders"]
    await buyer2.post(f"/api/orders/{oid}/cancel", {"reason": "Found it cheaper", "sub_order_id": a["id"]})
    await buyer2.post(f"/api/orders/{oid}/cancel", {"reason": "Found it cheaper", "sub_order_id": b["id"]})
    async with SessionLocal() as s:
        refunds = sorted((await s.execute(select(Refund.amount_paise).where(Refund.order_id == uuid.UUID(oid)))).scalars().all())
        order = await s.get(Order, uuid.UUID(oid))
        assert sum(refunds) == order.grand_total and order.payment_status == "refunded"
        sub_a, sub_b = await s.get(SubOrder, uuid.UUID(a["id"])), await s.get(SubOrder, uuid.UUID(b["id"]))
        assert sorted([sub_a.total, sub_b.total + order.fees_total + order.tip_paise]) == refunds


async def test_bad_weather_and_late_night_fees(admin):
    """Time-bound fees: the bad weather fee runs for a set number of hours (or until switched off); the late night fee
    applies to orders placed inside a window in India time, which may cross midnight."""
    from datetime import datetime, timedelta, timezone

    from app.services import fees as fees_svc

    for bad in ({"late_night_from": "25:00"}, {"late_night_from": "06:00", "late_night_to": "06:00"}, {"surge_hours": 100}, {"surge_hours": True},
                {"surge_until": "tomorrow"}, {"surge_until": "2030-01-01T10:00:00"}):
        assert (await admin.put("/api/admin/checkout", {"fees": bad})).json()["error"]["code"] == "invalid_setting", bad
    r = (await admin.put("/api/admin/checkout", {"fees": {"surge_enabled": True, "surge_paise": 3000, "surge_hours": 3, "late_night_enabled": True,
                                                          "late_night_paise": 1500, "surge_label": "Rain fee"}})).json()
    until = datetime.fromisoformat(r["status"]["surge_until"])
    assert timedelta(hours=2, minutes=59) < until - datetime.now(timezone.utc) <= timedelta(hours=3) and r["status"]["surge_active"]
    day = (await admin.post("/api/admin/checkout/preview", {"items_total": 50000})).json()
    night = (await admin.post("/api/admin/checkout/preview", {"items_total": 50000, "night": True})).json()
    assert [f["code"] for f in day["fees"]] == ["surge"] and day["fees"][0]["label"] == "Rain fee"
    assert [f["code"] for f in night["fees"]] == ["surge", "late_night"] and night["total"] == day["total"] + 1500
    assert night["fees"][1]["hint"] == "On orders placed between 11 pm and 6 am"
    # once its end time passes the fee stops by itself; the admin page says it ended
    ended = r["fees"] | {"surge_until": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}
    assert fees_svc.surge_active(ended) is False and fees_svc.status(ended)["surge_ended"] is True
    assert fees_svc.order_fees(ended | {"late_night_enabled": False}, 50000) == []

    ist = fees_svc.IST
    at = lambda h, m=0: datetime(2026, 11, 20, h, m, tzinfo=ist)  # noqa: E731
    ck = r["fees"] | {"surge_until": ""}  # charged until switched off
    assert [fees_svc.in_night_window(ck, at(h, m)) for h, m in ((22, 59), (23, 0), (2, 30), (5, 59), (6, 0), (13, 0))] == [False, True, True, True, False, False]
    early = ck | {"late_night_from": "01:00", "late_night_to": "05:30"}
    assert [fees_svc.in_night_window(early, at(h, m)) for h, m in ((0, 59), (1, 0), (5, 29), (5, 30))] == [False, True, True, False]
    assert [f["code"] for f in fees_svc.order_fees(ck, 50000, now=at(23, 30))] == ["surge", "late_night"]
    assert [f["code"] for f in fees_svc.order_fees(ck | {"surge_enabled": False}, 50000, now=at(23, 30))] == ["late_night"]
    assert fees_svc.order_fees(ck | {"surge_enabled": False}, 50000, now=at(12, 0)) == []
    assert fees_svc.clock("06:30") == "6:30 am" and fees_svc.clock("00:00") == "12 am" and fees_svc.clock("12:15") == "12:15 pm"


async def test_address_label_instructions_and_map_pin(client):
    """Saved addresses carry a name, instructions and a map pin; checkout's "Use my location" pins one later."""
    buyer = await login_phone(client, "9600000951", name="Pin Buyer")
    r = await buyer.post("/api/addresses", {"full_name": "Pin Buyer", "phone": "9876500001", "line1": "7 Temple St", "city": "Chennai", "state_code": "33",
                                            "pincode": "600004", "kind": "other", "label": "Amma's house", "instructions": "Blue gate, ring twice",
                                            "lat": 13.0333, "lng": 80.2667})
    assert r.status_code == 201, r.text
    a = r.json()
    assert a["label"] == "Amma's house" and a["instructions"] == "Blue gate, ring twice" and a["lat"] == 13.0333
    # a pin outside India, or only one of the two numbers, is refused or dropped
    assert (await buyer.post("/api/addresses", {"full_name": "X Y", "phone": "9876500001", "line1": "1 St", "city": "Chennai", "state_code": "33",
                                                "pincode": "600004", "lat": 51.5, "lng": -0.12})).status_code == 422
    half = await buyer.post("/api/addresses", {"full_name": "X Y", "phone": "9876500001", "line1": "1 St", "city": "Chennai", "state_code": "33",
                                               "pincode": "600004", "lat": 13.0})
    assert half.status_code == 201 and half.json()["lat"] is None and half.json()["lng"] is None

    # pin (and move) an existing address from checkout; only the owner can
    plain = await add_address(buyer)
    moved = await buyer.patch(f"/api/addresses/{plain}/location", {"lat": 13.0827123456, "lng": 80.2707})
    assert moved.status_code == 200, moved.text
    assert moved.json()["lat"] == 13.082712 and moved.json()["lng"] == 80.2707
    other = await login_phone(client, "9600000952", name="Someone Else")
    assert (await other.patch(f"/api/addresses/{plain}/location", {"lat": 13.0, "lng": 80.0})).status_code == 404
    cleared = await buyer.patch(f"/api/addresses/{plain}/location", {"lat": None, "lng": None})
    assert cleared.json()["lat"] is None


async def test_gift_message_is_off_until_admin_allows_it(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000611", name="Gift Buyer")
    addr = await add_address(buyer, state="33")
    vid = shirt["variants"][0]["id"]

    async def order(msg: str):
        await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 1})
        return await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "gift_message": msg})

    assert (await buyer.get("/api/cart")).json()["checkout"]["gift_message_enabled"] is False
    r = await order("Happy birthday!")
    assert r.status_code == 400 and r.json()["error"]["code"] == "gift_off"
    assert (await admin.put("/api/admin/checkout", {"fees": {"gift_message_enabled": True, "gift_message_max": 30}})).status_code == 200
    chk = (await buyer.get("/api/cart")).json()["checkout"]
    assert chk["gift_message_enabled"] is True and chk["gift_message_max"] == 30
    r = await order("x" * 31)
    assert r.status_code == 400 and r.json()["error"]["code"] == "gift_too_long"
    r = await order("  Happy   birthday, Meena!  ")
    assert r.status_code == 201, r.text
    o = r.json()["order"]
    assert o["ship_to"]["gift_message"] == "Happy birthday, Meena!"
    sub_id = o["sub_orders"][0]["id"]
    seller_view = (await tn.get(f"/api/seller/orders/{sub_id}")).json()
    assert seller_view["ship_to"]["gift_message"] == "Happy birthday, Meena!"
    assert (await admin.put("/api/admin/checkout", {"fees": {"gift_message_max": 10}})).status_code == 400


async def test_minimum_order_value_blocks_small_orders_and_nudges_in_the_cart(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000612", name="Min Buyer")
    addr = await add_address(buyer, state="33")
    vid = shirt["variants"][0]["id"]
    price = shirt["variants"][0]["price_paise"]
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    cart = (await buyer.get("/api/cart")).json()
    assert cart["checkout"]["min_order_paise"] == 0 and not any("Minimum order" in h for h in cart["hints"])
    assert (await admin.put("/api/admin/checkout", {"fees": {"min_order_paise": price + 5000}})).status_code == 200
    cart = (await buyer.get("/api/cart")).json()
    assert any("Minimum order is" in h for h in cart["hints"]), cart["hints"]
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 400 and r.json()["error"]["code"] == "min_order", r.text
    await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 1})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 201, r.text


async def test_delivery_time_choice_is_off_until_admin_offers_it(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9600000613", name="Slot Buyer")
    addr = await add_address(buyer, state="33")
    vid = shirt["variants"][0]["id"]

    async def order(slot: str):
        await buyer.post("/api/cart/items", {"variant_id": vid, "qty": 1})
        return await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key(), "delivery_slot": slot})

    chk = (await buyer.get("/api/cart")).json()["checkout"]
    assert chk["delivery_slots_enabled"] is False and chk["delivery_slots"] == []
    r = await order("Evening (4pm to 8pm)")
    assert r.status_code == 400 and r.json()["error"]["code"] == "slot_off"
    assert (await admin.put("/api/admin/checkout", {"fees": {"delivery_slots_enabled": True, "delivery_slots": " Morning ;  Evening ; Morning;; "}})).status_code == 200
    assert (await admin.put("/api/admin/checkout", {"fees": {"delivery_slots": "Only one"}})).status_code == 400
    chk = (await buyer.get("/api/cart")).json()["checkout"]
    assert chk["delivery_slots"] == ["Morning", "Evening"]
    r = await order("Night")
    assert r.status_code == 400 and r.json()["error"]["code"] == "slot_unknown"
    r = await order("Evening")
    assert r.status_code == 201, r.text
    o = r.json()["order"]
    assert o["ship_to"]["delivery_slot"] == "Evening"
    seller_view = (await tn.get(f"/api/seller/orders/{o['sub_orders'][0]['id']}")).json()
    assert seller_view["ship_to"]["delivery_slot"] == "Evening"
    r = await order("")  # no preference is fine
    assert r.status_code == 201 and r.json()["order"]["ship_to"]["delivery_slot"] == ""
