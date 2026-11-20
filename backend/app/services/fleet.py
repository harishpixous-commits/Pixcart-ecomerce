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
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError, Conflict, NotFound
from app.db import utcnow
from app.models import (
    DeliveryAssignment,
    DeliveryBoy,
    DeliveryCashDeposit,
    DeliveryPayout,
    DeliveryZone,
    Order,
    OrderItem,
    OrderStatusLog,
    Seller,
    SubOrder,
    User,
    Warehouse,
)
from app.models.delivery import ACTIVE, ON_TRIP
from app.services import delivery_settings
from app.services.delivery_settings import FAIL_REASONS, ID_PROOFS, REJECT_REASONS, VEHICLE_LABELS

IST = timezone(timedelta(hours=5, minutes=30))
ROAD_FACTOR = 1.3  # roads are longer than the straight line between two points

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


# ============================================================================ helpers


def rupees(paise: int) -> str:
    return f"₹{paise / 100:,.0f}" if paise % 100 == 0 else f"₹{paise / 100:,.2f}"


def _code() -> str:
    return f"{secrets.randbelow(10_000):04d}"


def fee_for(cfg: dict, distance_km: float | None) -> int:
    """What a partner earns for one delivery (before the customer's tip)."""
    if cfg["fee_mode"] == "distance":
        fee = cfg["fee_base_paise"] + (round(cfg["fee_per_km_paise"] * distance_km) if distance_km is not None else 0)
        return max(cfg["fee_min_paise"], min(fee, cfg["fee_max_paise"]))
    return cfg["fee_fixed_paise"]


async def cash_by_partner(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Cash on delivery each partner still holds: collected minus deposited."""
    if not ids:
        return {}
    got = dict((await session.execute(select(DeliveryAssignment.delivery_boy_id, func.coalesce(func.sum(DeliveryAssignment.cod_collected), 0))
                                      .where(DeliveryAssignment.delivery_boy_id.in_(ids), DeliveryAssignment.status == "delivered")
                                      .group_by(DeliveryAssignment.delivery_boy_id))).all())
    paid = dict((await session.execute(select(DeliveryCashDeposit.delivery_boy_id, func.coalesce(func.sum(DeliveryCashDeposit.amount), 0))
                                       .where(DeliveryCashDeposit.delivery_boy_id.in_(ids)).group_by(DeliveryCashDeposit.delivery_boy_id))).all())
    return {i: int(got.get(i, 0)) - int(paid.get(i, 0)) for i in ids}


async def cash_in_hand(session: AsyncSession, boy_id: uuid.UUID) -> int:
    return (await cash_by_partner(session, [boy_id]))[boy_id]


async def loads(session: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Live offers and trips per partner."""
    if not ids:
        return {}
    rows = dict((await session.execute(select(DeliveryAssignment.delivery_boy_id, func.count()).where(
        DeliveryAssignment.delivery_boy_id.in_(ids), DeliveryAssignment.status.in_(ACTIVE)).group_by(DeliveryAssignment.delivery_boy_id))).all())
    return {i: int(rows.get(i, 0)) for i in ids}


async def active_assignment(session: AsyncSession, sub_id: uuid.UUID) -> DeliveryAssignment | None:
    return (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.sub_order_id == sub_id, DeliveryAssignment.status.in_(ACTIVE))
                                  .order_by(DeliveryAssignment.created_at.desc()).limit(1))).scalar_one_or_none()


async def zone_for_pin(session: AsyncSession, pin: str) -> DeliveryZone | None:
    if not pin:
        return None
    return (await session.execute(select(DeliveryZone).where(DeliveryZone.is_active.is_(True), DeliveryZone.pincodes.contains([pin])).limit(1))).scalar_one_or_none()


async def pickup_place(session: AsyncSession, sub: SubOrder) -> dict:
    """Where the partner collects the package: the warehouse the stock came from (or the seller's pickup address)."""
    seller = await session.get(Seller, sub.seller_id)
    wh = await session.get(Warehouse, sub.warehouse_id) if sub.warehouse_id else None
    owner = await session.get(User, seller.user_id) if seller else None
    phone = (wh.contact_phone if wh else "") or (owner.phone if owner and owner.phone else "")
    # "address" is the street part; screens add the city and PIN code themselves
    if wh:
        return {"name": seller.display_name if seller else wh.name, "address": ", ".join(x for x in (wh.line1, wh.line2) if x), "pincode": wh.pincode,
                "city": wh.city, "phone": phone, "lat": float(wh.lat) if wh.lat is not None else None, "lng": float(wh.lng) if wh.lng is not None else None,
                "warehouse": wh}
    return {"name": seller.display_name if seller else "", "address": ", ".join(x for x in (seller.pickup_line1, seller.pickup_line2) if x) if seller else "",
            "pincode": seller.pickup_pincode if seller else "", "city": seller.pickup_city if seller else "", "phone": phone, "lat": None, "lng": None, "warehouse": None}


async def is_fee_carrier(session: AsyncSession, sub: SubOrder) -> bool:
    """The first live package of the order carries the marketplace fees and the tip."""
    first = (await session.execute(select(SubOrder.id).where(SubOrder.order_id == sub.order_id, SubOrder.status != "cancelled")
                                   .order_by(SubOrder.number).limit(1))).scalar_one_or_none()
    return first == sub.id


def _area(st: dict) -> str:
    return ", ".join(x for x in (st.get("city", ""), st.get("pincode", "")) if x)


async def _offer_vars(session: AsyncSession, a: DeliveryAssignment, sub: SubOrder, order: Order, cfg: dict) -> dict:
    place = await pickup_place(session, sub)
    return {"order_number": sub.number, "store": place["name"], "pickup_area": place["city"] or place["pincode"], "drop_area": _area(order.ship_to),
            "fee": f"Earn {rupees(fee_for(cfg, None) + (order.tip_paise if await is_fee_carrier(session, sub) else 0))}",
            "cod": f", collect {rupees(a.cod_amount)}" if a.cod_amount else "", "seconds": cfg["offer_seconds"]}


