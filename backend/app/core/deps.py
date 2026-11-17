from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Forbidden, TooManyRequests, Unauthorized
from app.core.observability import client_ip  # noqa: F401  (re-exported)
from app.core.security import decode_access_token
from app.db import get_session, utcnow
from app.models import AuditLog, RateLimitEvent, Seller, User

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def _user_from_request(request: Request, session: AsyncSession) -> User | None:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    payload = decode_access_token(auth[7:].strip())
    if not payload:
        raise Unauthorized("Your session has expired. Please sign in again.")
    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError):
        raise Unauthorized() from None
    user = await session.get(User, user_id)
    if user is None or not user.is_active:
        raise Unauthorized("This account is not active")
    return user


async def current_user(request: Request, session: SessionDep) -> User:
    user = await _user_from_request(request, session)
    if user is None:
        raise Unauthorized()
    return user


async def optional_user(request: Request, session: SessionDep) -> User | None:
    return await _user_from_request(request, session)


async def admin_user(user: Annotated[User, Depends(current_user)]) -> User:
    if not user.is_admin:
        raise Forbidden("Admin access required")
    return user


async def seller_account(user: Annotated[User, Depends(current_user)], session: SessionDep) -> Seller:
    """The caller's seller account in any status (used by onboarding)."""
    seller = (await session.execute(select(Seller).where(Seller.user_id == user.id))).scalar_one_or_none()
    if seller is None:
        raise Forbidden("Register as a seller first")
    return seller


async def approved_seller(seller: Annotated[Seller, Depends(seller_account)]) -> Seller:
    if seller.status != "approved":
        raise Forbidden("Your seller account is not approved yet")
    return seller


CurrentUser = Annotated[User, Depends(current_user)]
OptionalUser = Annotated[User | None, Depends(optional_user)]
AdminUser = Annotated[User, Depends(admin_user)]
SellerAccount = Annotated[Seller, Depends(seller_account)]
ApprovedSeller = Annotated[Seller, Depends(approved_seller)]


async def rate_limit(session: AsyncSession, key: str, *, limit: int, window_seconds: int) -> None:
    """Fixed-window limiter backed by Postgres (works across instances, no Redis needed)."""
    now = utcnow()
    since = now - timedelta(seconds=window_seconds)
    count = (
        await session.execute(select(func.count()).select_from(RateLimitEvent).where(RateLimitEvent.key == key, RateLimitEvent.created_at >= since))
    ).scalar_one()
    if count >= limit:
        raise TooManyRequests()
    session.add(RateLimitEvent(key=key, created_at=now))
    await session.flush()


async def prune_rate_limits(session: AsyncSession) -> None:
    await session.execute(delete(RateLimitEvent).where(RateLimitEvent.created_at < utcnow() - timedelta(days=1)))


def audit(session: AsyncSession, actor: User | None, action: str, entity_type: str, entity_id: object, detail: str = "") -> None:
    session.add(
        AuditLog(
            actor_user_id=actor.id if actor else None,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            detail=detail[:2000],
            created_at=utcnow(),
        )
    )
