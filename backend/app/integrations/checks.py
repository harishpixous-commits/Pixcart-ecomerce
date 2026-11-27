""""Test connection" for each provider: one harmless, read-only call with the saved credentials.

Only MSG91 and email send something, and only to the number or address the admin types in, so
the admin can see a real SMS or email arrive. Every check has a short timeout and returns a
message an admin can act on; provider error bodies are trimmed and never include our secrets.
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr

import httpx

from app.config import Settings

log = logging.getLogger("pixcart.integrations")

# Tests replace this with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


@dataclass
class CheckResult:
    ok: bool
    message: str


def _client(base_url: str, **kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(10.0, connect=5.0), transport=transport, **kw)


def _err(r: httpx.Response) -> str:
    try:
        data = r.json()
    except ValueError:
        return r.text[:160]
    if isinstance(data, dict):
        e = data.get("error")
        if isinstance(e, dict):
            return str(e.get("description") or e.get("message") or "")[:160]
        return str(data.get("message") or e or "")[:160]
    return ""


async def razorpay(cfg: Settings, **_) -> CheckResult:
    if not cfg.razorpay_enabled:
        return CheckResult(False, "Enter the Key ID and Key secret first.")
    async with _client(cfg.razorpay_api_base, auth=(cfg.razorpay_key_id, cfg.razorpay_key_secret)) as c:
        r = await c.get("/orders", params={"count": 1})
    if r.status_code == 401:
        return CheckResult(False, "Razorpay rejected the Key ID or Key secret. Copy both again from the dashboard.")
    if r.status_code >= 400:
        return CheckResult(False, f"Razorpay answered {r.status_code}: {_err(r)}")
    mode = "test" if cfg.razorpay_key_id.startswith("rzp_test_") else "live"
    extra = "" if cfg.razorpay_webhook_secret else " Add the webhook secret too."
    return CheckResult(True, f"Connected to Razorpay in {mode} mode.{extra}")


async def _gateway(code: str, label: str, cfg: Settings) -> CheckResult:
    from app.services import gateways

    if not gateways.configured(cfg, code):
        return CheckResult(False, f"Enter the {label} keys first.")
    adapter = gateways.build(cfg, code, timeout=10.0)
    try:
        await adapter.ping()
    except gateways.GatewayError as exc:
        return CheckResult(False, f"{label} did not accept the keys: {exc}")
    mode = "test" if adapter.sandbox else "live"
    return CheckResult(True, f"Connected to {label} in {mode} mode.")


async def cashfree(cfg: Settings, **_) -> CheckResult:
    return await _gateway("cashfree", "Cashfree", cfg)


async def phonepe(cfg: Settings, **_) -> CheckResult:
    return await _gateway("phonepe", "PhonePe", cfg)


async def payu(cfg: Settings, **_) -> CheckResult:
    return await _gateway("payu", "PayU", cfg)


async def stripe(cfg: Settings, **_) -> CheckResult:
    return await _gateway("stripe", "Stripe", cfg)


async def razorpayx(cfg: Settings, **_) -> CheckResult:
    if not cfg.razorpay_enabled:
        return CheckResult(False, "RazorpayX uses the Razorpay API keys. Fill them in under Razorpay payments first.")
    if not cfg.razorpayx_account_number:
        return CheckResult(False, "Enter your RazorpayX account number first.")
    async with _client(cfg.razorpay_api_base, auth=(cfg.razorpay_key_id, cfg.razorpay_key_secret)) as c:
        r = await c.get("/transactions", params={"account_number": cfg.razorpayx_account_number, "count": 1})
    if r.status_code == 401:
        return CheckResult(False, "RazorpayX rejected the API keys.")
    if r.status_code >= 400:
        return CheckResult(False, f"RazorpayX answered {r.status_code}: {_err(r)}. Check the account number and that this server's IP is allowlisted.")
    return CheckResult(True, "Connected to RazorpayX. Payouts will be sent from this account.")


async def msg91(cfg: Settings, *, phone: str = "", **_) -> CheckResult:
    if not (cfg.msg91_auth_key and cfg.msg91_otp_template_id):
        return CheckResult(False, "Enter the auth key and OTP template ID first.")
    if not phone:
        return CheckResult(False, "Enter your 10-digit mobile number to receive a test OTP.")
    async with _client(cfg.msg91_api_base) as c:
        r = await c.post(
            "/api/v5/otp",
            params={"template_id": cfg.msg91_otp_template_id, "mobile": f"91{phone}", "otp": "123456"},
            headers={"authkey": cfg.msg91_auth_key, "accept": "application/json"},
        )
    body_type = ""
    try:
        body_type = r.json().get("type", "")
    except ValueError:
        pass
    if r.status_code >= 400 or body_type == "error":
        return CheckResult(False, f"MSG91 did not send the SMS: {_err(r) or r.status_code}")
    return CheckResult(True, f"MSG91 accepted the test OTP 123456 for {phone[:2]}••••{phone[-2:]}. It should arrive within a minute.")


def _smtp_send(cfg: Settings, to: str, brand: str) -> None:
    if cfg.smtp_security == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=15, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=15)
    with server as s:
        if cfg.smtp_security == "starttls":
            s.starttls(context=ssl.create_default_context())
        if cfg.smtp_user:
            s.login(cfg.smtp_user, cfg.smtp_password)
        if to:
            msg = EmailMessage()
            sender = cfg.smtp_from or cfg.smtp_user
            msg["From"] = sender if "<" in sender else formataddr((brand, sender))
            msg["To"] = to
            msg["Subject"] = f"{brand}: test email"
            msg.set_content("This is a test email from Admin → Integrations. Email is working.")
            s.send_message(msg)


async def email(cfg: Settings, *, to: str = "", brand: str = "", **_) -> CheckResult:
    if not (cfg.smtp_host and cfg.smtp_from):
        return CheckResult(False, "Enter the SMTP host and sender address first.")
    try:
        await asyncio.wait_for(asyncio.to_thread(_smtp_send, cfg, to, brand or cfg.app_name), timeout=25)
    except smtplib.SMTPAuthenticationError:
        return CheckResult(False, "The SMTP server rejected the user or password.")
    except (smtplib.SMTPException, OSError, TimeoutError) as exc:
        return CheckResult(False, f"Could not reach the SMTP server: {str(exc)[:160] or type(exc).__name__}")
    return CheckResult(True, f"Signed in to {cfg.smtp_host}." + (f" A test email was sent to {to}." if to else ""))


async def whatsapp(cfg: Settings, **_) -> CheckResult:
    if not (cfg.whatsapp_token and cfg.whatsapp_phone_number_id):
        return CheckResult(False, "Enter the phone number ID and token first.")
    async with _client(cfg.whatsapp_api_base) as c:
        r = await c.get(
            f"/{cfg.whatsapp_api_version}/{cfg.whatsapp_phone_number_id}",
            params={"fields": "display_phone_number,verified_name"},
            headers={"Authorization": f"Bearer {cfg.whatsapp_token}"},
        )
    if r.status_code >= 400:
        return CheckResult(False, f"WhatsApp answered {r.status_code}: {_err(r)}")
    data = r.json()
    return CheckResult(True, f"Connected to {data.get('verified_name') or 'your business'} ({data.get('display_phone_number', 'number verified')}).")


async def shiprocket(cfg: Settings, **_) -> CheckResult:
    if not (cfg.shiprocket_email and cfg.shiprocket_password):
        return CheckResult(False, "Enter the API user email and password first.")
    async with _client(cfg.shiprocket_api_base) as c:
        r = await c.post("/auth/login", json={"email": cfg.shiprocket_email, "password": cfg.shiprocket_password})
    if r.status_code >= 400 or "token" not in (r.json() if r.headers.get("content-type", "").startswith("application/json") else {}):
        return CheckResult(False, f"Shiprocket login failed: {_err(r) or r.status_code}. Use the API user, not your own login.")
    return CheckResult(True, "Signed in to Shiprocket.")


async def ai(cfg: Settings, *, model: str = "", **_) -> CheckResult:
    if not cfg.anthropic_api_key:
        return CheckResult(False, "Enter the API key first.")
    async with _client(cfg.anthropic_api_base) as c:
        r = await c.get("/v1/models", params={"limit": 100}, headers={"x-api-key": cfg.anthropic_api_key, "anthropic-version": "2023-06-01"})
    if r.status_code == 401:
        return CheckResult(False, "Anthropic rejected the API key. Create a new key at console.anthropic.com.")
    if r.status_code >= 400:
        return CheckResult(False, f"Anthropic answered {r.status_code}: {_err(r)}")
    ids = [m.get("id", "") for m in r.json().get("data", [])]
    if model and ids and model not in ids:
        return CheckResult(False, f"Connected, but the model chosen in AI studio ({model}) is not available to this key. Pick another model there.")
    return CheckResult(True, "Connected to Claude." + (f" Model {model} is available." if model else ""))


async def sentry(cfg: Settings, **_) -> CheckResult:
    if not cfg.sentry_dsn:
        return CheckResult(False, "Enter the DSN first.")
    try:
        import sentry_sdk

        sentry_sdk.capture_message("Test event from Admin → Integrations", level="info")
        await asyncio.to_thread(sentry_sdk.flush, 5)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(False, f"Could not send a test event: {str(exc)[:160]}")
    return CheckResult(True, "A test event was sent. It shows up in Sentry → Issues within a minute.")


async def firebase(cfg: Settings, **_) -> CheckResult:
    from app.services import push

    if not push.configured(cfg):
        return CheckResult(False, "Enter the project ID, service account email and private key first.")
    try:
        push._token = None  # always ask Google again
        await push.access_token(cfg)
    except (ValueError, TypeError) as exc:  # the key text is not a valid PEM key
        return CheckResult(False, f"The private key could not be read: {str(exc)[:120]}. Copy private_key from the JSON file again.")
    except RuntimeError as exc:
        return CheckResult(False, str(exc)[:200])
    return CheckResult(True, f"Signed in to Firebase project {cfg.firebase_project_id}. Devices can now receive push notifications.")


CHECKS = {
    "razorpay": razorpay,
    "razorpayx": razorpayx,
    "cashfree": cashfree,
    "phonepe": phonepe,
    "payu": payu,
    "stripe": stripe,
    "msg91": msg91,
    "email": email,
    "whatsapp": whatsapp,
    "firebase": firebase,
    "shiprocket": shiprocket,
    "ai": ai,
    "sentry": sentry,
}


async def run(key: str, cfg: Settings, **params) -> CheckResult:
    check = CHECKS.get(key)
    if check is None:
        return CheckResult(False, "This integration has no connection test.")
    try:
        return await check(cfg, **params)
    except httpx.TimeoutException:
        return CheckResult(False, "The provider did not answer within 10 seconds. Try again in a minute.")
    except httpx.HTTPError as exc:
        log.warning("integration check %s failed: %s", key, exc)
        return CheckResult(False, "Could not reach the provider from this server. Check outbound internet access (NAT gateway).")
