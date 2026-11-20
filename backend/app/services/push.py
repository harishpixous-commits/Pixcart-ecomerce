"""Push notifications through Firebase Cloud Messaging (HTTP v1).

Devices (the partner app in a browser or the Android app, shoppers' and staff browsers) register an FCM token with
``POST /api/push/tokens``. ``notify(..., channels=(..., "push"))`` queues a push for each of the user's devices; the
pushes go out right after the database transaction commits (never for work that was rolled back), so a new delivery
request reaches the partner within a second or two. Tokens that FCM reports as gone are deleted.

Server credentials: a Google service account (Admin → Integrations → Firebase). The access token is made from a
signed JWT and cached for about 55 minutes.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

import httpx
import jwt
from sqlalchemy import delete, select
from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, settings
from app.integrations import get as get_integrations

log = logging.getLogger("pixcart.push")
transport: httpx.AsyncBaseTransport | None = None  # tests replace it
_token: tuple[str, float, str] | None = None  # (access token, expires at, key fingerprint)
SCOPE = "https://www.googleapis.com/auth/firebase.messaging"


def configured(cfg: Settings) -> bool:
    return bool(cfg.firebase_project_id and cfg.firebase_client_email and cfg.firebase_private_key)


def _key(cfg: Settings) -> str:
    return cfg.firebase_private_key.replace("\\n", "\n")


async def access_token(cfg: Settings) -> str:
    global _token
    fingerprint = f"{cfg.firebase_client_email}:{len(cfg.firebase_private_key)}"
    if _token and _token[1] > time.time() + 60 and _token[2] == fingerprint:
        return _token[0]
    now = int(time.time())
    assertion = jwt.encode({"iss": cfg.firebase_client_email, "scope": SCOPE, "aud": cfg.firebase_oauth_url, "iat": now, "exp": now + 3600},
                           _key(cfg), algorithm="RS256")
    async with httpx.AsyncClient(timeout=15, transport=transport) as c:
        r = await c.post(cfg.firebase_oauth_url, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
    if r.status_code >= 400:
        raise RuntimeError(f"Google sign-in failed ({r.status_code}): {r.text[:200]}")
    data = r.json()
    _token = (data["access_token"], now + int(data.get("expires_in", 3600)), fingerprint)
    return _token[0]


async def send_one(cfg: Settings, token: str, title: str, body: str, link: str, data: dict[str, str] | None = None) -> str:
    """Returns "sent", "gone" (the device unregistered) or "error"."""
    url = link if link.startswith("http") else f"{settings.public_web_url}{link or '/'}"
    message: dict[str, Any] = {
        "token": token,
        "notification": {"title": title[:120], "body": body[:400]},
        "data": {"link": link or "/", **(data or {})},
        "webpush": {"fcm_options": {"link": url}, "notification": {"icon": "/icon.svg", "badge": "/icon.svg", "requireInteraction": bool(data and data.get("urgent"))}},
        "android": {"priority": "HIGH", "notification": {"channel_id": "deliveries" if data and data.get("urgent") else "updates", "click_action": "OPEN_LINK"}},
    }
    async with httpx.AsyncClient(timeout=15, transport=transport) as c:
        r = await c.post(f"{cfg.firebase_fcm_base}/v1/projects/{cfg.firebase_project_id}/messages:send",
                         headers={"Authorization": f"Bearer {await access_token(cfg)}"}, json={"message": message})
    if r.status_code in (404, 410) or (r.status_code == 400 and "registration token" in r.text.lower()):
        return "gone"
    if r.status_code >= 400:
        log.warning("push failed %s: %s", r.status_code, r.text[:200])
        return "error"
    return "sent"


async def send_to_users(items: list[tuple[uuid.UUID, str, str, str, dict[str, str] | None]]) -> int:
    """Sends queued pushes (user, title, body, link, data) to every device of each user. Own session; never raises."""
    from app.db import SessionLocal
    from app.models import PushToken

    sent = 0
    try:
        async with SessionLocal() as session:
            cfg = await get_integrations(session)
            if not configured(cfg):
                return 0
            gone: list[str] = []
            for user_id, title, body, link, data in items:
                tokens = list((await session.execute(select(PushToken.token).where(PushToken.user_id == user_id))).scalars())
                for t in tokens:
                    result = await send_one(cfg, t, title, body, link, data)
                    sent += result == "sent"
                    if result == "gone":
                        gone.append(t)
            if gone:
                await session.execute(delete(PushToken).where(PushToken.token.in_(gone)))
                await session.commit()
    except Exception:  # noqa: BLE001 - a push must never break the request that caused it
        log.exception("sending push notifications failed")
    return sent


def queue(session: AsyncSession, user_id: uuid.UUID, title: str, body: str, link: str, data: dict[str, str] | None = None) -> None:
    """Sends the push after this session commits (and drops it if the transaction rolls back)."""
    sync = session.sync_session
    pending: list = sync.info.setdefault("push_queue", [])
    if not pending:
        def _after_commit(_sess) -> None:
            items = list(sync.info.pop("push_queue", []))
            if items:
                try:
                    asyncio.get_running_loop().create_task(send_to_users(items))
                except RuntimeError:
                    pass  # no running loop (scripts): skip

        def _after_rollback(_sess) -> None:
            sync.info.pop("push_queue", None)

        sa_event.listen(sync, "after_commit", _after_commit, once=True)
        sa_event.listen(sync, "after_soft_rollback", _after_rollback, once=True)
    pending.append((user_id, title, body, link, data))
