"""Admin → Delivery: partners and their KYC, delivery zones, settings (and, in later steps, the queue, live map,
payouts, reports, ratings and complaints). Every endpoint needs the "Delivery fleet" permission."""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select

from app.config import settings
from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import Perm
from app.core.security import decrypt_field
from app.core.validators import normalize_mobile
from app.db import utcnow
from app.models import (
    DeliveryAssignment,
    DeliveryBoy,
    DeliveryCashDeposit,
    DeliveryComplaint,
    DeliveryPayout,
    DeliveryZone,
    Order,
    OrderStatusLog,
    SubOrder,
    User,
)
from app.models.delivery import ACTIVE, ON_TRIP
from app.routers.delivery import ProfileIn, _apply, doc_response
from app.services import delivery_settings, storage
from app.services import fleet as svc
from app.services.notify import notify

router = APIRouter(prefix="/api/admin/delivery", tags=["delivery-admin"])
Staff = Perm("delivery")
_PIN = re.compile(r"^[1-9]\d{5}$")


async def _partner(session, partner_id: uuid.UUID) -> DeliveryBoy:
    b = await session.get(DeliveryBoy, partner_id)
    if b is None:
        raise NotFound("Delivery partner")
    return b


async def _out(session, b: DeliveryBoy) -> dict:
    return svc.partner_out(b, await svc.zone_of(session, b), await delivery_settings.get(session), admin=True)


# ============================================================================ overview


@router.get("/overview")
async def overview(admin: Staff, session: SessionDep) -> dict:
    if await svc.sweep(session):
        await session.commit()
    counts = dict((await session.execute(select(DeliveryBoy.kyc_status, func.count()).group_by(DeliveryBoy.kyc_status))).all())
    online = (await session.execute(select(func.count()).select_from(DeliveryBoy).where(
        DeliveryBoy.is_online.is_(True), DeliveryBoy.is_active.is_(True), DeliveryBoy.kyc_status == "approved"))).scalar_one()
    zones = (await session.execute(select(func.count()).select_from(DeliveryZone).where(DeliveryZone.is_active.is_(True)))).scalar_one()
    cfg = await delivery_settings.get(session)
    trips = dict((await session.execute(select(DeliveryAssignment.status, func.count()).where(DeliveryAssignment.status.in_(ACTIVE))
                                        .group_by(DeliveryAssignment.status))).all())
    day = svc.ist_day_start(datetime.now(svc.IST).date())
    delivered_today = (await session.execute(select(func.count()).select_from(DeliveryAssignment).where(
        DeliveryAssignment.status == "delivered", DeliveryAssignment.kind == "delivery", DeliveryAssignment.delivered_at >= day))).scalar_one()
    failed_today = (await session.execute(select(func.count()).select_from(DeliveryAssignment).where(
        DeliveryAssignment.status == "failed", DeliveryAssignment.ended_at >= day))).scalar_one()
    stuck_limit = utcnow() - timedelta(minutes=cfg["stuck_minutes"])
    stuck = (await session.execute(select(func.count()).select_from(DeliveryAssignment).where(
        DeliveryAssignment.status.in_(ON_TRIP), DeliveryAssignment.status_at < stuck_limit))).scalar_one()
    return {"partners": counts, "online": online, "zones": zones, "fleet_mode": cfg["fleet_mode"], "auto_assign": cfg["auto_assign"], "enabled": cfg["enabled"],
            "queue": len(await _waiting(session)), "offered": int(trips.get("offered", 0)), "on_trip": sum(int(trips.get(s, 0)) for s in ON_TRIP),
            "delivered_today": delivered_today, "failed_today": failed_today, "stuck": stuck, "stuck_minutes": cfg["stuck_minutes"]}


# ============================================================================ queue and assignment


async def _waiting(session) -> list[SubOrder]:
    """Packages ready for pickup with no live request or trip."""
    live = select(DeliveryAssignment.sub_order_id).where(DeliveryAssignment.status.in_(ACTIVE))
    return list((await session.execute(select(SubOrder).where(SubOrder.shipping_provider == "fleet", SubOrder.status == "packed",
                                                              SubOrder.ready_for_pickup_at.is_not(None), SubOrder.id.not_in(live))
                                       .order_by(SubOrder.ready_for_pickup_at))).scalars())


async def _failed(session) -> list[DeliveryAssignment]:
    """Failed attempts whose package is still out (no new trip yet)."""
    live = select(DeliveryAssignment.sub_order_id).where(DeliveryAssignment.status.in_(ACTIVE))
    rows = list((await session.execute(select(DeliveryAssignment).join(SubOrder, SubOrder.id == DeliveryAssignment.sub_order_id).where(
        DeliveryAssignment.status == "failed", SubOrder.status == "shipped", DeliveryAssignment.sub_order_id.not_in(live))
        .order_by(DeliveryAssignment.ended_at.desc()))).scalars())
    seen, out = set(), []
    for a in rows:  # only the latest failure per package
        if a.sub_order_id not in seen:
            seen.add(a.sub_order_id)
            out.append(a)
    return out


async def _package(session, sub: SubOrder) -> dict:
    order = await session.get(Order, sub.order_id)
    place = await svc.pickup_place(session, sub)
    st = order.ship_to or {}
    zone = await session.get(DeliveryZone, sub.delivery_zone_id) if sub.delivery_zone_id else None
    tries = (await session.execute(select(DeliveryAssignment.status, DeliveryAssignment.reject_reason, DeliveryBoy.name).join(
        DeliveryBoy, DeliveryBoy.id == DeliveryAssignment.delivery_boy_id).where(DeliveryAssignment.sub_order_id == sub.id)
        .order_by(DeliveryAssignment.created_at))).all()
    from app.services.orders import collect_amount

    return {"sub_order_id": str(sub.id), "order_id": str(order.id), "order_number": sub.number, "status": sub.status,
            "ready_since": sub.ready_for_pickup_at.isoformat() if sub.ready_for_pickup_at else None,
            "pickup": {"name": place["name"], "address": place["address"], "city": place["city"], "pincode": place["pincode"], "phone": place["phone"],
                       "lat": place["lat"], "lng": place["lng"]},
            "drop": {"name": st.get("full_name", ""), "city": st.get("city", ""), "pincode": st.get("pincode", ""), "lat": st.get("lat"), "lng": st.get("lng")},
            "zone": {"id": str(zone.id), "name": zone.name} if zone else None, "payment": order.payment_method,
            "cod_amount": await collect_amount(session, sub, order), "pickup_code": sub.pickup_code,
            "tries": [{"status": s, "reason": r, "partner": n} for s, r, n in tries]}


