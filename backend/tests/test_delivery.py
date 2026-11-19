"""Own delivery fleet: delivery partners, zones, assignment, the delivery pipeline, OTPs, proof, earnings and payouts."""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db import SessionLocal, utcnow
from app.models import DeliveryAssignment, DeliveryBoy, DeliveryZone, OrderStatusLog, SubOrder
from tests.conftest import login_phone
from tests.test_phase2_money import setup
from tests.test_promotions import order


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
