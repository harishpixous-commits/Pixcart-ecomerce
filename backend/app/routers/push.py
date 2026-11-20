"""Push notification devices: the web app and the Android app register their Firebase token here."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.core.deps import CurrentUser, SessionDep, rate_limit
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import PushToken
from app.services import push

router = APIRouter(prefix="/api/push", tags=["push"])
MAX_DEVICES = 10


@router.get("/config")
async def config(session: SessionDep) -> dict:
    """The public Firebase web settings the browser needs to ask for notification permission (no secrets)."""
    cfg = await get_integrations(session)
    if not push.configured(cfg):
        return {"enabled": False}
    return {"enabled": True, "apiKey": cfg.firebase_api_key, "projectId": cfg.firebase_project_id, "messagingSenderId": cfg.firebase_sender_id,
            "appId": cfg.firebase_app_id, "vapidKey": cfg.firebase_vapid_key}


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=400)
    platform: Literal["web", "android", "ios"] = "web"
    app: Literal["shop", "delivery", "seller", "admin"] = "shop"


@router.post("/tokens", status_code=201)
async def register(body: TokenIn, user: CurrentUser, session: SessionDep) -> dict:
    await rate_limit(session, f"push-token:{user.id}", limit=30, window_seconds=3600)
    now = utcnow()
    row = (await session.execute(select(PushToken).where(PushToken.token == body.token))).scalar_one_or_none()
    if row is None:
        row = PushToken(user_id=user.id, token=body.token, platform=body.platform, app=body.app, created_at=now, last_seen_at=now)
        session.add(row)
    else:  # the same device signed in to another account, or opened again
        row.user_id, row.platform, row.app, row.last_seen_at = user.id, body.platform, body.app, now
    await session.flush()
    # keep the newest devices only
    count = (await session.execute(select(func.count()).select_from(PushToken).where(PushToken.user_id == user.id))).scalar_one()
    if count > MAX_DEVICES:
        old = list((await session.execute(select(PushToken.id).where(PushToken.user_id == user.id).order_by(PushToken.last_seen_at)
                                          .limit(count - MAX_DEVICES))).scalars())
        await session.execute(delete(PushToken).where(PushToken.id.in_(old)))
    await session.commit()
    return {"ok": True}


class TokenOut(BaseModel):
    token: str = Field(min_length=20, max_length=400)


@router.post("/tokens/remove")
async def unregister(body: TokenOut, user: CurrentUser, session: SessionDep) -> dict:
    await session.execute(delete(PushToken).where(PushToken.token == body.token, PushToken.user_id == user.id))
    await session.commit()
    return {"ok": True}