# ============================================================================ which packages the fleet carries


async def route(session: AsyncSession, sub: SubOrder, order: Order | None = None) -> dict:
    """Whether this package goes to the own delivery partners, and from which zone.

    ``eligible``: the seller hands it to a partner ("Ready for pickup"). ``choice``: the seller may also ship it by
    courier (fleet mode "seller chooses"). ``zone_id``: the store's zone, whose partners get the request."""
    cfg = await delivery_settings.get(session)
    order = order or await session.get(Order, sub.order_id)
    off = {"eligible": False, "choice": False, "zone_id": None, "in_zones": False, "mode": cfg["fleet_mode"]}
    if not cfg["enabled"] or cfg["fleet_mode"] == "off":
        return off
    place = await pickup_place(session, sub)
    pz = await zone_for_pin(session, place["pincode"])
    dz = await zone_for_pin(session, (order.ship_to or {}).get("pincode", ""))
    in_zones = bool(pz and dz and pz.city.strip().lower() == dz.city.strip().lower())
    zone_id = pz.id if pz else (dz.id if dz else None)
    if cfg["fleet_mode"] == "all":
        return {**off, "eligible": True, "zone_id": zone_id, "in_zones": in_zones}
    if cfg["fleet_mode"] == "zones":
        return {**off, "eligible": in_zones, "zone_id": pz.id if in_zones else None, "in_zones": in_zones}
    return {**off, "eligible": in_zones, "choice": in_zones, "zone_id": pz.id if in_zones else None, "in_zones": in_zones}


# ============================================================================ seller: ready for pickup


async def ready_for_pickup(session: AsyncSession, sub: SubOrder, user: User) -> DeliveryAssignment | None:
    from app.services.notify import notify_staff
    from app.services.orders import transition

    if sub.status == "confirmed":
        await transition(session, sub, "packed", "seller", "Packed and ready for pickup")
    if sub.status != "packed":
        raise Conflict("Confirm and pack the order before handing it to a delivery partner", "invalid_status")
    order = await session.get(Order, sub.order_id)
    r = await route(session, sub, order)
    if not r["eligible"]:
        raise ApiError("Our delivery partners do not cover this order. Ship it by courier.", "not_fleet")
    if await active_assignment(session, sub.id):
        raise Conflict("A delivery partner is already assigned", "already_assigned")
    now = utcnow()
    sub.shipping_provider = "fleet"
    sub.ready_for_pickup_at = sub.ready_for_pickup_at or now
    sub.pickup_code = sub.pickup_code or _code()
    sub.delivery_otp = sub.delivery_otp or _code()
    sub.delivery_zone_id = r["zone_id"]
    sub.fleet_alerted_at = None
    log_status(session, order_id=order.id, sub_order_id=sub.id, status="ready_for_pickup", actor="seller", user_id=user.id)
    cfg = await delivery_settings.get(session)
    if cfg["auto_assign"]:
        return await auto_assign(session, sub, cfg=cfg)
    place = await pickup_place(session, sub)
    await notify_staff(session, "delivery", "staff_delivery_ready", {"order_number": sub.number, "store": place["name"], "pickup_area": place["city"],
                                                                     "drop_area": _area(order.ship_to)}, link="/admin/delivery/queue")
    return None


async def use_courier(session: AsyncSession, sub: SubOrder, user: User, *, actor: str) -> None:
    """Takes a package back from the fleet before pickup (the seller ships it by courier instead)."""
    a = await active_assignment(session, sub.id)
    if a and a.status not in ("offered", "accepted", "at_store"):
        raise Conflict("The delivery partner already has the package", "already_picked")
    if a:
        await _end(session, a, "cancelled", f"Switched to courier by the {actor}", user_id=user.id, actor=actor, tell_partner=True)
    sub.shipping_provider = "manual"
    sub.ready_for_pickup_at = None
    log_status(session, order_id=sub.order_id, sub_order_id=sub.id, status="courier", actor=actor, user_id=user.id, note="Ships by courier")


# ============================================================================ offering and assigning


async def _end(session: AsyncSession, a: DeliveryAssignment, status: str, note: str, *, user_id: uuid.UUID | None = None, actor: str = "system",
               tell_partner: bool = False) -> None:
    now = utcnow()
    a.status, a.ended_at, a.status_at = status, now, now
    if status in ("rejected", "expired", "cancelled") and not a.reject_reason:
        a.reject_reason = note[:200]
    log_status(session, order_id=a.order_id, sub_order_id=a.sub_order_id, assignment_id=a.id, status=status, actor=actor, user_id=user_id, note=note)
    if tell_partner:
        from app.services.notify import notify

        boy = await session.get(DeliveryBoy, a.delivery_boy_id)
        sub = await session.get(SubOrder, a.sub_order_id)
        if boy and sub:
            await notify(session, "delivery_trip_cancelled", await session.get(User, boy.user_id), {"order_number": sub.number, "message": note}, link="/delivery")