@router.get("/queue")
async def queue(admin: Staff, session: SessionDep, tab: Literal["waiting", "offered", "failed"] = "waiting") -> dict:
    if await svc.sweep(session):
        await session.commit()
    waiting = await _waiting(session)
    failed = await _failed(session)
    offered = list((await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.status == "offered").order_by(DeliveryAssignment.expires_at))).scalars())
    if tab == "waiting":
        items = [await _package(session, s) for s in waiting]
    elif tab == "offered":
        items = []
        for a in offered:
            item = await _package(session, await session.get(SubOrder, a.sub_order_id))
            boy = await session.get(DeliveryBoy, a.delivery_boy_id)
            item["assignment"] = {**svc.assignment_brief(a), "partner": boy.name, "partner_phone": boy.phone,
                                  "seconds_left": max(0, int((a.expires_at - utcnow()).total_seconds())) if a.expires_at else None}
            items.append(item)
    else:
        items = []
        for a in failed:
            item = await _package(session, await session.get(SubOrder, a.sub_order_id))
            boy = await session.get(DeliveryBoy, a.delivery_boy_id)
            item["assignment"] = {**svc.assignment_brief(a), "partner": boy.name, "partner_phone": boy.phone}
            items.append(item)
    return {"items": items, "counts": {"waiting": len(waiting), "offered": len(offered), "failed": len(failed)}}


@router.get("/packages/{sub_id}/candidates")
async def package_candidates(sub_id: uuid.UUID, admin: Staff, session: SessionDep) -> list[dict]:
    sub = await session.get(SubOrder, sub_id)
    if sub is None or sub.shipping_provider != "fleet":
        raise NotFound("Package")
    cfg = await delivery_settings.get(session)
    zones = {z.id: z.name for z in (await session.execute(select(DeliveryZone))).scalars()}
    out = []
    for c in await svc.candidates(session, sub, cfg, online_only=False):
        b = c["boy"]
        out.append({"id": str(b.id), "name": b.name, "phone": b.phone, "photo": b.photo, "vehicle": svc.VEHICLE_LABELS.get(b.vehicle_type, ""),
                    "zone": zones.get(b.zone_id, ""), "online": b.is_online, "distance_km": c["distance_km"], "load": c["load"], "cash": c["cash"],
                    "location_fresh": c["fresh"], "ok": c["ok"], "reasons": c["reasons"], "rating_avg": round(float(b.rating_avg or 0), 1)})
    return out


class AssignIn(BaseModel):
    sub_order_id: uuid.UUID
    partner_id: uuid.UUID
    direct: bool = False  # assign without asking (the partner agreed by phone)
    force: bool = False   # even if busy, over the cash limit, offline or from another zone


@router.post("/assign")
async def assign(body: AssignIn, admin: Staff, session: SessionDep) -> dict:
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == body.sub_order_id).with_for_update())).scalar_one_or_none()
    if sub is None or sub.shipping_provider != "fleet" or sub.status != "packed":
        raise Conflict("Only packages ready for pickup can be assigned", "not_ready")
    boy = await _partner(session, body.partner_id)
    if boy.kyc_status != "approved" or not boy.is_active:
        raise ApiError("This partner is not approved or is switched off", "partner_unavailable")
    cfg = await delivery_settings.get(session)
    match = next((c for c in await svc.candidates(session, sub, cfg, online_only=False) if c["boy"].id == boy.id), None)
    reasons = [r for r in (match["reasons"] if match else []) if r != "already asked"]
    if reasons and not body.force:
        raise Conflict(f"{boy.name}: {', '.join(reasons)}. Assign anyway to override.", "partner_not_free")
    a = await svc.offer(session, sub, boy, mode="manual", by=admin, direct=body.direct, cfg=cfg)
    audit(session, admin, "delivery.assign", "sub_order", sub.id, f"{boy.name}{' (direct)' if body.direct else ''}")
    await session.commit()
    return svc.assignment_brief(a)


@router.post("/packages/{sub_id}/auto-assign")
async def run_auto(sub_id: uuid.UUID, admin: Staff, session: SessionDep) -> dict:
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == sub_id).with_for_update())).scalar_one_or_none()
    if sub is None or sub.shipping_provider != "fleet":
        raise NotFound("Package")
    cfg = {**(await delivery_settings.get(session)), "auto_assign": True}
    sub.fleet_alerted_at = None
    a = await svc.auto_assign(session, sub, cfg=cfg)
    await session.commit()
    if a is None:
        raise Conflict("No free partner can take it right now", "no_partner")
    return svc.assignment_brief(a)


class ReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


@router.post("/assignments/{assignment_id}/cancel")
async def cancel_assignment(assignment_id: uuid.UUID, body: ReasonIn, admin: Staff, session: SessionDep) -> dict:
    a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.id == assignment_id).with_for_update())).scalar_one_or_none()
    if a is None:
        raise NotFound("Delivery")
    await svc.cancel_by_staff(session, a, admin, body.reason)
    audit(session, admin, "delivery.unassign", "delivery_assignment", a.id, body.reason[:200])
    await session.commit()
    return {"ok": True}


class ResolveIn(BaseModel):
    action: Literal["retry", "return"]


@router.post("/assignments/{assignment_id}/resolve")
async def resolve(assignment_id: uuid.UUID, body: ResolveIn, admin: Staff, session: SessionDep) -> dict:
    a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.id == assignment_id).with_for_update())).scalar_one_or_none()
    if a is None:
        raise NotFound("Delivery")
    new = await svc.resolve_failed(session, a, admin, body.action)
    audit(session, admin, f"delivery.{body.action}", "delivery_assignment", a.id)
    await session.commit()
    return svc.assignment_brief(new)


