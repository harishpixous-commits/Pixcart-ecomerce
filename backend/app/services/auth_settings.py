"""Sign-in and account settings, edited in Admin → Sign-in and accounts. Stored in ``platform_settings['auth']``.

Covers who may sign up, the one-time code rules (length, validity, resend wait, attempts, hourly limits), password
sign-in lockout, the password policy, how long staff and customers stay signed in, sign-in alerts, and whether staff
must use two-step sign-in. Defaults come from the environment (``config.py``) so an install behaves as before until
the owner changes something.

``show_dev_otp`` puts the one-time code on the sign-in screen so a test install works without an SMS
provider. It can never apply in production or once real SMS (MSG91) is connected: ``dev_otp_status``
checks all three conditions on every request, whatever the stored switch says.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as env
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import PlatformSetting

KEY = "auth"
EMAIL_MODES = ("optional", "required", "hidden")
ALERT_MODES = ("off", "staff", "everyone")
DEFAULTS: dict[str, Any] = {
    "show_dev_otp": True,        # testing only; ignored in production and when SMS is connected
    "customer_signup": True,     # new customers can create an account
    "seller_signup": True,       # new sellers can register from "Become a seller"
    "signup_email": "optional",  # ask for an email when creating an account: optional | required | hidden
    # one-time codes (customers, sellers, delivery partners)
    "otp_length": env.otp_length,
    "otp_ttl_seconds": env.otp_ttl_seconds,
    "otp_resend_cooldown_seconds": env.otp_resend_cooldown_seconds,
    "otp_max_attempts": env.otp_max_attempts,
    "otp_max_per_hour": env.otp_max_per_hour,      # codes per mobile number per hour
    "otp_max_per_ip_hour": 30,                     # codes per network per hour (stops number probing)
    # password sign-in (staff)
    "login_max_attempts": 10,                      # wrong passwords before the account waits
    "login_lockout_minutes": 15,
    "password_min_length": 12,
    "password_require_mixed": True,                # upper and lower case letters and a number
    "staff_require_two_step": False,               # staff must turn on two-step sign-in to use the admin panel
    # sessions and alerts
    "customer_session_days": env.refresh_token_days,
    "staff_session_days": env.refresh_token_days,
    "login_alerts": "staff",                       # tell people about a sign-in from a new device: off | staff | everyone
}

# key -> (lowest, highest)
INTS: dict[str, tuple[int, int]] = {
    "otp_length": (4, 8),
    "otp_ttl_seconds": (60, 900),
    "otp_resend_cooldown_seconds": (15, 120),
    "otp_max_attempts": (3, 10),
    "otp_max_per_hour": (3, 20),
    "otp_max_per_ip_hour": (10, 500),
    "login_max_attempts": (3, 50),
    "login_lockout_minutes": (5, 1440),
    "password_min_length": (8, 64),
    "customer_session_days": (1, 365),
    "staff_session_days": (1, 90),
}
CHOICES: dict[str, tuple[str, ...]] = {"signup_email": EMAIL_MODES, "login_alerts": ALERT_MODES}


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
        if k in CHOICES:
            if v not in CHOICES[k]:
                raise AuthSettingsError(f"{k} must be one of: {', '.join(CHOICES[k])}")
        elif k in INTS:
            lo, hi = INTS[k]
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise AuthSettingsError(f"{k} must be a whole number from {lo} to {hi}")
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


def password_problem(cfg: dict[str, Any], password: str) -> str | None:
    """Why a new password is not allowed under the owner's policy, or None. One rule for every password screen."""
    if len(password) < cfg["password_min_length"]:
        return f"Use at least {cfg['password_min_length']} characters"
    if cfg["password_require_mixed"] and not (re.search(r"[a-z]", password) and re.search(r"[A-Z]", password) and re.search(r"\d", password)):
        return "Use upper and lower case letters and a number"
    return None


def session_days(cfg: dict[str, Any], is_staff: bool) -> int:
    return int(cfg["staff_session_days"] if is_staff else cfg["customer_session_days"])


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