async def offer(session: AsyncSession, sub: SubOrder, boy: DeliveryBoy, *, mode: str, by: User | None = None, direct: bool = False,
                cfg: dict | None = None) -> DeliveryAssignment:
    """Offers the package to a partner (they accept within the offer time), or assigns it outright (``direct``)."""
    from app.services.notify import notify
    from app.services.orders import collect_amount

    cfg = cfg or await delivery_settings.get(session)
    if await active_assignment(session, sub.id):
        raise Conflict("This package already has a delivery partner", "already_assigned")
    order = await session.get(Order, sub.order_id)
    now = utcnow()
    a = DeliveryAssignment(
        order_id=order.id, sub_order_id=sub.id, delivery_boy_id=boy.id, assigned_by=by.id if by else None, mode=mode, kind="delivery",
        status="accepted" if direct else "offered", assigned_at=now, expires_at=None if direct else now + timedelta(seconds=cfg["offer_seconds"]),
        accepted_at=now if direct else None, status_at=now, cod_amount=await collect_amount(session, sub, order), created_at=now,
    )
    session.add(a)
    await session.flush()
    log_status(session, order_id=order.id, sub_order_id=sub.id, assignment_id=a.id, status=a.status, actor="admin" if by else "system",
               user_id=by.id if by else None, note=f"{'Assigned to' if direct else 'Offered to'} {boy.name}")
    variables = await _offer_vars(session, a, sub, order, cfg)
    await notify(session, "delivery_assigned" if direct else "delivery_new_offer", await session.get(User, boy.user_id), variables,
                 link=f"/delivery/trips/{a.id}" if direct else "/delivery", channels=("inapp", "push", "sms") if direct else ("inapp", "push"))
    if direct:
        await _announce_accepted(session, a, sub, order, boy)
    return a


async def _announce_accepted(session: AsyncSession, a: DeliveryAssignment, sub: SubOrder, order: Order, boy: DeliveryBoy) -> None:
    from app.services.notify import notify, notify_seller

    item = (await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id).limit(1))).scalar_one_or_none() or "Your package"
    await notify(session, "delivery_partner_assigned", await session.get(User, order.user_id), {"partner": boy.name, "item": item}, link=f"/orders/{order.id}")
    await notify_seller(session, sub.seller_id, "seller_pickup_assigned", {"order_number": sub.number, "partner": boy.name,
                                                                           "vehicle": f"{VEHICLE_LABELS.get(boy.vehicle_type, '')} {boy.vehicle_no}".strip(),
                                                                           "code": sub.pickup_code}, link=f"/seller/orders/{sub.id}")


async def candidates(session: AsyncSession, sub: SubOrder, cfg: dict, *, online_only: bool = True) -> list[dict]:
    """Partners who could take this package, best first, each with why they can or cannot."""
    from app.services.orders import collect_amount

    order = await session.get(Order, sub.order_id)
    place = await pickup_place(session, sub)
    stmt = select(DeliveryBoy).where(DeliveryBoy.kyc_status == "approved", DeliveryBoy.is_active.is_(True))
    if online_only:
        stmt = stmt.where(DeliveryBoy.is_online.is_(True))
    boys = list((await session.execute(stmt)).scalars())
    ids = [b.id for b in boys]
    load, cash = await loads(session, ids), await cash_by_partner(session, ids)
    tried = set((await session.execute(select(DeliveryAssignment.delivery_boy_id).where(DeliveryAssignment.sub_order_id == sub.id))).scalars())
    cod = await collect_amount(session, sub, order)
    now = utcnow()
    out = []
    for b in boys:
        dist = haversine_km(place["lat"], place["lng"], float(b.lat), float(b.lng)) if (place["lat"] is not None and b.lat is not None) else None
        reasons = []
        if sub.delivery_zone_id and b.zone_id != sub.delivery_zone_id:
            reasons.append("other zone")
        if b.id in tried:
            reasons.append("already asked")
        if load[b.id] >= cfg["max_active"]:
            reasons.append("busy")
        if cod and cash[b.id] + cod > cfg["cod_limit_paise"]:
            reasons.append("cash limit")
        if dist is not None and dist > cfg["radius_km"]:
            reasons.append("too far")
        if not b.is_online:
            reasons.append("offline")
        fresh = bool(b.location_at and now - b.location_at < timedelta(minutes=10))
        out.append({"boy": b, "distance_km": round(dist, 2) if dist is not None else None, "load": load[b.id], "cash": cash[b.id], "fresh": fresh,
                    "ok": not reasons, "reasons": reasons})
    out.sort(key=lambda c: (not c["ok"], c["distance_km"] is None, c["distance_km"] or 0, c["load"], not c["fresh"]))
    return out


async def _alert_unassigned(session: AsyncSession, sub: SubOrder, reason: str) -> None:
    from app.services.notify import notify_staff

    if sub.fleet_alerted_at:
        return
    sub.fleet_alerted_at = utcnow()
    await notify_staff(session, "delivery", "staff_delivery_unassigned", {"order_number": sub.number, "reason": reason}, link="/admin/delivery/queue")


async def auto_assign(session: AsyncSession, sub: SubOrder, *, cfg: dict | None = None) -> DeliveryAssignment | None:
    """Offers the package to the nearest free partner of the store's zone. After ``max_offers`` partners, or when nobody
    can take it, staff are told once and the package waits in the queue."""
    cfg = cfg or await delivery_settings.get(session)
    if not cfg["enabled"] or not cfg["auto_assign"] or sub.status != "packed" or sub.shipping_provider != "fleet":
        return None
    if await active_assignment(session, sub.id):
        return None
    tried = (await session.execute(select(func.count()).select_from(DeliveryAssignment).where(
        DeliveryAssignment.sub_order_id == sub.id, DeliveryAssignment.mode == "auto"))).scalar_one()
    if tried >= cfg["max_offers"]:
        await _alert_unassigned(session, sub, f"{tried} partners were asked and none took it.")
        return None
    if sub.delivery_zone_id is None:
        await _alert_unassigned(session, sub, "No delivery zone covers the store.")
        return None
    pool = [c for c in await candidates(session, sub, cfg) if c["ok"]]
    if not pool:
        await _alert_unassigned(session, sub, "No free partner is online near the store right now.")
        return None
    return await offer(session, sub, pool[0]["boy"], mode="auto", cfg=cfg)


