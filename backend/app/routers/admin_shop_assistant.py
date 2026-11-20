"""Admin → Shop assistant: switches and settings, the help knowledge base, customer chats and statistics.

Permissions: ``shop_assistant`` (settings and switches), ``shop_assistant_kb`` (help articles),
``shop_assistant_chats`` (read customer chats and stats). Staff read customer chats here; nothing staff do here
is ever shown to customers except published help articles.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, NotFound
from app.core.permissions import Perm
from app.db import utcnow
from app.llm import config as llm_config
from app.models import AiRun, ShopChatAction, ShopChatMessage, ShopChatSession, ShopKbArticle, SupportTicket, User
from app.models.shop_assistant import KB_TOPICS
from app.shop_assistant import agent, kb
from app.shop_assistant import settings as shop_settings

router = APIRouter(prefix="/api/admin/shop-assistant", tags=["admin-shop-assistant"])
IST = timezone(timedelta(hours=5, minutes=30))
SAFE_LINK = re.compile(r"^(/(?!/)[A-Za-z0-9\-_/?=&.%#]*)?$")
TOPIC_LABELS = {"orders": "Orders", "delivery": "Delivery", "payments": "Payments", "returns": "Returns and refunds", "account": "Account",
                "offers": "Offers", "selling": "Selling", "other": "Other"}


# ----------------------------------------------------------------------------- settings and switches


async def _status(session, cfg: dict[str, Any]) -> dict[str, Any]:
    mode, chain = await agent.choose_mode(session, cfg)
    raw = await llm_config._raw(session)
    own = bool((raw.get("routes") or {}).get(agent.ROUTE))
    start = datetime.now(IST).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    used = (await session.execute(select(func.coalesce(func.sum(AiRun.input_tokens + AiRun.output_tokens), 0))
                                  .where(AiRun.task == agent.ROUTE, AiRun.created_at >= start))).scalar_one()
    models = [f"{t.model} ({t.connection.name})" for t in await llm_config.targets(session, agent.ROUTE)]
    return {"mode": mode, "models": models, "own_route": own, "tokens_this_month": int(used)}


@router.get("/settings")
async def get_settings(admin: Perm("shop_assistant"), session: SessionDep) -> dict:
    cfg = await shop_settings.get(session)
    return {"settings": cfg, "features": [{"key": k, "label": label, "help": help_} for k, (label, help_) in shop_settings.FEATURE_LABELS.items()],
            "status": await _status(session, cfg)}


@router.put("/settings")
async def put_settings(body: dict[str, Any], admin: Perm("shop_assistant"), session: SessionDep) -> dict:
    before = await shop_settings.get(session)
    try:
        cfg = await shop_settings.update(session, body)
    except shop_settings.SettingsError as exc:
        raise ApiError(str(exc), "invalid_settings") from exc
    changed = sorted(k for k in cfg if cfg[k] != before.get(k))
    audit(session, admin, "shop_assistant.settings", "settings", shop_settings.KEY, ", ".join(changed) or "no change")
    await session.commit()
    return {"settings": cfg, "features": [{"key": k, "label": label, "help": help_} for k, (label, help_) in shop_settings.FEATURE_LABELS.items()],
            "status": await _status(session, cfg)}


# ----------------------------------------------------------------------------- help articles (knowledge base)


class ArticleIn(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    body: str = Field(min_length=10, max_length=5000)
    keywords: list[str] = Field(default_factory=list, max_length=40)
    topic: str = "other"
    link: str = Field(default="", max_length=300)
    is_published: bool = True
    position: int = Field(default=0, ge=0, le=10_000)


def _article_out(a: ShopKbArticle) -> dict[str, Any]:
    return {"id": str(a.id), "title": a.title, "body": a.body, "keywords": a.keywords, "topic": a.topic, "topic_label": TOPIC_LABELS.get(a.topic, a.topic),
            "link": a.link, "is_published": a.is_published, "position": a.position, "uses": a.uses, "updated_at": a.updated_at.isoformat() if a.updated_at else None}


def _apply(a: ShopKbArticle, body: ArticleIn) -> None:
    if body.topic not in KB_TOPICS:
        raise ApiError("Choose a topic", "invalid_topic")
    link = body.link.strip()
    if not SAFE_LINK.match(link):
        raise ApiError("The link must be a page on this site, starting with /", "invalid_link")
    a.title, a.body = " ".join(body.title.split()), body.body.strip()
    a.keywords = list(dict.fromkeys(k.strip()[:60] for k in body.keywords if k.strip()))
    a.topic, a.link, a.is_published, a.position = body.topic, link, body.is_published, body.position


@router.get("/articles")
async def list_articles(admin: Perm("shop_assistant_kb"), session: SessionDep) -> dict:
    await kb.ensure_starter(session)
    rows =(await session.execute(select(ShopKbArticle).order_by(ShopKbArticle.position, ShopKbArticle.title))).scalars()
    return {"items": [_article_out(a) for a in rows], "topics": [{"code": k, "label": v} for k, v in TOPIC_LABELS.items()],
            "placeholders": ["{brand}", "{shipping_fee}", "{free_delivery_amount}", "{transit_same_city}", "{transit_same_state}",
                             "{transit_national}", "{cod_text}", "{grievance_text}"]}


@router.post("/articles", status_code=201)
async def create_article(body: ArticleIn, admin: Perm("shop_assistant_kb"), session: SessionDep) -> dict:
    a = ShopKbArticle(uses=0)
    _apply(a, body)
    session.add(a)
    await session.flush()
    audit(session, admin, "shop_assistant.article_create", "kb_article", a.id, a.title)
    await session.commit()
    return _article_out(a)


@router.put("/articles/{article_id}")
async def update_article(article_id: uuid.UUID, body: ArticleIn, admin: Perm("shop_assistant_kb"), session: SessionDep) -> dict:
    a = await session.get(ShopKbArticle, article_id)
    if a is None:
        raise NotFound("Article")
    _apply(a, body)
    a.updated_at = utcnow()
    audit(session, admin, "shop_assistant.article_update", "kb_article", a.id, a.title)
    await session.commit()
    return _article_out(a)


@router.delete("/articles/{article_id}")
async def delete_article(article_id: uuid.UUID, admin: Perm("shop_assistant_kb"), session: SessionDep) -> dict:
    a = await session.get(ShopKbArticle, article_id)
    if a is None:
        raise NotFound("Article")
    audit(session, admin, "shop_assistant.article_delete", "kb_article", a.id, a.title)
    await session.delete(a)
    await session.commit()
    return {"ok": True}


class TryIn(BaseModel):
    question: str = Field(min_length=2, max_length=300)


@router.post("/articles/try")
async def try_question(body: TryIn, admin: Perm("shop_assistant_kb"), session: SessionDep) -> dict:
    """Shows which published articles a customer question would find, best first."""
    hits = await kb.search(session, body.question, limit=5, min_score=0.5)
    return {"items": [{"id": h.id, "title": h.title, "source": h.source, "score": round(h.score, 1), "link": h.link,
                       "answers": h.score >= 1.5} for h in hits]}


# ----------------------------------------------------------------------------- customer chats and stats


def _phone(p: str | None) -> str:
    return f"••••••{p[-4:]}" if p and len(p) >= 4 else ""


@router.get("/chats")
async def list_chats(admin: Perm("shop_assistant_chats"), session: SessionDep, page: int = Query(default=1, ge=1, le=500),
                     feedback: int | None = Query(default=None, ge=-1, le=1), escalated: bool = False, q: str = Query(default="", max_length=80)) -> dict:
    stmt = select(ShopChatSession, User).outerjoin(User, User.id == ShopChatSession.user_id).where(ShopChatSession.message_count > 0)
    if feedback is not None:
        stmt = stmt.where(ShopChatSession.feedback == feedback)
    if escalated:
        stmt = stmt.where(ShopChatSession.ticket_id.is_not(None))
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(ShopChatSession.title.ilike(like) | User.name.ilike(like) | User.phone.ilike(like))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(ShopChatSession.updated_at.desc()).offset((page - 1) * 25).limit(25))).all()
    tickets = dict((await session.execute(select(SupportTicket.id, SupportTicket.number).where(
        SupportTicket.id.in_([c.ticket_id for c, _ in rows if c.ticket_id])))).all()) if rows else {}
    return {"total": total, "page": page, "items": [
        {"id": str(c.id), "title": c.title, "customer": (u.name or "Customer") if u else "Guest", "phone": _phone(u.phone) if u else "",
         "messages": c.message_count, "feedback": c.feedback, "language": c.language, "ticket": tickets.get(c.ticket_id, ""),
         "page": (c.page or {}).get("path", ""), "updated_at": c.updated_at.isoformat()} for c, u in rows]}


@router.get("/chats/{chat_id}")
async def get_chat(chat_id: uuid.UUID, admin: Perm("shop_assistant_chats"), session: SessionDep) -> dict:
    c = await session.get(ShopChatSession, chat_id)
    if c is None:
        raise NotFound("Chat")
    u = await session.get(User, c.user_id) if c.user_id else None
    msgs = (await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == c.id).order_by(ShopChatMessage.created_at))).scalars()
    t = await session.get(SupportTicket, c.ticket_id) if c.ticket_id else None
    audit(session, admin, "shop_assistant.chat_view", "shop_chat", c.id)
    await session.commit()
    return {"id": str(c.id), "title": c.title, "customer": (u.name or "Customer") if u else "Guest", "phone": _phone(u.phone) if u else "",
            "customer_id": str(u.id) if u else None, "feedback": c.feedback, "language": c.language, "page": c.page,
            "ticket": {"id": str(t.id), "number": t.number, "status": t.status} if t else None,
            "messages": [agent.message_out(m) | {"intent": m.intent, "voice": m.voice} for m in msgs]}


@router.get("/stats")
async def stats(admin: Perm("shop_assistant_chats"), session: SessionDep, days: int = Query(default=30, ge=1, le=365)) -> dict:
    since = utcnow() - timedelta(days=days)
    chats = (await session.execute(select(func.count(), func.count(ShopChatSession.user_id), func.count(ShopChatSession.ticket_id))
                                   .where(ShopChatSession.created_at >= since, ShopChatSession.message_count > 0))).one()
    fb = dict((await session.execute(select(ShopChatSession.feedback, func.count()).where(ShopChatSession.created_at >= since, ShopChatSession.feedback.is_not(None))
                                     .group_by(ShopChatSession.feedback))).all())
    user_msgs = (await session.execute(select(func.count()).where(ShopChatMessage.role == "user", ShopChatMessage.created_at >= since))).scalar_one()
    voice = (await session.execute(select(func.count()).where(ShopChatMessage.role == "user", ShopChatMessage.voice.is_(True), ShopChatMessage.created_at >= since))).scalar_one()
    intents = (await session.execute(select(ShopChatMessage.intent, func.count()).where(ShopChatMessage.role == "user", ShopChatMessage.created_at >= since)
                                     .group_by(ShopChatMessage.intent).order_by(func.count().desc()).limit(12))).all()
    modes = dict((await session.execute(select(ShopChatMessage.mode, func.count()).where(ShopChatMessage.role == "assistant", ShopChatMessage.created_at >= since)
                                        .group_by(ShopChatMessage.mode))).all())
    cancels = (await session.execute(select(func.count()).where(ShopChatAction.kind == "cancel_order", ShopChatAction.status == "done",
                                                                ShopChatAction.created_at >= since))).scalar_one()
    top_articles = (await session.execute(select(ShopKbArticle.title, ShopKbArticle.uses).where(ShopKbArticle.uses > 0)
                                          .order_by(ShopKbArticle.uses.desc()).limit(5))).all()
    return {"days": days, "chats": chats[0], "customer_chats": chats[1], "guest_chats": chats[0] - chats[1], "escalated": chats[2],
            "messages": user_msgs, "voice_messages": voice, "cancellations": cancels,
            "helpful": int(fb.get(1, 0)), "not_helpful": int(fb.get(-1, 0)),
            "intents": [{"intent": i or "unknown", "count": n} for i, n in intents],
            "ai_answers": int(modes.get("live", 0)), "guided_answers": int(modes.get("guided", 0)),
            "top_articles": [{"title": t, "uses": u} for t, u in top_articles]}