@router.post("/packages/{sub_id}/courier")
async def to_courier(sub_id: uuid.UUID, admin: Staff, session: SessionDep) -> dict:
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == sub_id).with_for_update())).scalar_one_or_none()
    if sub is None or sub.shipping_provider != "fleet":
        raise NotFound("Package")
    await svc.use_courier(session, sub, admin, actor="admin")
    audit(session, admin, "delivery.to_courier", "sub_order", sub.id)
    await session.commit()
    return {"ok": True}


# ============================================================================ live view and trips


@router.get("/live")
async def live(admin: Staff, session: SessionDep) -> dict:
    """Partners online right now (and anyone on a trip) with where they are, what they carry, today's work and cash in
    hand; trips in progress with their pickup and drop points; for the live map and the online list."""
    if await svc.sweep(session):
        await session.commit()
    now = utcnow()
    cfg = await delivery_settings.get(session)
    on_trip_ids = set((await session.execute(select(DeliveryAssignment.delivery_boy_id).where(DeliveryAssignment.status.in_(ACTIVE)))).scalars())
    boys = list((await session.execute(select(DeliveryBoy).where(DeliveryBoy.kyc_status == "approved", DeliveryBoy.is_active.is_(True),
                                                                 or_(DeliveryBoy.is_online.is_(True), DeliveryBoy.id.in_(on_trip_ids or {uuid.uuid4()}))))).scalars())
    ids = [b.id for b in boys]
    cash, load = await svc.cash_by_partner(session, ids), await svc.loads(session, ids)
    day = svc.ist_day_start(datetime.now(svc.IST).date())
    today = {bid: (int(n), int(e)) for bid, n, e in (await session.execute(select(DeliveryAssignment.delivery_boy_id, func.count(),
                                                                                    func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0))
                                                                             .where(DeliveryAssignment.delivery_boy_id.in_(ids or [uuid.uuid4()]), DeliveryAssignment.status == "delivered",
                                                                                    DeliveryAssignment.delivered_at >= day).group_by(DeliveryAssignment.delivery_boy_id))).all()}
    zones = {z.id: z for z in (await session.execute(select(DeliveryZone))).scalars()}
    trips = list((await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.status.in_(ACTIVE)).order_by(DeliveryAssignment.status_at))).scalars())
    stuck_limit = now - timedelta(minutes=cfg["stuck_minutes"])
    trip_views = []
    for a in trips:
        v = await svc.trip_view(session, a, for_partner=False)
        v["minutes_in_step"] = int((now - a.status_at).total_seconds() // 60)
        v["stuck"] = a.status in ON_TRIP and a.status_at < stuck_limit
        trip_views.append(v)
    partners = []
    for b in boys:
        current = [t for t in trip_views if t["partner"]["id"] == str(b.id)]
        age = int((now - b.location_at).total_seconds()) if b.location_at else None
        partners.append({
            "id": str(b.id), "name": b.name, "phone": b.phone, "photo": b.photo, "vehicle": svc.VEHICLE_LABELS.get(b.vehicle_type, ""), "vehicle_no": b.vehicle_no,
            "zone": {"id": str(b.zone_id), "name": zones[b.zone_id].name, "city": zones[b.zone_id].city} if b.zone_id in zones else None,
            "online": b.is_online, "online_since": b.online_since.isoformat() if b.online_since and b.is_online else None,
            "online_minutes": int((now - b.online_since).total_seconds() // 60) if b.online_since and b.is_online else None,
            "lat": float(b.lat) if b.lat is not None else None, "lng": float(b.lng) if b.lng is not None else None,
            "location_age_seconds": age, "location_state": "live" if age is not None and age <= 120 else "stale" if age is not None and age <= 900 else "unknown",
            "load": load.get(b.id, 0), "max_active": cfg["max_active"], "state": "on_trip" if current else "free",
            "trips": [{"id": t["id"], "order_number": t["order_number"], "status": t["status"], "status_label": t["status_label"], "stuck": t["stuck"]} for t in current],
            "today_trips": today.get(b.id, (0, 0))[0], "today_earned": today.get(b.id, (0, 0))[1], "cash_in_hand": cash.get(b.id, 0),
            "cash_limit": cfg["cod_limit_paise"], "rating_avg": round(float(b.rating_avg or 0), 1), "rating_count": b.rating_count,
        })
    partners.sort(key=lambda p: (not p["online"], p["state"] != "free", p["name"]))
    by_zone: dict[str, dict] = {}
    for p in partners:
        key = p["zone"]["name"] if p["zone"] else "No zone"
        z = by_zone.setdefault(key, {"zone": key, "online": 0, "free": 0, "on_trip": 0})
        z["online"] += 1 if p["online"] else 0
        z["free"] += 1 if p["online"] and p["state"] == "free" else 0
        z["on_trip"] += 1 if p["state"] == "on_trip" else 0
    return {"partners": partners, "trips": trip_views, "zones": [{"id": str(z.id), "name": z.name, "city": z.city, "lat": float(z.center_lat) if z.center_lat is not None else None,
                                                                  "lng": float(z.center_lng) if z.center_lng is not None else None} for z in zones.values() if z.is_active],
            "summary": {"online": sum(1 for p in partners if p["online"]), "free": sum(1 for p in partners if p["online"] and p["state"] == "free"),
                        "on_trip": sum(1 for p in partners if p["state"] == "on_trip"), "stuck": sum(1 for t in trip_views if t["stuck"]),
                        "waiting": len(await _waiting(session)), "cash_in_hand": sum(p["cash_in_hand"] for p in partners)},
            "by_zone": sorted(by_zone.values(), key=lambda z: z["zone"]), "map_tiles": cfg["map_tiles"], "map_attribution": cfg["map_attribution"],
            "server_time": now.isoformat()}


@router.get("/trips")
async def trips(admin: Staff, session: SessionDep, status: str = Query(default="", max_length=12), q: str = Query(default="", max_length=60),
                partner_id: uuid.UUID | None = None, page: int = Query(default=1, ge=1)) -> dict:
    stmt = select(DeliveryAssignment).join(SubOrder, SubOrder.id == DeliveryAssignment.sub_order_id).join(DeliveryBoy, DeliveryBoy.id == DeliveryAssignment.delivery_boy_id)
    if status == "active":
        stmt = stmt.where(DeliveryAssignment.status.in_(ACTIVE))
    elif status:
        stmt = stmt.where(DeliveryAssignment.status == status)
    if partner_id:
        stmt = stmt.where(DeliveryAssignment.delivery_boy_id == partner_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(SubOrder.number.ilike(like), DeliveryBoy.name.ilike(like), DeliveryBoy.phone.ilike(like)))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await session.execute(stmt.order_by(DeliveryAssignment.assigned_at.desc()).offset((page - 1) * 30).limit(30))).scalars())
    return {"items": [await svc.trip_view(session, a, for_partner=False) for a in rows], "total": total, "page": page, "page_size": 30}


