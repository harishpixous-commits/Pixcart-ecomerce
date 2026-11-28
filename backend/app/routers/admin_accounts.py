"""Admin → Customers (account details and management), creating accounts for people, and
Admin → Sign-in and accounts (dev OTP on screen, sign-up switches).

Permissions: ``customers`` (view, edit, create, block, sign out a customer), ``sellers`` (create a seller account),
``settings`` (sign-in settings). Every change is written to the audit log.
"""
from __future__ import annotations

import secrets
import uuid
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, select, update

from app.config import settings as env
from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, Forbidden, NotFound
from app.core.permissions import Perm, permissions_for
from app.core.step_up import confirm_identity
from app.core.validators import STATES, normalize_mobile, slugify
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import (
    Address,
    AuditLog,
    Order,
    OrderItem,
    RefreshSession,
    ReturnRequest,
    Review,
    Seller,
    SubOrder,
    SupportTicket,
    User,
    WishlistItem,
)
from app.routers.orders import order_summary
from app.routers.seller_onboarding import (
    BankIn,
    GrievanceIn,
    PickupIn,
    ProfileIn,
    apply_bank,
    apply_grievance,
    apply_pickup,
    apply_profile,
    seller_profile,
)
from app.services import auth_settings
from app.services import returns as returns_svc
from app.services.notify import notify, notify_seller

router = APIRouter(prefix="/api/admin", tags=["admin-accounts"])


def _mobile(v: str) -> str:
    try:
        return normalize_mobile(v)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_phone", fields={"phone": "Enter a 10-digit Indian mobile number"}) from exc


# ----------------------------------------------------------------------------- sign-in settings


@router.get("/auth-settings")
async def get_auth_settings(admin: Perm("settings"), session: SessionDep) -> dict:
    return {"settings": await auth_settings.get(session), "dev_otp": await auth_settings.dev_otp_status(session),
            "environment": env.environment, "sms_provider": (await get_integrations(session)).sms_provider,
            "limits": {k: list(v) for k, v in auth_settings.INTS.items()}}


