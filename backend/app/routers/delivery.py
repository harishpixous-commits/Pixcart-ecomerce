"""Delivery partner app API (``/delivery`` in the web app and the Android app).

Partners sign in with their mobile number and a one-time code (the ordinary ``/api/auth/otp`` flow), register,
upload KYC documents and bank details, and wait for approval. Approved partners go online, share their location,
receive delivery requests, run the delivery steps and see their earnings.
"""
from __future__ import annotations

import re
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from app.config import settings
from app.core.deps import CurrentUser, SessionDep, rate_limit
from app.core.errors import ApiError, Conflict, Forbidden, NotFound
from app.core.security import encrypt_field
from app.core.validators import validate_account_number, validate_ifsc
from app.db import utcnow
from app.models import DeliveryBoy, DeliveryZone
from app.services import fleet as svc
from app.services import delivery_settings, storage
from app.services.notify import notify_staff

router = APIRouter(prefix="/api/delivery", tags=["delivery"])

_VEHICLE_NO = re.compile(r"^[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{0,3}[ -]?\d{1,4}$")
_LICENSE = re.compile(r"^[A-Z0-9 -]{8,20}$")
_UPI = re.compile(r"^[\w.\-]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,40}$")


async def current_partner(user: CurrentUser, session: SessionDep) -> DeliveryBoy:
    b = await svc.partner_for_user(session, user.id)
    if b is None:
        raise ApiError("Register as a delivery partner first", "not_registered", 404)
    return b


Partner = Annotated[DeliveryBoy, Depends(current_partner)]


async def approved_partner(b: Partner, session: SessionDep) -> DeliveryBoy:
    cfg = await delivery_settings.get(session)
    if not cfg["enabled"]:
        raise ApiError("Deliveries are paused right now", "delivery_off", 403)
    if b.kyc_status != "approved":
        raise Forbidden("Your account is not approved yet")
    if not b.is_active:
        raise Forbidden("Your account is switched off. Contact the delivery team.")
    return b


ApprovedPartner = Annotated[DeliveryBoy, Depends(approved_partner)]


# ============================================================================ registration and profile


