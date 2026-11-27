"""Staff send one in-app message to a customer segment (Admin -> Growth -> Campaigns). Off by default.

Only customers who opted in to marketing get it, only in the app (no email or SMS), at most max_recipients per send (biggest spenders
first) and at most max_per_day sends a day. A preview (dry_run, the default) counts the people and sends nothing. Every send is logged."""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import SegmentCampaign, User
from app.services import growth, segments
from app.services.notify import notify


async def send(session: AsyncSession, admin: User, segment: str, title: str, message: str, link: str, dry_run: bool) -> dict[str, Any]:
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
    people = [m for m in await segments.members(session, allcfg["segments"], segment, limit=5000) if m["marketing_opt_in"]]
    total = len(people)
    people = people[: cfg["max_recipients"]]
    out: dict[str, Any] = {"dry_run": dry_run, "segment": segment, "opted_in": total, "recipients": len(people), "capped": total > len(people)}
    if dry_run:
        return out
    today = (await session.execute(select(func.count()).select_from(SegmentCampaign).where(SegmentCampaign.created_at >= utcnow() - timedelta(hours=24)))).scalar_one()
    if today >= cfg["max_per_day"]:
        raise ApiError(f"Limit reached: {cfg['max_per_day']} campaigns in 24 hours", "campaign_limit")
    users = (await session.execute(select(User).where(User.id.in_([uuid.UUID(p["id"]) for p in people])))).scalars().all()
    for u in users:
        await notify(session, "marketing_message", u, {"title": title, "message": message}, link=link, channels=("inapp",))
    row = SegmentCampaign(segment=segment, title=title, message=message, link=link, recipients=len(users), created_by=admin.id, created_at=utcnow())
    session.add(row)
    await session.flush()
    out["id"] = str(row.id)
    out["recipients"] = len(users)
    return out


async def recent(session: AsyncSession, limit: int = 50) -> list[dict[str, Any]]:
    rows = (await session.execute(select(SegmentCampaign).order_by(SegmentCampaign.created_at.desc()).limit(limit))).scalars().all()
    return [{"id": str(r.id), "segment": r.segment, "title": r.title, "message": r.message, "link": r.link, "recipients": r.recipients, "at": r.created_at.isoformat()} for r in rows]