@router.get("/trips/{assignment_id}")
async def trip_detail(assignment_id: uuid.UUID, admin: Staff, session: SessionDep) -> dict:
    a = await session.get(DeliveryAssignment, assignment_id)
    if a is None:
        raise NotFound("Delivery")
    v = await svc.trip_view(session, a, for_partner=False)
    logs = (await session.execute(select(OrderStatusLog).where(OrderStatusLog.sub_order_id == a.sub_order_id).order_by(OrderStatusLog.created_at))).scalars()
    v["log"] = [{"status": x.status, "actor": x.actor, "note": x.note, "lat": float(x.lat) if x.lat is not None else None,
                 "lng": float(x.lng) if x.lng is not None else None, "at": x.created_at.isoformat()} for x in logs]
    return v


@router.get("/trips/{assignment_id}/proof")
async def trip_proof(assignment_id: uuid.UUID, admin: Staff, session: SessionDep) -> Response:
    from app.routers.delivery import proof_response

    a = await session.get(DeliveryAssignment, assignment_id)
    if a is None:
        raise NotFound("Delivery")
    return await proof_response(a)


# ============================================================================ cash and payouts


@router.get("/cash")
async def cash(admin: Staff, session: SessionDep) -> dict:
    boys = list((await session.execute(select(DeliveryBoy).where(DeliveryBoy.kyc_status == "approved"))).scalars())
    held = await svc.cash_by_partner(session, [b.id for b in boys])
    cfg = await delivery_settings.get(session)
    rows = [{"id": str(b.id), "name": b.name, "phone": b.phone, "photo": b.photo, "cash_in_hand": held[b.id], "over_limit": held[b.id] > cfg["cod_limit_paise"]}
            for b in boys if held[b.id] > 0]
    rows.sort(key=lambda r: -r["cash_in_hand"])
    recent = (await session.execute(select(DeliveryCashDeposit, DeliveryBoy.name).join(DeliveryBoy, DeliveryBoy.id == DeliveryCashDeposit.delivery_boy_id)
                                    .order_by(DeliveryCashDeposit.created_at.desc()).limit(30))).all()
    return {"partners": rows, "total": sum(r["cash_in_hand"] for r in rows), "limit": cfg["cod_limit_paise"],
            "recent": [{"partner": n, "amount": d.amount, "method": d.method, "reference": d.reference, "note": d.note, "at": d.created_at.isoformat()} for d, n in recent]}


class DepositIn(BaseModel):
    amount_paise: int = Field(gt=0, le=100_000_000)
    method: Literal["cash", "upi", "bank"] = "cash"
    reference: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=300)


@router.post("/partners/{partner_id}/deposits")
async def add_deposit(partner_id: uuid.UUID, body: DepositIn, admin: Staff, session: SessionDep) -> dict:
    b = await _partner(session, partner_id)
    held = await svc.cash_in_hand(session, b.id)
    if body.amount_paise > held:
        raise ApiError(f"{b.name} holds {svc.rupees(held)}; the deposit cannot be more", "deposit_too_big")
    session.add(DeliveryCashDeposit(delivery_boy_id=b.id, amount=body.amount_paise, method=body.method, reference=body.reference.strip(),
                                    note=body.note.strip(), recorded_by=admin.id, created_at=utcnow()))
    audit(session, admin, "delivery.cash_deposit", "delivery_boy", b.id, f"{body.amount_paise} {body.method}")
    await session.commit()
    return {"cash_in_hand": await svc.cash_in_hand(session, b.id)}


@router.get("/payouts")
async def payouts(admin: Staff, session: SessionDep, status: Literal["", "pending", "paid"] = "", page: int = Query(default=1, ge=1)) -> dict:
    stmt = select(DeliveryPayout, DeliveryBoy).join(DeliveryBoy, DeliveryBoy.id == DeliveryPayout.delivery_boy_id)
    if status:
        stmt = stmt.where(DeliveryPayout.status == status)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(DeliveryPayout.period_start.desc(), DeliveryBoy.name).offset((page - 1) * 50).limit(50))).all()
    pending = (await session.execute(select(func.coalesce(func.sum(DeliveryPayout.net_amount), 0)).where(DeliveryPayout.status == "pending"))).scalar_one()
    unbilled = (await session.execute(select(func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0)).where(
        DeliveryAssignment.status == "delivered", DeliveryAssignment.payout_id.is_(None)))).scalar_one()
    return {"items": [{"id": str(p.id), "partner": {"id": str(b.id), "name": b.name, "phone": b.phone, "bank": {k: v for k, v in (b.bank_details or {}).items() if k != "account_enc"}},
                       "period_start": p.period_start.isoformat(), "period_end": p.period_end.isoformat(), "deliveries": p.deliveries, "amount": p.amount,
                       "cod_deducted": p.cod_deducted, "net_amount": p.net_amount, "status": p.status, "paid_at": p.paid_at.isoformat() if p.paid_at else None,
                       "reference": p.reference} for p, b in rows],
            "total": total, "page": page, "page_size": 50, "pending_total": int(pending), "not_in_payout": int(unbilled)}


class GenerateIn(BaseModel):
    week_start: date | None = None  # any day in the week; empty = last week


@router.post("/payouts/generate")
async def generate(body: GenerateIn, admin: Perm("payouts"), session: SessionDep) -> dict:
    day = body.week_start or (datetime.now(svc.IST).date() - timedelta(days=7))
    made = await svc.generate_payouts(session, day)
    audit(session, admin, "delivery.payouts_generate", "delivery_payout", day.isoformat(), str(made))
    await session.commit()
    return {"created": made, "week_start": svc.week_of(day)[0].isoformat()}


class PaidIn(BaseModel):
    reference: str = Field(min_length=3, max_length=60)


