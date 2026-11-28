"""The footer newsletter box: collects email addresses. Nothing is sent from here; staff export or use the list themselves."""
from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import NewsletterSubscriber
from app.services import growth

_EMAIL = re.compile(r"^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")


def clean_email(raw: str) -> str | None:
    e = (raw or "").strip().lower()
    return e if len(e) <= 254 and _EMAIL.match(e) else None


async def config(session: AsyncSession) -> dict:
    return (await growth.get(session))["newsletter"]


async def subscribe(session: AsyncSession, email: str) -> bool:
    """True when the address is new."""
    row = (await session.execute(select(NewsletterSubscriber).where(NewsletterSubscriber.email == email))).scalar_one_or_none()
    if row:
        return False
    session.add(NewsletterSubscriber(email=email, created_at=utcnow()))
    return True


async def listing(session: AsyncSession, limit: int = 200) -> dict:
    total = (await session.execute(select(func.count()).select_from(NewsletterSubscriber))).scalar_one()
    rows = (await session.execute(select(NewsletterSubscriber).order_by(NewsletterSubscriber.created_at.desc()).limit(limit))).scalars()
    return {"total": total, "items": [{"id": str(r.id), "email": r.email, "created_at": r.created_at.isoformat()} for r in rows]}
