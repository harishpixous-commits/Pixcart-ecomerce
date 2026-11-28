"""Return policy: one line per item in a return request, the return window promised when the order was placed,
returns of damaged, faulty, wrong or incomplete items, each category's return policy, and returns staff open for
a customer."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal
from app.models import AuditLog, Order, ReturnItem, SubOrder
from app.shop_assistant.views import order_view
from tests.conftest import Api, add_address, login_phone, upload_image
from tests.test_gallery import body_from
from tests.test_phase2_money import key, setup, ship_and_deliver
from tests.test_product_import import make_csv, upload


async def place(buyer, addr: str, variant_id: str, qty: int = 1) -> dict:
    await buyer.post("/api/cart/items", {"variant_id": variant_id, "qty": qty})
    r = await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    assert r.status_code == 201, r.text
    return r.json()["order"]


async def delivered_order(client, admin, categories, *, qty: int = 1, phone: str = "9500000101"):
    """A cash-on-delivery order of `qty` shirts (7-day returns) from Kovai Textiles, delivered.
    Returns (seller, buyer, order, sub id, shirt listing, address id)."""
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer, state="33")
    o = await place(buyer, addr, shirt["variants"][0]["id"], qty)
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)
    return tn, buyer, o, sub_id, shirt, addr


async def returnable(buyer, order_id: str, sub_id: str) -> list[dict]:
    return (await buyer.get(f"/api/orders/{order_id}/returnable")).json()["items"][sub_id]


async def set_listing_window(tn, admin, product_id: str, days: int) -> None:
    """The seller changes the listing's return window and staff approve the edit."""
    detail = (await tn.get(f"/api/seller/products/{product_id}")).json()
    r = await tn.put(f"/api/seller/products/{product_id}", body_from(detail, return_window_days=days))
    assert r.status_code == 200 and r.json()["return_window_days"] == days, r.text
    assert (await admin.post(f"/api/admin/products/{product_id}/approve")).status_code == 200


async def test_an_item_named_twice_is_one_line(client, admin, categories):
    tn, buyer, o, sub_id, *_ = await delivered_order(client, admin, categories, qty=2)
    item = (await returnable(buyer, o["id"], sub_id))[0]
    x, unit = item["order_item_id"], item["unit_refund"]
    body = {"sub_order_id": sub_id, "reason": "size_fit", "refund_upi": "priya@okaxis"}

    # Together the lines ask for more units than were bought: refused.
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 2}, {"order_item_id": x, "qty": 1}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_qty"
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 1}, {"order_item_id": x, "qty": 0}]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_qty"

    # Within what is left, the lines become one line and the refund is counted once per unit.
    r = await buyer.post("/api/returns", {**body, "items": [{"order_item_id": x, "qty": 1}, {"order_item_id": x, "qty": 1}]})
    assert r.status_code == 201, r.text
    ret = r.json()
    assert ret["refund_amount"] == 2 * unit
    assert [(i["qty"], i["amount"]) for i in ret["items"]] == [(2, 2 * unit)]
    assert (await returnable(buyer, o["id"], sub_id))[0]["qty_left"] == 0

    # The seller can receive it: it does not get stuck.
    assert (await tn.post(f"/api/seller/returns/{ret['id']}", {"action": "approve"})).json()["status"] == "approved"
    r = await tn.post(f"/api/seller/returns/{ret['id']}", {"action": "received"})
    assert r.status_code == 200 and r.json()["status"] == "received"

    # The database refuses a second line for the same item in the same return.
    async with SessionLocal() as s:
        line = (await s.execute(select(ReturnItem))).scalar_one()
        s.add(ReturnItem(return_id=line.return_id, order_item_id=line.order_item_id, qty=1, amount=unit))
        with pytest.raises(IntegrityError):
            await s.flush()