async def _after_release(session: AsyncSession, sub: SubOrder, why: str, cfg: dict) -> None:
    """A partner declined, did not answer or was taken off: offer the package again or tell staff."""
    if sub.status != "packed" or sub.shipping_provider != "fleet":
        return
    if cfg["auto_assign"]:
        if await auto_assign(session, sub, cfg=cfg) is None:
            await _alert_unassigned(session, sub, why)
    else:
        sub.fleet_alerted_at = None
        await _alert_unassigned(session, sub, why)


async def sweep(session: AsyncSession) -> int:
    """Ends offers whose time ran out and moves their packages on. Safe to call often (a job, the partner app's feed
    and the admin queue all call it)."""
    now = utcnow()
    rows = list((await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.status == "offered", DeliveryAssignment.expires_at < now)
                                       .with_for_update(skip_locked=True))).scalars())
    if not rows:
        return 0
    cfg = await delivery_settings.get(session)
    for a in rows:
        await _end(session, a, "expired", "Not accepted in time")
        sub = await session.get(SubOrder, a.sub_order_id)
        if sub:
            await session.flush()
            await _after_release(session, sub, "The partner did not answer in time.", cfg)
    return len(rows)


# ============================================================================ the partner's answer


async def accept(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy) -> None:
    cfg = await delivery_settings.get(session)
    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery request")
    if a.status != "offered":
        raise Conflict("This request is no longer available", "offer_gone")
    if a.expires_at and a.expires_at < utcnow():
        await _end(session, a, "expired", "Not accepted in time")
        sub = await session.get(SubOrder, a.sub_order_id)
        await session.flush()
        await _after_release(session, sub, "The partner answered too late.", cfg)
        raise Conflict("Time is up for this request; it went to another partner", "offer_expired")
    busy = (await session.execute(select(func.count()).select_from(DeliveryAssignment).where(
        DeliveryAssignment.delivery_boy_id == boy.id, DeliveryAssignment.status.in_(ON_TRIP)))).scalar_one()
    if busy >= cfg["max_active"]:
        raise Conflict(f"You can carry at most {cfg['max_active']} packages at once", "too_many_trips")
    now = utcnow()
    a.status, a.accepted_at, a.status_at = "accepted", now, now
    log_status(session, order_id=a.order_id, sub_order_id=a.sub_order_id, assignment_id=a.id, status="accepted", actor="delivery", user_id=boy.user_id)
    sub = await session.get(SubOrder, a.sub_order_id)
    await _announce_accepted(session, a, sub, await session.get(Order, a.order_id), boy)


async def reject(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy, reason: str, note: str = "") -> None:
    cfg = await delivery_settings.get(session)
    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery request")
    if a.status not in ("offered", "accepted"):
        raise Conflict("This request can no longer be declined; call the delivery team", "cannot_reject")
    text = REJECT_REASONS.get(reason, "Other reason") + (f": {note.strip()}" if note.strip() else "")
    a.reject_reason = text[:200]
    await _end(session, a, "rejected", text, user_id=boy.user_id, actor="delivery")
    sub = await session.get(SubOrder, a.sub_order_id)
    await session.flush()
    await _after_release(session, sub, f"{boy.name} declined: {text}", cfg)


# ============================================================================ the trip


STEPS = {"at_store": ("accepted",), "picked": ("accepted", "at_store"), "on_the_way": ("picked",), "reached": ("picked", "on_the_way")}


async def advance(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy, to: str, *, code: str = "",
                  lat: float | None = None, lng: float | None = None) -> None:
    from app.core.deps import rate_limit
    from app.services.notify import notify
    from app.services.orders import transition

    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery")
    allowed = STEPS.get(to, ())
    if a.kind == "return":
        allowed = {"on_the_way": ("picked",), "reached": ("picked", "on_the_way")}.get(to, ())
    if a.status not in allowed:
        raise Conflict(f"You cannot mark this as {to.replace('_', ' ')} now", "invalid_step")
    cfg = await delivery_settings.get(session)
    sub = await session.get(SubOrder, a.sub_order_id)
    order = await session.get(Order, a.order_id)
    now = utcnow()
    if to == "picked":
        if cfg["pickup_code_required"]:
            await rate_limit(session, f"dpick:{a.id}", limit=8, window_seconds=900)
            if code.strip() != sub.pickup_code:
                await session.commit()  # keep the attempt count
                raise ApiError("The pickup code does not match. Ask the seller for the code on their order screen.", "wrong_code")
        sub.courier_name, sub.tracking_number = "Own delivery partner", ""
        await transition(session, sub, "shipped", "delivery", f"Picked up by {boy.name}", announce=False)
        a.picked_lat, a.picked_lng = lat, lng
    if to == "at_store" and lat is not None and lng is not None and sub.warehouse_id:
        wh = await session.get(Warehouse, sub.warehouse_id)
        if wh and wh.lat is None:  # learn where the store is from the first partner who reaches it
            wh.lat, wh.lng = round(lat, 6), round(lng, 6)
    a.status, a.status_at, a.stuck_alerted_at = to, now, None
    setattr(a, f"{to}_at", now)
    log_status(session, order_id=a.order_id, sub_order_id=a.sub_order_id, assignment_id=a.id, status=to, actor="delivery", user_id=boy.user_id, lat=lat, lng=lng)
    if a.kind == "delivery":
        customer = await session.get(User, order.user_id)
        item = (await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id).limit(1))).scalar_one_or_none() or "Your package"
        if to == "picked":
            await notify(session, "delivery_out_for_delivery", customer, {"item": item, "partner": boy.name, "otp": sub.delivery_otp}, link=f"/orders/{order.id}")
        elif to == "reached":
            await notify(session, "delivery_arriving", customer, {"item": item, "partner": boy.name, "otp": sub.delivery_otp}, link=f"/orders/{order.id}",
                         channels=("inapp", "push"))


