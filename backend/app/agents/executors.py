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
    if k == "request_restock":
        from app.models import Variant

        v = await session.get(Variant, uuid.UUID(p["variant_id"]))
        if v is None or not v.is_active:
            raise Stale("This item is no longer for sale, so nothing was sent.")
        if v.stock > p["stock"]:
            raise Stale(f"Stock was already topped up ({v.stock} now), so nothing was sent.")
        await notify_seller(session, v.seller_id, "seller_restock", {"item": p["item"], "stock": str(v.stock), "sold": str(p["sold"]), "days": str(p["days"]),
                                                                      "left": str(p["left"]), "suggest": str(p["suggest"])}, link="/seller/inventory?low_stock=1")
        return {"ok": True, "told_seller": True}
    if k == "create_coupon":
        from datetime import timedelta

        from sqlalchemy import func, select

        from app.core.deps import audit
        from app.models import Category, Coupon

        if await session.get(Category, uuid.UUID(p["category_id"])) is None:
            raise Stale("The category no longer exists, so no coupon was made.")
        if (await session.execute(select(Coupon.id).where(func.upper(Coupon.code) == p["code"].upper()))).first():
            raise Stale("A coupon with this code already exists, so nothing was made.")
        now = utcnow()
        c = Coupon(code=p["code"].upper(), description=f"{p['percent']}% off {p['category']}", kind="percent", value=p["percent"] * 100,
                   starts_at=now, ends_at=now + timedelta(days=p["days"]), category_id=uuid.UUID(p["category_id"]), per_user_limit=1,
                   funded_by="platform", show_on_checkout=True, is_active=True)
        session.add(c)
        audit(session, user, "coupon.create", "coupon", c.code, "made by the marketing agent")
        await session.commit()
        return {"ok": True, "code": c.code}
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
