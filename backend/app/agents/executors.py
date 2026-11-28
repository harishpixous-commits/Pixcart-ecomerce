"""What happens when staff approve a proposal. Each branch calls the same function the admin panel or a background job uses."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import AgentProposal, SubOrder, User
from app.services.notify import notify_seller

from .core import Stale


async def run(session: AsyncSession, user: User, row: AgentProposal, bg: BackgroundTasks) -> dict[str, Any]:
    p, k = row.params, row.kind
    if k in ("nudge_seller", "nudge_tracking", "cancel_package"):
        sub = await session.get(SubOrder, uuid.UUID(p["sub_id"]))
        if sub is None:
            raise Stale("The package no longer exists.")
        want = ("shipped",) if k == "nudge_tracking" else ("confirmed", "packed")
        if sub.status not in want or (k == "nudge_tracking" and sub.tracking_number):
            raise Stale(f"Package {sub.number} has moved on ({sub.status}), so nothing was sent.")
        hours = int((utcnow() - (sub.shipped_at if k == "nudge_tracking" else sub.confirmed_at)).total_seconds() // 3600)
        if k == "cancel_package":
            from app.routers import admin as admin_r

            return await admin_r.admin_cancel(sub.id, admin_r.ReasonIn(reason=p.get("reason") or "The seller did not ship in time"), user, session, bg)
        event = "seller_tracking_reminder" if k == "nudge_tracking" else "seller_ship_reminder"
        await notify_seller(session, sub.seller_id, event, {"order_number": sub.number, "hours": str(hours)}, link=f"/seller/orders/{sub.id}")
        return {"ok": True, "told_seller": True}
    if k == "delay_notice":
        from app.models import Order
        from app.services.notify import notify

        sub = await session.get(SubOrder, uuid.UUID(p["sub_id"]))
        if sub is None or sub.status != "shipped":
            raise Stale("The package is no longer on its way, so nothing was sent.")
        order = await session.get(Order, sub.order_id)
        customer = await session.get(User, order.user_id) if order else None
        if customer is None:
            raise Stale("The customer no longer exists.")
        await notify(session, "order_delay", customer, {"order_number": sub.number, "expected": p["expected"]}, link="/account/orders")
        return {"ok": True, "told_customer": True}
    raise Stale("This kind of proposal is no longer supported.")
