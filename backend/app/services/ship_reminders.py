"""Ship reminders (Admin -> Growth -> Ship reminders, off by default). A job sends the seller one in-app note, once per package, when a
confirmed or packed package has not shipped after_hours since confirmation. Packages confirmed more than max_age_days ago are skipped, so
switching the module on does not message about old orders."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import SubOrder
from app.services import growth
from app.services.notify import notify_seller


async def send_due(session: AsyncSession, batch: int = 200) -> int:
    cfg = (await growth.get(session))["ship_reminders"]
    if not cfg["enabled"]:
        return 0
    now = utcnow()
    due = now - timedelta(hours=cfg["after_hours"])
    oldest = now - timedelta(days=cfg["max_age_days"])
    rows = (await session.execute(
        select(SubOrder).where(SubOrder.status.in_(("confirmed", "packed")), SubOrder.ship_reminded_at.is_(None),
                               SubOrder.confirmed_at <= due, SubOrder.confirmed_at >= oldest)
        .order_by(SubOrder.confirmed_at).limit(batch))).scalars().all()
    for sub in rows:
        sub.ship_reminded_at = now  # once, whether or not a note goes out
        hours = int((now - sub.confirmed_at).total_seconds() // 3600)
        await notify_seller(session, sub.seller_id, "seller_ship_reminder", {"order_number": sub.number, "hours": str(hours)}, link=f"/seller/orders/{sub.id}")
    await session.flush()
    return len(rows)
