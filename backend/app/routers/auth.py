from __future__ import annotations

import re
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select, update

from app.config import settings
from app.core import totp
from app.core.deps import CurrentUser, SessionDep, client_ip, rate_limit
from app.core.errors import ApiError, Forbidden, TooManyRequests, Unauthorized
from app.core.security import (
    create_access_token,
    decrypt_field,
    encrypt_field,
    generate_otp,
    hash_otp,
    hash_password,
    new_opaque_token,
    sha256,
    verify_password,
)
from app.core.validators import normalize_mobile
from app.db import utcnow
from app.models import DeliveryBoy, OtpChallenge, RefreshSession, Seller, User
from app.services import auth_settings, sms
from app.services.cms import get_site

router = APIRouter(prefix="/api/auth", tags=["auth"])


Purpose = Literal["signin", "signup", "any"]


class OtpRequest(BaseModel):
    phone: str
    # signin: only an existing account; signup: only a new one; any: either (older clients)
    purpose: Purpose = "any"
    for_seller: bool = False  # creating an account to sell (checked against the seller sign-up switch)

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_mobile(v)


class OtpVerify(OtpRequest):
    code: str = Field(min_length=4, max_length=8)
    name: str = Field(default="", max_length=120)
    email: EmailStr | None = None
    accept_terms: bool = False
    marketing_opt_in: bool = False


class PasswordLogin(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)
    totp: str = Field(default="", max_length=8)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=12, max_length=200)


class TotpCode(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    email: EmailStr | None = None


async def user_payload(session, user: User) -> dict:
    seller = (await session.execute(select(Seller).where(Seller.user_id == user.id))).scalar_one_or_none()
    partner = (await session.execute(select(DeliveryBoy).where(DeliveryBoy.user_id == user.id))).scalar_one_or_none()
    return {
        # delivery partner summary: the web app sends partners to /delivery with it
        "delivery": {"id": str(partner.id), "kyc_status": partner.kyc_status, "is_active": partner.is_active} if partner else None,
        "id": str(user.id),
        "name": user.name,
        "phone": user.phone,
        "email": user.email,
        "is_admin": user.is_admin,
        "admin_role": (user.admin_role or "owner") if user.is_admin else None,
        "marketing_opt_in": user.marketing_opt_in,
        "totp_enabled": user.totp_enabled,
        "seller": {"id": str(seller.id), "status": seller.status, "display_name": seller.display_name} if seller else None,
    }


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.refresh_cookie_name,
        token,
        max_age=settings.refresh_token_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/api/auth",
    )


async def _issue_session(session, request: Request, response: Response, user: User) -> dict:
    token = new_opaque_token()
    now = utcnow()
    session.add(
        RefreshSession(
            user_id=user.id,
            token_hash=sha256(token),
            created_at=now,
            expires_at=now + timedelta(days=settings.refresh_token_days),
            user_agent=(request.headers.get("user-agent") or "")[:300],
        )
    )
    user.last_login_at = now
    await session.commit()
    _set_refresh_cookie(response, token)
    return {"access_token": create_access_token(user.id, is_admin=user.is_admin), "user": await user_payload(session, user)}


def _require_csrf_header(request: Request) -> None:
    # Cookie-authenticated endpoints need a custom header, which a cross-site form cannot send.
    if request.headers.get("x-requested-with") != "pixcart":
        raise Forbidden("Missing request header")


async def _check_purpose(session, body: OtpRequest) -> User | None:
    """Sign in needs an existing, active account; create-account needs a number that has none."""
    user = (await session.execute(select(User).where(User.phone == body.phone))).scalar_one_or_none()
    if body.purpose == "signin":
        if user is None:
            raise ApiError("No account uses this mobile number yet. Create an account to continue.", "no_account", 404)
        if not user.is_active:
            raise Forbidden("This account has been blocked. Contact support.")
    elif body.purpose == "signup":
        if user is not None:
            raise ApiError("This mobile number already has an account. Sign in instead.", "account_exists", 409)
        cfg = await auth_settings.get(session)
        if not (cfg["seller_signup"] if body.for_seller else cfg["customer_signup"]):
            raise ApiError("New accounts are paused right now. Please try again later.", "signup_closed", 403)
    return user