@router.post("/payouts/{payout_id}/paid")
async def mark_paid(payout_id: uuid.UUID, body: PaidIn, admin: Perm("payouts"), session: SessionDep) -> dict:
    p = (await session.execute(select(DeliveryPayout).where(DeliveryPayout.id == payout_id).with_for_update())).scalar_one_or_none()
    if p is None:
        raise NotFound("Payout")
    if p.status == "paid":
        raise Conflict("Already marked paid", "already_paid")
    p.status, p.paid_at, p.paid_by, p.reference = "paid", utcnow(), admin.id, body.reference.strip()
    b = await session.get(DeliveryBoy, p.delivery_boy_id)
    audit(session, admin, "delivery.payout_paid", "delivery_payout", p.id, body.reference[:60])
    await notify(session, "delivery_payout_paid", await session.get(User, b.user_id), {"amount": svc.rupees(p.net_amount),
                 "period": f"{p.period_start:%d %b} to {p.period_end:%d %b}", "reference": p.reference}, link="/delivery/earnings")
    await session.commit()
    return {"ok": True, "status": p.status}


# ============================================================================ reports and feedback


@router.get("/reports")
async def reports(admin: Staff, session: SessionDep, days: int = Query(default=30, ge=7, le=180)) -> dict:
    since_day = datetime.now(svc.IST).date() - timedelta(days=days - 1)
    since = svc.ist_day_start(since_day)
    day_col = func.date(func.timezone("Asia/Kolkata", func.coalesce(DeliveryAssignment.delivered_at, DeliveryAssignment.ended_at)))
    rows = (await session.execute(select(day_col, DeliveryAssignment.status, func.count(), func.coalesce(func.sum(DeliveryAssignment.cod_collected), 0))
                                  .where(DeliveryAssignment.kind == "delivery", DeliveryAssignment.status.in_(("delivered", "failed")),
                                         func.coalesce(DeliveryAssignment.delivered_at, DeliveryAssignment.ended_at) >= since)
                                  .group_by(day_col, DeliveryAssignment.status))).all()
    per_day: dict[str, dict] = {}
    for k in range(days):
        d = (since_day + timedelta(days=k)).isoformat()
        per_day[d] = {"date": d, "delivered": 0, "failed": 0, "cod": 0}
    for d, st, n, cod in rows:
        rec = per_day.setdefault(d.isoformat(), {"date": d.isoformat(), "delivered": 0, "failed": 0, "cod": 0})
        rec[st] = int(n)
        rec["cod"] += int(cod)
    delivered = sum(r["delivered"] for r in per_day.values())
    failed = sum(r["failed"] for r in per_day.values())
    mins = func.extract("epoch", DeliveryAssignment.delivered_at - DeliveryAssignment.accepted_at) / 60
    perf = (await session.execute(select(DeliveryBoy.id, DeliveryBoy.name, DeliveryBoy.rating_avg, DeliveryBoy.rating_count,
                                         func.count().filter(DeliveryAssignment.status == "delivered"), func.count().filter(DeliveryAssignment.status == "failed"),
                                         func.count().filter(DeliveryAssignment.status.in_(("rejected", "expired"))),
                                         func.coalesce(func.sum(DeliveryAssignment.fee_paise + DeliveryAssignment.tip_paise), 0),
                                         func.coalesce(func.sum(DeliveryAssignment.cod_collected), 0), func.avg(mins).filter(DeliveryAssignment.status == "delivered"))
                                  .join(DeliveryBoy, DeliveryBoy.id == DeliveryAssignment.delivery_boy_id)
                                  .where(DeliveryAssignment.assigned_at >= since).group_by(DeliveryBoy.id, DeliveryBoy.name, DeliveryBoy.rating_avg, DeliveryBoy.rating_count))).all()
    return {"days": list(per_day.values()), "delivered": delivered, "failed": failed,
            "success_rate": round(100 * delivered / (delivered + failed), 1) if delivered + failed else None,
            "cod_collected": sum(r["cod"] for r in per_day.values()),
            "partners": sorted([{"id": str(i), "name": n, "rating_avg": round(float(r or 0), 1), "rating_count": rc, "delivered": int(dl), "failed": int(fl),
                                 "declined": int(dc), "earned": int(e), "cod": int(c), "avg_minutes": round(float(m), 1) if m is not None else None,
                                 "success_rate": round(100 * int(dl) / (int(dl) + int(fl)), 1) if int(dl) + int(fl) else None}
                                for i, n, r, rc, dl, fl, dc, e, c, m in perf], key=lambda x: -x["delivered"])}


@router.get("/feedback")
async def feedback(admin: Staff, session: SessionDep, kind: Literal["ratings", "complaints"] = "complaints", status: Literal["", "open", "resolved"] = "open",
                   page: int = Query(default=1, ge=1)) -> dict:
    if kind == "ratings":
        stmt = select(DeliveryAssignment, DeliveryBoy.name, SubOrder.number).join(DeliveryBoy, DeliveryBoy.id == DeliveryAssignment.delivery_boy_id).join(
            SubOrder, SubOrder.id == DeliveryAssignment.sub_order_id).where(DeliveryAssignment.rating.is_not(None))
        total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
        rows = (await session.execute(stmt.order_by(DeliveryAssignment.rated_at.desc()).offset((page - 1) * 30).limit(30))).all()
        return {"items": [{"assignment_id": str(a.id), "partner": n, "order_number": num, "rating": a.rating, "comment": a.rating_comment,
                           "at": a.rated_at.isoformat() if a.rated_at else None} for a, n, num in rows], "total": total, "page": page, "page_size": 30}
    stmt = select(DeliveryComplaint, DeliveryBoy.name, SubOrder.number).join(DeliveryBoy, DeliveryBoy.id == DeliveryComplaint.delivery_boy_id).join(
        DeliveryAssignment, DeliveryAssignment.id == DeliveryComplaint.assignment_id).join(SubOrder, SubOrder.id == DeliveryAssignment.sub_order_id)
    if status:
        stmt = stmt.where(DeliveryComplaint.status == status)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(DeliveryComplaint.created_at.desc()).offset((page - 1) * 30).limit(30))).all()
    open_count = (await session.execute(select(func.count()).select_from(DeliveryComplaint).where(DeliveryComplaint.status == "open"))).scalar_one()
    return {"items": [{"id": str(c.id), "assignment_id": str(c.assignment_id), "partner": n, "order_number": num, "category": c.category,
                       "category_label": delivery_settings.COMPLAINTS.get(c.category, c.category), "text": c.text, "status": c.status, "admin_note": c.admin_note,
                       "at": c.created_at.isoformat()} for c, n, num in rows], "total": total, "page": page, "page_size": 30, "open": open_count}


