"""Own delivery fleet: delivery partners, zones, assignment, the delivery pipeline, OTPs, proof, earnings and payouts."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal, utcnow
from app.models import DeliveryAssignment, DeliveryBoy, DeliveryZone, OrderStatusLog, SubOrder
from tests.conftest import PDF, Api, add_address, login_phone, png_bytes
from tests.test_phase2_money import setup
from tests.test_promotions import order


async def make_zone(name="Coimbatore Central", city="Coimbatore", pincodes=("641001", "641002", "641018")) -> str:
    async with SessionLocal() as s:
        z = DeliveryZone(name=name, city=city, pincodes=list(pincodes))
        s.add(z)
        await s.commit()
        return str(z.id)


async def register_partner(client, phone: str, name: str, zone_id: str | None = None, *, aadhaar="234567890123") -> Api:
    """A new mobile number signs in, registers, uploads everything and sends the registration for review."""
    rider = await login_phone(client, phone, name=name)
    body = {"name": name, "city": "Coimbatore", "address": "12 Gandhi Road, RS Puram", "vehicle_type": "bike", "vehicle_no": "tn 38 ab 1234",
            "license_no": "TN38 20190012345", "id_proof_type": "aadhaar", "id_proof_no": aadhaar}
    if zone_id:
        body["zone_id"] = zone_id
    r = await rider.post("/api/delivery/register", body)
    assert r.status_code == 201, r.text
    for kind, f in (("photo", ("me.png", png_bytes(), "image/png")), ("license", ("dl.pdf", PDF, "application/pdf")), ("id_proof", ("id.pdf", PDF, "application/pdf"))):
        assert (await client.post(f"/api/delivery/me/docs/{kind}", headers=rider.h(), files={"file": f})).status_code == 200
    bank = {"holder": name, "account_number": "123456789012", "confirm_account_number": "123456789012", "ifsc": "SBIN0001234"}
    assert (await rider.put("/api/delivery/me/bank", bank)).status_code == 200
    r = await rider.post("/api/delivery/me/submit")
    assert r.status_code == 200 and r.json()["kyc_status"] == "submitted", r.text
    return rider


# ---------------------------------------------------------------------------- step 1: tables


async def test_delivery_tables_and_one_live_assignment_per_package(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    _, sub_id = await order(client, shirt, "9600000301")
    rider = await login_phone(client, "9600000302", name="Ravi Rider")
    rider_id = (await rider.get("/api/auth/me")).json()["id"]
    now = utcnow()
    async with SessionLocal() as s:
        sub = await s.get(SubOrder, sub_id)
        assert sub.pickup_code == "" and sub.delivery_otp == "" and sub.ready_for_pickup_at is None  # new columns, empty
        zone = DeliveryZone(name="Coimbatore Central", city="Coimbatore", pincodes=["641001", "641002"])
        s.add(zone)
        await s.flush()
        boy = DeliveryBoy(user_id=rider_id, name="Ravi Rider", phone="9600000302", zone_id=zone.id, kyc_status="approved")
        s.add(boy)
        await s.flush()
        row = dict(order_id=sub.order_id, sub_order_id=sub.id, delivery_boy_id=boy.id, assigned_at=now, status_at=now, created_at=now)
        first = DeliveryAssignment(**row, status="offered", expires_at=now + timedelta(seconds=30))
        s.add(first)
        s.add(OrderStatusLog(order_id=sub.order_id, sub_order_id=sub.id, status="offered", actor="admin", created_at=now))
        await s.commit()
        first_id = first.id

    # a second live offer for the same package is refused by the database itself
    async with SessionLocal() as s:
        s.add(DeliveryAssignment(**row, status="offered"))
        with pytest.raises(IntegrityError):
            await s.commit()

    # once the first offer is rejected, the package can be offered again (the rejected row stays as history)
    async with SessionLocal() as s:
        first = await s.get(DeliveryAssignment, first_id)
        first.status, first.reject_reason, first.ended_at = "rejected", "Vehicle problem", now
        s.add(DeliveryAssignment(**row, status="offered"))
        await s.commit()
        rows = (await s.execute(select(DeliveryAssignment.status).where(DeliveryAssignment.sub_order_id == sub_id))).scalars().all()
        assert sorted(rows) == ["offered", "rejected"]
        boy = (await s.execute(select(DeliveryBoy).where(DeliveryBoy.user_id == rider_id))).scalar_one()
        assert boy.is_online is False and boy.is_active is True and boy.rating_count == 0


# ---------------------------------------------------------------------------- step 2: partner login, registration, profile


async def test_partner_registration_profile_documents_bank_and_review(client, admin):
    zone_id = await make_zone()
    opts = (await client.get("/api/delivery/options")).json()
    assert opts["registration_open"] is True and opts["zones"][0]["name"] == "Coimbatore Central" and "bike" in opts["vehicles"]

    # a new mobile number: one-time code creates the account, then the partner registers
    rider = await login_phone(client, "9600000401", name="Selvi Kumar")
    assert rider.user["delivery"] is None
    assert (await rider.get("/api/delivery/me")).json()["error"]["code"] == "not_registered"
    bad = await rider.post("/api/delivery/register", {"name": "Selvi Kumar", "vehicle_no": "HELLO"})
    assert bad.status_code == 422
    r = await rider.post("/api/delivery/register", {"name": "Selvi Kumar", "city": "Coimbatore", "vehicle_type": "scooter", "vehicle_no": "tn38 cd 4321",
                                                   "zone_id": zone_id})
    assert r.status_code == 201 and r.json()["kyc_status"] == "draft" and r.json()["vehicle_no"] == "TN38 CD 4321"
    assert (await rider.post("/api/delivery/register", {"name": "Again"})).status_code == 409
    me = (await rider.get("/api/auth/me")).json()
    assert me["delivery"]["kyc_status"] == "draft"

    # the checklist says what is missing; submitting early is refused
    p = (await rider.get("/api/delivery/me")).json()
    assert not p["can_submit"] and {i["key"] for i in p["checklist"] if not i["done"]} == {"profile", "photo", "license", "id_proof", "bank"}
    assert (await rider.post("/api/delivery/me/submit")).json()["error"]["code"] == "incomplete"

    # ID numbers: Aadhaar keeps only the last 4 digits, PAN is stored encrypted
    assert (await rider.put("/api/delivery/me", {"id_proof_type": "pan", "id_proof_no": "12345"})).json()["error"]["code"] == "invalid_id"
    p = (await rider.put("/api/delivery/me", {"address": "4 Lake View, Saibaba Colony", "license_no": "tn38 20190054321", "id_proof_type": "aadhaar",
                                              "id_proof_no": "2345 6789 0123"})).json()
    assert p["id_proof_last4"] == "0123" and p["license_no"] == "TN38 20190054321"
    async with SessionLocal() as s:
        row = (await s.execute(select(DeliveryBoy).where(DeliveryBoy.phone == "9600000401"))).scalar_one()
        assert row.id_proof_enc == ""  # the Aadhaar number itself is not kept

    # photo (public image), licence and ID (private files only the partner and staff can open)
    up = await client.post("/api/delivery/me/docs/photo", headers=rider.h(), files={"file": ("me.png", png_bytes(), "image/png")})
    assert up.status_code == 200 and up.json()["photo"].endswith(".webp")
    for kind in ("license", "id_proof"):
        assert (await client.post(f"/api/delivery/me/docs/{kind}", headers=rider.h(), files={"file": ("d.pdf", PDF, "application/pdf")})).status_code == 200
    doc = await rider.get("/api/delivery/me/docs/license")
    assert doc.status_code == 200 and doc.headers["content-type"] == "application/pdf"
    other = await login_phone(client, "9600000402", name="Someone Else")
    assert (await other.get("/api/delivery/me/docs/license")).status_code == 404  # not a partner: nothing to read

    # payouts: bank account (checked twice) or UPI
    assert (await rider.put("/api/delivery/me/bank", {"holder": "Selvi Kumar", "account_number": "123456789012", "confirm_account_number": "123456789013",
                                                       "ifsc": "SBIN0001234"})).json()["error"]["code"] == "account_mismatch"
    assert (await rider.put("/api/delivery/me/bank", {"holder": "Selvi Kumar", "upi": "not a upi"})).json()["error"]["code"] == "invalid_upi"
    b = (await rider.put("/api/delivery/me/bank", {"holder": "Selvi Kumar", "upi": "selvi@okaxis"})).json()["bank"]
    assert b["set"] and b["upi"] == "selvi@okaxis" and b["account_last4"] == ""

    # going online needs approval; submitting sends it to staff
    assert (await rider.post("/api/delivery/me/online", {"online": True})).status_code == 403
    p = (await rider.post("/api/delivery/me/submit")).json()
    assert p["kyc_status"] == "submitted" and p["editable"] is False
    assert (await rider.put("/api/delivery/me", {"vehicle_no": "TN 38 ZZ 9999"})).json()["error"]["code"] == "locked"
    assert (await rider.put("/api/delivery/me", {"address": "New address, Coimbatore"})).status_code == 200  # home address may change
    titles = [n["title"] for n in (await admin.get("/api/notifications")).json()["items"]]
    assert "Delivery partner to verify" in titles

    # registrations can be closed
    async with SessionLocal() as s:
        from app.services import delivery_settings
        await delivery_settings.update(s, {"registration_open": False})
        await s.commit()
    late = await login_phone(client, "9600000403", name="Late Comer")
    assert (await late.post("/api/delivery/register", {"name": "Late Comer"})).json()["error"]["code"] == "registration_closed"


async def test_full_registration_helper(client):
    zone_id = await make_zone()
    rider = await register_partner(client, "9600000404", "Arun Raj", zone_id)
    p = (await rider.get("/api/delivery/me")).json()
    assert p["zone"]["id"] == zone_id and p["docs"] == {"license": True, "id_proof": True, "vehicle_rc": False} and p["bank"]["account_last4"] == "9012"


# ---------------------------------------------------------------------------- step 3: admin partners, KYC, zones, settings, roles


async def staff_with_role(client, role: str, email: str) -> Api:
    from app.core.security import hash_password
    from app.models import User

    async with SessionLocal() as s:
        s.add(User(email=email, name=f"{role} staff", password_hash=hash_password("Staff@12345"), is_admin=True, admin_role=role))
        await s.commit()
    r = await client.post("/api/auth/login", json={"email": email, "password": "Staff@12345"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


async def test_admin_reviews_partners_zones_and_settings(client, admin):
    zone_id = await make_zone()
    rider = await register_partner(client, "9600000501", "Priya Das", aadhaar="345678901234")
    rider2 = await login_phone(client, "9600000502", name="Mani Vel")  # a PAN partner, to see the stored (encrypted) number
    await rider2.post("/api/delivery/register", {"name": "Mani Vel", "city": "Coimbatore", "id_proof_type": "pan", "id_proof_no": "abcde1234f"})

    listing = (await admin.get("/api/admin/delivery/partners")).json()
    assert listing["items"][0]["name"] == "Priya Das" and listing["counts"]["submitted"] == 1 and listing["counts"]["draft"] == 1
    pid = listing["items"][0]["id"]
    detail = (await admin.get(f"/api/admin/delivery/partners/{pid}")).json()
    assert detail["id_proof_no"] == "" and detail["id_proof_last4"] == "1234"  # Aadhaar: never stored
    pan_id = next(i["id"] for i in listing["items"] if i["name"] == "Mani Vel")
    assert (await admin.get(f"/api/admin/delivery/partners/{pan_id}")).json()["id_proof_no"] == "ABCDE1234F"
    doc = await admin.get(f"/api/admin/delivery/partners/{pid}/docs/license")
    assert doc.status_code == 200 and doc.headers["content-type"] == "application/pdf"
    bank = (await admin.get(f"/api/admin/delivery/partners/{pid}/bank")).json()
    assert bank["account_number"] == "123456789012" and bank["ifsc"] == "SBIN0001234"
    actions = {a["action"] for a in (await admin.get("/api/admin/audit", params={"entity_id": pid})).json()["items"]}
    assert {"delivery.kyc_view", "delivery.bank_view"} <= actions

    # asking for changes needs a note; the partner can edit again and is told
    assert (await admin.post(f"/api/admin/delivery/partners/{pid}/kyc", {"action": "reject", "note": "no"})).json()["error"]["code"] == "note_required"
    r = (await admin.post(f"/api/admin/delivery/partners/{pid}/kyc", {"action": "reject", "note": "Licence photo is blurred, upload again"})).json()
    assert r["kyc_status"] == "rejected" and r["editable"] is True
    assert (await rider.get("/api/notifications")).json()["items"][0]["title"] == "Delivery partner account needs changes"
    assert (await rider.post("/api/delivery/me/submit")).json()["kyc_status"] == "submitted"

    # approval needs complete documents and a zone
    assert (await admin.post(f"/api/admin/delivery/partners/{pan_id}/kyc", {"action": "approve", "zone_id": zone_id})).json()["error"]["code"] == "incomplete"
    async with SessionLocal() as s:
        row = (await s.execute(select(DeliveryBoy).where(DeliveryBoy.phone == "9600000501"))).scalar_one()
        row.zone_id = None
        await s.commit()
    assert (await admin.post(f"/api/admin/delivery/partners/{pid}/kyc", {"action": "approve"})).json()["error"]["code"] == "zone_required"
    r = (await admin.post(f"/api/admin/delivery/partners/{pid}/kyc", {"action": "approve", "zone_id": zone_id})).json()
    assert r["kyc_status"] == "approved" and r["zone"]["id"] == zone_id
    assert (await rider.get("/api/auth/me")).json()["delivery"]["kyc_status"] == "approved"
    assert (await rider.post("/api/delivery/me/online", {"online": True})).json()["is_online"] is True
    assert (await rider.post("/api/delivery/me/location", {"lat": 11.0168, "lng": 76.9558})).json()["ok"] is True

    # switching a partner off takes them offline and blocks the app
    assert (await admin.post(f"/api/admin/delivery/partners/{pid}/active", {"active": False})).json()["error"]["code"] == "reason_required"
    r = (await admin.post(f"/api/admin/delivery/partners/{pid}/active", {"active": False, "reason": "Repeated late deliveries"})).json()
    assert r["is_active"] is False and r["is_online"] is False
    assert (await rider.post("/api/delivery/me/online", {"online": True})).status_code == 403
    assert (await admin.post(f"/api/admin/delivery/partners/{pid}/active", {"active": True})).json()["is_active"] is True
    assert (await admin.get("/api/admin/delivery/partners", params={"status": "approved"})).json()["total"] == 1

    # zones: a PIN code cannot be in two active zones; switching a zone off takes its partners offline
    bad = await admin.post("/api/admin/delivery/zones", {"name": "Peelamedu", "city": "Coimbatore", "pincodes": "641004, 64100"})
    assert bad.json()["error"]["code"] == "invalid_pin"
    clash = await admin.post("/api/admin/delivery/zones", {"name": "Peelamedu", "city": "Coimbatore", "pincodes": "641004 641002"})
    assert clash.status_code == 409 and clash.json()["error"]["code"] == "pin_overlap"
    z2 = (await admin.post("/api/admin/delivery/zones", {"name": "Peelamedu", "city": "Coimbatore", "pincodes": "641004\n641014,641004"})).json()
    assert z2["pincodes"] == ["641004", "641014"]
    await rider.post("/api/delivery/me/online", {"online": True})
    zl = {z["name"]: z for z in (await admin.get("/api/admin/delivery/zones")).json()}
    assert zl["Coimbatore Central"]["online"] == 1 and zl["Coimbatore Central"]["approved"] == 1
    await admin.put(f"/api/admin/delivery/zones/{zone_id}", {"name": "Coimbatore Central", "city": "Coimbatore", "pincodes": ["641001", "641002"], "is_active": False})
    assert (await rider.get("/api/delivery/me")).json()["is_online"] is False
    assert (await admin.delete(f"/api/admin/delivery/zones/{zone_id}")).status_code == 409  # partners still in it
    assert (await admin.post(f"/api/admin/delivery/zones/{z2['id']}/partners", {"partner_ids": [pid]})).json()["moved"] == 1
    assert (await admin.delete(f"/api/admin/delivery/zones/{zone_id}")).status_code == 200

    # staff add a partner by mobile number; the partner signs in with it and finishes the registration
    added = await admin.post("/api/admin/delivery/partners", {"phone": "+91 96000 00503", "name": "Walk In", "vehicle_type": "cycle"})
    assert added.status_code == 201 and added.json()["kyc_status"] == "draft"
    walk = await login_phone(client, "9600000503")
    assert (await walk.get("/api/delivery/me")).json()["name"] == "Walk In"

    # settings
    s = (await admin.get("/api/admin/delivery/settings")).json()
    assert s["values"]["offer_seconds"] == 30 and "zones" in s["fleet_modes"]
    assert (await admin.put("/api/admin/delivery/settings", {"offer_seconds": 5})).json()["error"]["code"] == "invalid_setting"
    assert (await admin.put("/api/admin/delivery/settings", {"fleet_mode": "everywhere"})).json()["error"]["code"] == "invalid_setting"
    assert (await admin.put("/api/admin/delivery/settings", {"fee_min_paise": 9000, "fee_max_paise": 5000})).json()["error"]["code"] == "invalid_setting"
    v = (await admin.put("/api/admin/delivery/settings", {"offer_seconds": 45, "fleet_mode": "all", "support_phone": "9876543210"})).json()["values"]
    assert v["offer_seconds"] == 45 and v["fleet_mode"] == "all"
    assert (await client.get("/api/delivery/options")).json()["support_phone"] == "9876543210"

    # roles: without the delivery permission staff cannot open these pages; the delivery manager can
    marketing = await staff_with_role(client, "marketing", "mkt@pixcart.in")
    assert (await marketing.get("/api/admin/delivery/partners")).status_code == 403
    manager = await staff_with_role(client, "delivery_manager", "dm@pixcart.in")
    assert (await manager.get("/api/admin/delivery/partners")).status_code == 200
    assert (await manager.get(f"/api/admin/delivery/partners/{pid}/bank")).status_code == 403  # bank numbers need the payouts permission


# ---------------------------------------------------------------------------- steps 4 to 8: the delivery pipeline

CHENNAI = ("600001", "600028", "600040")  # the test seller's store is in 600001, the shopper in 600028


async def ready_partner(client, admin, phone: str, name: str, zone_id: str, lat: float, lng: float) -> Api:
    rider = await register_partner(client, phone, name, zone_id)
    pid = (await rider.get("/api/delivery/me")).json()["id"]
    assert (await admin.post(f"/api/admin/delivery/partners/{pid}/kyc", {"action": "approve", "zone_id": zone_id})).status_code == 200
    assert (await rider.post("/api/delivery/me/online", {"online": True})).status_code == 200
    assert (await rider.post("/api/delivery/me/location", {"lat": lat, "lng": lng})).status_code == 200
    rider.partner_id = pid
    return rider


async def cod_order(client, product, phone: str) -> tuple[Api, dict]:
    buyer = await login_phone(client, phone, name=f"Buyer {phone[-3:]}")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": product["variants"][0]["id"], "qty": 1})
    from tests.test_phase2_money import key

    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return buyer, o


def titles(inbox: dict) -> list[str]:
    return [n["title"] for n in inbox["items"]]


async def test_pipeline_manual_assignment_to_delivery_earnings_and_payout(client, admin, categories):
    zone_id = await make_zone("Chennai Central", "Chennai", CHENNAI)
    await admin.put("/api/admin/delivery/settings", {"auto_assign": False, "fleet_mode": "zones"})
    tn, ka, shirt, _ = await setup(client, admin, categories)  # shirt ₹1,000, sold by Kovai Textiles from 600001
    rider = await ready_partner(client, admin, "9600000701", "Kumar Rider", zone_id, 13.0830, 80.2710)
    buyer, o = await cod_order(client, shirt, "9600000702")
    sub_id = o["sub_orders"][0]["id"]

    # the seller: the order is in the fleet's zones, so courier shipping is refused and "Ready for pickup" is offered
    assert (await tn.post(f"/api/seller/orders/{sub_id}/confirm")).status_code == 200
    view = (await tn.get(f"/api/seller/orders/{sub_id}")).json()
    assert view["fleet"]["eligible"] is True and view["fleet"]["choice"] is False
    await tn.post(f"/api/seller/orders/{sub_id}/pack")
    assert (await tn.post(f"/api/seller/orders/{sub_id}/ship", {"courier_name": "DTDC", "tracking_number": "AWB99999"})).json()["error"]["code"] == "fleet_order"
    r = (await tn.post(f"/api/seller/orders/{sub_id}/ready-for-pickup")).json()
    code = r["fleet"]["pickup_code"]
    assert r["status"] == "packed" and r["fleet"]["active"] and len(code) == 4 and r["fleet"]["step"]["status"] == "waiting"
    assert "Ready for pickup: " + r["number"] in titles((await admin.get("/api/notifications")).json())

    # admin queue → candidates → offer; the partner sees the request with a timer, without the customer's details yet
    q = (await admin.get("/api/admin/delivery/queue")).json()
    assert q["counts"]["waiting"] == 1 and q["items"][0]["cod_amount"] == 100000
    cands = (await admin.get(f"/api/admin/delivery/packages/{sub_id}/candidates")).json()
    assert cands[0]["ok"] and cands[0]["distance_km"] is None  # the store has no map position yet
    await admin.post("/api/admin/delivery/assign", {"sub_order_id": sub_id, "partner_id": rider.partner_id})
    feed = (await rider.get("/api/delivery/feed")).json()
    offer = feed["offers"][0]
    assert 0 < offer["seconds_left"] <= 30 and offer["drop"]["name"] == "" and offer["cod_amount"] == 100000 and offer["fee_estimate"] == 3000
    assert "New delivery request" in titles((await rider.get("/api/notifications")).json())

    # declined → back to the queue, staff told; offered again and accepted
    assert (await rider.post(f"/api/delivery/offers/{offer['id']}/reject", {"reason": "vehicle", "note": "Puncture"})).json()["ok"]
    assert (await admin.get("/api/admin/delivery/queue")).json()["counts"]["waiting"] == 1
    assert any(t.startswith("No delivery partner took") for t in titles((await admin.get("/api/notifications")).json()))
    a2 = (await admin.post("/api/admin/delivery/assign", {"sub_order_id": sub_id, "partner_id": rider.partner_id})).json()
    accepted = (await rider.post(f"/api/delivery/offers/{a2['id']}/accept")).json()
    assert accepted["status"] == "accepted" and accepted["drop"]["name"] == "Priya S" and accepted["drop"]["phone"] == "9876500000"
    assert "Delivery partner assigned" in titles((await buyer.get("/api/notifications")).json())
    assert any(t.startswith("Pickup assigned") for t in titles((await tn.get("/api/notifications")).json()))
    assert (await tn.get(f"/api/seller/orders/{sub_id}")).json()["fleet"]["partner"]["name"] == "Kumar Rider"

    # at the store (its map position is learnt) → pickup needs the seller's code → the package is shipped
    trip = f"/api/delivery/trips/{a2['id']}"
    assert (await rider.post(f"{trip}/status", {"to": "on_the_way"})).json()["error"]["code"] == "invalid_step"
    await rider.post(f"{trip}/status", {"to": "at_store", "lat": 13.0827, "lng": 80.2707})
    assert (await rider.post(f"{trip}/status", {"to": "picked", "code": "0000" if code != "0000" else "1111"})).json()["error"]["code"] == "wrong_code"
    picked = (await rider.post(f"{trip}/status", {"to": "picked", "code": code, "lat": 13.0827, "lng": 80.2707})).json()
    assert picked["status"] == "picked"
    order_view = (await buyer.get(f"/api/orders/{o['id']}")).json()
    track = order_view["fleet"][sub_id]
    assert order_view["sub_orders"][0]["status"] == "shipped" and track["partner"]["name"] == "Kumar Rider" and len(track["otp"]) == 4
    assert track["location"]["lat"] == 13.083
    assert "Out for delivery" in titles((await buyer.get("/api/notifications")).json())
    otp = track["otp"]

    # at the door: OTP, photo and the exact cash are all checked
    await rider.post(f"{trip}/status", {"to": "on_the_way"})
    await rider.post(f"{trip}/status", {"to": "reached"})
    photo = {"photo": ("door.png", png_bytes(), "image/png")}
    bad = await client.post(f"{trip}/deliver", headers=rider.h(), data={"otp": "9999" if otp != "9999" else "8888", "cod_collected": "100000", "cod_method": "cash"}, files=photo)
    assert bad.json()["error"]["code"] == "wrong_otp"
    no_photo = await client.post(f"{trip}/deliver", headers=rider.h(), data={"otp": otp, "cod_collected": "100000", "cod_method": "cash"})
    assert no_photo.json()["error"]["code"] == "proof_required"
    short = await client.post(f"{trip}/deliver", headers=rider.h(), data={"otp": otp, "cod_collected": "90000", "cod_method": "cash"}, files=photo)
    assert short.json()["error"]["code"] == "cod_mismatch"
    done = await client.post(f"{trip}/deliver", headers=rider.h(), data={"otp": otp, "cod_collected": "100000", "cod_method": "upi", "lat": "13.06", "lng": "80.25"},
                             files={"photo": ("door.png", png_bytes(), "image/png")})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "delivered" and done.json()["fee"] == 3000 and done.json()["distance_km"] > 0
    after = (await buyer.get(f"/api/orders/{o['id']}")).json()
    assert after["sub_orders"][0]["status"] == "delivered" and after["fleet"][sub_id]["can_rate"] is True
    assert (await buyer.get(f"/api/orders/{o['id']}/delivery-proof/{sub_id}")).status_code == 200
    assert "Delivered" in titles((await buyer.get("/api/notifications")).json())

    # rating and complaint
    assert (await buyer.post(f"/api/orders/{o['id']}/delivery-rating", {"sub_order_id": sub_id, "rating": 5, "comment": "Very polite"})).json()["rating"] == 5
    me = (await rider.get("/api/delivery/me")).json()
    assert me["rating_avg"] == 5.0 and me["rating_count"] == 1
    c = (await buyer.post(f"/api/orders/{o['id']}/delivery-complaint", {"sub_order_id": sub_id, "category": "late", "text": "Came 20 minutes late"})).json()
    fb = (await admin.get("/api/admin/delivery/feedback")).json()
    assert fb["open"] == 1 and fb["items"][0]["category_label"] == "Delivered late"
    assert (await admin.post(f"/api/admin/delivery/complaints/{c['id']}/resolve", {"note": "Spoke to the partner"})).json()["ok"]
    assert (await admin.get("/api/admin/delivery/feedback", params={"kind": "ratings"})).json()["items"][0]["rating"] == 5

    # earnings, cash in hand, deposits, the weekly payout
    e = (await rider.get("/api/delivery/earnings")).json()
    assert e["today"]["trips"] == 1 and e["today"]["earned"] == 3000 and e["cash_in_hand"] == 100000 and e["unpaid"] == 3000
    assert (await rider.get("/api/delivery/history")).json()["items"][0]["status"] == "delivered"
    assert (await admin.post(f"/api/admin/delivery/partners/{rider.partner_id}/deposits", {"amount_paise": 200000})).json()["error"]["code"] == "deposit_too_big"
    assert (await admin.post(f"/api/admin/delivery/partners/{rider.partner_id}/deposits", {"amount_paise": 100000, "method": "upi", "reference": "UPI123"})).json()["cash_in_hand"] == 0
    from datetime import date
    gen = (await admin.post("/api/admin/delivery/payouts/generate", {"week_start": date.today().isoformat()})).json()
    assert gen["created"] == 1
    pays = (await admin.get("/api/admin/delivery/payouts")).json()
    assert pays["items"][0]["amount"] == 3000 and pays["items"][0]["net_amount"] == 3000 and pays["pending_total"] == 3000
    assert (await admin.post(f"/api/admin/delivery/payouts/{pays['items'][0]['id']}/paid", {"reference": "UTR0001"})).json()["status"] == "paid"
    assert "Payout ₹30 paid" in titles((await rider.get("/api/notifications")).json())
    assert (await admin.post("/api/admin/delivery/payouts/generate", {"week_start": date.today().isoformat()})).json()["created"] == 0

    # the live view and the reports
    live = (await admin.get("/api/admin/delivery/live")).json()
    p = next(x for x in live["partners"] if x["name"] == "Kumar Rider")
    assert p["online"] and p["state"] == "free" and p["today_trips"] == 1 and p["location_state"] == "live" and live["summary"]["online"] >= 1
    rep = (await admin.get("/api/admin/delivery/reports")).json()
    assert rep["delivered"] == 1 and rep["success_rate"] == 100.0 and rep["partners"][0]["delivered"] == 1
    over = (await admin.get("/api/admin/delivery/overview")).json()
    assert over["delivered_today"] == 1 and over["queue"] == 0


async def test_auto_assign_expiry_failure_return_and_alerts(client, admin, categories, gateway):
    from app.services import fleet

    zone_id = await make_zone("Chennai Central", "Chennai", CHENNAI)
    await admin.put("/api/admin/delivery/settings", {"auto_assign": True, "offer_seconds": 10, "max_offers": 3, "stuck_minutes": 30})
    tn, ka, shirt, _ = await setup(client, admin, categories)
    near = await ready_partner(client, admin, "9600000801", "Near Rider", zone_id, 13.0830, 80.2700)
    far = await ready_partner(client, admin, "9600000802", "Far Rider", zone_id, 13.1200, 80.2900)
    # the store's position is known (a partner reached it before), so the nearest partner is asked first
    async with SessionLocal() as s:
        from app.models import Warehouse
        for wh in (await s.execute(select(Warehouse))).scalars():
            wh.lat, wh.lng = 13.0827, 80.2707
        await s.commit()

    buyer, o = await cod_order(client, shirt, "9600000803")
    sub_id = o["sub_orders"][0]["id"]
    await tn.post(f"/api/seller/orders/{sub_id}/confirm")
    r = (await tn.post(f"/api/seller/orders/{sub_id}/ready-for-pickup")).json()  # straight from confirmed: packs it too
    assert r["status"] == "packed" and r["fleet"]["step"]["status"] == "offered"
    first = (await near.get("/api/delivery/feed")).json()["offers"]
    assert len(first) == 1 and (await far.get("/api/delivery/feed")).json()["offers"] == []

    # nobody answers in time: the request moves to the next partner
    async with SessionLocal() as s:
        a = await s.get(DeliveryAssignment, __import__("uuid").UUID(first[0]["id"]))
        a.expires_at = utcnow() - timedelta(seconds=1)
        await s.commit()
    assert (await near.post(f"/api/delivery/offers/{first[0]['id']}/accept")).json()["error"]["code"] == "offer_expired"
    second = (await far.get("/api/delivery/feed")).json()["offers"]
    assert len(second) == 1
    # the second partner declines and nobody else is free: staff are told and the package waits in the queue
    await far.post(f"/api/delivery/offers/{second[0]['id']}/reject", {"reason": "too_far"})
    q = (await admin.get("/api/admin/delivery/queue")).json()
    assert q["counts"]["waiting"] == 1 and [t["status"] for t in q["items"][0]["tries"]] == ["expired", "rejected"]
    assert any(t.startswith("No delivery partner took") for t in titles((await admin.get("/api/notifications")).json()))

    # staff assign directly (the partner agreed on the phone); a trip that stays in one step too long alerts staff
    direct = (await admin.post("/api/admin/delivery/assign", {"sub_order_id": sub_id, "partner_id": near.partner_id, "direct": True})).json()
    assert direct["status"] == "accepted"
    async with SessionLocal() as s:
        a = await s.get(DeliveryAssignment, __import__("uuid").UUID(direct["id"]))
        a.status_at = utcnow() - timedelta(minutes=45)
        await s.commit()
    async with SessionLocal() as s:
        assert await fleet.stuck_check(s) == 1
        await s.commit()
    assert any(t.startswith("Delivery stuck") for t in titles((await admin.get("/api/notifications")).json()))
    live = (await admin.get("/api/admin/delivery/live")).json()
    assert live["summary"]["stuck"] == 1 and next(p for p in live["partners"] if p["name"] == "Near Rider")["state"] == "on_trip"

    # picked up, then the customer is not available: the attempt fails; staff send it back to the seller
    code = (await tn.get(f"/api/seller/orders/{sub_id}")).json()["fleet"]["pickup_code"]
    trip = f"/api/delivery/trips/{direct['id']}"
    await near.post(f"{trip}/status", {"to": "picked", "code": code})
    failed = (await near.post(f"{trip}/fail", {"reason": "not_available", "note": "Phone switched off"})).json()
    assert failed["status"] == "failed" and "Customer not available" in failed["fail_reason"]
    assert "Delivery attempt failed" in titles((await buyer.get("/api/notifications")).json())
    fq = (await admin.get("/api/admin/delivery/queue", params={"tab": "failed"})).json()
    assert fq["counts"]["failed"] == 1
    back = (await admin.post(f"/api/admin/delivery/assignments/{direct['id']}/resolve", {"action": "return"})).json()
    assert back["kind"] == "return" and back["status"] == "picked"
    assert (await near.post(f"/api/delivery/trips/{back['id']}/returned", {"code": "0000" if code != "0000" else "1111"})).json()["error"]["code"] == "wrong_code"
    done = (await near.post(f"/api/delivery/trips/{back['id']}/returned", {"code": code})).json()
    assert done["status"] == "delivered"
    after = (await buyer.get(f"/api/orders/{o['id']}")).json()
    assert after["sub_orders"][0]["status"] == "cancelled"  # returned to the seller: the order part is cancelled
    assert (await tn.get("/api/seller/inventory")).json()["items"][0]["total"] == 10  # the stock is back
    assert any(t.startswith("Package returned") for t in titles((await tn.get("/api/notifications")).json()))

    # a cancelled order while a partner holds the request: the partner is told and the request ends
    buyer2, o2 = await cod_order(client, shirt, "9600000804")
    sub2 = o2["sub_orders"][0]["id"]
    await tn.post(f"/api/seller/orders/{sub2}/confirm")
    await tn.post(f"/api/seller/orders/{sub2}/ready-for-pickup")
    offers = (await near.get("/api/delivery/feed")).json()["offers"] + (await far.get("/api/delivery/feed")).json()["offers"]
    assert len(offers) == 1
    await buyer2.post(f"/api/orders/{o2['id']}/cancel", {"reason": "Ordered by mistake"})
    assert (await near.get("/api/delivery/feed")).json()["offers"] == [] and (await far.get("/api/delivery/feed")).json()["offers"] == []
    told = titles((await near.get("/api/notifications")).json()) + titles((await far.get("/api/notifications")).json())
    assert any(t.startswith("Delivery cancelled") for t in told)

    # "seller chooses": a package in the zones can still go by courier
    await admin.put("/api/admin/delivery/settings", {"fleet_mode": "seller_choice", "auto_assign": False})
    buyer3, o3 = await cod_order(client, shirt, "9600000805")
    sub3 = o3["sub_orders"][0]["id"]
    await tn.post(f"/api/seller/orders/{sub3}/confirm")
    assert (await tn.get(f"/api/seller/orders/{sub3}")).json()["fleet"]["choice"] is True
    await tn.post(f"/api/seller/orders/{sub3}/ready-for-pickup")
    assert (await tn.post(f"/api/seller/orders/{sub3}/use-courier")).json()["fleet"]["active"] is False
    shipped = await tn.post(f"/api/seller/orders/{sub3}/ship", {"courier_name": "DTDC", "tracking_number": "AWB12345"})
    assert shipped.status_code == 200 and shipped.json()["status"] == "shipped"

    # couriers only: the fleet is not offered at all
    await admin.put("/api/admin/delivery/settings", {"fleet_mode": "off"})
    buyer4, o4 = await cod_order(client, shirt, "9600000806")
    sub4 = o4["sub_orders"][0]["id"]
    await tn.post(f"/api/seller/orders/{sub4}/confirm")
    assert (await tn.get(f"/api/seller/orders/{sub4}")).json()["fleet"]["eligible"] is False
    assert (await tn.post(f"/api/seller/orders/{sub4}/ready-for-pickup")).json()["error"]["code"] == "not_fleet"


def fake_apk() -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00manifest")
        z.writestr("classes.dex", b"dex\n035\x00")
        z.writestr("resources.arsc", b"\x02\x00\x0c\x00")
    return buf.getvalue()


async def test_partner_app_upload_publishes_the_download_link(client, admin):
    url = "/api/admin/delivery/app"
    # not an app: refused, and the settings stay as they were
    bad = await client.post(url, headers=admin.h(), files={"file": ("app.apk", b"PK\x03\x04not really a zip", "application/octet-stream")})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_apk"
    pdf = await client.post(url, headers=admin.h(), files={"file": ("app.apk", PDF, "application/pdf")})
    assert pdf.json()["error"]["code"] == "invalid_apk"
    assert (await client.post(url + "?version=1.0<script>", headers=admin.h(), files={"file": ("a.apk", fake_apk())})).json()["error"]["code"] == "invalid_version"

    ok = await client.post(url + "?version=1.2.0", headers=admin.h(), files={"file": ("pixcart.apk", fake_apk(), "application/vnd.android.package-archive")})
    assert ok.status_code == 200, ok.text
    link = ok.json()["values"]["android_apk_url"]
    assert "/apps/pixcart-partner-1.2.0-" in link and link.endswith(".apk")
    opts = (await client.get("/api/delivery/options")).json()
    assert opts["android_apk_url"] == link and opts["app_version"] == "1.2.0"  # partners see it on /delivery/download
    actions = {a["action"] for a in (await admin.get("/api/admin/audit")).json()["items"]}
    assert "delivery.app_upload" in actions
