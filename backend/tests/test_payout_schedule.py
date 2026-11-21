"""Seller payout schedule: the weekday and cycle set in Admin → Settings, the daily 10:00 IST job and the seller page."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select

from app import jobs
from app.db import SessionLocal, utcnow
from app.models import LedgerEntry, Payout
from app.services import ledger
from tests.conftest import make_seller

IST = timezone(timedelta(hours=5, minutes=30))
CFG = {"auto_payouts": True, "payout_weekday": 0, "payout_every_weeks": 1, "payout_min_paise": 10000}


def test_payout_days_and_next_run():
    monday = datetime(2026, 11, 23, 9, 59, tzinfo=IST)
    assert ledger.payout_schedule(CFG, monday)["next_at"] == "2026-11-23T04:30:00+00:00"
    assert ledger.payout_schedule(CFG, monday.replace(hour=10, minute=0))["next_at"] == "2026-11-30T04:30:00+00:00"  # today's run has started
    assert ledger.payout_schedule(CFG | {"payout_weekday": 4}, monday)["next_at"] == "2026-11-27T04:30:00+00:00"
    fortnight = CFG | {"payout_every_weeks": 2}
    assert [ledger.is_payout_day(fortnight, date(2026, 11, 23) + timedelta(weeks=w)) for w in range(4)] == [False, True, False, True]
    assert ledger.payout_schedule(fortnight, monday)["next_at"] == "2026-11-30T04:30:00+00:00"
    off = ledger.payout_schedule(CFG | {"auto_payouts": False}, monday)
    assert off == {"auto": False, "weekday": 0, "every_weeks": 1, "min_paise": 10000, "next_at": None}


async def test_payout_job_pays_only_on_the_chosen_day(client, admin, categories, monkeypatch):
    seller = await make_seller(client, admin, "9400000071", name="Payday Traders", pan="PAYDY1234P")
    async with SessionLocal() as s:
        s.add(LedgerEntry(seller_id=uuid.UUID(seller.seller_id), kind="adjustment", amount=50000, description="Opening balance",
                          available_at=utcnow() - timedelta(minutes=1), created_at=utcnow()))
        await s.commit()
    off = (await seller.get("/api/seller/payouts")).json()["schedule"]
    assert off["auto"] is False and off["next_at"] is None  # automatic payouts are off until the owner turns them on
    assert (await admin.put("/api/admin/settings", {"payout_weekday": 7})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"payout_every_weeks": 3})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"auto_payouts": True, "payout_weekday": 4, "payout_every_weeks": 2})).status_code == 200

    async def payouts_after_run_on(day: datetime) -> int:
        monkeypatch.setattr(jobs, "utcnow", lambda: day)
        await jobs.payouts_job()
        async with SessionLocal() as s:
            return (await s.execute(select(func.count()).select_from(Payout))).scalar_one()

    assert await payouts_after_run_on(datetime(2026, 11, 26, 10, tzinfo=IST)) == 0  # a Thursday
    assert await payouts_after_run_on(datetime(2026, 11, 27, 10, tzinfo=IST)) == 0  # a Friday in the week off
    assert await payouts_after_run_on(datetime(2026, 12, 4, 10, tzinfo=IST)) == 1

    sched = (await seller.get("/api/seller/payouts")).json()["schedule"]
    assert sched["auto"] is True and (sched["weekday"], sched["every_weeks"], sched["min_paise"]) == (4, 2, 10000)
    nxt = datetime.fromisoformat(sched["next_at"]).astimezone(IST)
    assert (nxt.hour, nxt.minute) == (10, 0) and ledger.is_payout_day({"payout_weekday": 4, "payout_every_weeks": 2}, nxt.date())
