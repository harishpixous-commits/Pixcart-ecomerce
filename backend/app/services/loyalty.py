"""Loyalty points (Admin -> Growth -> Loyalty points). Off by default.

Points are earned once per delivered package: ``points_per_100`` for every full 100 rupees of goods (items total,
before shipping and fees). Balance = sum of the ledger. Tiers follow lifetime earned points."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import LoyaltyEntry, SubOrder
from app.services import growth


def tier_for(cfg: dict, lifetime: int) -> str:
    if cfg["tier_gold_points"] and lifetime >= cfg["tier_gold_points"]:
        return "gold"
    if cfg["tier_silver_points"] and lifetime >= cfg["tier_silver_points"]:
        return "silver"
    return "member"


async def earn_for_delivery(session: AsyncSession, sub: SubOrder, user_id: uuid.UUID) -> int:
    """Credits the points for a delivered package (once). Returns the points credited (0 when off or already done)."""
    cfg = (await growth.get(session))["loyalty"]
    if not cfg["enabled"] or not cfg["points_per_100"]:
        return 0
    points = (sub.items_total // 10000) * cfg["points_per_100"]
    if points <= 0:
        return 0
    done = (await session.execute(select(LoyaltyEntry.id).where(LoyaltyEntry.sub_order_id == sub.id, LoyaltyEntry.kind == "earn"))).first()
    if done:
        return 0
    session.add(LoyaltyEntry(user_id=user_id, sub_order_id=sub.id, kind="earn", points=points, note=f"Delivered package {sub.number}", created_at=utcnow()))
    await session.flush()
    return points


async def summary(session: AsyncSession, user_id: uuid.UUID) -> dict:
    cfg = (await growth.get(session))["loyalty"]
    balance = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id))).scalar_one()
    lifetime = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id, LoyaltyEntry.points > 0))).scalar_one()
    rows = (await session.execute(select(LoyaltyEntry).where(LoyaltyEntry.user_id == user_id).order_by(LoyaltyEntry.created_at.desc()).limit(50))).scalars().all()
    return {
        "enabled": cfg["enabled"], "balance": int(balance), "lifetime": int(lifetime), "tier": tier_for(cfg, int(lifetime)),
        "value_paise": int(balance) * cfg["point_value_paise"],
        "history": [{"kind": r.kind, "points": r.points, "note": r.note, "at": r.created_at.isoformat()} for r in rows],
    }
