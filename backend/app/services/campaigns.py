"""Staff send one in-app message to a customer segment (Admin -> Growth -> Campaigns). Off by default.

Only customers who opted in to marketing get it, only in the app (no email or SMS), at most max_recipients per send (biggest spenders
first) and at most max_per_day sends a day. A preview (dry_run, the default) counts the people and sends nothing. Every send is logged."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import SegmentCampaign, User
from app.services import growth, segments
from app.services.notify import notify


async def _audience(session: AsyncSession, allcfg: dict, segment: str) -> tuple[list[dict], int]:
    cfg = allcfg["campaigns"]
    people = [m for m in await segments.members(session, allcfg["segments"], segment, limit=5000) if m["marketing_opt_in"]]
    return people[: cfg["max_recipients"]], len(people)


async def _deliver(session: AsyncSession, people: list[dict], title: str, message: str, link: str) -> int:
    users = (await session.execute(select(User).where(User.id.in_([uuid.UUID(p["id"]) for p in people])))).scalars().all()
    for u in users:
        await notify(session, "marketing_message", u, {"title": title, "message": message}, link=link, channels=("inapp",))
    return len(users)


async def send(session: AsyncSession, admin: User, segment: str, title: str, message: str, link: str, dry_run: bool, send_at: datetime | None = None, repeat_days: int = 0, repeat_times: int = 0) -> dict[str, Any]:
    allcfg = await growth.get(session)
    cfg = allcfg["campaigns"]
    if not cfg["enabled"]:
        raise ApiError("Campaigns are switched off. Turn them on in Admin > Growth.", "campaigns_off")
    if not allcfg["segments"]["enabled"]:
        raise ApiError("Customer segments are switched off. Turn them on in Admin > Growth.", "segments_off")
    if segment not in segments.SEGMENTS:
        raise ApiError("Unknown segment", "invalid_segment")
    title, message, link = title.strip(), message.strip(), link.strip()
    if not title or not message:
        raise ApiError("A title and a message are needed", "invalid_message")
    if link and not (link.startswith("/") and not link.startswith("//")):
        raise ApiError("The link must be a page on this store, like /offers", "invalid_link")
    if repeat_days not in (0, 7, 14, 30) or not 0 <= repeat_times <= 12 or (repeat_days == 0) != (repeat_times == 0):
        raise ApiError("Repeat every 7, 14 or 30 days, 1 to 12 more times", "invalid_repeat")
    if repeat_days and send_at is None:
        raise ApiError("A repeating campaign needs a first send time", "invalid_repeat")
    people, total = await _audience(session, allcfg, segment)
    out: dict[str, Any] = {"dry_run": dry_run, "segment": segment, "opted_in": total, "recipients": len(people), "capped": total > len(people)}
    if dry_run:
        return out
    today = (await session.execute(select(func.count()).select_from(SegmentCampaign).where(SegmentCampaign.created_at >= utcnow() - timedelta(hours=24), SegmentCampaign.status != "cancelled"))).scalar_one()
    if today >= cfg["max_per_day"]:
        raise ApiError(f"Limit reached: {cfg['max_per_day']} campaigns in 24 hours", "campaign_limit")
    now = utcnow()
    if send_at is not None:
        # Held until the time comes; the list is worked out again then, so people who opted out meanwhile are left out.
        when = send_at if send_at.tzinfo else send_at.replace(tzinfo=now.tzinfo)
        if when < now + timedelta(minutes=2) or when > now + timedelta(days=30):
            raise ApiError("Pick a time between 2 minutes and 30 days from now", "invalid_send_at")
        row = SegmentCampaign(segment=segment, title=title, message=message, link=link, recipients=0, created_by=admin.id, created_at=now, status="scheduled", send_at=when, repeat_days=repeat_days, repeats_left=repeat_times)
        session.add(row)
        await session.flush()
        out.update({"id": str(row.id), "scheduled": True, "send_at": when.isoformat(), "repeat_days": repeat_days, "repeats_left": repeat_times})
        return out
    row = SegmentCampaign(segment=segment, title=title, message=message, link=link, recipients=await _deliver(session, people, title, message, link), created_by=admin.id, created_at=now)
    session.add(row)
    await session.flush()
    out["id"] = str(row.id)
    out["recipients"] = row.recipients
    return out


async def send_due(session: AsyncSession, limit: int = 5) -> int:
    """Job: deliver scheduled campaigns whose time has come. Held (not lost) while campaigns or segments are switched off."""
    allcfg = await growth.get(session)
    if not allcfg["campaigns"]["enabled"] or not allcfg["segments"]["enabled"]:
        return 0
    rows = (await session.execute(select(SegmentCampaign).where(SegmentCampaign.status == "scheduled", SegmentCampaign.send_at <= utcnow())
                                  .order_by(SegmentCampaign.send_at).limit(limit).with_for_update(skip_locked=True))).scalars().all()
    for r in rows:
        people, _ = await _audience(session, allcfg, r.segment)
        r.recipients = await _deliver(session, people, r.title, r.message, r.link)
        r.status = "sent"
        if r.repeat_days and r.repeats_left > 0:  # the next one is its own row: cancelling it ends the series
            nxt = max(r.send_at + timedelta(days=r.repeat_days), utcnow() + timedelta(hours=1))
            session.add(SegmentCampaign(segment=r.segment, title=r.title, message=r.message, link=r.link, recipients=0, created_by=r.created_by, created_at=utcnow(),
                                        status="scheduled", send_at=nxt, repeat_days=r.repeat_days, repeats_left=r.repeats_left - 1))
    await session.flush()
    return len(rows)


async def cancel(session: AsyncSession, campaign_id: uuid.UUID) -> bool:
    row = (await session.execute(select(SegmentCampaign).where(SegmentCampaign.id == campaign_id).with_for_update())).scalar_one_or_none()
    if row is None or row.status != "scheduled":
        return False
    row.status = "cancelled"
    return True


async def recent(session: AsyncSession, limit: int = 50) -> list[dict[str, Any]]:
    rows = (await session.execute(select(SegmentCampaign).order_by(SegmentCampaign.created_at.desc()).limit(limit))).scalars().all()
    return [{"id": str(r.id), "segment": r.segment, "title": r.title, "message": r.message, "link": r.link, "recipients": r.recipients, "at": r.created_at.isoformat(),
             "status": r.status, "send_at": r.send_at.isoformat() if r.send_at else None, "repeat_days": r.repeat_days, "repeats_left": r.repeats_left} for r in rows]