async def test_return_window_is_the_one_promised_at_the_sale(client, admin, categories):
    # only the listing's own window here (no period for damaged or wrong items)
    assert (await admin.put("/api/admin/settings", {"defect_return_days": 0})).status_code == 200
    tn, buyer, o, sub_id, shirt, addr = await delivered_order(client, admin, categories)
    before = (await returnable(buyer, o["id"], sub_id))[0]
    assert before["eligible"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert sub.settlement_due_at - sub.delivered_at == timedelta(days=7)

    # After delivery the seller makes the listing non-returnable. The customer keeps the 7 days they were promised.
    await set_listing_window(tn, admin, shirt["id"], 0)
    after = (await returnable(buyer, o["id"], sub_id))[0]
    assert after["eligible"] and after["return_by"] == before["return_by"]
    async with SessionLocal() as s:
        view = await order_view(s, await s.get(Order, uuid.UUID(o["id"])))
        assert view["packages"][0]["items"][0]["return_window_days"] == 7 and view["packages"][0]["can_return"]

    # An order placed after the change gets the new window, and the seller is paid at delivery.
    o2 = await place(buyer, addr, shirt["variants"][0]["id"])
    sub2 = o2["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub2)
    assert not (await returnable(buyer, o2["id"], sub2))[0]["eligible"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub2))
        assert sub.settlement_due_at == sub.delivered_at

    # Raising the window later does not reopen returns on orders that were already delivered.
    await set_listing_window(tn, admin, shirt["id"], 30)
    assert not (await returnable(buyer, o2["id"], sub2))[0]["eligible"]


async def test_damaged_faulty_or_wrong_items_come_back_even_when_not_returnable(client, admin, categories):
    r = await admin.put("/api/admin/settings", {"defect_return_days": 31})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_setting"
    r = await admin.put("/api/admin/settings", {"defect_return_days": 10})
    assert r.status_code == 200 and r.json()["defect_return_days"] == 10
    reasons = (await client.get("/api/returns/reasons")).json()["reasons"]
    assert {x["code"] for x in reasons if x["defect"]} == {"damaged", "defective", "wrong_item", "missing_parts"}

    # The seller makes the listing non-returnable before the sale.
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    await set_listing_window(tn, admin, shirt["id"], 0)
    buyer = await login_phone(client, "9500000102")
    o = await place(buyer, await add_address(buyer, state="33"), shirt["variants"][0]["id"], 2)
    sub_id = o["sub_orders"][0]["id"]
    await ship_and_deliver(tn, sub_id)

    # For 10 days after delivery the items can come back, but only when they arrived damaged, faulty, wrong or incomplete,
    # and the seller is paid after that period.
    item = (await returnable(buyer, o["id"], sub_id))[0]
    assert item["eligible"] and item["defects_only"]
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, uuid.UUID(sub_id))
        assert datetime.fromisoformat(item["return_by"]) == sub.delivered_at + timedelta(days=10)
        assert sub.settlement_due_at == sub.delivered_at + timedelta(days=10)
    body = {"sub_order_id": sub_id, "items": [{"order_item_id": item["order_item_id"], "qty": 1}], "refund_upi": "priya@okaxis"}
    r = await buyer.post("/api/returns", {**body, "reason": "size_fit"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "reason_not_allowed"
    r = await buyer.post("/api/returns", {**body, "reason": "damaged"})
    assert r.status_code == 201, r.text

    # After the period nothing more can be returned.
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sub_id)).values(delivered_at=SubOrder.delivered_at - timedelta(days=11)))
        await s.commit()
    item = (await returnable(buyer, o["id"], sub_id))[0]
    assert item["qty_left"] == 1 and not item["eligible"] and not item["defects_only"]
    r = await buyer.post("/api/returns", {**body, "reason": "defective"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_returnable"


async def test_category_return_policy(client, admin, categories):
    tn, _ka, shirt, _phone = await setup(client, admin, categories)
    assert shirt["return_window_days"] == 7  # listed without a window: the category's default
    cat = next(c for c in (await admin.get("/api/admin/categories")).json() if c["id"] == categories["shirts"])
    assert (cat["return_window_days"], cat["min_return_window_days"]) == (7, 0)
    url = f"/api/admin/categories/{categories['shirts']}"

    # The default cannot be shorter than the minimum.
    r = await admin.put(url, cat | {"return_window_days": 5, "min_return_window_days": 10})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_return_window"
    r = await admin.put(url, cat | {"return_window_days": 15, "min_return_window_days": 10})
    assert r.status_code == 200 and (r.json()["return_window_days"], r.json()["min_return_window_days"]) == (15, 10)

    # The live listing below the new minimum moves up to it, and the audit log says so.
    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert detail["return_window_days"] == 10 and detail["status"] == "approved"
    async with SessionLocal() as s:
        log = (await s.execute(select(AuditLog).where(AuditLog.action == "category.update"))).scalars().all()
        assert [x.detail for x in log] == ["Listings raised to the 10-day minimum return window: 1"]

    # Sellers see the policy and cannot go below the minimum.
    sc = next(c for c in (await tn.get("/api/seller/categories")).json() if c["id"] == categories["shirts"])
    assert (sc["return_window_days"], sc["min_return_window_days"]) == (15, 10)
    r = await tn.put(f"/api/seller/products/{shirt['id']}", body_from(detail, return_window_days=7))
    assert r.status_code == 400 and r.json()["error"]["code"] == "return_window_too_short"
    assert r.json()["error"]["fields"] == {"return_window_days": "At least 10 days"}
    r = await tn.put(f"/api/seller/products/{shirt['id']}", body_from(detail, return_window_days=30))
    assert r.status_code == 200 and r.json()["return_window_days"] == 30

    # A new listing without a window starts with the category's default.
    new = body_from(detail, title="Handloom Cotton Shirt Green", images=[await upload_image(client, tn)],
                    variants=[{"sku": "HL-G", "options": {}, "mrp_paise": 200000, "price_paise": 100000, "stock": 5}])
    del new["return_window_days"]
    r = await tn.post("/api/seller/products", new)
    assert r.status_code == 201 and r.json()["return_window_days"] == 15

    # Bulk upload: a blank window takes the default; a shorter one is refused with the reason.
    rows = [["S-1", "Kovai Men's Cotton Formal Shirt White", "Men's Shirts", "Kovai", "Crisp white cotton shirt for office wear.", "", "6205", "5", "",
             "India", "KS-1", "", "", "", "", "1299", "799", "20", "250"],
            ["S-2", "Kovai Men's Linen Casual Shirt Beige", "Men's Shirts", "Kovai", "Linen shirt for summer, relaxed fit.", "", "6205", "5", "3",
             "India", "KS-2", "", "", "", "", "1299", "799", "20", "250"]]
    out = (await upload(tn, make_csv(rows), dry_run=False)).json()
    assert [p["errors"] for p in out["products"]] == [[], ["Listings in Men's Shirts need a return window of at least 10 days"]]
    created = (await tn.get(f"/api/seller/products/{out['created'][0]['id']}")).json()
    assert created["return_window_days"] == 15


async def staff(client, admin, email: str, role: str) -> Api:
    r = await admin.post("/api/admin/staff", {"email": email, "name": role.title(), "role": role, "password": "Staff@2026xyz"})
    assert r.status_code == 201, r.text
    r = await client.post("/api/auth/login", json={"email": email, "password": "Staff@2026xyz"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


async def test_staff_open_a_return_for_the_customer(client, admin, categories):
    tn, buyer, o, sub_id, *_ = await delivered_order(client, admin, categories, qty=2)
    support = await staff(client, admin, "help@pixcart.in", "support")
    catalog = await staff(client, admin, "cat@pixcart.in", "catalog")

    # Staff need the orders permission.
    assert (await catalog.get(f"/api/admin/orders/{o['id']}/returnable")).status_code == 403
    found = (await support.get(f"/api/admin/orders/{o['id']}/returnable")).json()
    item = found["items"][sub_id][0]
    assert found["needs_upi"] and item["eligible"] and item["qty_left"] == 2
    body = {"sub_order_id": sub_id, "items": [{"order_item_id": item["order_item_id"], "qty": 1}], "reason": "defective",
            "comment": "Customer called: it does not switch on"}
    assert (await catalog.post("/api/admin/returns", body)).status_code == 403
    assert (await support.post("/api/admin/returns", body | {"sub_order_id": str(uuid.uuid4())})).status_code == 404

    # The customer's own checks apply: a cash-on-delivery refund needs their UPI ID.
    r = await support.post("/api/admin/returns", body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "upi_required"
    r = await support.post("/api/admin/returns", body | {"refund_upi": "priya@okaxis"})
    assert r.status_code == 201, r.text
    ret = r.json()
    assert ret["status"] == "requested" and ret["refund_upi"] == "priya@okaxis" and ret["refund_amount"] == item["unit_refund"]

    # It is the customer's return: they see it, the seller is asked as usual, and the audit log names the staff member.
    mine = (await buyer.get(f"/api/orders/{o['id']}/returnable")).json()
    assert [x["number"] for x in mine["returns"]] == [ret["number"]] and mine["items"][sub_id][0]["qty_left"] == 1
    assert any(n["title"].startswith("Return requested") for n in (await tn.get("/api/notifications")).json()["items"])
    async with SessionLocal() as s:
        row = (await s.execute(select(AuditLog).where(AuditLog.action == "return.admin_open"))).scalar_one()
        assert row.entity_id == ret["id"] and row.actor_user_id == uuid.UUID(support.user["id"])


async def test_return_photos_are_off_until_admin_switches_them_on(client, admin, categories):
    tn, buyer, o, sub_id, *_ = await delivered_order(client, admin, categories, qty=2, phone="9500000191")
    x = (await returnable(buyer, o["id"], sub_id))[0]["order_item_id"]
    body = {"sub_order_id": sub_id, "items": [{"order_item_id": x, "qty": 1}], "reason": "damaged", "refund_upi": "priya@okaxis"}
    png = (await upload_image(client, tn))  # a hosted seller image url, not a return photo

    assert (await buyer.get("/api/returns/reasons")).json()["photos"] == {"enabled": False, "required_for_defects": False, "max": 3}
    r = await buyer.post("/api/returns", {**body, "photos": [png]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "photos_off"
    assert (await client.post("/api/returns/photos", headers=buyer.h(), files={"file": ("p.png", __import__("tests.conftest", fromlist=["png_bytes"]).png_bytes(), "image/png")})).status_code == 400

    assert (await admin.put("/api/admin/growth/settings", {"return_photos": {"enabled": True, "required_for_defects": True, "max_photos": 2}})).status_code == 200
    r = await buyer.post("/api/returns", body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "photos_required"
    r = await buyer.post("/api/returns", {**body, "photos": [png]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_photos"  # not from the return photo folder
    from tests.conftest import png_bytes

    urls = []
    for _ in range(3):
        up = await client.post("/api/returns/photos", headers=buyer.h(), files={"file": ("p.png", png_bytes(), "image/png")})
        assert up.status_code == 201, up.text
        assert "/return-photos/" in up.json()["url"]
        urls.append(up.json()["url"])
    r = await buyer.post("/api/returns", {**body, "photos": urls})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_photos"  # more than max_photos
    r = await buyer.post("/api/returns", {**body, "photos": urls[:2]})
    assert r.status_code == 201, r.text
    assert r.json()["photos"] == urls[:2]
    # The seller and staff see the same photos.
    assert (await tn.get("/api/seller/returns")).json()["items"][0]["photos"] == urls[:2]
