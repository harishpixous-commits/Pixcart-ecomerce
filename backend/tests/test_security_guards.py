"""Separation of duties: staff with the "customers" permission cannot switch staff accounts back on, sign staff out or
take over a seller by changing the owner's mobile; two-step sign-in cannot be guessed off or removed quietly."""
from __future__ import annotations

import uuid

from sqlalchemy import select

from app.core import totp
from app.db import SessionLocal
from app.models import Notification
from tests.test_delivery import staff_with_role
from tests.test_phase2_money import setup


async def test_customers_permission_cannot_touch_staff_or_take_over_sellers(client, admin, categories):
    support = await staff_with_role(client, "support", "desk@kadai.in")  # has "customers", not "sellers"
    leaver = await staff_with_role(client, "operations", "leaver@kadai.in")
    # the owner switches a departing employee off in Staff and roles
    assert (await admin.patch(f"/api/admin/staff/{leaver.user['id']}", {"is_active": False})).status_code == 200
    r = await support.post(f"/api/admin/customers/{leaver.user['id']}/unblock")
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_target"
    r = await support.post(f"/api/admin/customers/{admin.user['id']}/sign-out")
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_target"

    # a seller's owner: support may fix the name, not the mobile or email they sign in with
    tn, _ka, _shirt, _phone = await setup(client, admin, categories)
    owner_id = tn.user["id"]
    assert (await support.patch(f"/api/admin/customers/{owner_id}", {"name": "Kovai Owner"})).status_code == 200
    r = await support.patch(f"/api/admin/customers/{owner_id}", {"phone": "9811111111"})
    assert r.status_code == 403 and "manage sellers" in r.json()["error"]["message"]
    assert (await support.patch(f"/api/admin/customers/{owner_id}", {"email": "thief@example.com"})).status_code == 403
    # the owner role may, and the seller is told on the old contact details first
    r = await admin.patch(f"/api/admin/customers/{owner_id}", {"phone": "9811111111"})
    assert r.status_code == 200, r.text
    async with SessionLocal() as s:
        sent = (await s.execute(select(Notification).where(Notification.user_id == uuid.UUID(owner_id), Notification.event == "security_notice"))).scalars().all()
    assert sent and "mobile number" in sent[0].body


async def test_turning_off_two_step_sign_in_needs_the_password_and_is_rate_limited(client, admin):
    r = await admin.post("/api/admin/staff", {"email": "lock@kadai.in", "name": "Lock Test", "role": "support", "password": "Support@Desk2026"})
    assert r.status_code == 201
    h = {"Authorization": f"Bearer {(await client.post('/api/auth/login', json={'email': 'lock@kadai.in', 'password': 'Support@Desk2026'})).json()['access_token']}"}
    secret = (await client.post("/api/auth/totp/setup", headers=h)).json()["secret"]
    assert (await client.post("/api/auth/totp/enable", json={"code": totp.current(secret)}, headers=h)).status_code == 200
    # a stolen session without the password cannot remove it, even with a valid code
    r = await client.post("/api/auth/totp/disable", json={"code": totp.current(secret)}, headers=h)
    assert r.status_code == 400 and r.json()["error"]["code"] == "wrong_password"
    # every code attempt counts (turning it on was the 1st, the refused one above the 2nd): 5 in 15 minutes, then refused
    for _ in range(2):
        assert (await client.post("/api/auth/totp/disable", json={"code": "000000", "password": "Support@Desk2026"}, headers=h)).status_code == 400
    r = await client.post("/api/auth/totp/disable", json={"code": totp.current(secret), "password": "Support@Desk2026"}, headers=h)
    assert r.status_code == 200, r.text  # 5th attempt, right code and password
    me = (await client.get("/api/admin/me", headers=h)).json()
    assert me["totp_enabled"] is False
    async with SessionLocal() as s:
        uid = (await client.get("/api/auth/me", headers=h)).json()["id"]
        sent = (await s.execute(select(Notification).where(Notification.user_id == uuid.UUID(uid), Notification.event == "security_notice"))).scalars().all()
    assert sent and "two-step sign-in" in sent[0].subject.lower()
    assert (await client.post("/api/auth/totp/enable", json={"code": "123456"}, headers=h)).status_code == 429
