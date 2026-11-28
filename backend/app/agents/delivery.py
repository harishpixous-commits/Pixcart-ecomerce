"""Delivery and shipping agent. Looks at every open package and finds the ones that are stuck:
- confirmed but not shipped for too long: proposes a reminder to the seller;
- still unshipped much later: proposes cancelling and refunding the package;
- marked shipped with no tracking number: proposes asking the seller to add it.
It never contacts a courier and never moves a parcel."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import Seller, SubOrder

from .core import AgentDef


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    oldest = now - timedelta(days=cfg["delivery_max_age_days"])
    out: list[dict] = []
    rows = (await session.execute(
        select(SubOrder, Seller.display_name).join(Seller, Seller.id == SubOrder.seller_id)
        .where(SubOrder.status.in_(("confirmed", "packed")), SubOrder.confirmed_at <= now - timedelta(hours=cfg["delivery_nudge_hours"]), SubOrder.confirmed_at >= oldest)
        .order_by(SubOrder.confirmed_at).limit(200))).all()
    for sub, seller in rows:
        hours = int((now - sub.confirmed_at).total_seconds() // 3600)
        d = [["Package", sub.number], ["Seller", seller], ["Waiting to ship", f"{hours} hours"], ["Status", sub.status]]
        if hours >= cfg["delivery_cancel_hours"]:
            out.append(dict(kind="cancel_package", key=str(sub.id), summary=f"Cancel and refund {sub.number}: {seller} has not shipped for {hours // 24} days", details=d,
                            params={"sub_id": str(sub.id), "reason": "The seller did not ship in time"}, permission="orders"))
        else:
            out.append(dict(kind="nudge_seller", key=str(sub.id), summary=f"Remind {seller} to ship {sub.number} (waiting {hours} hours)", details=d,
                            params={"sub_id": str(sub.id)}, permission="orders"))
    rows = (await session.execute(
        select(SubOrder, Seller.display_name).join(Seller, Seller.id == SubOrder.seller_id)
        .where(SubOrder.status == "shipped", SubOrder.tracking_number == "", SubOrder.provider_shipment_id == "",
               SubOrder.shipped_at <= now - timedelta(hours=cfg["delivery_tracking_hours"]), SubOrder.shipped_at >= oldest)
        .order_by(SubOrder.shipped_at).limit(200))).all()
    for sub, seller in rows:
        hours = int((now - sub.shipped_at).total_seconds() // 3600)
        out.append(dict(kind="nudge_tracking", key=str(sub.id), summary=f"Ask {seller} to add tracking to {sub.number} (shipped {hours} hours ago, no tracking)",
                        details=[["Package", sub.number], ["Seller", seller], ["Marked shipped", f"{hours} hours ago"]], params={"sub_id": str(sub.id)}, permission="orders"))
    return out


AGENT = AgentDef(
    "delivery", "Delivery and shipping agent",
    "Finds packages that are not shipped on time or shipped with no tracking, and proposes a seller reminder or a cancel and refund.",
    "Does not talk to couriers, re-book a pickup or read live tracking events. Late-in-transit packages are handled by the order update agent (not built yet).",
    scan)
