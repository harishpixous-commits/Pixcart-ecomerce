"""Sign-in and account settings, edited in Admin → Sign-in and accounts. Stored in ``platform_settings['auth']``.

``show_dev_otp`` puts the one-time code on the sign-in screen so a test install works without an SMS
provider. It can never apply in production or once real SMS (MSG91) is connected: ``dev_otp_status``
checks all three conditions on every request, whatever the stored switch says.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as env
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import PlatformSetting

KEY = "auth"
EMAIL_MODES = ("optional", "required", "hidden")
DEFAULTS: dict[str, Any] = {
    "show_dev_otp": True,        # testing only; ignored in production and when SMS is connected
    "customer_signup": True,     # new customers can create an account
    "seller_signup": True,       # new sellers can register from "Become a seller"
    "signup_email": "optional",  # ask for an email when creating an account: optional | required | hidden
}


class AuthSettingsError(ValueError):
    pass


async def get(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    out = dict(DEFAULTS)
    if row:
        out.update({k: v for k, v in (row.value or {}).items() if k in DEFAULTS})
    return out


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in DEFAULTS:
            raise AuthSettingsError(f"Unknown setting: {k}")
        if k == "signup_email":
            if v not in EMAIL_MODES:
                raise AuthSettingsError("Choose optional, required or hidden for the email field")
        elif not isinstance(v, bool):
            raise AuthSettingsError(f"{k} must be on or off")
        clean[k] = v
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


async def dev_otp_status(session: AsyncSession) -> dict[str, Any]:
    """Whether the code is shown on screen right now, and why (for the admin page)."""
    cfg = await get(session)
    sms = (await get_integrations(session)).sms_provider
    if env.environment == "production":
        return {"active": False, "reason": "Never shown in production."}
    if sms != "console":
        return {"active": False, "reason": "Real SMS is connected, so codes go by SMS only."}
    if not cfg["show_dev_otp"]:
        return {"active": False, "reason": "Switched off. Codes are only in the server log."}
    return {"active": True, "reason": "Test mode: the code appears under the code box on the sign-in screen."}