@router.put("/auth-settings")
async def put_auth_settings(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    if body.get("staff_require_two_step") is True and not admin.totp_enabled:
        raise ApiError("Turn on two-step sign-in for your own account first (My account), so you are not locked out.", "two_step_self")
    try:
        cfg = await auth_settings.update(session, body)
    except auth_settings.AuthSettingsError as exc:
        raise ApiError(str(exc), "invalid_settings") from exc
    audit(session, admin, "auth.settings", "settings", auth_settings.KEY, ", ".join(f"{k}={v}" for k, v in body.items()))
    await session.commit()
    return await get_auth_settings(admin, session) | {"settings": cfg}


# ----------------------------------------------------------------------------- customers


class CustomerIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    phone: str
    email: EmailStr | None = None
    marketing_opt_in: bool = False


class CustomerPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    phone: str | None = None
    email: EmailStr | None = None
    clear_email: bool = False
    marketing_opt_in: bool | None = None
    staff_note: str | None = Field(default=None, max_length=1000)
    staff_tags: list[str] | None = Field(default=None, max_length=10)


async def _phone_free(session, phone: str, but: uuid.UUID | None = None) -> None:
    q = select(User.id).where(User.phone == phone)
    if but:
        q = q.where(User.id != but)
    if (await session.execute(q)).first():
        raise ApiError("Another account already uses this mobile number", "phone_taken", fields={"phone": "Already in use"})


async def _email_free(session, email: str, but: uuid.UUID | None = None) -> None:
    q = select(User.id).where(User.email == email)
    if but:
        q = q.where(User.id != but)
    if (await session.execute(q)).first():
        raise ApiError("Another account already uses this email", "email_taken", fields={"email": "Already in use"})


@router.post("/customers", status_code=201)
async def create_customer(body: CustomerIn, admin: Perm("customers"), session: SessionDep) -> dict:
    """Creates a customer account (e.g. a phone order). The customer signs in with an OTP on their mobile."""
    phone = _mobile(body.phone)
    await _phone_free(session, phone)
    email = body.email.lower() if body.email else None
    if email:
        await _email_free(session, email)
    u = User(phone=phone, name=" ".join(body.name.split()), email=email, marketing_opt_in=body.marketing_opt_in)
    session.add(u)
    await session.flush()
    audit(session, admin, "user.create", "user", u.id, f"{phone} by staff")
    await session.commit()
    return {"id": str(u.id)}


def _ua(ua: str | None) -> str:
    ua = ua or ""
    device = "Phone" if any(k in ua for k in ("Android", "iPhone", "Mobile")) else "Computer"
    browser = next((b for b in ("Edg", "Chrome", "Firefox", "Safari") if b in ua), "Browser")
    return f"{device} · {'Edge' if browser == 'Edg' else browser}"


@router.get("/customers/{user_id}")
async def customer_detail(user_id: uuid.UUID, admin: Perm("customers"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None:
        raise NotFound("Customer")
    seller = (await session.execute(select(Seller).where(Seller.user_id == u.id))).scalar_one_or_none()
    placed = select(Order).where(Order.user_id == u.id, Order.status == "placed")
    spent = (await session.execute(select(func.coalesce(func.sum(Order.grand_total - Order.refunded_total), 0)).where(Order.user_id == u.id, Order.status == "placed"))).scalar_one()
    count = lambda stmt: session.execute(select(func.count()).select_from(stmt.subquery()))  # noqa: E731
    orders = list((await session.execute(select(Order).where(Order.user_id == u.id).order_by(Order.created_at.desc()).limit(10))).scalars())
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id.in_([o.id for o in orders])).order_by(SubOrder.number))).scalars()) if orders else []
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s in subs])))).scalars()) if subs else []
    by_sub: dict[uuid.UUID, list[OrderItem]] = {}
    for it in items:
        by_sub.setdefault(it.sub_order_id, []).append(it)
    addresses = list((await session.execute(select(Address).where(Address.user_id == u.id, Address.is_deleted.is_(False)).order_by(Address.is_default.desc(), Address.created_at))).scalars())
    rets = list((await session.execute(select(ReturnRequest).where(ReturnRequest.user_id == u.id).order_by(ReturnRequest.created_at.desc()).limit(10))).scalars())
    tickets = list((await session.execute(select(SupportTicket).where(SupportTicket.user_id == u.id).order_by(SupportTicket.updated_at.desc()).limit(10))).scalars())
    sessions = list((await session.execute(select(RefreshSession).where(RefreshSession.user_id == u.id, RefreshSession.revoked_at.is_(None),
                                                                        RefreshSession.expires_at > utcnow()).order_by(RefreshSession.created_at.desc()).limit(10))).scalars())
    history = list((await session.execute(select(AuditLog).where(AuditLog.entity_type == "user", AuditLog.entity_id == str(u.id)).order_by(AuditLog.created_at.desc()).limit(15))).scalars())
    actors = dict((await session.execute(select(User.id, User.name).where(User.id.in_({h.actor_user_id for h in history if h.actor_user_id})))).all()) if history else {}
    return {
        "id": str(u.id), "name": u.name, "phone": u.phone, "email": u.email, "is_active": u.is_active, "is_admin": u.is_admin,
        "marketing_opt_in": u.marketing_opt_in, "staff_note": u.staff_note, "staff_tags": u.staff_tags or [], "created_at": u.created_at.isoformat(), "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "terms_accepted_at": u.terms_accepted_at.isoformat() if u.terms_accepted_at else None,
        "seller": {"id": str(seller.id), "name": seller.display_name, "status": seller.status} if seller else None,
        "stats": {
            "orders": (await count(placed)).scalar_one(), "spent": int(spent),
            "returns": (await count(select(ReturnRequest).where(ReturnRequest.user_id == u.id))).scalar_one(),
            "tickets": (await count(select(SupportTicket).where(SupportTicket.user_id == u.id))).scalar_one(),
            "open_tickets": (await count(select(SupportTicket).where(SupportTicket.user_id == u.id, SupportTicket.status.in_(("open", "awaiting_customer"))))).scalar_one(),
            "wishlist": (await count(select(WishlistItem).where(WishlistItem.user_id == u.id))).scalar_one(),
            "reviews": (await count(select(Review).where(Review.user_id == u.id))).scalar_one(),
        },
        "addresses": [{"id": str(a.id), "name": a.full_name, "phone": a.phone, "kind": a.kind, "is_default": a.is_default,
                       "text": ", ".join(x for x in (a.line1, a.line2, a.landmark, a.city, STATES.get(a.state_code, a.state_code), a.pincode) if x)} for a in addresses],
        "orders": [order_summary(o, [s for s in subs if s.order_id == o.id], by_sub) for o in orders],
        "returns": [await returns_svc.return_out(session, r, viewer="admin") for r in rets],
        "tickets": [{"id": str(t.id), "number": t.number, "subject": t.subject, "status": t.status, "updated_at": t.updated_at.isoformat()} for t in tickets],
        "sessions": [{"device": _ua(s.user_agent), "signed_in_at": s.created_at.isoformat(), "expires_at": s.expires_at.isoformat()} for s in sessions],
        "history": [{"action": h.action, "detail": h.detail, "by": actors.get(h.actor_user_id, "") if h.actor_user_id else "", "at": h.created_at.isoformat()} for h in history],
    }


