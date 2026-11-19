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