@router.post("/otp/request")
async def request_otp(body: OtpRequest, request: Request, session: SessionDep) -> dict:
    # Count the attempt before telling anyone whether a number has an account (limits number probing).
    await rate_limit(session, f"otp:ip:{client_ip(request)}", limit=30, window_seconds=3600)
    await session.commit()
    await _check_purpose(session, body)
    now = utcnow()
    latest = (
        await session.execute(
            select(OtpChallenge).where(OtpChallenge.phone == body.phone).order_by(OtpChallenge.created_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if latest and (now - latest.created_at).total_seconds() < settings.otp_resend_cooldown_seconds:
        wait = settings.otp_resend_cooldown_seconds - int((now - latest.created_at).total_seconds())
        raise TooManyRequests(f"Please wait {wait} seconds before requesting another OTP")
    await rate_limit(session, f"otp:phone:{body.phone}", limit=settings.otp_max_per_hour, window_seconds=3600)

    code = generate_otp()
    # Only the newest challenge for a phone is valid.
    await session.execute(
        update(OtpChallenge).where(OtpChallenge.phone == body.phone, OtpChallenge.consumed_at.is_(None)).values(consumed_at=now)
    )
    session.add(
        OtpChallenge(
            phone=body.phone,
            code_hash=hash_otp(body.phone, code),
            expires_at=now + timedelta(seconds=settings.otp_ttl_seconds),
            created_at=now,
            ip=client_ip(request),
        )
    )
    await session.commit()
    try:
        await sms.send_otp(body.phone, code)
    except sms.SmsError as exc:
        raise ApiError(str(exc), "sms_failed", 503) from exc
    out = {"sent": True, "expires_in": settings.otp_ttl_seconds, "resend_in": settings.otp_resend_cooldown_seconds, "length": settings.otp_length}
    if (await auth_settings.dev_otp_status(session))["active"]:
        out["dev_otp"] = code  # test installs only: never in production or with real SMS (see auth_settings)
    return out


@router.get("/options")
async def auth_options(session: SessionDep) -> dict:
    """What the sign-in and create-account screens should offer."""
    cfg = await auth_settings.get(session)
    return {"customer_signup": cfg["customer_signup"], "seller_signup": cfg["seller_signup"], "signup_email": cfg["signup_email"],
            "otp_length": settings.otp_length, "dev_otp": (await auth_settings.dev_otp_status(session))["active"]}


@router.post("/otp/verify")
async def verify_otp(body: OtpVerify, request: Request, response: Response, session: SessionDep) -> dict:
    now = utcnow()
    signup = body.purpose == "signup"
    name = " ".join(body.name.split())
    email = body.email.lower() if body.email else None
    if signup:
        cfg = await auth_settings.get(session)
        if len(name) < 2:
            raise ApiError("Enter your name", "name_required", fields={"name": "Required"})
        if not body.accept_terms:
            raise ApiError("Please accept the terms of use and privacy policy", "terms_required", fields={"accept_terms": "Required"})
        if cfg["signup_email"] == "required" and not email:
            raise ApiError("Enter your email", "email_required", fields={"email": "Required"})
        if cfg["signup_email"] == "hidden":
            email = None
        if email and (await session.execute(select(User.id).where(User.email == email))).first():
            raise ApiError("This email is already used by another account", "email_taken", fields={"email": "Already in use"})
    challenge = (
        await session.execute(
            select(OtpChallenge)
            .where(OtpChallenge.phone == body.phone, OtpChallenge.consumed_at.is_(None))
            .order_by(OtpChallenge.created_at.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if challenge is None or challenge.expires_at < now:
        raise ApiError("This OTP has expired. Please request a new one.", "otp_expired")
    if challenge.attempts >= settings.otp_max_attempts:
        raise TooManyRequests("Too many wrong attempts. Please request a new OTP.")
    if hash_otp(body.phone, body.code.strip()) != challenge.code_hash:
        challenge.attempts += 1
        await session.commit()
        left = settings.otp_max_attempts - challenge.attempts
        raise ApiError(f"Incorrect OTP. {left} attempt(s) left." if left else "Incorrect OTP.", "otp_invalid")
    challenge.consumed_at = now

    user = (await session.execute(select(User).where(User.phone == body.phone))).scalar_one_or_none()
    is_new = user is None
    if user is None:
        if body.purpose == "signin":
            await session.commit()
            raise ApiError("No account uses this mobile number yet. Create an account to continue.", "no_account", 404)
        # Creating an account records acceptance of the terms and privacy notice shown on the screen.
        user = User(phone=body.phone, name=name, email=email, terms_accepted_at=now, marketing_opt_in=bool(signup and body.marketing_opt_in))
        session.add(user)
        await session.flush()
    elif name and not user.name:
        user.name = name
    if not user.is_active:
        await session.commit()
        raise Forbidden("This account has been blocked. Contact support.")
    result = await _issue_session(session, request, response, user)
    result["is_new"] = is_new
    return result


@router.post("/login")
async def password_login(body: PasswordLogin, request: Request, response: Response, session: SessionDep) -> dict:
    email = body.email.lower()
    await rate_limit(session, f"login:{email}", limit=10, window_seconds=900)
    await rate_limit(session, f"login-ip:{client_ip(request)}", limit=50, window_seconds=900)
    await session.commit()
    user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        raise Unauthorized("Incorrect email or password")
    if not user.is_active:
        raise Forbidden("This account has been blocked")
    if user.totp_enabled:
        if not body.totp:
            raise ApiError("Enter the 6-digit code from your authenticator app", "totp_required", 401)
        if not totp.verify(decrypt_field(user.totp_secret_enc), body.totp):
            raise Unauthorized("The authenticator code is not correct")
    return await _issue_session(session, request, response, user)


@router.post("/password")
async def change_password(body: PasswordChange, user: CurrentUser, session: SessionDep) -> dict:
    if not verify_password(body.current_password, user.password_hash):
        raise ApiError("Your current password is not correct", "wrong_password", fields={"current_password": "Incorrect"})
    if not (re.search(r"[a-z]", body.new_password) and re.search(r"[A-Z]", body.new_password) and re.search(r"\d", body.new_password)):
        raise ApiError("Use upper and lower case letters and a number", "weak_password", fields={"new_password": "Too weak"})
    user.password_hash = hash_password(body.new_password)
    await session.execute(update(RefreshSession).where(RefreshSession.user_id == user.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))
    await session.commit()
    return {"ok": True}


@router.post("/totp/setup")
async def totp_setup(user: CurrentUser, session: SessionDep) -> dict:
    if user.totp_enabled:
        raise ApiError("Two-step sign-in is already on", "totp_on")
    secret = totp.new_secret()
    user.totp_secret_enc = encrypt_field(secret)
    await session.commit()
    return {"secret": secret, "uri": totp.uri(secret, user.email or user.phone or str(user.id), issuer=(await get_site(session))["brand_name"])}


@router.post("/totp/enable")
async def totp_enable(body: TotpCode, user: CurrentUser, session: SessionDep) -> dict:
    if not user.totp_secret_enc or not totp.verify(decrypt_field(user.totp_secret_enc), body.code):
        raise ApiError("That code is not correct. Check the time on your phone and try again.", "totp_invalid")
    user.totp_enabled = True
    await session.commit()
    return {"ok": True}


@router.post("/totp/disable")
async def totp_disable(body: TotpCode, user: CurrentUser, session: SessionDep) -> dict:
    if not user.totp_enabled or not totp.verify(decrypt_field(user.totp_secret_enc), body.code):
        raise ApiError("That code is not correct", "totp_invalid")
    user.totp_enabled, user.totp_secret_enc = False, None
    await session.commit()
    return {"ok": True}


@router.post("/refresh")
async def refresh(request: Request, response: Response, session: SessionDep) -> dict:
    _require_csrf_header(request)
    token = request.cookies.get(settings.refresh_cookie_name)
    if not token:
        raise Unauthorized()
    now = utcnow()
    row = (
        await session.execute(select(RefreshSession).where(RefreshSession.token_hash == sha256(token)).with_for_update())
    ).scalar_one_or_none()
    if row is None:
        raise Unauthorized()
    if row.revoked_at is not None:
        # A rotated token was replayed: assume theft and end every session of this user.
        await session.execute(
            update(RefreshSession).where(RefreshSession.user_id == row.user_id, RefreshSession.revoked_at.is_(None)).values(revoked_at=now)
        )
        await session.commit()
        response.delete_cookie(settings.refresh_cookie_name, path="/api/auth")
        raise Unauthorized()
    if row.expires_at < now:
        raise Unauthorized()
    user = await session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise Unauthorized()
    row.revoked_at = now
    return await _issue_session(session, request, response, user)


@router.post("/logout")
async def logout(request: Request, response: Response, session: SessionDep) -> dict:
    _require_csrf_header(request)
    token = request.cookies.get(settings.refresh_cookie_name)
    if token:
        await session.execute(
            update(RefreshSession).where(RefreshSession.token_hash == sha256(token), RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow())
        )
        await session.commit()
    response.delete_cookie(settings.refresh_cookie_name, path="/api/auth")
    return {"ok": True}


@router.get("/me")
async def me(user: CurrentUser, session: SessionDep) -> dict:
    return await user_payload(session, user)


@router.patch("/me")
async def update_me(body: ProfileUpdate, user: CurrentUser, session: SessionDep) -> dict:
    if body.name is not None:
        user.name = body.name.strip()
    if body.email is not None:
        email = body.email.lower()
        taken = (await session.execute(select(User.id).where(User.email == email, User.id != user.id))).first()
        if taken:
            raise ApiError("This email is already used by another account", "email_taken", fields={"email": "Already in use"})
        user.email = email
    await session.commit()
    return await user_payload(session, user)