async def deliver(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy, *, otp: str, proof_key: str, cod_collected: int, cod_method: str,
                  lat: float | None, lng: float | None) -> None:
    """Hands the package over: checks the customer's OTP, the proof photo and the cash collected, then records the fee."""
    from app.core.deps import rate_limit
    from app.services.notify import notify, notify_seller
    from app.services.orders import collect_amount, transition

    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery")
    if a.kind != "delivery" or a.status not in ("picked", "on_the_way", "reached"):
        raise Conflict("This package cannot be marked delivered now", "invalid_step")
    cfg = await delivery_settings.get(session)
    sub = await session.get(SubOrder, a.sub_order_id)
    order = await session.get(Order, a.order_id)
    if cfg["delivery_otp_required"]:
        await rate_limit(session, f"dotp:{a.id}", limit=6, window_seconds=900)
        if otp.strip() != sub.delivery_otp:
            await session.commit()
            raise ApiError("The OTP does not match. Ask the customer for the code in their SMS or order page.", "wrong_otp")
    if cfg["proof_photo_required"] and not proof_key:
        raise ApiError("Take a photo of the delivered package", "proof_required")
    due = await collect_amount(session, sub, order)
    if due:
        if cod_collected != due:
            raise ApiError(f"Collect {rupees(due)} from the customer and enter that amount", "cod_mismatch", fields={"cod_collected": rupees(due)})
        if cod_method not in ("cash", "upi"):
            raise ApiError("Choose how the customer paid: cash or UPI", "cod_method")
    now = utcnow()
    a.status, a.delivered_at, a.status_at, a.ended_at = "delivered", now, now, now
    a.drop_lat, a.drop_lng, a.proof_photo = lat, lng, proof_key
    a.cod_collected, a.cod_method = (due, cod_method) if due else (0, "")
    if a.picked_lat is not None and lat is not None:
        a.distance_km = round(haversine_km(float(a.picked_lat), float(a.picked_lng), lat, lng) * ROAD_FACTOR, 2)
    a.fee_paise = fee_for(cfg, float(a.distance_km) if a.distance_km is not None else None)
    a.tip_paise = order.tip_paise if await is_fee_carrier(session, sub) else 0
    await transition(session, sub, "delivered", "delivery", f"Delivered by {boy.name}")
    log_status(session, order_id=a.order_id, sub_order_id=sub.id, assignment_id=a.id, status="delivered", actor="delivery", user_id=boy.user_id, lat=lat, lng=lng)
    item = (await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id).limit(1))).scalar_one_or_none() or "your package"
    await notify_seller(session, sub.seller_id, "seller_package_delivered", {"order_number": sub.number, "partner": boy.name}, link=f"/seller/orders/{sub.id}")
    await notify(session, "delivery_rate", await session.get(User, order.user_id), {"partner": boy.name, "item": item}, link=f"/orders/{order.id}#delivery",
                 channels=("inapp", "push"))


async def fail(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy, reason: str, note: str, lat: float | None, lng: float | None) -> None:
    from app.services.notify import notify, notify_staff

    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery")
    if a.kind != "delivery" or a.status not in ("picked", "on_the_way", "reached"):
        raise Conflict("Only a package you are carrying can be marked as not delivered", "invalid_step")
    text = FAIL_REASONS.get(reason, "Other reason") + (f": {note.strip()}" if note.strip() else "")
    a.fail_reason, a.drop_lat, a.drop_lng = text[:200], lat, lng
    await _end(session, a, "failed", text, user_id=boy.user_id, actor="delivery")
    sub = await session.get(SubOrder, a.sub_order_id)
    order = await session.get(Order, a.order_id)
    item = (await session.execute(select(OrderItem.title).where(OrderItem.sub_order_id == sub.id).limit(1))).scalar_one_or_none() or "Your package"
    await notify(session, "delivery_failed", await session.get(User, order.user_id), {"item": item, "reason": FAIL_REASONS.get(reason, "Other reason")},
                 link=f"/orders/{order.id}")
    await notify_staff(session, "delivery", "staff_delivery_failed", {"order_number": sub.number, "partner": boy.name, "reason": text},
                       link="/admin/delivery/queue?tab=failed")


async def resolve_failed(session: AsyncSession, failed: DeliveryAssignment, user: User, action: str) -> DeliveryAssignment:
    """After a failed attempt the partner still has the package: try again, or bring it back to the seller."""
    from app.services.notify import notify
    from app.services.orders import collect_amount

    if failed.status != "failed":
        raise Conflict("Only a failed delivery can be resolved", "invalid_status")
    sub = await session.get(SubOrder, failed.sub_order_id)
    if await active_assignment(session, sub.id):
        raise Conflict("This package already has a trip in progress", "already_assigned")
    if sub.status != "shipped":
        raise Conflict("This package is no longer with the delivery partner", "invalid_status")
    boy = await session.get(DeliveryBoy, failed.delivery_boy_id)
    order = await session.get(Order, sub.order_id)
    now = utcnow()
    kind = "return" if action == "return" else "delivery"
    a = DeliveryAssignment(order_id=order.id, sub_order_id=sub.id, delivery_boy_id=boy.id, assigned_by=user.id, mode="manual", kind=kind, status="picked",
                           assigned_at=now, accepted_at=now, picked_at=now, status_at=now, picked_lat=failed.picked_lat, picked_lng=failed.picked_lng,
                           cod_amount=await collect_amount(session, sub, order) if kind == "delivery" else 0, created_at=now)
    session.add(a)
    await session.flush()
    note = "Try the delivery again" if kind == "delivery" else "Bring the package back to the store"
    log_status(session, order_id=order.id, sub_order_id=sub.id, assignment_id=a.id, status=f"{kind}_trip", actor="admin", user_id=user.id, note=note)
    await notify(session, "delivery_assigned", await session.get(User, boy.user_id), {**(await _offer_vars(session, a, sub, order, await delivery_settings.get(session))),
                                                                                      "drop_area": "the store" if kind == "return" else _area(order.ship_to)},
                 link=f"/delivery/trips/{a.id}")
    return a