@router.get("/options")
async def options(session: SessionDep) -> dict:
    """For the join page and the registration form (no sign-in needed)."""
    cfg = await delivery_settings.get(session)
    zones = (await session.execute(select(DeliveryZone).where(DeliveryZone.is_active.is_(True)).order_by(DeliveryZone.city, DeliveryZone.name))).scalars()
    return {**delivery_settings.public(cfg), "zones": [{"id": str(z.id), "name": z.name, "city": z.city} for z in zones]}


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    city: str | None = Field(default=None, min_length=2, max_length=80)
    address: str | None = Field(default=None, max_length=500)
    zone_id: uuid.UUID | None = None
    vehicle_type: Literal["bike", "scooter", "ev", "cycle", "auto", "van"] | None = None
    vehicle_no: str | None = Field(default=None, max_length=15)
    license_no: str | None = Field(default=None, max_length=20)
    id_proof_type: Literal["aadhaar", "pan", "voter", "passport"] | None = None
    id_proof_no: str | None = Field(default=None, max_length=20)

    @field_validator("vehicle_no")
    @classmethod
    def _vehicle(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return "" if v is not None else None
        v = " ".join(v.upper().split())
        if not _VEHICLE_NO.match(v):
            raise ValueError("Enter the vehicle number as on the number plate, e.g. TN 38 AB 1234")
        return v

    @field_validator("license_no")
    @classmethod
    def _license(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.upper().strip()
        if v and not _LICENSE.match(v):
            raise ValueError("Enter the driving licence number as printed, e.g. TN38 20190012345")
        return v


def _apply_id(b: DeliveryBoy, kind: str, number: str) -> None:
    clean = re.sub(r"[\s-]", "", number).upper()
    rules = {"aadhaar": r"^\d{12}$", "pan": r"^[A-Z]{5}\d{4}[A-Z]$", "voter": r"^[A-Z]{3}\d{7}$", "passport": r"^[A-Z]\d{7}$"}
    if not re.match(rules[kind], clean):
        raise ApiError({"aadhaar": "Enter the 12-digit Aadhaar number", "pan": "Enter a valid PAN, e.g. ABCDE1234F",
                        "voter": "Enter a valid voter ID, e.g. ABC1234567", "passport": "Enter a valid passport number, e.g. K1234567"}[kind],
                       "invalid_id", fields={"id_proof_no": "Invalid"})
    b.id_proof_type, b.id_proof_last4 = kind, clean[-4:]
    # Aadhaar numbers are not stored (only the last 4 digits and the photo); other ID numbers are encrypted.
    b.id_proof_enc = "" if kind == "aadhaar" else encrypt_field(clean)


async def _apply(session, b: DeliveryBoy, body: ProfileIn) -> None:
    for k in ("name", "city", "address", "vehicle_type", "vehicle_no", "license_no"):
        v = getattr(body, k)
        if v is not None:
            setattr(b, k, " ".join(v.split()) if k in ("name", "city") else v)
    if body.zone_id is not None:
        zone = await session.get(DeliveryZone, body.zone_id)
        if zone is None or not zone.is_active:
            raise ApiError("Choose one of the delivery areas", "invalid_zone")
        b.zone_id = zone.id
    if body.id_proof_type and body.id_proof_no:
        _apply_id(b, body.id_proof_type, body.id_proof_no)
    elif body.id_proof_type and body.id_proof_type != b.id_proof_type:
        b.id_proof_type, b.id_proof_last4, b.id_proof_enc = body.id_proof_type, "", ""


@router.get("/me")
async def me(b: Partner, session: SessionDep) -> dict:
    return svc.partner_out(b, await svc.zone_of(session, b), await delivery_settings.get(session))


@router.post("/register", status_code=201)
async def register(body: ProfileIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await delivery_settings.get(session)
    if not cfg["enabled"] or not cfg["registration_open"]:
        raise ApiError("New delivery partner registrations are closed right now", "registration_closed", 403)
    if await svc.partner_for_user(session, user.id):
        raise Conflict("You are already registered", "already_registered")
    if user.is_admin:
        raise ApiError("Staff accounts cannot register as delivery partners", "staff_account")
    b = DeliveryBoy(user_id=user.id, name=(body.name or user.name or "").strip(), phone=user.phone or "", kyc_status="draft", bank_details={})
    if not b.name:
        raise ApiError("Enter your name", "name_required", fields={"name": "Required"})
    await _apply(session, b, body)
    session.add(b)
    if body.name and not user.name:
        user.name = body.name.strip()
    await session.commit()
    return svc.partner_out(b, await svc.zone_of(session, b), cfg)


@router.put("/me")
async def update_me(body: ProfileIn, b: Partner, session: SessionDep) -> dict:
    if b.kyc_status not in ("draft", "rejected"):
        # after review only the home address can change here; the delivery team updates the rest
        if any(getattr(body, k) is not None for k in ("name", "city", "zone_id", "vehicle_type", "vehicle_no", "license_no", "id_proof_type", "id_proof_no")):
            raise Conflict("Your details are verified. Ask the delivery team to change them.", "locked")
    await _apply(session, b, body)
    await session.commit()
    return svc.partner_out(b, await svc.zone_of(session, b), await delivery_settings.get(session))


@router.post("/me/docs/{kind}")
async def upload_doc(kind: Literal["photo", "license", "id_proof", "vehicle_rc"], b: Partner, session: SessionDep, file: UploadFile = File(...)) -> dict:
    if kind != "photo" and b.kyc_status not in ("draft", "rejected"):
        raise Conflict("Your documents are verified. Ask the delivery team to change them.", "locked")
    if kind == "photo":
        data = await file.read(settings.max_image_bytes + 1)
        b.photo = await storage.save_image(data, f"delivery/{b.id}")
    else:
        data = await file.read(settings.max_document_bytes + 1)
        key, _ = await storage.save_private(data, f"delivery-kyc/{b.id}")
        setattr(b, svc.DOC_FIELDS[kind], key)
    await session.commit()
    return svc.partner_out(b, await svc.zone_of(session, b), await delivery_settings.get(session))


async def doc_response(b: DeliveryBoy, kind: str) -> Response:
    key = getattr(b, svc.DOC_FIELDS.get(kind, ""), "") if kind in svc.DOC_FIELDS else ""
    if not key:
        raise NotFound("Document")
    data = await storage.read_private(key)
    ext = key.rsplit(".", 1)[-1]
    media = {"pdf": "application/pdf", "png": "image/png", "webp": "image/webp"}.get(ext, "image/jpeg")
    return Response(data, media_type=media, headers={"Content-Disposition": f'inline; filename="{kind}.{ext}"', "Cache-Control": "private, no-store",
                                                     "X-Content-Type-Options": "nosniff"})


@router.get("/me/docs/{kind}")
async def my_doc(kind: str, b: Partner) -> Response:
    return await doc_response(b, kind)


class BankIn(BaseModel):
    holder: str = Field(min_length=3, max_length=120)
    account_number: str = ""
    confirm_account_number: str = ""
    ifsc: str = ""
    upi: str = Field(default="", max_length=80)


@router.put("/me/bank")
async def set_bank(body: BankIn, b: Partner, session: SessionDep) -> dict:
    out = {"holder": " ".join(body.holder.split())}
    if body.account_number:
        try:
            acct = validate_account_number(body.account_number)
            ifsc = validate_ifsc(body.ifsc)
        except ValueError as exc:
            raise ApiError(str(exc), "invalid_bank") from exc
        if acct != re.sub(r"\D", "", body.confirm_account_number):
            raise ApiError("The two account numbers do not match", "account_mismatch", fields={"confirm_account_number": "Does not match"})
        out |= {"account_enc": encrypt_field(acct), "account_last4": acct[-4:], "ifsc": ifsc}
    upi = body.upi.strip()
    if upi:
        if not _UPI.match(upi):
            raise ApiError("Enter a UPI ID like name@okaxis", "invalid_upi", fields={"upi": "Invalid"})
        out["upi"] = upi
    if "account_enc" not in out and "upi" not in out:
        raise ApiError("Add a bank account or a UPI ID for your payouts", "bank_required")
    changed = bool(b.bank_details) and b.kyc_status == "approved"
    b.bank_details = out
    await session.commit()
    if changed:  # staff check payout details that change after approval
        await notify_staff(session, "delivery", "staff_delivery_bank", {"name": b.name, "phone": b.phone}, link=f"/admin/delivery/partners/{b.id}")
        await session.commit()
    return svc.partner_out(b, await svc.zone_of(session, b), await delivery_settings.get(session))


@router.post("/me/submit")
async def submit(b: Partner, session: SessionDep) -> dict:
    cfg = await delivery_settings.get(session)
    if b.kyc_status not in ("draft", "rejected"):
        raise Conflict("Already sent for review", "already_submitted")
    missing = [i["label"] for i in svc.checklist(b, cfg) if not i["done"]]
    if missing:
        raise ApiError(f"Complete these first: {', '.join(missing)}", "incomplete", fields={"missing": ", ".join(missing)})
    b.kyc_status, b.kyc_note = "submitted", ""
    await notify_staff(session, "delivery", "staff_delivery_kyc", {"name": b.name, "city": b.city}, link="/admin/delivery/partners?status=submitted")
    await session.commit()
    return svc.partner_out(b, await svc.zone_of(session, b), cfg)


# ============================================================================ online and location


class OnlineIn(BaseModel):
    online: bool


@router.post("/me/online")
async def set_online(body: OnlineIn, b: ApprovedPartner, session: SessionDep) -> dict:
    if body.online and b.zone_id is None:
        raise ApiError("Your delivery area is not set yet. Ask the delivery team to assign one.", "no_zone")
    now = utcnow()
    if body.online and not b.is_online:
        b.online_since = now
    b.is_online = body.online
    await session.commit()
    return {"is_online": b.is_online, "online_since": b.online_since.isoformat() if b.online_since and b.is_online else None}


class LocationIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0, le=100_000)


@router.post("/me/location")
async def set_location(body: LocationIn, b: ApprovedPartner, session: SessionDep) -> dict:
    await rate_limit(session, f"dloc:{b.id}", limit=40, window_seconds=60)
    b.lat, b.lng, b.location_at = round(body.lat, 6), round(body.lng, 6), utcnow()
    await session.commit()
    return {"ok": True}
