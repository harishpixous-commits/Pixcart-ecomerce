"""Business assistant agent. Once a week it adds up the numbers an owner looks at first (sales against the week before, items nearly out of
stock, tickets nobody answered, listings waiting for review) and proposes a short digest. Approving sends the digest to the person who
approved it, in-app and by email. Plain counting, no AI model."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import Product, SubOrder, SupportTicket, Variant

from .core import AgentDef


def _rupees(paise: int) -> str:
    return f"Rs {paise / 100:,.0f}"


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    live = SubOrder.status.notin_(("pending_payment", "cancelled"))

    async def sales(start, end):
        n, total = (await session.execute(select(func.count(), func.coalesce(func.sum(SubOrder.total), 0)).where(SubOrder.created_at >= start, SubOrder.created_at < end, live))).one()
        return int(n), int(total)

    week = cfg["assistant_window_days"]
    n1, t1 = await sales(now - timedelta(days=week), now)
    n0, t0 = await sales(now - timedelta(days=2 * week), now - timedelta(days=week))
    low = (await session.execute(select(func.count(func.distinct(Variant.id))).join(Product, Product.id == Variant.product_id)
                                 .where(Variant.is_active.is_(True), Product.status == "approved", Variant.stock <= cfg["assistant_low_stock"]))).scalar_one()
    stuck = (await session.execute(select(func.count()).where(SupportTicket.status == "open", SupportTicket.acknowledged_at.is_(None),
                                                                SupportTicket.created_at <= now - timedelta(hours=cfg["assistant_ticket_hours"])))).scalar_one()
    pending = (await session.execute(select(func.count()).where(Product.status == "pending"))).scalar_one()
    change = "no orders the week before" if n0 == 0 else f"{(t1 - t0) * 100 // max(t0, 1):+d}% against the week before"
    lines = [f"Sales, last {week} days: {n1} orders, {_rupees(t1)} ({change})",
             f"Items with {cfg['assistant_low_stock']} or fewer left: {low}",
             f"Tickets nobody has answered for {cfg['assistant_ticket_hours']} hours: {stuck}",
             f"Listings waiting for review: {pending}"]
    digest = "\n".join(lines)
    return [dict(kind="send_digest", key=now.strftime("%G-W%V"), summary=f"Weekly digest: {n1} orders, {_rupees(t1)}, {low} low stock, {stuck} unanswered tickets, {pending} listings waiting",
                 details=[[x.split(":")[0], x.split(": ", 1)[1]] for x in lines], params={"digest": digest}, permission="assistant_actions")]


AGENT = AgentDef(
    "assistant", "Business assistant",
    "Once a week adds up sales against the week before, items nearly out of stock, unanswered tickets and listings waiting for review, and proposes a short digest. Approving sends it to you.",
    "Counts only. It does not explain why sales moved, forecast, or send the digest to anyone but the person who approved it.",
    scan)
