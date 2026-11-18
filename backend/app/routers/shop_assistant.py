"""Customer-facing shop assistant API (the chat on the storefront).

Guests may chat (products and help articles) when Admin allows it; their chat is reachable only with the
session key their browser received (``X-Chat-Key``). Signed-in customers own their chats; a guest chat is
moved to the customer's account when they sign in and continue it. Order, return and ticket answers need
sign-in, and every record is checked against the signed-in customer.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.deps import CurrentUser, OptionalUser, SessionDep, client_ip, rate_limit
from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import Order, ShopChatAction, ShopChatMessage, ShopChatSession
from app.routers.orders import customer_cancel, run_refunds
from app.services import support as support_svc
from app.shop_assistant import agent, views
from app.shop_assistant import settings as shop_settings

router = APIRouter(prefix="/api/shop-assistant", tags=["shop-assistant"])
ACTION_TTL = timedelta(minutes=30)


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def _own_chat(session, chat_id: uuid.UUID, user, request: Request, *, lock: bool = False) -> ShopChatSession:
    stmt = select(ShopChatSession).where(ShopChatSession.id == chat_id)
    chat = (await session.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if chat is None:
        raise NotFound("Chat")
    if chat.user_id is not None:
        if user is None or chat.user_id != user.id:
            raise NotFound("Chat")
        return chat
    key = request.headers.get("x-chat-key", "")
    if not key or not chat.guest_key_hash or not hmac.compare_digest(_hash(key), chat.guest_key_hash):
        raise NotFound("Chat")
    if user is not None:  # the guest signed in: the chat becomes theirs
        chat.user_id, chat.guest_key_hash = user.id, ""
        await session.flush()
    return chat


@router.get("/config")
async def config(user: OptionalUser, session: SessionDep) -> dict:
    cfg = await shop_settings.get(session)
    mode, _ = await agent.choose_mode(session, cfg)
    return {
        "enabled": cfg["enabled"] and (user is not None or cfg["allow_guests"]),
        "switched_on": cfg["enabled"], "allow_guests": cfg["allow_guests"], "signed_in": user is not None,
        "name": cfg["name"], "greeting": cfg["greeting"], "quick_replies": cfg["quick_replies"], "voice": cfg["voice"], "mode": mode,
    }


class StartIn(BaseModel):
    page: dict[str, Any] = Field(default_factory=dict)


@router.post("/sessions", status_code=201)
async def start(body: StartIn, request: Request, user: OptionalUser, session: SessionDep) -> dict:
    cfg = await shop_settings.get(session)
    if not cfg["enabled"]:
        raise ApiError("The help assistant is switched off right now. Please use the Support page.", "assistant_off", 409)
    if user is None and not cfg["allow_guests"]:
        raise ApiError("Please sign in to chat with us.", "sign_in_required", 401)
    await rate_limit(session, f"shopchat:new:{user.id if user else client_ip(request)}", limit=30, window_seconds=3600)
    now = utcnow()
    key = "" if user else secrets.token_urlsafe(24)
    chat = ShopChatSession(user_id=user.id if user else None, guest_key_hash=_hash(key) if key else "", title="New chat",
                           page={"path": str(body.page.get("path") or "")[:200], "title": str(body.page.get("title") or "")[:120]},
                           created_at=now, updated_at=now)
    session.add(chat)
    await session.commit()
    return {"id": str(chat.id), "guest_key": key or None}


@router.get("/sessions")
async def my_chats(user: CurrentUser, session: SessionDep) -> dict:
    rows = (await session.execute(select(ShopChatSession).where(ShopChatSession.user_id == user.id).order_by(ShopChatSession.updated_at.desc()).limit(10))).scalars()
    return {"items": [{"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat()} for c in rows]}


@router.get("/sessions/{chat_id}")
async def get_chat(chat_id: uuid.UUID, request: Request, user: OptionalUser, session: SessionDep) -> dict:
    chat = await _own_chat(session, chat_id, user, request)
    await session.commit()  # a claimed guest chat
    msgs = (await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == chat.id).order_by(ShopChatMessage.created_at).limit(200))).scalars()
    return {"id": str(chat.id), "title": chat.title, "feedback": chat.feedback, "messages": [agent.message_out(m) for m in msgs]}


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: bool = False
    page: dict[str, Any] | None = None


@router.post("/sessions/{chat_id}/messages")
async def send(chat_id: uuid.UUID, body: MessageIn, request: Request, user: OptionalUser, session: SessionDep) -> StreamingResponse:
    cfg = await shop_settings.get(session)
    if not cfg["enabled"]:
        raise ApiError("The help assistant is switched off right now. Please use the Support page.", "assistant_off", 409)
    chat = await _own_chat(session, chat_id, user, request)
    lim = cfg["limits"]
    if user is None and lim["per_day_guest"] == 0:
        raise ApiError("Please sign in to chat with us.", "sign_in_required", 401)
    # Customers are limited per account; guests per chat (many shoppers can share one mobile-network IP),
    # with a wide per-IP guard against one machine opening endless guest chats.
    who = f"u:{user.id}" if user else f"g:{chat.id}"
    await rate_limit(session, f"shopchat:min:{who}", limit=lim["per_minute"], window_seconds=60)
    await rate_limit(session, f"shopchat:day:{who}", limit=lim["per_day_customer"] if user else lim["per_day_guest"], window_seconds=86400)
    if user is None:
        await rate_limit(session, f"shopchat:ip:{client_ip(request)}", limit=lim["per_day_guest"] * 20, window_seconds=86400)
    await session.commit()

    async def gen():
        async for ev in agent.run(chat.id, user.id if user else None, body.text.strip(), voice=body.voice, page=body.page):
            yield agent.sse(ev)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class TicketIn(BaseModel):
    category: str
    subject: str = Field(min_length=5, max_length=200)
    message: str = Field(min_length=10, max_length=5000)
    order_id: uuid.UUID | None = None
    grievance: bool = False


async def _say(session, chat: ShopChatSession, text: str, blocks: list[dict[str, Any]], intent: str) -> ShopChatMessage:
    m = ShopChatMessage(session_id=chat.id, role="assistant", text=text, blocks=[{"type": "text", "text": text}, *blocks],
                        model_content=[{"role": "assistant", "content": [{"type": "text", "text": text}]}], intent=intent, mode="guided", created_at=utcnow())
    session.add(m)
    chat.message_count = (chat.message_count or 0) + 1
    chat.updated_at = utcnow()
    return m


@router.post("/sessions/{chat_id}/ticket", status_code=201)
async def raise_ticket(chat_id: uuid.UUID, body: TicketIn, request: Request, user: CurrentUser, session: SessionDep) -> dict:
    """Sends the support request the assistant prepared (after the customer reviewed it), with the chat attached."""
    chat = await _own_chat(session, chat_id, user, request, lock=True)
    await rate_limit(session, f"shopchat:ticket:{user.id}", limit=5, window_seconds=3600)
    rows = list((await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == chat.id).order_by(ShopChatMessage.created_at.desc()).limit(20))).scalars())
    transcript = "\n".join(f"{'Customer' if m.role == 'user' else 'Assistant'}: {' '.join((m.text or '').split())[:400]}" for m in reversed(rows) if m.text)
    message = body.message.strip()
    if transcript:
        message += "\n\n— Chat with the help assistant —\n" + transcript[:4000]
    t = await support_svc.create_ticket(session, user, category=body.category, subject=body.subject, message=message,
                                        order_id=body.order_id, is_grievance=body.grievance)
    chat.ticket_id = t.id
    v = views.ticket_view(t)
    m = await _say(session, chat, f"Your request {t.number} has been sent to our support team. They will reply within 48 hours; you can follow it under Support.",
                   [{"type": "tickets", "title": "", "items": [v], "link": v["link"]}], "ticket_sent")
    _mark_cards(rows, lambda b: b.get("type") == "ticket_form", {"status": "sent", "ticket_number": t.number})
    await session.commit()
    return {"ticket": v, "message": agent.message_out(m)}


def _mark_cards(rows: list[ShopChatMessage], match, patch: dict[str, Any]) -> None:
    """Updates a card in the saved chat (e.g. a form that was sent) so the chat reloads the way it looks now."""
    for m in rows:
        if any(match(b) for b in m.blocks or []):
            m.blocks = [({**b, **patch} if match(b) else b) for b in m.blocks]


async def _action(session, action_id: uuid.UUID, user) -> ShopChatAction:
    act = (await session.execute(select(ShopChatAction).where(ShopChatAction.id == action_id).with_for_update())).scalar_one_or_none()
    if act is None or act.user_id != user.id:
        raise NotFound("Request")
    if act.status != "pending":
        raise ApiError("This was already handled.", "action_done", 409)
    if utcnow() - act.created_at > ACTION_TTL:
        act.status = "expired"
        await session.commit()
        raise ApiError("This expired. Please ask again.", "action_expired", 409)
    return act


@router.post("/actions/{action_id}/confirm")
async def confirm(action_id: uuid.UUID, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    act = await _action(session, action_id, user)
    chat = await session.get(ShopChatSession, act.session_id)
    rows = list((await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == act.session_id))).scalars())
    match = lambda b: b.get("type") == "confirm" and b.get("action_id") == str(act.id)  # noqa: E731
    if act.kind != "cancel_order":
        raise ApiError("Unknown request", "action_unknown", 400)
    o = await session.get(Order, uuid.UUID(act.params["order_id"]))
    if o is None or o.user_id != user.id:
        raise NotFound("Order")
    try:
        sub = uuid.UUID(act.params["sub_order_id"]) if act.params.get("sub_order_id") else None
        refund_ids = await customer_cancel(session, o, sub, act.params.get("reason") or "Changed my mind")
    except ApiError as exc:
        await session.rollback()
        act = (await session.execute(select(ShopChatAction).where(ShopChatAction.id == action_id).with_for_update())).scalar_one()
        act.status, act.result, act.decided_at = "failed", {"error": exc.message}, utcnow()
        rows = list((await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == act.session_id))).scalars())
        _mark_cards(rows, match, {"status": "failed", "error": exc.message})
        await session.commit()
        raise
    act.status, act.result, act.decided_at = "done", {"refunds": len(refund_ids)}, utcnow()
    _mark_cards(rows, match, {"status": "done"})
    v = await views.order_view(session, o)
    note = " Your refund has been started and reaches the original payment method in 5 to 7 working days." if refund_ids else ""
    m = await _say(session, chat, f"Done. {act.params.get('target') or 'Your order'} is cancelled.{note}", [{"type": "order", "order": v}], "cancelled")
    await session.commit()
    background.add_task(run_refunds, refund_ids)
    return {"status": "done", "message": agent.message_out(m)}


@router.post("/actions/{action_id}/dismiss")
async def dismiss(action_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    act = await _action(session, action_id, user)
    act.status, act.decided_at = "cancelled", utcnow()
    rows = list((await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == act.session_id))).scalars())
    _mark_cards(rows, lambda b: b.get("type") == "confirm" and b.get("action_id") == str(act.id), {"status": "cancelled"})
    await session.commit()
    return {"status": "cancelled"}


class FeedbackIn(BaseModel):
    value: Literal[1, -1]


@router.post("/sessions/{chat_id}/feedback")
async def feedback(chat_id: uuid.UUID, body: FeedbackIn, request: Request, user: OptionalUser, session: SessionDep) -> dict:
    chat = await _own_chat(session, chat_id, user, request)
    chat.feedback = body.value
    await session.commit()
    return {"ok": True}

