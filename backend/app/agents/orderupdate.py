"""Order update agent. Looks at packages that are on their way and past the delivery date the shopper was promised, and proposes a
plain delay message to the customer. The message only says what is true: it was due, it has not arrived, it is still on its way.
It never promises a new date and does not contact the courier."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import SubOrder
from app.services.delivery import IST

from .core import AgentDef


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    rows = (await session.execute(
        select(SubOrder).where(SubOrder.status == "shipped", SubOrder.expected_delivery_at.is_not(None),
                               SubOrder.expected_delivery_at <= now - timedelta(hours=cfg["orderupdate_late_hours"]),
                               SubOrder.expected_delivery_at >= now - timedelta(days=cfg["orderupdate_max_age_days"]))
        .order_by(SubOrder.expected_delivery_at).limit(200))).scalars().all()
    out = []
    for sub in rows:
        due = sub.expected_delivery_at.astimezone(IST)
        late = int((now - sub.expected_delivery_at).total_seconds() // 3600)
        expected = f"{due.day} {due.strftime('%b')}"
        out.append(dict(kind="delay_notice", key=str(sub.id), summary=f"Tell the customer package {sub.number} is late (due {expected}, {late} hours past)",
                        details=[["Package", sub.number], ["Courier", sub.courier_name or "not recorded"], ["Was due", expected], ["Hours late", str(late)]],
                        params={"sub_id": str(sub.id), "expected": expected}, permission="orders"))
    return out


AGENT = AgentDef(
    "orderupdate", "Order update agent",
    "Finds packages on their way that are past the promised delivery date and proposes a plain delay message to the customer (in-app and email).",
    "Does not read live courier tracking, promise a new date, or message about other order stages. Normal shipped and delivered messages already go out without an agent.",
    scan)
