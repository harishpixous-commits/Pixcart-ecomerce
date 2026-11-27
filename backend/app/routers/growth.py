"""Admin -> Growth: settings for loyalty, referral, abandoned carts, flash sales, gift cards, seller scorecard,
COD risk, SEO, bulk edit and segments; plus the seller scorecard itself."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.core.deps import CurrentUser, SessionDep, audit
from app.core.errors import ApiError
from app.core.permissions import Perm
from app.models import Seller
from app.services import growth

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
