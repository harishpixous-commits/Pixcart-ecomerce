"""Before each recording (demo database only): cancel open orders left by earlier takes, so no stray delivery request
pops up, and let demo partners hold more cash so repeated cash-on-delivery takes keep getting requests."""
import asyncio
import os
import sys

import httpx

sys.path.insert(0, os.getcwd())
from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import SubOrder  # noqa: E402

BASE = "http://localhost:3200"
H = {"X-Requested-With": "pixcart"}


async def main():
    async with httpx.AsyncClient(base_url=BASE, headers=H, timeout=60) as c:
        tok = (await c.post("/api/auth/login", json={"email": "admin@pixcart.in", "password": os.environ["ADMIN_PW"]})).json()["access_token"]
        auth = {"Authorization": f"Bearer {tok}"}
        r = await c.put("/api/admin/delivery/settings", json={"cod_limit_paise": 5_000_000}, headers=auth)
        print("cash limit", r.status_code)
        # many takes from one computer: more codes per number and per network on this demo install only
        r = await c.put("/api/admin/auth-settings", json={"otp_max_per_hour": 20, "otp_resend_cooldown_seconds": 15, "otp_max_per_ip_hour": 500}, headers=auth)
        print("code limits", r.status_code)
        async with SessionLocal() as s:
            from sqlalchemy import delete, or_

            from app.models import OtpChallenge, RateLimitEvent
            await s.execute(delete(RateLimitEvent).where(or_(RateLimitEvent.key.like("otp:%"), RateLimitEvent.key.like("login%"))))
            await s.execute(delete(OtpChallenge))
            await s.commit()
        async with SessionLocal() as s:
            open_subs = (await s.execute(select(SubOrder.id, SubOrder.number, SubOrder.status)
                                         .where(SubOrder.status.in_(("pending_payment", "placed", "confirmed", "packed", "shipped"))))).all()
        for sid, number, status in open_subs:
            r = await c.post(f"/api/admin/sub-orders/{sid}/cancel", json={"reason": "Demo clean-up before recording"}, headers=auth)
            print("cancel", number, status, r.status_code, "" if r.status_code == 200 else r.text[:120])


asyncio.run(main())