async def returned(session: AsyncSession, a: DeliveryAssignment, boy: DeliveryBoy, *, code: str, lat: float | None, lng: float | None) -> None:
    """The partner hands a package back to the seller (after failed attempts or a cancellation): the order part is
    cancelled, a prepaid amount refunded and the stock goes back to the seller."""
    from app.core.deps import rate_limit
    from app.services.notify import notify_seller
    from app.services.orders import cancel_sub_order

    if a.delivery_boy_id != boy.id:
        raise NotFound("Delivery")
    if a.kind != "return" or a.status not in ("picked", "on_the_way", "reached"):
        raise Conflict("This is not a return to the store", "invalid_step")
    cfg = await delivery_settings.get(session)
    sub = await session.get(SubOrder, a.sub_order_id)
    if cfg["pickup_code_required"]:
        await rate_limit(session, f"dret:{a.id}", limit=8, window_seconds=900)
        if code.strip() != sub.pickup_code:
            await session.commit()
            raise ApiError("The code does not match. Ask the seller for the pickup code on their order screen.", "wrong_code")
    now = utcnow()
    a.status, a.delivered_at, a.ended_at, a.status_at, a.drop_lat, a.drop_lng = "delivered", now, now, now, lat, lng
    a.fee_paise = fee_for(cfg, None)
    last_fail = (await session.execute(select(DeliveryAssignment.fail_reason).where(DeliveryAssignment.sub_order_id == sub.id, DeliveryAssignment.status == "failed")
                                       .order_by(DeliveryAssignment.created_at.desc()).limit(1))).scalar_one_or_none() or "Order cancelled"
    log_status(session, order_id=a.order_id, sub_order_id=sub.id, assignment_id=a.id, status="returned", actor="delivery", user_id=boy.user_id, lat=lat, lng=lng)
    if sub.status != "cancelled":
        await cancel_sub_order(session, sub, actor="admin", reason=f"Returned to the seller: {last_fail}")
    await notify_seller(session, sub.seller_id, "seller_package_returned", {"order_number": sub.number, "partner": boy.name, "reason": last_fail},
                        link=f"/seller/orders/{sub.id}")


async def on_cancelled(session: AsyncSession, sub: SubOrder, reason: str) -> None:
    """A fleet package was cancelled: stop the request or trip; a package already picked up goes back to the store."""
    a = await active_assignment(session, sub.id)
    if a is None:
        return
    if a.status in ("offered", "accepted", "at_store"):
        await _end(session, a, "cancelled", f"Order cancelled ({reason}). Do not pick it up.", tell_partner=True)
        return
    if a.kind == "return":
        return  # already on its way back
    await _end(session, a, "cancelled", f"Order cancelled ({reason}). Bring the package back to the store.", tell_partner=True)
    now = utcnow()
    back = DeliveryAssignment(order_id=a.order_id, sub_order_id=sub.id, delivery_boy_id=a.delivery_boy_id, mode="manual", kind="return", status="picked",
                              assigned_at=now, accepted_at=now, picked_at=now, status_at=now, picked_lat=a.picked_lat, picked_lng=a.picked_lng, created_at=now)
    session.add(back)
    await session.flush()


async def cancel_by_staff(session: AsyncSession, a: DeliveryAssignment, user: User, reason: str) -> None:
    """Staff take a request or trip off a partner (before pickup); the package goes back to the queue."""
    if a.status not in ("offered", "accepted", "at_store"):
        raise Conflict("The partner already has the package; mark the delivery failed or return it instead", "already_picked")
    await _end(session, a, "cancelled", f"Taken off by the delivery team: {reason}", user_id=user.id, actor="admin", tell_partner=True)
    sub = await session.get(SubOrder, a.sub_order_id)
    sub.fleet_alerted_at = None
    await session.flush()


# ============================================================================ alerts


