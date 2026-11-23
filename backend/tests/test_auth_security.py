"""Sign-in security settings (Admin → Sign-in and accounts): one-time code rules, password lockout and policy, how long
people stay signed in, sign-in alerts and required two-step sign-in for staff."""
from __future__ import annotations

import httpx
from sqlalchemy import select

from app.config import settings as env
from app.core import totp
from app.core.security import decrypt_field
from app.db import SessionLocal
from app.main import app
from app.models import Notification, User
from app.services import sms
from tests.conftest import Api, login_phone

URL = "/api/admin/auth-settings"


def browser(ua: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"user-agent": ua})


async def staff(client, admin: Api, email: str, role: str = "support", password: str = "Staff@2026xyz") -> Api:
    r = await admin.post("/api/admin/staff", {"email": email, "name": role.title(), "role": role, "password": password})
    assert r.status_code in (200, 201), r.text
    r = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


async def test_defaults_follow_the_environment(admin):
    s = (await admin.get(URL)).json()
    cfg = s["settings"]
    assert cfg["otp_length"] == env.otp_length and cfg["otp_ttl_seconds"] == env.otp_ttl_seconds
    assert cfg["customer_session_days"] == cfg["staff_session_days"] == env.refresh_token_days
    assert cfg["password_min_length"] == 12 and cfg["password_require_mixed"] is True
    assert cfg["login_alerts"] == "staff" and cfg["staff_require_two_step"] is False
    assert s["limits"]["otp_length"] == [4, 8]


async def test_validation(admin):
    for body in ({"otp_length": 3}, {"otp_length": 9}, {"otp_length": "6"}, {"otp_length": True}, {"otp_ttl_seconds": 30},
                 {"login_max_attempts": 0}, {"password_min_length": 7}, {"staff_session_days": 91}, {"login_alerts": "sometimes"},
                 {"password_require_mixed": "yes"}, {"unknown": 1}):
        r = await admin.put(URL, body)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_settings", (body, r.text)


async def test_code_length_and_attempts(client, admin):
    assert (await admin.put(URL, {"otp_length": 4, "otp_max_attempts": 3})).status_code == 200
    assert (await client.get("/api/auth/options")).json()["otp_length"] == 4
    r = await client.post("/api/auth/otp/request", json={"phone": "9720000001"})
    assert r.status_code == 200 and r.json()["length"] == 4
    code = sms.DEV_OUTBOX["9720000001"]
    assert len(code) == 4
    wrong = "0000" if code != "0000" else "1111"
    for _ in range(3):
        r = await client.post("/api/auth/otp/verify", json={"phone": "9720000001", "code": wrong, "name": "Ravi", "purpose": "signup", "accept_terms": True})
        assert r.status_code == 400
    r = await client.post("/api/auth/otp/verify", json={"phone": "9720000001", "code": code, "name": "Ravi", "purpose": "signup", "accept_terms": True})
    assert r.status_code == 429  # three wrong tries use the code up


async def test_lockout_after_wrong_passwords(client, admin):
    r = await admin.post("/api/admin/staff", {"email": "lock@kadai.in", "name": "Lock", "role": "support", "password": "Staff@2026xyz"})
    assert r.status_code == 201, r.text
    assert (await admin.put(URL, {"login_max_attempts": 3, "login_lockout_minutes": 5})).status_code == 200
    for _ in range(3):
        assert (await client.post("/api/auth/login", json={"email": "lock@kadai.in", "password": "wrong"})).status_code == 401
    # even the right password waits now
    r = await client.post("/api/auth/login", json={"email": "lock@kadai.in", "password": "Staff@2026xyz"})
    assert r.status_code == 429


async def test_password_policy_everywhere(client, admin):
    assert (await admin.put(URL, {"password_min_length": 16})).status_code == 200
    r = await admin.post("/api/auth/password", {"current_password": "Admin@12345", "new_password": "Short@2026abc"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "weak_password" and "16" in r.json()["error"]["message"]
    r = await admin.post("/api/admin/staff", {"email": "x@kadai.in", "name": "Xavier", "role": "support", "password": "Short@2026abc"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "weak_password"
    # mixed case can be switched off; the length still counts
    assert (await admin.put(URL, {"password_require_mixed": False})).status_code == 200
    r = await admin.post("/api/auth/password", {"current_password": "Admin@12345", "new_password": "a long passphrase here"})
    assert r.status_code == 200, r.text
    assert (await client.get("/api/auth/options")).json()["password_min_length"] == 16


async def test_session_length_by_kind(client, admin):
    assert (await admin.put(URL, {"staff_session_days": 7, "customer_session_days": 60})).status_code == 200
    r = await client.post("/api/auth/login", json={"email": "admin@pixcart.in", "password": "Admin@12345"})
    assert f"Max-Age={7 * 86400}" in r.headers["set-cookie"]
    client.cookies.clear()
    await client.post("/api/auth/otp/request", json={"phone": "9720000002"})
    r = await client.post("/api/auth/otp/verify", json={"phone": "9720000002", "code": sms.DEV_OUTBOX["9720000002"], "name": "Asha",
                                                         "purpose": "signup", "accept_terms": True})
    assert f"Max-Age={60 * 86400}" in r.headers["set-cookie"]


async def test_alert_on_a_new_device(admin):
    login = {"email": "admin@pixcart.in", "password": "Admin@12345"}
    async with browser("Mozilla/5.0 (Windows NT 10.0) Chrome/131.0 Safari/537.36") as laptop, \
            browser("Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36") as phone:
        assert (await laptop.post("/api/auth/login", json=login)).status_code == 200
        assert (await laptop.post("/api/auth/login", json=login)).status_code == 200  # same device: no alert
        assert (await phone.post("/api/auth/login", json=login)).status_code == 200   # new device: alert
    async with SessionLocal() as s:
        rows = (await s.execute(select(Notification).where(Notification.event == "security_notice", Notification.channel == "inapp"))).scalars().all()
    subjects = [r.subject for r in rows]
    # one alert per new device (the laptop was new too: the test client signed in before); none for the repeat
    assert sorted(subjects) == ["Security notice: new sign-in on Chrome on Android", "Security notice: new sign-in on Chrome on Windows"], subjects


async def test_staff_must_use_two_step(client, admin):
    helper = await staff(client, admin, "desk@kadai.in")
    # the owner must have it first, so they are never locked out
    r = await admin.put(URL, {"staff_require_two_step": True})
    assert r.status_code == 400 and r.json()["error"]["code"] == "two_step_self"
    r = await admin.post("/api/auth/totp/setup")
    async with SessionLocal() as s:
        secret = decrypt_field((await s.get(User, admin.user["id"])).totp_secret_enc)
    assert (await admin.post("/api/auth/totp/enable", {"code": totp.current(secret)})).status_code == 200
    assert (await admin.put(URL, {"staff_require_two_step": True})).status_code == 200

    # staff without it: the panel tells them what to do, and every admin action waits
    me = await helper.get("/api/admin/me")
    assert me.status_code == 200 and me.json()["two_step_required"] is True
    r = await helper.get("/api/admin/orders")
    assert r.status_code == 403 and r.json()["error"]["code"] == "two_step_required"
    # the owner (who has it) carries on
    assert (await admin.get("/api/admin/orders")).status_code == 200
    assert (await admin.get("/api/admin/me")).json()["two_step_required"] is False
    # customers are not affected
    shopper = await login_phone(client, "9720000003", "Meena")
    assert (await shopper.get("/api/orders")).status_code == 200
