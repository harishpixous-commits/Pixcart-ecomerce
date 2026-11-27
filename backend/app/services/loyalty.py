"""Loyalty points (Admin -> Growth -> Loyalty points). Off by default.

Points are earned once per delivered package: ``points_per_100`` for every full 100 rupees of goods (items total,
before shipping and fees). Balance = sum of the ledger. Tiers follow lifetime earned points."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.core.errors import ApiError
from app.models import Coupon, LoyaltyEntry, SubOrder
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


async def reverse_for_return(session: AsyncSession, sub: SubOrder, user_id: uuid.UUID) -> int:
    """Takes back the share of a package's earned points that matches what has been returned (call after sub.returned_total
    is updated). Safe to call again: only the not-yet-reversed part is taken. Never takes the balance below zero (points already
    spent stay spent). Returns the points taken."""
    earned = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.sub_order_id == sub.id, LoyaltyEntry.kind == "earn"))).scalar_one()
    if not earned or not sub.items_total:
        return 0
    target = (int(earned) * min(sub.returned_total, sub.items_total)) // sub.items_total
    prefix = f"Returned items, package {sub.number}"
    done = (await session.execute(select(func.coalesce(func.sum(-LoyaltyEntry.points), 0)).where(
        LoyaltyEntry.user_id == user_id, LoyaltyEntry.kind == "reverse", LoyaltyEntry.note.like(prefix + "%")))).scalar_one()
    balance = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id))).scalar_one()
    take = min(target - int(done), int(balance))
    if take <= 0:
        return 0
    session.add(LoyaltyEntry(user_id=user_id, kind="reverse", points=-take, note=prefix, created_at=utcnow()))
    await session.flush()
    return take


REDEEM_DAYS = 30
CODE_PREFIX = "LP"


async def redeem(session: AsyncSession, user_id: uuid.UUID, points: int) -> dict:
    """Turns points into a single-use platform-funded coupon (flat amount), applied at checkout like any coupon so every
    existing discount rule (per-line split, seller/platform funding, refunds, cancellations) stays the same.
    The coupon needs a cart of at least discount / max_redeem_percent. Unused after 30 days: the points come back."""
    import secrets
    from datetime import timedelta

    cfg = (await growth.get(session))["loyalty"]
    if not cfg["enabled"]:
        raise ApiError("Loyalty points are not available right now.", "loyalty_off", 400)
    if points < cfg["min_redeem_points"]:
        raise ApiError(f"Redeem at least {cfg['min_redeem_points']} points at a time.", "below_minimum", 400)
    await restore_expired(session, user_id)
    balance = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id))).scalar_one()
    if points > int(balance):
        raise ApiError("You do not have that many points.", "balance_too_low", 400)
    discount = points * cfg["point_value_paise"]
    min_order = -(-discount * 100 // cfg["max_redeem_percent"])
    now = utcnow()
    code = CODE_PREFIX + secrets.token_hex(4).upper()
    session.add(Coupon(code=code, description="Loyalty points", kind="flat", value=discount, min_order_paise=min_order, ends_at=now + timedelta(days=REDEEM_DAYS),
                       usage_limit=1, per_user_limit=1, funded_by="platform", is_active=True, show_on_checkout=False))
    session.add(LoyaltyEntry(user_id=user_id, kind="redeem", points=-points, note=f"Redeemed for coupon {code}", created_at=now))
    await session.flush()
    return {"code": code, "discount_paise": discount, "min_order_paise": min_order, "valid_days": REDEEM_DAYS, "balance": int(balance) - points}


async def restore_expired(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Gives back the points of a redeemed coupon that ran out unused (once per coupon)."""
    now = utcnow()
    rows = (await session.execute(select(LoyaltyEntry).where(LoyaltyEntry.user_id == user_id, LoyaltyEntry.kind == "redeem"))).scalars().all()
    back = 0
    for r in rows:
        code = r.note.rsplit(" ", 1)[-1]
        if not code.startswith(CODE_PREFIX):
            continue
        done = (await session.execute(select(LoyaltyEntry.id).where(LoyaltyEntry.user_id == user_id, LoyaltyEntry.kind == "reverse", LoyaltyEntry.note == f"Coupon {code} expired unused"))).first()
        cp = (await session.execute(select(Coupon).where(Coupon.code == code))).scalar_one_or_none()
        if done or cp is None or cp.used_count > 0 or cp.ends_at is None or cp.ends_at > now:
            continue
        session.add(LoyaltyEntry(user_id=user_id, kind="reverse", points=-r.points, note=f"Coupon {code} expired unused", created_at=now))
        back += -r.points
    if back:
        await session.flush()
    return back


async def summary(session: AsyncSession, user_id: uuid.UUID) -> dict:
    await restore_expired(session, user_id)
    cfg = (await growth.get(session))["loyalty"]
    balance = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id))).scalar_one()
    lifetime = (await session.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == user_id, LoyaltyEntry.points > 0))).scalar_one()
    rows = (await session.execute(select(LoyaltyEntry).where(LoyaltyEntry.user_id == user_id).order_by(LoyaltyEntry.created_at.desc()).limit(50))).scalars().all()
    return {
        "enabled": cfg["enabled"], "balance": int(balance), "lifetime": int(lifetime), "tier": tier_for(cfg, int(lifetime)),
        "value_paise": int(balance) * cfg["point_value_paise"],
        "history": [{"kind": r.kind, "points": r.points, "note": r.note, "at": r.created_at.isoformat()} for r in rows],
    }