async def stuck_check(session: AsyncSession) -> int:
    """Tells staff about trips that stay in one step too long, and packages nobody took."""
    from app.services.notify import notify_staff

    cfg = await delivery_settings.get(session)
    if not cfg["enabled"]:
        return 0
    limit = utcnow() - timedelta(minutes=cfg["stuck_minutes"])
    told = 0
    rows = (await session.execute(select(DeliveryAssignment, DeliveryBoy.name, SubOrder.number).join(DeliveryBoy, DeliveryBoy.id == DeliveryAssignment.delivery_boy_id)
                                  .join(SubOrder, SubOrder.id == DeliveryAssignment.sub_order_id)
                                  .where(DeliveryAssignment.status.in_(ON_TRIP), DeliveryAssignment.status_at < limit, DeliveryAssignment.stuck_alerted_at.is_(None)))).all()
    for a, name, number in rows:
        minutes = int((utcnow() - a.status_at).total_seconds() // 60)
        await notify_staff(session, "delivery", "staff_delivery_stuck", {"order_number": number, "status": STEP_LABEL.get(a.status, a.status), "minutes": minutes,
                                                                         "partner": name}, link="/admin/delivery")
        a.stuck_alerted_at = utcnow()
        told += 1
    waiting = list((await session.execute(select(SubOrder).where(SubOrder.shipping_provider == "fleet", SubOrder.status == "packed",
                                                                 SubOrder.ready_for_pickup_at < limit, SubOrder.fleet_alerted_at.is_(None)))).scalars())
    for sub in waiting:
        if await active_assignment(session, sub.id) is None:
            minutes = int((utcnow() - sub.ready_for_pickup_at).total_seconds() // 60)
            await _alert_unassigned(session, sub, f"It has waited {minutes} minutes for a delivery partner.")
            told += 1
    return told


# ============================================================================ earnings and payouts


def ist_day_start(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time(), IST)


def week_of(d: date) -> tuple[date, date]:
    start = d - timedelta(days=d.weekday())
    return start, start + timedelta(days=6)


async def earnings(session: AsyncSession, boy: DeliveryBoy) -> dict:
    today = datetime.now(IST).date()
    week_start, _ = week_of(today)
    month_start = today.replace(day=1)

    async def period(since: datetime | None) -> dict:
        stmt = select(func.count(), func.coalesce(func.sum(DeliveryAssignment.fee_paise), 0), func.coalesce(func.sum(DeliveryAssignment.tip_paise), 0),
                      func.coalesce(func.sum(DeliveryAssignment.cod_collected), 0)).where(
            DeliveryAssignment.delivery_boy_id == boy.id, DeliveryAssignment.status == "delivered")
        if since:
            stmt = stmt.where(DeliveryAssignment.delivered_at >= since)
        n, fee, tip, cod = (await session.execute(stmt)).one()
        return {"trips": int(n), "fees": int(fee), "tips": int(tip), "earned": int(fee) + int(tip), "cod_collected": int(cod)}

    days = []
    for k in range(6, -1, -1):
        d = today - timedelta(days=k)
        n, amount = (await session.execute(select(func.count(), func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0)).where(
            DeliveryAssignment.delivery_boy_id == boy.id, DeliveryAssignment.status == "delivered",
            DeliveryAssignment.delivered_at >= ist_day_start(d), DeliveryAssignment.delivered_at < ist_day_start(d + timedelta(days=1))))).one()
        days.append({"date": d.isoformat(), "trips": int(n), "earned": int(amount)})
    payouts = list((await session.execute(select(DeliveryPayout).where(DeliveryPayout.delivery_boy_id == boy.id).order_by(DeliveryPayout.period_start.desc()).limit(12))).scalars())
    deposits = list((await session.execute(select(DeliveryCashDeposit).where(DeliveryCashDeposit.delivery_boy_id == boy.id).order_by(DeliveryCashDeposit.created_at.desc()).limit(10))).scalars())
    unpaid = (await session.execute(select(func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0)).where(
        DeliveryAssignment.delivery_boy_id == boy.id, DeliveryAssignment.status == "delivered", DeliveryAssignment.payout_id.is_(None)))).scalar_one()
    cfg = await delivery_settings.get(session)
    return {
        "today": await period(ist_day_start(today)), "week": await period(ist_day_start(week_start)), "month": await period(ist_day_start(month_start)),
        "total": await period(None), "days": days, "cash_in_hand": await cash_in_hand(session, boy.id), "cash_limit": cfg["cod_limit_paise"],
        "unpaid": int(unpaid),
        "payouts": [{"id": str(p.id), "period_start": p.period_start.isoformat(), "period_end": p.period_end.isoformat(), "deliveries": p.deliveries, "amount": p.amount,
                     "cod_deducted": p.cod_deducted, "net_amount": p.net_amount, "status": p.status, "paid_at": p.paid_at.isoformat() if p.paid_at else None,
                     "reference": p.reference} for p in payouts],
        "deposits": [{"amount": d.amount, "method": d.method, "reference": d.reference, "at": d.created_at.isoformat()} for d in deposits],
    }


async def generate_payouts(session: AsyncSession, week_start: date) -> int:
    """Creates one payout per partner for the week (Monday to Sunday) with every delivered trip up to its end that is
    not yet in a payout. With "deduct cash" on, cash the partner still holds comes off the payout."""
    cfg = await delivery_settings.get(session)
    start, end = week_of(week_start)
    until = ist_day_start(end + timedelta(days=1))
    rows = (await session.execute(select(DeliveryAssignment.delivery_boy_id, func.count(), func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0))
                                  .where(DeliveryAssignment.status == "delivered", DeliveryAssignment.payout_id.is_(None), DeliveryAssignment.delivered_at < until)
                                  .group_by(DeliveryAssignment.delivery_boy_id))).all()
    made = 0
    now = utcnow()
    for boy_id, n, amount in rows:
        amount = int(amount)
        p = (await session.execute(select(DeliveryPayout).where(DeliveryPayout.delivery_boy_id == boy_id, DeliveryPayout.period_start == start))).scalar_one_or_none()
        if p is not None and p.status == "paid":
            continue  # already paid for this week; late trips go into the next week's payout
        deduct = 0
        if cfg["cod_deduct_from_payout"]:
            deduct = max(0, min(await cash_in_hand(session, boy_id), amount))
        if p is None:
            p = DeliveryPayout(delivery_boy_id=boy_id, period_start=start, period_end=end, deliveries=0, amount=0, cod_deducted=0, net_amount=0, status="pending",
                               reference="", created_at=now)
            session.add(p)
            await session.flush()
            made += 1
        p.deliveries += int(n)
        p.amount += amount
        p.cod_deducted += deduct
        p.net_amount = p.amount - p.cod_deducted
        if deduct:
            session.add(DeliveryCashDeposit(delivery_boy_id=boy_id, amount=deduct, method="payout", reference=f"Payout {start.isoformat()}",
                                            note="Cash in hand taken from the weekly payout", created_at=now))
        await session.execute(DeliveryAssignment.__table__.update().where(
            DeliveryAssignment.delivery_boy_id == boy_id, DeliveryAssignment.status == "delivered", DeliveryAssignment.payout_id.is_(None),
            DeliveryAssignment.delivered_at < until).values(payout_id=p.id))
    await session.flush()
    return made


# ============================================================================ views


