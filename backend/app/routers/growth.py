"""Admin -> Growth: settings for loyalty, referral, abandoned carts, flash sales, gift cards, seller scorecard,
COD risk, SEO, bulk edit and segments; plus the seller scorecard itself."""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.deps import ApprovedSeller, CurrentUser, SessionDep, audit
from app.core.errors import ApiError, NotFound
from app.core.permissions import Perm
from app.db import utcnow
from app.models import LoyaltyEntry
from app.config import settings
from app.services import growth, loyalty, referral, seo

router = APIRouter(prefix="/api/admin/growth", tags=["growth"])


@router.get("/settings")
async def get_settings(admin: Perm("marketing"), session: SessionDep) -> dict:
    return {"settings": await growth.get(session), "defaults": growth.defaults()}


@router.put("/settings")
async def put_settings(body: dict[str, Any], admin: Perm("marketing"), session: SessionDep) -> dict:
    try:
        cfg = await growth.update(session, body)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "settings.growth", "settings", "growth", ", ".join(sorted(body))[:200])
    await session.commit()
    return {"settings": cfg, "defaults": growth.defaults()}


@router.get("/scorecard")
async def scorecard(admin: Perm("dashboard"), session: SessionDep) -> dict:
    cfg = (await growth.get(session))["scorecard"]
    return {"enabled": cfg["enabled"], "window_days": cfg["window_days"], "items": await growth.seller_scorecard(session, cfg)}


class AdjustIn(BaseModel):
    user_id: uuid.UUID
    points: int = Field(ge=-100000, le=100000)
    note: str = Field(min_length=3, max_length=200)


@router.post("/loyalty/adjust")
async def adjust_points(body: AdjustIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    """Staff add or take back points (goodwill, correction). A balance never goes below zero."""
    if body.points == 0:
        raise ApiError("Enter a number of points other than zero", "invalid_points")
    cur = (await loyalty.summary(session, body.user_id))["balance"]
    if cur + body.points < 0:
        raise ApiError("That would take the balance below zero", "balance_too_low")
    session.add(LoyaltyEntry(user_id=body.user_id, kind="adjust", points=body.points, note=body.note.strip(), created_at=utcnow()))
    audit(session, admin, "loyalty.adjust", "user", body.user_id, f"{body.points:+d} points")
    await session.commit()
    return await loyalty.summary(session, body.user_id)


me_router = APIRouter(prefix="/api", tags=["loyalty"])


@me_router.get("/loyalty")
async def my_points(user: CurrentUser, session: SessionDep) -> dict:
    return await loyalty.summary(session, user.id)


class ReferralIn(BaseModel):
    code: str = Field(min_length=4, max_length=20)


@me_router.get("/referral")
async def my_referral(user: CurrentUser, session: SessionDep) -> dict:
    return await referral.summary(session, user)


@me_router.post("/referral/apply")
async def apply_referral(body: ReferralIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await referral.apply(session, user, body.code)
    await session.commit()
    return out


@router.get("/referrals")
async def admin_referrals(admin: Perm("marketing"), session: SessionDep) -> dict:
    from sqlalchemy import select
    from app.models import Referral, User
    rows = (await session.execute(select(Referral).order_by(Referral.created_at.desc()).limit(200))).scalars().all()
    names = {u.id: u.name or u.phone or u.email or "" for u in (await session.execute(select(User).where(User.id.in_({i for r in rows for i in (r.referrer_id, r.referee_id)})))).scalars()} if rows else {}
    return {"items": [{"referrer": names.get(r.referrer_id, ""), "friend": names.get(r.referee_id, ""), "status": r.status, "reward_paise": r.reward_paise, "at": r.created_at.isoformat()} for r in rows]}


@me_router.get("/seo/sitemap.xml")
async def sitemap(session: SessionDep) -> Response:
    base = getattr(settings, "public_web_url", "") or settings.cors_origin_list[0]
    xml = await seo.sitemap_xml(session, base)
    if xml is None:
        raise NotFound("Sitemap")
    return Response(xml, media_type="application/xml")


@me_router.get("/seller/scorecard")
async def my_scorecard(seller: ApprovedSeller, session: SessionDep) -> dict:
    """The seller's own late-shipping, cancellation and return figures against the levels staff set."""
    cfg = (await growth.get(session))["scorecard"]
    if not cfg["enabled"]:
        return {"enabled": False}
    rows = await growth.seller_scorecard(session, cfg, seller.id)
    mine = rows[0] if rows else {"orders": 0, "late": 0, "cancelled_by_seller": 0, "returned": 0, "late_percent": 0, "cancel_percent": 0, "return_percent": 0, "level": "not_enough_orders"}
    return {"enabled": True, "window_days": cfg["window_days"], "ship_within_hours": cfg["ship_within_hours"], "min_orders": cfg["min_orders"],
            "limits": {k: cfg[k] for k in cfg if k.endswith("_percent")}, "you": mine}
