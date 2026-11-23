"""Signed-in devices: a shopper or staff member sees where they are signed in and signs every other device out."""
from __future__ import annotations

import asyncio
from datetime import timedelta

import httpx

from sqlalchemy import update

from app.db import SessionLocal, utcnow
from app.main import app
from app.models import AuditLog, OtpChallenge, User
from app.services import sms

CSRF = {"x-requested-with": "pixcart"}
PHONE = "9711111111"
UA = {"phone": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
      "laptop": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0"}


def device(ua: str) -> httpx.AsyncClient:
    """One browser: its own cookie jar (the refresh cookie) and user agent."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers={"user-agent": ua})


async def sign_in(c: httpx.AsyncClient) -> str:
    async with SessionLocal() as s:  # as if the last code was sent a while ago (the resend wait is not under test)
        await s.execute(update(OtpChallenge).values(created_at=utcnow() - timedelta(minutes=10)))
        await s.commit()
    assert (await c.post("/api/auth/otp/request", json={"phone": PHONE})).status_code == 200
    r = await c.post("/api/auth/otp/verify", json={"phone": PHONE, "code": sms.DEV_OUTBOX[PHONE], "name": "Divya"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def test_list_and_sign_out_others():
    async with device(UA["phone"]) as phone, device(UA["laptop"]) as laptop:
        t_phone = await sign_in(phone)
        t_laptop = await sign_in(laptop)

        r = await laptop.get("/api/auth/sessions", headers=bearer(t_laptop))
        assert r.status_code == 200, r.text
        rows = r.json()["sessions"]
        assert sorted(x["device"] for x in rows) == ["Chrome on Android", "Edge on Windows"]
        assert [x["device"] for x in rows if x["current"]] == ["Edge on Windows"]
        assert "Mozilla" not in r.text  # never the raw header

        await asyncio.sleep(1.1)  # tokens carry whole seconds
        r = await laptop.post("/api/auth/sessions/sign-out-others", headers=bearer(t_laptop) | CSRF)
        assert r.status_code == 200 and r.json() == {"signed_out": 1}

        # the phone is out: its access token is refused and it cannot renew it
        assert (await phone.get("/api/auth/me", headers=bearer(t_phone))).status_code == 401
        assert (await phone.post("/api/auth/refresh", headers=CSRF)).status_code == 401
        # the laptop renews with its own session and carries on
        r = await laptop.post("/api/auth/refresh", headers=CSRF)
        assert r.status_code == 200, r.text
        t_laptop = r.json()["access_token"]
        assert (await laptop.get("/api/auth/me", headers=bearer(t_laptop))).status_code == 200
        assert [x["device"] for x in (await laptop.get("/api/auth/sessions", headers=bearer(t_laptop))).json()["sessions"]] == ["Edge on Windows"]

    async with SessionLocal() as s:
        user = (await s.execute(User.__table__.select().where(User.phone.like(f"%{PHONE}")))).first()
        assert user is not None
        actions = (await s.execute(AuditLog.__table__.select().where(AuditLog.action == "account.sign_out_others"))).all()
        assert len(actions) == 1


async def test_needs_sign_in_and_the_header():
    async with device(UA["phone"]) as phone:
        assert (await phone.get("/api/auth/sessions")).status_code == 401
        assert (await phone.post("/api/auth/sessions/sign-out-others", headers=CSRF)).status_code == 401
        token = await sign_in(phone)
        # a cross-site form cannot send the custom header
        assert (await phone.post("/api/auth/sessions/sign-out-others", headers=bearer(token))).status_code == 403
        assert (await phone.get("/api/auth/me", headers=bearer(token))).status_code == 200