@router.patch("/customers/{user_id}")
async def edit_customer(user_id: uuid.UUID, body: CustomerPatch, admin: Perm("customers"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None:
        raise NotFound("Customer")
    if u.is_admin and u.id != admin.id:
        raise Conflict("Staff accounts are edited in Staff and roles", "invalid_target")
    new_phone = _mobile(body.phone) if body.phone is not None else u.phone
    new_email = None if body.clear_email else (body.email.lower() if body.email is not None else u.email)
    sign_in_changes = [x for x, changed in (("mobile number", new_phone != u.phone), ("email", new_email != u.email)) if changed]
    if sign_in_changes and (await session.execute(select(Seller.id).where(Seller.user_id == u.id))).first() and "sellers" not in permissions_for(admin):
        # whoever controls the owner's mobile signs in as the seller: only staff who manage sellers may change it
        raise Forbidden("This person owns a seller account. Only staff who manage sellers can change their mobile number or email.")
    if sign_in_changes:
        # told on the old number and email before they change, so a change nobody asked for is noticed
        await notify(session, "security_notice", u, {"what": "sign-in details changed",
                     "message": f"Our team changed the {' and '.join(sign_in_changes)} you use to sign in."}, channels=("inapp", "email", "sms"))
    changes = []
    if body.name is not None:
        u.name = " ".join(body.name.split())
        changes.append("name")
    if new_phone != u.phone:
        await _phone_free(session, new_phone, u.id)
        u.phone = new_phone
        changes.append("mobile")
        # A new number must sign in again with an OTP sent to it.
        await session.execute(update(RefreshSession).where(RefreshSession.user_id == u.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))
    if body.clear_email and u.email:
        u.email = None
        changes.append("email removed")
    elif new_email != u.email and new_email:
        await _email_free(session, new_email, u.id)
        u.email = new_email
        changes.append("email")
    if body.marketing_opt_in is not None:
        u.marketing_opt_in = body.marketing_opt_in
        changes.append(f"marketing {'on' if body.marketing_opt_in else 'off'}")
    if body.staff_note is not None and body.staff_note.strip() != u.staff_note:
        u.staff_note = body.staff_note.strip()
        changes.append("staff note")
    if body.staff_tags is not None:
        tags = list(dict.fromkeys(" ".join(t.split())[:30] for t in body.staff_tags if t.strip()))
        if tags != (u.staff_tags or []):
            u.staff_tags = tags
            changes.append("tags")
    audit(session, admin, "user.edit", "user", u.id, ", ".join(changes) or "no change")
    await session.commit()
    return await customer_detail(user_id, admin, session)


@router.post("/customers/{user_id}/sign-out")
async def sign_out_customer(user_id: uuid.UUID, admin: Perm("customers"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None:
        raise NotFound("Customer")
    if u.is_admin:
        raise Conflict("Staff accounts are managed in Staff and roles", "invalid_target")
    n = (await session.execute(update(RefreshSession).where(RefreshSession.user_id == u.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))).rowcount
    audit(session, admin, "user.sign_out", "user", u.id, f"{n} session(s)")
    await session.commit()
    return {"ok": True, "sessions": n}


# ----------------------------------------------------------------------------- sellers created by staff


class SellerIn(BaseModel):
    phone: str
    name: str = Field(min_length=2, max_length=120)  # the owner's name
    store_name: str = Field(min_length=2, max_length=80)
    email: EmailStr | None = None

    @field_validator("store_name")
    @classmethod
    def _store(cls, v: str) -> str:
        return " ".join(v.split())


@router.post("/sellers", status_code=201)
async def create_seller(body: SellerIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    """Opens a seller account for someone (e.g. onboarded by the sales team). It starts as a draft: the seller
    signs in with an OTP on this mobile and completes business, PAN, GST, pickup and bank details; then the
    application comes back here for approval as usual."""
    phone = _mobile(body.phone)
    user = (await session.execute(select(User).where(User.phone == phone))).scalar_one_or_none()
    email = body.email.lower() if body.email else None
    if user is None:
        if email:
            await _email_free(session, email)
        user = User(phone=phone, name=" ".join(body.name.split()), email=email)
        session.add(user)
        await session.flush()
        audit(session, admin, "user.create", "user", user.id, f"{phone} for a seller account")
    elif (await session.execute(select(Seller.id).where(Seller.user_id == user.id))).first():
        raise ApiError("This mobile number already has a seller account", "seller_exists", 409)
    base = slugify(body.store_name, 70)
    slug = base
    while (await session.execute(select(Seller.id).where(Seller.slug == slug))).first():
        slug = f"{base}-{secrets.token_hex(2)}"
    seller = Seller(user_id=user.id, display_name=body.store_name, slug=slug, contact_phone=phone, contact_email=email or user.email or "")
    session.add(seller)
    await session.flush()
    audit(session, admin, "seller.create", "seller", seller.id, f"{body.store_name} for {phone}")
    await session.commit()
    return {"id": str(seller.id), "user_id": str(user.id)}


# ----------------------------------------------------------------------------- seller details edited by staff


async def _seller_for_edit(session, seller_id: uuid.UUID) -> Seller:
    s = (await session.execute(select(Seller).where(Seller.id == seller_id).with_for_update())).scalar_one_or_none()
    if s is None:
        raise NotFound("Seller")
    return s


@router.put("/sellers/{seller_id}/business")
async def admin_seller_business(seller_id: uuid.UUID, body: ProfileIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    """Corrects business, GSTIN and PAN details, also while under review or approved (the seller cannot then)."""
    s = await _seller_for_edit(session, seller_id)
    before = (s.legal_name, s.gstin, s.display_name)
    await apply_profile(session, s, body)
    audit(session, admin, "seller.edit_business", "seller", s.id, f"{before} → {(s.legal_name, s.gstin, s.display_name)}")
    await session.commit()
    return await seller_profile(session, s, reveal=True)


@router.put("/sellers/{seller_id}/pickup-address")
async def admin_seller_pickup(seller_id: uuid.UUID, body: PickupIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller_for_edit(session, seller_id)
    await apply_pickup(session, s, body)
    audit(session, admin, "seller.edit_pickup", "seller", s.id, f"{body.city} {body.pincode}")
    await session.commit()
    return await seller_profile(session, s, reveal=True)


class StaffBankIn(BankIn):
    # changing where money goes is sensitive: the staff member confirms with their password (and authenticator code)
    password: str = Field(default="", max_length=200)
    totp: str = Field(default="", max_length=8)


@router.put("/sellers/{seller_id}/bank")
async def admin_seller_bank(seller_id: uuid.UUID, body: StaffBankIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    """Changes where payouts go. The staff member confirms it is them; the seller is told at once, so a change they did
    not ask for is noticed; payouts already created keep the old account until Finance confirms the new one."""
    await confirm_identity(session, admin, body.password, body.totp, purpose="seller-bank")
    s = await _seller_for_edit(session, seller_id)
    old = s.bank_account_last4
    apply_bank(s, body)
    audit(session, admin, "seller.edit_bank", "seller", s.id, f"account …{old or '-'} → …{s.bank_account_last4}, IFSC {s.bank_ifsc}")
    await notify_seller(session, s.id, "seller_kyc_update", {"status": "bank account changed",
                        "message": f"Your payout bank account was changed by our team to the account ending {s.bank_account_last4} (IFSC {s.bank_ifsc}). "
                                   "If you did not ask for this, contact seller support at once."}, link="/seller/settings")
    await session.commit()
    return await seller_profile(session, s, reveal=True)


@router.put("/sellers/{seller_id}/grievance-officer")
async def admin_seller_grievance(seller_id: uuid.UUID, body: GrievanceIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller_for_edit(session, seller_id)
    apply_grievance(s, body)
    audit(session, admin, "seller.edit_grievance", "seller", s.id, body.name)
    await session.commit()
    return await seller_profile(session, s, reveal=True)