def assignment_brief(a: DeliveryAssignment) -> dict:
    return {"id": str(a.id), "status": a.status, "status_label": STEP_LABEL.get(a.status, a.status), "kind": a.kind, "mode": a.mode,
            "assigned_at": a.assigned_at.isoformat(), "expires_at": a.expires_at.isoformat() if a.expires_at else None,
            "accepted_at": a.accepted_at.isoformat() if a.accepted_at else None, "at_store_at": a.at_store_at.isoformat() if a.at_store_at else None,
            "picked_at": a.picked_at.isoformat() if a.picked_at else None, "on_the_way_at": a.on_the_way_at.isoformat() if a.on_the_way_at else None,
            "reached_at": a.reached_at.isoformat() if a.reached_at else None, "delivered_at": a.delivered_at.isoformat() if a.delivered_at else None,
            "status_at": a.status_at.isoformat(), "reject_reason": a.reject_reason, "fail_reason": a.fail_reason, "cod_amount": a.cod_amount,
            "cod_collected": a.cod_collected, "cod_method": a.cod_method, "fee": a.fee_paise, "tip": a.tip_paise,
            "distance_km": float(a.distance_km) if a.distance_km is not None else None, "rating": a.rating, "rating_comment": a.rating_comment,
            "has_proof": bool(a.proof_photo)}


async def trip_view(session: AsyncSession, a: DeliveryAssignment, *, for_partner: bool = True) -> dict:
    """Everything a partner needs for one trip (and staff, for the queue and the live map)."""
    sub = await session.get(SubOrder, a.sub_order_id)
    order = await session.get(Order, a.order_id)
    place = await pickup_place(session, sub)
    st = order.ship_to or {}
    items = list((await session.execute(select(OrderItem.title, OrderItem.variant_label, OrderItem.qty, OrderItem.image_url).where(OrderItem.sub_order_id == sub.id))).all())
    cfg = await delivery_settings.get(session)
    boy = await session.get(DeliveryBoy, a.delivery_boy_id)
    show_customer = a.status not in ("offered",)  # partners see the customer's details once they accept
    out = {
        **assignment_brief(a), "order_number": sub.number, "order_id": str(order.id), "sub_order_id": str(sub.id), "payment": order.payment_method,
        "pickup": {"name": place["name"], "address": place["address"], "pincode": place["pincode"], "city": place["city"], "phone": place["phone"],
                   "lat": place["lat"], "lng": place["lng"]},
        "drop": {"name": st.get("full_name", "") if show_customer else "", "phone": st.get("phone", "") if show_customer else "",
                 "address": ", ".join(x for x in (st.get("line1", ""), st.get("line2", ""), st.get("landmark", "")) if x) if show_customer else "",
                 "city": st.get("city", ""), "pincode": st.get("pincode", ""), "lat": st.get("lat"), "lng": st.get("lng"),
                 "instructions": st.get("instructions", "") if show_customer else "", "no_bag": bool(st.get("no_bag"))},
        "items": [{"title": t, "variant": v, "qty": q, "image": img} for t, v, q, img in items],
        "fee_estimate": fee_for(cfg, None) + (order.tip_paise if await is_fee_carrier(session, sub) else 0),
        "needs": {"pickup_code": cfg["pickup_code_required"], "otp": cfg["delivery_otp_required"], "photo": cfg["proof_photo_required"]},
        "partner": {"id": str(boy.id), "name": boy.name, "phone": boy.phone, "photo": boy.photo, "vehicle": VEHICLE_LABELS.get(boy.vehicle_type, ""),
                    "vehicle_no": boy.vehicle_no, "lat": float(boy.lat) if boy.lat is not None else None, "lng": float(boy.lng) if boy.lng is not None else None,
                    "location_at": boy.location_at.isoformat() if boy.location_at else None},
    }
    if not for_partner:
        out["pickup_code"] = sub.pickup_code
    return out


async def customer_tracking(session: AsyncSession, order: Order) -> dict[str, dict]:
    """Per package delivered by the fleet: the partner, the steps, the OTP and the partner's live position."""
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == order.id, SubOrder.shipping_provider == "fleet"))).scalars())
    out: dict[str, dict] = {}
    for sub in subs:
        a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.sub_order_id == sub.id, DeliveryAssignment.kind == "delivery",
                                                                    DeliveryAssignment.status.in_((*ON_TRIP, "delivered", "failed")))
                                   .order_by(DeliveryAssignment.created_at.desc()).limit(1))).scalar_one_or_none()
        view: dict[str, Any] = {"ready_for_pickup_at": sub.ready_for_pickup_at.isoformat() if sub.ready_for_pickup_at else None, "assignment": None, "partner": None,
                                "otp": None, "location": None, "drop": {"lat": (order.ship_to or {}).get("lat"), "lng": (order.ship_to or {}).get("lng")}}
        if a is not None:
            boy = await session.get(DeliveryBoy, a.delivery_boy_id)
            view["assignment"] = {k: v for k, v in assignment_brief(a).items() if k not in ("fee", "tip", "cod_collected", "cod_method", "reject_reason")}
            view["partner"] = {"name": boy.name, "photo": boy.photo, "phone": boy.phone, "vehicle": VEHICLE_LABELS.get(boy.vehicle_type, ""), "vehicle_no": boy.vehicle_no,
                               "rating_avg": round(float(boy.rating_avg or 0), 1), "rating_count": boy.rating_count}
            if a.status in ("picked", "on_the_way", "reached"):
                view["otp"] = sub.delivery_otp
                if boy.lat is not None and boy.location_at and utcnow() - boy.location_at < timedelta(minutes=15):
                    view["location"] = {"lat": float(boy.lat), "lng": float(boy.lng), "at": boy.location_at.isoformat()}
            view["can_rate"] = a.status == "delivered" and a.rating is None
        out[str(sub.id)] = view
    return out
