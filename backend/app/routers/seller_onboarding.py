"""Seller registration and KYC onboarding (seller side)."""
from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select

from app.config import settings
from app.core.deps import CurrentUser, SellerAccount, SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.security import decrypt_field, encrypt_field
from app.core.validators import (
    STATES,
    normalize_mobile,
    slugify,
    validate_account_number,
    validate_gstin,
    validate_ifsc,
    validate_pan,
    validate_pincode,
    validate_state_code,
)
from app.db import utcnow
from app.models import Seller, SellerDocument, User
from app.models.seller import DOCUMENT_KINDS
from app.services import auth_settings, inventory, storage

router = APIRouter(prefix="/api/seller", tags=["seller-onboarding"])

EDITABLE_KYC = ("draft", "rejected")
REQUIRED_DOCS = ("pan_card", "gst_certificate", "cancelled_cheque")


class RegisterIn(BaseModel):
    display_name: str = Field(min_length=3, max_length=80)


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=3, max_length=80)
    description: str = Field(default="", max_length=2000)
    legal_name: str = Field(min_length=3, max_length=160)
    business_type: Literal["individual", "proprietorship", "partnership", "llp", "private_limited", "public_limited"]
    gstin: str
    pan: str
    contact_email: EmailStr
    contact_phone: str

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str) -> str:
        return validate_gstin(v)

    @field_validator("pan")
    @classmethod
    def _pan(cls, v: str) -> str:
        return validate_pan(v)

    @field_validator("contact_phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_mobile(v)


class StoreInfoIn(BaseModel):
    display_name: str = Field(min_length=3, max_length=80)
    description: str = Field(default="", max_length=2000)
    contact_email: EmailStr
    contact_phone: str

    @field_validator("contact_phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_mobile(v)


class PickupIn(BaseModel):
    line1: str = Field(min_length=3, max_length=200)
    line2: str = Field(default="", max_length=200)
    city: str = Field(min_length=2, max_length=80)
    state_code: str
    pincode: str

    @field_validator("state_code")
    @classmethod
    def _state(cls, v: str) -> str:
        return validate_state_code(v)

    @field_validator("pincode")
    @classmethod
    def _pin(cls, v: str) -> str:
        return validate_pincode(v)


class BankIn(BaseModel):
    holder_name: str = Field(min_length=3, max_length=120)
    account_number: str
    confirm_account_number: str
    ifsc: str

    @field_validator("account_number", "confirm_account_number")
    @classmethod
    def _acct(cls, v: str) -> str:
        return validate_account_number(v)

    @field_validator("ifsc")
    @classmethod
    def _ifsc(cls, v: str) -> str:
        return validate_ifsc(v)


class GrievanceIn(BaseModel):
    name: str = Field(min_length=3, max_length=120)
    email: EmailStr
    phone: str

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_mobile(v)


def checklist(seller: Seller, doc_kinds: set[str]) -> list[dict]:
    items = [
        ("business", "Business details (legal name, GSTIN, PAN)", bool(seller.legal_name and seller.gstin and seller.pan_enc)),
        ("pickup", "Pickup address", bool(seller.pickup_line1 and seller.pickup_pincode and seller.pickup_state_code)),
        ("bank", "Bank account for payouts", bool(seller.bank_account_enc and seller.bank_ifsc)),
        ("grievance", "Grievance officer (Consumer Protection E-Commerce Rules 2020)", bool(seller.grievance_name and seller.grievance_email)),
    ]
    items += [(f"doc:{k}", f"Upload {k.replace('_', ' ')}", k in doc_kinds) for k in REQUIRED_DOCS]
    return [{"key": k, "label": label, "done": done} for k, label, done in items]


async def _docs(session, seller: Seller) -> list[SellerDocument]:
    return list((await session.execute(select(SellerDocument).where(SellerDocument.seller_id == seller.id))).scalars())


async def seller_profile(session, seller: Seller, *, reveal: bool = False) -> dict:
    docs = await _docs(session, seller)
    pan = decrypt_field(seller.pan_enc)
    acct = decrypt_field(seller.bank_account_enc)
    return {
        "id": str(seller.id),
        "status": seller.status,
        "display_name": seller.display_name,
        "slug": seller.slug,
        "description": seller.description,
        "legal_name": seller.legal_name,
        "business_type": seller.business_type,
        "gstin": seller.gstin,
        "pan": pan if reveal else (f"XXXXXX{pan[-4:]}" if pan else ""),
        "contact_email": seller.contact_email,
        "contact_phone": seller.contact_phone,
        "pickup": {
            "line1": seller.pickup_line1,
            "line2": seller.pickup_line2,
            "city": seller.pickup_city,
            "state_code": seller.pickup_state_code,
            "state": STATES.get(seller.pickup_state_code, ""),
            "pincode": seller.pickup_pincode,
        },
        "bank": {
            "holder_name": seller.bank_holder_name,
            "account_number": acct if reveal else (f"XXXX{acct[-4:]}" if acct else ""),
            "ifsc": seller.bank_ifsc,
        },
        "grievance": {"name": seller.grievance_name, "email": seller.grievance_email, "phone": seller.grievance_phone},
        "documents": [
            {"kind": d.kind, "filename": d.filename, "content_type": d.content_type, "size_bytes": d.size_bytes, "uploaded_at": d.uploaded_at.isoformat()}
            for d in docs
        ],
        "checklist": checklist(seller, {d.kind for d in docs}),
        "rejection_reason": seller.rejection_reason,
        "submitted_at": seller.submitted_at.isoformat() if seller.submitted_at else None,
        "approved_at": seller.approved_at.isoformat() if seller.approved_at else None,
        "commission_bps_override": seller.commission_bps_override,
    }


def _require_editable(seller: Seller) -> None:
    if seller.status not in EDITABLE_KYC:
        raise Conflict(
            "KYC details are locked while your application is under review or approved. Contact seller support to change them.",
            "kyc_locked",
        )


async def _unique_slug(session, name: str) -> str:
    base = slugify(name, 70)
    slug = base
    while (await session.execute(select(Seller.id).where(Seller.slug == slug))).first():
        slug = f"{base}-{secrets.token_hex(2)}"
    return slug


@router.post("/register", status_code=201)
async def register(body: RegisterIn, user: CurrentUser, session: SessionDep) -> dict:
    existing = (await session.execute(select(Seller).where(Seller.user_id == user.id))).scalar_one_or_none()
    if existing:
        return await seller_profile(session, existing)
    if not (await auth_settings.get(session))["seller_signup"]:
        raise ApiError("New seller registrations are paused right now. Please try again later.", "seller_signup_closed", 403)
    seller = Seller(
        user_id=user.id,
        display_name=body.display_name.strip(),
        slug=await _unique_slug(session, body.display_name),
        contact_phone=user.phone or "",
        contact_email=user.email or "",
    )
    session.add(seller)
    await session.flush()
    audit(session, user, "seller.register", "seller", seller.id)
    await session.commit()
    return await seller_profile(session, seller)


@router.get("/me")
async def get_me(seller: SellerAccount, session: SessionDep) -> dict:
    return await seller_profile(session, seller)


@router.put("/profile")
async def update_profile(body: ProfileIn, seller: SellerAccount, session: SessionDep) -> dict:
    _require_editable(seller)
    await apply_profile(session, seller, body)
    await session.commit()
    return await seller_profile(session, seller)


# The apply_* helpers hold the rules for each section; the seller's routes (above/below) and the
# admin's routes (routers/admin_accounts.py) both use them. Only the seller side is locked during review.


async def apply_profile(session, seller: Seller, body: ProfileIn) -> None:
    if body.gstin[2:12] != body.pan:
        raise ApiError("The PAN inside your GSTIN (characters 3 to 12) must match the PAN you entered", "pan_gstin_mismatch", fields={"pan": "Does not match GSTIN"})
    clash = (await session.execute(select(Seller.id).where(Seller.gstin == body.gstin, Seller.id != seller.id))).first()
    if clash:
        raise Conflict("This GSTIN is already registered with another seller account", "gstin_taken")
    seller.display_name = body.display_name.strip()
    seller.description = body.description.strip()
    seller.legal_name = body.legal_name.strip()
    seller.business_type = body.business_type
    seller.gstin = body.gstin
    seller.pan_enc = encrypt_field(body.pan)
    seller.pan_last4 = body.pan[-4:]
    seller.contact_email = body.contact_email.lower()
    seller.contact_phone = body.contact_phone


@router.put("/store")
async def update_store_info(body: StoreInfoIn, seller: SellerAccount, session: SessionDep) -> dict:
    """Non-KYC store details an approved seller may change at any time."""
    seller.display_name = body.display_name.strip()
    seller.description = body.description.strip()
    seller.contact_email = body.contact_email.lower()
    seller.contact_phone = body.contact_phone
    await session.commit()
    return await seller_profile(session, seller)


@router.put("/pickup-address")
async def update_pickup(body: PickupIn, seller: SellerAccount, session: SessionDep) -> dict:
    _require_editable(seller)
    await apply_pickup(session, seller, body)
    await session.commit()
    return await seller_profile(session, seller)


async def apply_pickup(session, seller: Seller, body: PickupIn) -> None:
    seller.pickup_line1 = body.line1.strip()
    seller.pickup_line2 = body.line2.strip()
    seller.pickup_city = body.city.strip()
    seller.pickup_state_code = body.state_code
    seller.pickup_pincode = body.pincode
    await inventory.sync_default_warehouse(session, seller)


@router.put("/bank")
async def update_bank(body: BankIn, seller: SellerAccount, session: SessionDep) -> dict:
    # Bank details decide where money goes; once approved they change only through admin review.
    _require_editable(seller)
    apply_bank(seller, body)
    await session.commit()
    return await seller_profile(session, seller)


def apply_bank(seller: Seller, body: BankIn) -> None:
    if body.account_number != body.confirm_account_number:
        raise ApiError("Account numbers do not match", "account_mismatch", fields={"confirm_account_number": "Does not match"})
    seller.bank_holder_name = body.holder_name.strip()
    seller.bank_account_enc = encrypt_field(body.account_number)
    seller.bank_account_last4 = body.account_number[-4:]
    seller.bank_ifsc = body.ifsc
    # Payout routing (RazorpayX contact / fund account) must be set up again for the new account.
    seller.payout_fund_account_id = ""


@router.put("/grievance-officer")
async def update_grievance(body: GrievanceIn, seller: SellerAccount, session: SessionDep) -> dict:
    apply_grievance(seller, body)
    await session.commit()
    return await seller_profile(session, seller)


def apply_grievance(seller: Seller, body: GrievanceIn) -> None:
    seller.grievance_name = body.name.strip()
    seller.grievance_email = body.email.lower()
    seller.grievance_phone = body.phone


@router.post("/documents/{kind}")
async def upload_document(kind: str, seller: SellerAccount, session: SessionDep, file: UploadFile = File(...)) -> dict:
    if kind not in DOCUMENT_KINDS:
        raise NotFound("Document type")
    _require_editable(seller)
    data = await file.read(settings.max_document_bytes + 1)  # never buffer more than the limit
    key, content_type = await storage.save_private(data, f"kyc/{seller.id}")
    doc = (
        await session.execute(select(SellerDocument).where(SellerDocument.seller_id == seller.id, SellerDocument.kind == kind))
    ).scalar_one_or_none()
    if doc is None:
        doc = SellerDocument(seller_id=seller.id, kind=kind)
        session.add(doc)
    doc.storage_key = key
    doc.filename = (file.filename or kind)[:200]
    doc.content_type = content_type
    doc.size_bytes = len(data)
    doc.uploaded_at = utcnow()
    await session.commit()
    return await seller_profile(session, seller)


async def document_response(session, seller_id, kind: str) -> Response:
    doc = (
        await session.execute(select(SellerDocument).where(SellerDocument.seller_id == seller_id, SellerDocument.kind == kind))
    ).scalar_one_or_none()
    if doc is None:
        raise NotFound("Document")
    data = await storage.read_private(doc.storage_key)
    return Response(
        data,
        media_type=doc.content_type,
        headers={
            "Content-Disposition": f'inline; filename="{kind}.{doc.storage_key.rsplit(".", 1)[-1]}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/documents/{kind}")
async def download_document(kind: str, seller: SellerAccount, session: SessionDep) -> Response:
    return await document_response(session, seller.id, kind)


@router.post("/submit")
async def submit(seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    _require_editable(seller)
    docs = await _docs(session, seller)
    missing = [i["label"] for i in checklist(seller, {d.kind for d in docs}) if not i["done"]]
    if missing:
        raise ApiError("Please complete: " + "; ".join(missing), "onboarding_incomplete")
    if seller.gstin and seller.gstin[:2] != seller.pickup_state_code:
        raise ApiError(
            "Your pickup address must be in the state of your GSTIN registration (GST registration is state-wise)",
            "gstin_state_mismatch",
        )
    seller.status = "submitted"
    seller.submitted_at = utcnow()
    seller.rejection_reason = ""
    audit(session, user, "seller.submit", "seller", seller.id)
    await session.commit()
    return await seller_profile(session, seller)


async def seller_user(session, seller: Seller) -> User | None:
    return await session.get(User, seller.user_id)