class ResolveComplaintIn(BaseModel):
    note: str = Field(min_length=3, max_length=500)


@router.post("/complaints/{complaint_id}/resolve")
async def resolve_complaint(complaint_id: uuid.UUID, body: ResolveComplaintIn, admin: Staff, session: SessionDep) -> dict:
    c = await session.get(DeliveryComplaint, complaint_id)
    if c is None:
        raise NotFound("Complaint")
    c.status, c.admin_note, c.resolved_at = "resolved", body.note.strip(), utcnow()
    audit(session, admin, "delivery.complaint_resolve", "delivery_complaint", c.id, body.note[:200])
    await session.commit()
    return {"ok": True}


# ============================================================================ partners


@router.get("/partners")
async def partners(admin: Staff, session: SessionDep, status: str = Query(default="", max_length=12), q: str = Query(default="", max_length=80),
                   zone_id: uuid.UUID | None = None, online: bool | None = None, page: int = Query(default=1, ge=1)) -> dict:
    stmt = select(DeliveryBoy)
    if status == "inactive":
        stmt = stmt.where(DeliveryBoy.is_active.is_(False))
    elif status in ("draft", "submitted", "approved", "rejected"):
        stmt = stmt.where(DeliveryBoy.kyc_status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(DeliveryBoy.name.ilike(like), DeliveryBoy.phone.ilike(like), DeliveryBoy.vehicle_no.ilike(like)))
    if zone_id:
        stmt = stmt.where(DeliveryBoy.zone_id == zone_id)
    if online is not None:
        stmt = stmt.where(DeliveryBoy.is_online.is_(online))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    waiting_first = case((DeliveryBoy.kyc_status == "submitted", 0), else_=1)
    rows = list((await session.execute(stmt.order_by(waiting_first, DeliveryBoy.created_at.desc()).offset((page - 1) * 30).limit(30))).scalars())
    zones = {z.id: z for z in (await session.execute(select(DeliveryZone))).scalars()}
    cfg = await delivery_settings.get(session)
    counts = dict((await session.execute(select(DeliveryBoy.kyc_status, func.count()).group_by(DeliveryBoy.kyc_status))).all())
    counts["inactive"] = (await session.execute(select(func.count()).select_from(DeliveryBoy).where(DeliveryBoy.is_active.is_(False)))).scalar_one()
    return {"items": [svc.partner_out(b, zones.get(b.zone_id), cfg, admin=True) for b in rows], "total": total, "page": page, "page_size": 30, "counts": counts}


class NewPartnerIn(ProfileIn):
    phone: str = Field(min_length=10, max_length=15)
    name: str = Field(min_length=2, max_length=120)


