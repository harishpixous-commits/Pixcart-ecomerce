"""Saved searches (Admin -> Growth -> Saved searches, off by default). A signed-in shopper follows a search; a job tells them (in the app
only) when a product approved since the last check matches every word of it in the title or brand, and is within the price limit. A shopper
gets at most one note per search every min_hours_between_alerts, which carries the number of new matches."""
from __future__ import annotations

import re
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import Product, SavedSearch, User
from app.services import growth
from app.services.catalog import public_product_filter
from app.services.notify import notify


def terms(query: str) -> list[str]:
    return [t for t in re.findall(r"[\w]+", query.lower()) if len(t) >= 2][:6]


async def _cfg(session: AsyncSession) -> dict[str, Any]:
    cfg = (await growth.get(session))["saved_searches"]
    if not cfg["enabled"]:
        raise ApiError("Saved searches are switched off", "saved_searches_off")
    return cfg


def _out(r: SavedSearch) -> dict[str, Any]:
    return {"id": str(r.id), "query": r.query, "max_price_paise": r.max_price_paise, "created_at": r.created_at.isoformat(),
            "last_notified_at": r.last_notified_at.isoformat() if r.last_notified_at else None}


async def list_for(session: AsyncSession, user_id: uuid.UUID) -> dict[str, Any]:
    cfg = (await growth.get(session))["saved_searches"]
    rows = (await session.execute(select(SavedSearch).where(SavedSearch.user_id == user_id).order_by(SavedSearch.created_at.desc()))).scalars().all()
    return {"enabled": cfg["enabled"], "max_per_user": cfg["max_per_user"], "items": [_out(r) for r in rows]}


async def add(session: AsyncSession, user_id: uuid.UUID, query: str, max_price_paise: int | None) -> dict[str, Any]:
    cfg = await _cfg(session)
    query = " ".join(query.split())
    if not terms(query):
        raise ApiError("Type at least one word to follow", "invalid_query")
    if max_price_paise is not None and max_price_paise < 100:
        raise ApiError("The price limit must be at least 1 rupee", "invalid_price")
    mine = (await session.execute(select(SavedSearch).where(SavedSearch.user_id == user_id).with_for_update())).scalars().all()
    same = next((r for r in mine if r.query.lower() == query.lower() and r.max_price_paise == max_price_paise), None)
    if same:
        return _out(same)
    if len(mine) >= cfg["max_per_user"]:
        raise ApiError(f"You can follow up to {cfg['max_per_user']} searches", "too_many_searches")
    now = utcnow()
    row = SavedSearch(user_id=user_id, query=query[:120], max_price_paise=max_price_paise, created_at=now, last_checked_at=now)
    session.add(row)
    await session.flush()
    return _out(row)


async def remove(session: AsyncSession, user_id: uuid.UUID, search_id: uuid.UUID) -> None:
    row = await session.get(SavedSearch, search_id)
    if row is not None and row.user_id == user_id:
        await session.delete(row)


async def send_matches(session: AsyncSession, batch: int = 300) -> int:
    """Job: one in-app note per followed search that has new matching products. Returns the notes sent."""
    cfg = (await growth.get(session))["saved_searches"]
    if not cfg["enabled"]:
        return 0
    now = utcnow()
    quiet = now - timedelta(hours=cfg["min_hours_between_alerts"])
    rows = (await session.execute(select(SavedSearch).where((SavedSearch.last_notified_at.is_(None)) | (SavedSearch.last_notified_at <= quiet)).order_by(SavedSearch.last_checked_at).limit(batch))).scalars().all()
    sent = 0
    for r in rows:
        q = select(Product.title, Product.slug).where(*public_product_filter(), Product.approved_at > r.last_checked_at)
        for t in terms(r.query):
            like = f"%{t}%"
            q = q.where((func.lower(Product.title).like(like)) | (func.lower(Product.brand).like(like)))
        if r.max_price_paise is not None:
            q = q.where(Product.price_from <= r.max_price_paise)
        found = (await session.execute(q.order_by(Product.approved_at.desc()).limit(50))).all()
        r.last_checked_at = now
        if not found:
            continue
        user = await session.get(User, r.user_id)
        n = len(found)
        await notify(session, "saved_search_match", user, {"query": r.query, "count": str(n), "item": found[0][0], "more": f" and {n - 1} more" if n > 1 else ""},
                     link=f"/search?q={r.query.replace(' ', '+')}", channels=("inapp",))
        r.last_notified_at = now
        sent += 1
    await session.flush()
    return sent
