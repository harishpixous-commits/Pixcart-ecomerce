"""OTP delivery. 'console' logs the code (development only); 'msg91' sends a DLT-registered OTP SMS."""
from __future__ import annotations

import logging

import httpx

from app.config import settings
from app.integrations import get as get_integrations

log = logging.getLogger("pixcart.sms")

# Development/test outbox so the code can be read in local runs and tests. Never used in production
# (in production the console provider refuses to send instead of logging codes).
DEV_OUTBOX: dict[str, str] = {}


# Tests replace this with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


class SmsError(Exception):
    pass


async def send_otp(phone: str, code: str) -> None:
    cfg = await get_integrations()
    if cfg.sms_provider == "console":
        if settings.environment == "production":
            # Never print OTPs in production logs; switch on MSG91 in Admin → Integrations.
            raise SmsError("Sign-in by OTP is not set up yet. Please try again later.")
        DEV_OUTBOX[phone] = code
        log.warning("DEV OTP for %s: %s", phone, code)
        return
    if cfg.sms_provider == "msg91":
        if not cfg.msg91_auth_key or not cfg.msg91_otp_template_id:
            raise SmsError("MSG91 is not configured")
        async with httpx.AsyncClient(base_url=cfg.msg91_api_base, timeout=10, transport=transport) as client:
            resp = await client.post(
                "/api/v5/otp",
                params={"template_id": cfg.msg91_otp_template_id, "mobile": f"91{phone}", "otp": code},
                headers={"authkey": cfg.msg91_auth_key, "accept": "application/json"},
            )
        if resp.status_code >= 400 or resp.json().get("type") == "error":
            log.error("MSG91 send failed: %s %s", resp.status_code, resp.text[:300])
            raise SmsError("Could not send the OTP right now")
        return
    raise SmsError(f"Unknown SMS provider {cfg.sms_provider}")