@router.post("/partners", status_code=201)
async def add_partner(body: NewPartnerIn, admin: Staff, session: SessionDep) -> dict:
    """Staff add a partner by mobile number (for walk-in hiring); the partner signs in with that number to finish."""
    try:
        phone = normalize_mobile(body.phone)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_phone", fields={"phone": "Invalid"}) from exc
    user = (await session.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    if user is None:
        user = User(phone=phone, name=body.name.strip())
        session.add(user)
        await session.flush()
    elif user.is_admin:
        raise ApiError("This number belongs to a staff account", "staff_account")
    if await svc.partner_for_user(session, user.id):
        raise Conflict("This number is already a delivery partner", "already_registered")
    b = DeliveryBoy(user_id=user.id, name=body.name.strip(), phone=phone, kyc_status="draft", bank_details={})
    await _apply(session, b, body)
    session.add(b)
    await session.flush()
    audit(session, admin, "delivery.partner_add", "delivery_boy", b.id, phone)
    await session.commit()
    return await _out(session, b)


@router.get("/partners/{partner_id}")
async def partner(partner_id: uuid.UUID, admin: Staff, session: SessionDep) -> dict:
    b = await _partner(session, partner_id)
    out = await _out(session, b)
    # The verification team compares the number with the document photo (Aadhaar numbers are never stored).
    out["id_proof_no"] = decrypt_field(b.id_proof_enc) if b.id_proof_enc else ""
    user = await session.get(User, b.user_id)
    out["account"] = {"name": user.name if user else "", "last_login_at": user.last_login_at.isoformat() if user and user.last_login_at else None}
    return out


@router.put("/partners/{partner_id}")
async def edit_partner(partner_id: uuid.UUID, body: ProfileIn, admin: Staff, session: SessionDep) -> dict:
    b = await _partner(session, partner_id)
    await _apply(session, b, body)
    audit(session, admin, "delivery.partner_edit", "delivery_boy", b.id, ",".join(k for k, v in body.model_dump().items() if v is not None)[:200])
    await session.commit()
    return await _out(session, b)


@router.get("/partners/{partner_id}/docs/{kind}")
async def partner_doc(partner_id: uuid.UUID, kind: str, admin: Staff, session: SessionDep) -> Response:
    b = await _partner(session, partner_id)
    audit(session, admin, "delivery.kyc_view", "delivery_boy", b.id, kind)
    await session.commit()
    return await doc_response(b, kind)


@router.post("/partners/{partner_id}/docs/{kind}")
async def upload_partner_doc(partner_id: uuid.UUID, kind: Literal["photo", "license", "id_proof", "vehicle_rc"], admin: Staff, session: SessionDep,
                             file: UploadFile = File(...)) -> dict:
    b = await _partner(session, partner_id)
    if kind == "photo":
        b.photo = await storage.save_image(await file.read(settings.max_image_bytes + 1), f"delivery/{b.id}")
    else:
        key, _ = await storage.save_private(await file.read(settings.max_document_bytes + 1), f"delivery-kyc/{b.id}")
        setattr(b, svc.DOC_FIELDS[kind], key)
    audit(session, admin, "delivery.kyc_upload", "delivery_boy", b.id, kind)
    await session.commit()
    return await _out(session, b)


@router.get("/partners/{partner_id}/bank")
async def partner_bank(partner_id: uuid.UUID, admin: Perm("payouts"), session: SessionDep) -> dict:
    """The full account number, for paying the partner. Needs the payouts permission and is written to the audit log."""
    b = await _partner(session, partner_id)
    bank = b.bank_details or {}
    audit(session, admin, "delivery.bank_view", "delivery_boy", b.id)
    await session.commit()
    return {"holder": bank.get("holder", ""), "account_number": decrypt_field(bank.get("account_enc")) if bank.get("account_enc") else "",
            "ifsc": bank.get("ifsc", ""), "upi": bank.get("upi", "")}


class KycIn(BaseModel):
    action: Literal["approve", "reject"]
    note: str = Field(default="", max_length=500)
    zone_id: uuid.UUID | None = None


@router.post("/partners/{partner_id}/kyc")
async def review(partner_id: uuid.UUID, body: KycIn, admin: Staff, session: SessionDep) -> dict:
    b = await _partner(session, partner_id)
    cfg = await delivery_settings.get(session)
    user = await session.get(User, b.user_id)
    if body.zone_id:
        zone = await session.get(DeliveryZone, body.zone_id)
        if zone is None:
            raise ApiError("Choose a delivery zone", "invalid_zone")
        b.zone_id = zone.id
    if body.action == "approve":
        missing = [i["label"] for i in svc.checklist(b, cfg) if not i["done"]]
        if missing:
            raise ApiError(f"Missing before approval: {', '.join(missing)}", "incomplete")
        if b.zone_id is None:
            raise ApiError("Choose the zone this partner delivers in", "zone_required", fields={"zone_id": "Required"})
        b.kyc_status, b.kyc_note, b.approved_at = "approved", body.note.strip(), b.approved_at or utcnow()
        message = "You are approved. Open the partner app, go online and start delivering."
    else:
        if len(body.note.strip()) < 5:
            raise ApiError("Tell the partner what to fix (at least 5 characters)", "note_required", fields={"note": "Required"})
        b.kyc_status, b.kyc_note, b.is_online = "rejected", body.note.strip(), False
        message = f"Please fix your registration: {b.kyc_note}"
    audit(session, admin, f"delivery.kyc_{body.action}", "delivery_boy", b.id, body.note[:200])
    await notify(session, "delivery_kyc_update", user, {"status": "approved" if body.action == "approve" else "needs changes", "message": message},
                 link="/delivery" if body.action == "approve" else "/delivery/register")
    await session.commit()
    return await _out(session, b)


class ActiveIn(BaseModel):
    active: bool
    reason: str = Field(default="", max_length=300)


@router.post("/partners/{partner_id}/active")
async def set_active(partner_id: uuid.UUID, body: ActiveIn, admin: Staff, session: SessionDep) -> dict:
    b = await _partner(session, partner_id)
    if not body.active and len(body.reason.strip()) < 5:
        raise ApiError("Give a reason (at least 5 characters)", "reason_required", fields={"reason": "Required"})
    b.is_active = body.active
    in_hand = 0
    if not body.active:
        b.is_online = False
        # requests and trips not yet picked up go to other partners; packages already in hand stay with the partner,
        # who can still deliver them or bring them back to the store
        cfg = await delivery_settings.get(session)
        for a in list((await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.delivery_boy_id == b.id,
                                                                               DeliveryAssignment.status.in_(ACTIVE)).with_for_update())).scalars()):
            if a.status in ("offered", "accepted", "at_store"):
                await svc.cancel_by_staff(session, a, admin, f"Partner switched off: {body.reason.strip()}")
                await svc._after_release(session, await session.get(SubOrder, a.sub_order_id), "the partner was switched off", cfg)
            else:
                in_hand += 1
    audit(session, admin, "delivery.partner_on" if body.active else "delivery.partner_off", "delivery_boy", b.id, body.reason[:200])
    user = await session.get(User, b.user_id)
    await notify(session, "delivery_kyc_update", user, {"status": "switched on" if body.active else "switched off",
                                                         "message": "You can take deliveries again." if body.active else body.reason.strip()}, link="/delivery")
    await session.commit()
    return {**(await _out(session, b)), "trips_in_hand": in_hand}


# ============================================================================ zones


def _pins(raw: list[str] | str) -> list[str]:
    items = re.split(r"[\s,;]+", raw) if isinstance(raw, str) else [str(x) for x in raw]
    out = []
    for p in (x.strip() for x in items):
        if not p:
            continue
        if not _PIN.match(p):
            raise ApiError(f"{p} is not a 6-digit PIN code", "invalid_pin", fields={"pincodes": p})
        if p not in out:
            out.append(p)
    if not out:
        raise ApiError("Add at least one PIN code", "pins_required", fields={"pincodes": "Required"})
    if len(out) > 500:
        raise ApiError("A zone can have at most 500 PIN codes", "too_many_pins")
    return out


class ZoneIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    city: str = Field(min_length=2, max_length=80)
    pincodes: list[str] | str
    is_active: bool = True
    center_lat: float | None = Field(default=None, ge=-90, le=90)
    center_lng: float | None = Field(default=None, ge=-180, le=180)


async def _zone_out(session, zones: list[DeliveryZone]) -> list[dict]:
    ids = [z.id for z in zones]
    stats: dict[Any, dict] = {}
    if ids:
        rows = (await session.execute(select(DeliveryBoy.zone_id, DeliveryBoy.kyc_status, DeliveryBoy.is_online, func.count())
                                      .where(DeliveryBoy.zone_id.in_(ids), DeliveryBoy.is_active.is_(True))
                                      .group_by(DeliveryBoy.zone_id, DeliveryBoy.kyc_status, DeliveryBoy.is_online))).all()
        for zid, st, on, n in rows:
            s = stats.setdefault(zid, {"partners": 0, "approved": 0, "online": 0})
            s["partners"] += n
            if st == "approved":
                s["approved"] += n
                if on:
                    s["online"] += n
    return [{"id": str(z.id), "name": z.name, "city": z.city, "pincodes": z.pincodes, "is_active": z.is_active,
             "center_lat": float(z.center_lat) if z.center_lat is not None else None, "center_lng": float(z.center_lng) if z.center_lng is not None else None,
             **stats.get(z.id, {"partners": 0, "approved": 0, "online": 0})} for z in zones]


