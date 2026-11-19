"""Own delivery fleet: partner profiles, the delivery pipeline, fees, cash and payouts.

Pipeline for one package (sub-order with ``shipping_provider = 'fleet'``):

    seller "Ready for pickup" → offered to a partner (staff or auto-assign, 30-second timer) → accepted
    → at the store → picked up (seller's pickup code; the package becomes "shipped") → on the way → reached
    → delivered (customer's OTP + proof photo; the package becomes "delivered"; fee and cash are recorded)

A rejected or expired offer stays as a history row and the package goes to the next partner (auto) or back to the
admin queue. Every step is written to ``order_status_logs`` with who did it and where.
"""
from __future__ import annotations

import math
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import DeliveryBoy, DeliveryZone, OrderStatusLog
from app.services.delivery_settings import ID_PROOFS, VEHICLE_LABELS

KYC_LABEL = {"draft": "Not submitted", "submitted": "Under review", "approved": "Approved", "rejected": "Needs changes"}
DOC_FIELDS = {"license": "license_doc", "id_proof": "id_proof_doc", "vehicle_rc": "vehicle_doc"}
STEP_LABEL = {
    "offered": "Waiting for the partner to accept",
    "accepted": "Partner on the way to the store",
    "at_store": "Partner at the store",
    "picked": "Picked up",
    "on_the_way": "On the way to you",
    "reached": "Partner has arrived",
    "delivered": "Delivered",
    "rejected": "Declined by the partner",
    "expired": "Not accepted in time",
    "cancelled": "Cancelled",
    "failed": "Delivery attempt failed",
}


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _f(v: Any) -> float | None:
    return float(v) if v is not None else None


def checklist(b: DeliveryBoy, cfg: dict) -> list[dict]:
    """What a partner must fill in before sending the registration for review."""
    bank = b.bank_details or {}
    items = [
        ("profile", "Name, city and address", bool(b.name and b.city and b.address)),
        ("photo", "Your photo", bool(b.photo)),
        ("vehicle", "Vehicle type and number", bool(b.vehicle_type and (b.vehicle_no or b.vehicle_type == "cycle"))),
        ("license", "Driving licence number and photo", bool(b.license_no and b.license_doc) or b.vehicle_type == "cycle"),
        ("id_proof", "ID proof number and photo", bool(b.id_proof_type and b.id_proof_last4 and b.id_proof_doc)),
        ("bank", "Bank account or UPI for payouts", bool((bank.get("account_enc") and bank.get("ifsc")) or bank.get("upi"))),
    ]
    if cfg.get("require_vehicle_doc") and b.vehicle_type != "cycle":
        items.append(("vehicle_rc", "Vehicle registration (RC) photo", bool(b.vehicle_doc)))
    return [{"key": k, "label": label, "done": done} for k, label, done in items]


def partner_out(b: DeliveryBoy, zone: DeliveryZone | None, cfg: dict, *, admin: bool = False) -> dict:
    bank = b.bank_details or {}
    items = checklist(b, cfg)
    out = {
        "id": str(b.id), "name": b.name, "phone": b.phone, "photo": b.photo, "city": b.city, "address": b.address,
        "license_no": b.license_no, "id_proof_type": b.id_proof_type, "id_proof_label": ID_PROOFS.get(b.id_proof_type, ""),
        "id_proof_last4": b.id_proof_last4, "vehicle_type": b.vehicle_type, "vehicle_label": VEHICLE_LABELS.get(b.vehicle_type, b.vehicle_type),
        "vehicle_no": b.vehicle_no, "zone": {"id": str(zone.id), "name": zone.name, "city": zone.city} if zone else None,
        "is_online": b.is_online, "is_active": b.is_active, "kyc_status": b.kyc_status, "kyc_label": KYC_LABEL.get(b.kyc_status, b.kyc_status),
        "kyc_note": b.kyc_note, "approved_at": b.approved_at.isoformat() if b.approved_at else None,
        "docs": {k: bool(getattr(b, f)) for k, f in DOC_FIELDS.items()},
        "bank": {"holder": bank.get("holder", ""), "ifsc": bank.get("ifsc", ""), "account_last4": bank.get("account_last4", ""),
                 "upi": bank.get("upi", ""), "set": bool((bank.get("account_enc") and bank.get("ifsc")) or bank.get("upi"))},
        "rating_avg": round(float(b.rating_avg or 0), 2), "rating_count": b.rating_count,
        "checklist": items, "can_submit": b.kyc_status in ("draft", "rejected") and all(i["done"] for i in items),
        "editable": b.kyc_status in ("draft", "rejected"),
        "location": {"lat": _f(b.lat), "lng": _f(b.lng), "at": b.location_at.isoformat() if b.location_at else None},
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }
    if admin:
        out["user_id"] = str(b.user_id)
    return out


async def zone_of(session: AsyncSession, b: DeliveryBoy) -> DeliveryZone | None:
    return await session.get(DeliveryZone, b.zone_id) if b.zone_id else None


def log_status(session: AsyncSession, *, order_id: uuid.UUID, sub_order_id: uuid.UUID | None, status: str, actor: str,
               user_id: uuid.UUID | None = None, assignment_id: uuid.UUID | None = None, note: str = "",
               lat: float | None = None, lng: float | None = None) -> None:
    session.add(OrderStatusLog(order_id=order_id, sub_order_id=sub_order_id, assignment_id=assignment_id, status=status, actor=actor,
                               updated_by=user_id, note=note[:1000], lat=lat, lng=lng, created_at=utcnow()))


async def partner_for_user(session: AsyncSession, user_id: uuid.UUID) -> DeliveryBoy | None:
    return (await session.execute(select(DeliveryBoy).where(DeliveryBoy.user_id == user_id))).scalar_one_or_none()
