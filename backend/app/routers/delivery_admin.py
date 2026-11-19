"""Admin → Delivery: partners and their KYC, delivery zones, settings (and, in later steps, the queue, live map,
payouts, reports, ratings and complaints). Every endpoint needs the "Delivery fleet" permission."""
from __future__ import annotations

import re
import uuid
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
from app.models import DeliveryBoy, DeliveryZone, User
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
    counts = dict((await session.execute(select(DeliveryBoy.kyc_status, func.count()).group_by(DeliveryBoy.kyc_status))).all())
    online = (await session.execute(select(func.count()).select_from(DeliveryBoy).where(
        DeliveryBoy.is_online.is_(True), DeliveryBoy.is_active.is_(True), DeliveryBoy.kyc_status == "approved"))).scalar_one()
    zones = (await session.execute(select(func.count()).select_from(DeliveryZone).where(DeliveryZone.is_active.is_(True)))).scalar_one()
    cfg = await delivery_settings.get(session)
    return {"partners": counts, "online": online, "zones": zones, "fleet_mode": cfg["fleet_mode"], "auto_assign": cfg["auto_assign"], "enabled": cfg["enabled"]}


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
    if not body.active:
        b.is_online = False
    audit(session, admin, "delivery.partner_on" if body.active else "delivery.partner_off", "delivery_boy", b.id, body.reason[:200])
    user = await session.get(User, b.user_id)
    await notify(session, "delivery_kyc_update", user, {"status": "switched on" if body.active else "switched off",
                                                         "message": "You can take deliveries again." if body.active else body.reason.strip()}, link="/delivery")
    await session.commit()
    return await _out(session, b)


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


@router.put("/settings")
async def put_settings(body: dict[str, Any], admin: Staff, session: SessionDep) -> dict:
    try:
        values = await delivery_settings.update(session, body)
    except delivery_settings.DeliverySettingsError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "delivery.settings", "settings", "delivery", ",".join(sorted(body))[:200])
    await session.commit()
    return {"values": values, "fleet_modes": list(delivery_settings.FLEET_MODES), "fee_modes": list(delivery_settings.FEE_MODES)}