async def _check_overlap(session, pins: list[str], zone_id: uuid.UUID | None) -> None:
    stmt = select(DeliveryZone).where(DeliveryZone.is_active.is_(True))
    if zone_id:
        stmt = stmt.where(DeliveryZone.id != zone_id)
    for z in (await session.execute(stmt)).scalars():
        clash = sorted(set(pins) & set(z.pincodes or []))
        if clash:
            raise Conflict(f"{', '.join(clash[:5])}{'…' if len(clash) > 5 else ''} already belong to the zone {z.name}", "pin_overlap")


@router.get("/zones")
async def zones(admin: Staff, session: SessionDep) -> list[dict]:
    rows = list((await session.execute(select(DeliveryZone).order_by(DeliveryZone.city, DeliveryZone.name))).scalars())
    return await _zone_out(session, rows)


@router.post("/zones", status_code=201)
async def create_zone(body: ZoneIn, admin: Staff, session: SessionDep) -> dict:
    pins = _pins(body.pincodes)
    if body.is_active:
        await _check_overlap(session, pins, None)
    if (await session.execute(select(DeliveryZone.id).where(func.lower(DeliveryZone.name) == body.name.strip().lower()))).first():
        raise Conflict("A zone with this name exists", "zone_exists")
    z = DeliveryZone(name=body.name.strip(), city=body.city.strip(), pincodes=pins, is_active=body.is_active, center_lat=body.center_lat, center_lng=body.center_lng)
    session.add(z)
    await session.flush()
    audit(session, admin, "delivery.zone_create", "delivery_zone", z.id, z.name)
    await session.commit()
    return (await _zone_out(session, [z]))[0]


@router.put("/zones/{zone_id}")
async def update_zone(zone_id: uuid.UUID, body: ZoneIn, admin: Staff, session: SessionDep) -> dict:
    z = await session.get(DeliveryZone, zone_id)
    if z is None:
        raise NotFound("Zone")
    pins = _pins(body.pincodes)
    if body.is_active:
        await _check_overlap(session, pins, z.id)
    clash = (await session.execute(select(DeliveryZone.id).where(func.lower(DeliveryZone.name) == body.name.strip().lower(), DeliveryZone.id != z.id))).first()
    if clash:
        raise Conflict("A zone with this name exists", "zone_exists")
    z.name, z.city, z.pincodes, z.is_active, z.center_lat, z.center_lng = body.name.strip(), body.city.strip(), pins, body.is_active, body.center_lat, body.center_lng
    if not body.is_active:  # partners of a switched-off zone stop getting requests
        for b in (await session.execute(select(DeliveryBoy).where(DeliveryBoy.zone_id == z.id, DeliveryBoy.is_online.is_(True)))).scalars():
            b.is_online = False
    audit(session, admin, "delivery.zone_update", "delivery_zone", z.id, z.name)
    await session.commit()
    return (await _zone_out(session, [z]))[0]


@router.delete("/zones/{zone_id}")
async def delete_zone(zone_id: uuid.UUID, admin: Staff, session: SessionDep) -> dict:
    z = await session.get(DeliveryZone, zone_id)
    if z is None:
        raise NotFound("Zone")
    if (await session.execute(select(DeliveryBoy.id).where(DeliveryBoy.zone_id == z.id).limit(1))).first():
        raise Conflict("Move this zone's partners to another zone first, or switch the zone off", "zone_in_use")
    audit(session, admin, "delivery.zone_delete", "delivery_zone", z.id, z.name)
    await session.delete(z)
    await session.commit()
    return {"ok": True}


class AssignZoneIn(BaseModel):
    partner_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


@router.post("/zones/{zone_id}/partners")
async def assign_zone(zone_id: uuid.UUID, body: AssignZoneIn, admin: Staff, session: SessionDep) -> dict:
    z = await session.get(DeliveryZone, zone_id)
    if z is None:
        raise NotFound("Zone")
    rows = list((await session.execute(select(DeliveryBoy).where(DeliveryBoy.id.in_(body.partner_ids)))).scalars())
    for b in rows:
        b.zone_id = z.id
    audit(session, admin, "delivery.zone_assign", "delivery_zone", z.id, f"{len(rows)} partners")
    await session.commit()
    return {"moved": len(rows)}


# ============================================================================ settings


@router.get("/settings")
async def get_settings(admin: Staff, session: SessionDep) -> dict:
    return {"values": await delivery_settings.get(session), "fleet_modes": list(delivery_settings.FLEET_MODES), "fee_modes": list(delivery_settings.FEE_MODES)}


APK_MAX_BYTES = 120 * 1024 * 1024
_VERSION = re.compile(r"^[0-9A-Za-z.\-+ ]{0,20}$")


@router.post("/app")
async def upload_app(admin: Staff, session: SessionDep, file: UploadFile = File(...), version: str = Query(default="", max_length=20)) -> dict:
    """Publishes the partner Android app: the APK is checked, stored with the public files, and the download link and
    version shown in the partner app and on /delivery/download are updated."""
    if not _VERSION.match(version.strip()):
        raise ApiError("Use a version like 1.0.3", "invalid_version")
    data = await file.read(APK_MAX_BYTES + 1)
    name = "pixcart-partner" + (f"-{re.sub(r'[^0-9A-Za-z.]+', '-', version.strip())}" if version.strip() else "")
    url = await storage.save_app_package(data, APK_MAX_BYTES, name)
    values = await delivery_settings.update(session, {"android_apk_url": url, **({"app_version": version.strip()} if version.strip() else {})})
    audit(session, admin, "delivery.app_upload", "settings", "delivery", f"{version.strip() or 'no version'} {len(data) // 1024} KB")
    await session.commit()
    return {"values": values, "size": len(data)}


@router.put("/settings")
async def put_settings(body: dict[str, Any], admin: Staff, session: SessionDep) -> dict:
    try:
        values = await delivery_settings.update(session, body)
    except delivery_settings.DeliverySettingsError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "delivery.settings", "settings", "delivery", ",".join(sorted(body))[:200])
    await session.commit()
    return {"values": values, "fleet_modes": list(delivery_settings.FLEET_MODES), "fee_modes": list(delivery_settings.FEE_MODES)}
