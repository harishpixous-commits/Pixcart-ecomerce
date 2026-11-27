"""Referral rewards (Admin -> Growth -> Referral rewards). Off by default.

A customer shares a code (derived from their id, nothing stored). A new customer with no orders enters it once. When the
friend's first package is delivered and the order is at least the minimum, both get the reward as loyalty points
(reward in rupees / the value of one point). Each customer can earn the referrer reward up to `max_per_user` times."""
from __future__ import annotations

import uuid

from sqlalchemy import String, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import LoyaltyEntry, Order, Referral, SubOrder, User
from app.services import growth

PREFIX = "PX"


def code_for(user_id: uuid.UUID) -> str:
    return PREFIX + user_id.hex[:8].upper()


async def _find_referrer(session: AsyncSession, code: str) -> User | None:
    code = code.strip().upper()
    if not code.startswith(PREFIX) or len(code) != len(PREFIX) + 8:
        return None
    hexpart = code[len(PREFIX):].lower()
    return (await session.execute(select(User).where(func.replace(cast(User.id, String), "-", "").like(hexpart + "%")).limit(1))).scalar_one_or_none()


async def summary(session: AsyncSession, user: User) -> dict:
    cfg = (await growth.get(session))["referral"]
    rows = (await session.execute(select(Referral).where(Referral.referrer_id == user.id))).scalars().all()
    mine = (await session.execute(select(Referral).where(Referral.referee_id == user.id))).scalar_one_or_none()
    return {
        "enabled": cfg["enabled"], "code": code_for(user.id), "referrer_reward_paise": cfg["referrer_reward_paise"], "friend_reward_paise": cfg["friend_reward_paise"],
        "min_order_paise": cfg["min_order_paise"], "joined": len(rows), "rewarded": sum(1 for r in rows if r.status == "rewarded"),
        "earned_paise": sum(r.reward_paise for r in rows), "used_code": mine is not None,
    }


async def apply(session: AsyncSession, user: User, code: str) -> dict:
    cfg = (await growth.get(session))["referral"]
    if not cfg["enabled"]:
        raise ApiError("Referral rewards are not available right now.", "referral_off", 400)
    referrer = await _find_referrer(session, code)
    if referrer is None:
        raise ApiError("That referral code is not valid.", "invalid_code", 400)
    if referrer.id == user.id:
        raise ApiError("You cannot use your own code.", "own_code", 400)
    if (await session.execute(select(Referral.id).where(Referral.referee_id == user.id))).first():
        raise ApiError("You have already used a referral code.", "already_used", 409)
    if (await session.execute(select(Order.id).where(Order.user_id == user.id).limit(1))).first():
        raise ApiError("Referral codes are for new customers, before the first order.", "not_new", 400)
    session.add(Referral(referrer_id=referrer.id, referee_id=user.id, status="joined", created_at=utcnow()))
    await session.flush()
    return {"ok": True, "friend_reward_paise": cfg["friend_reward_paise"], "min_order_paise": cfg["min_order_paise"]}


async def reward_on_delivery(session: AsyncSession, sub: SubOrder, user_id: uuid.UUID) -> bool:
    """Called when a package is delivered. Pays both sides once, on the friend's first delivered package of enough value."""
    gcfg = await growth.get(session)
    cfg = gcfg["referral"]
    if not cfg["enabled"]:
        return False
    ref = (await session.execute(select(Referral).where(Referral.referee_id == user_id).with_for_update())).scalar_one_or_none()
    if ref is None or ref.status != "joined" or sub.items_total < cfg["min_order_paise"]:
        return False
    unit = gcfg["loyalty"]["point_value_paise"] or 100
    done = (await session.execute(select(func.count()).select_from(Referral).where(Referral.referrer_id == ref.referrer_id, Referral.status == "rewarded"))).scalar_one()
    now = utcnow()
    if done >= cfg["max_per_user"]:
        ref.status = "capped"
        await session.flush()
        return False
    pay = [(user_id, cfg["friend_reward_paise"], "Referral welcome reward"), (ref.referrer_id, cfg["referrer_reward_paise"], "Referral reward for a friend's first order")]
    for uid, paise, note in pay:
        points = paise // unit
        if points > 0:
            session.add(LoyaltyEntry(user_id=uid, sub_order_id=None, kind="adjust", points=points, note=note, created_at=now))
    ref.status, ref.reward_paise, ref.rewarded_at = "rewarded", cfg["referrer_reward_paise"], now
    await session.flush()
    return True
