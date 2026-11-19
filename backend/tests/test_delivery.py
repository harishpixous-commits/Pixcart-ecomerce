"""Own delivery fleet: delivery partners, zones, assignment, the delivery pipeline, OTPs, proof, earnings and payouts."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal, utcnow
from app.models import DeliveryAssignment, DeliveryBoy, DeliveryZone, OrderStatusLog, SubOrder
from tests.conftest import PDF, Api, login_phone, png_bytes
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
