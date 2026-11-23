"""Languages, currencies, regions and payment options; the site's translations; shoppers' saved cards.

Public:   GET  /api/regional                 currencies, languages and the visitor's suggested choice
          POST /api/i18n/translate           the page's text in a language (known lines; new ones via the AI)
Shopper:  GET  /api/account/cards            cards saved with Razorpay (last 4 digits, network, expiry)
          DELETE /api/account/cards/{id}     remove one
Admin:    GET/PUT /api/admin/regional, POST /api/admin/regional/rates, translations list/edit/delete
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select

from app.core.deps import CurrentUser, SessionDep, audit, rate_limit
from app.core.errors import ApiError, NotFound
from app.core.observability import client_ip
from app.core.permissions import Perm
from app.models import Translation
from app.services import razorpay, regional, translate

log = logging.getLogger("pixcart.regional")
router = APIRouter()


# ----------------------------------------------------------------------------- public


@router.get("/api/regional")
async def regional_public(session: SessionDep, country: str = Query(default="", max_length=2)) -> dict:
    cfg = await regional.get_regional(session)
    if cfg.get("auto_rates") and any(c.get("auto") and c["enabled"] for c in cfg["currencies"]):
        changed, _ = await regional.refresh_rates(session)  # at most once a day; failures keep the last rates
        if changed:
            await session.commit()
            cfg = await regional.get_regional(session)
    return regional.public(cfg, country)


class TranslateIn(BaseModel):
    lang: str = Field(min_length=2, max_length=12)
    texts: list[str] = Field(max_length=translate.MAX_TEXTS)


@router.post("/api/i18n/translate")
async def translate_texts(body: TranslateIn, request: Request, session: SessionDep) -> dict:
    """The words on a page in the visitor's language. Lines nobody has translated yet come back missing (English)."""
    await rate_limit(session, f"i18n:{client_ip(request)}", limit=600, window_seconds=3600)
    cfg = await regional.get_regional(session)
    found = await translate.translate(session, cfg, body.lang, body.texts)
    await session.commit()
    return {"lang": body.lang, "translations": found}


# ----------------------------------------------------------------------------- saved cards


def _card(t: dict[str, Any]) -> dict[str, Any] | None:
    card = t.get("card") or {}
    if t.get("method") != "card" or not card:
        return None
    return {"id": t.get("id"), "last4": card.get("last4", ""), "network": (card.get("network") or "").lower(),
            "issuer": card.get("issuer") or "", "type": card.get("type") or "", "name": card.get("name") or "",
            "expiry_month": card.get("expiry_month"), "expiry_year": card.get("expiry_year"),
            "international": bool(card.get("international")), "used_at": t.get("used_at")}


@router.get("/api/account/cards")
async def my_cards(user: CurrentUser, session: SessionDep) -> dict:
    cfg = await regional.get_regional(session)
    if not user.razorpay_customer_id:
        return {"enabled": cfg["save_cards"], "items": []}
    try:
        tokens = await razorpay.customer_tokens(user.razorpay_customer_id)
    except razorpay.GatewayError as exc:
        raise ApiError(f"Could not load your saved cards right now: {exc}", "gateway_error", 502) from exc
    return {"enabled": cfg["save_cards"], "items": [c for c in (_card(t) for t in tokens) if c]}


@router.delete("/api/account/cards/{token_id}")
async def remove_card(token_id: str, user: CurrentUser, session: SessionDep) -> dict:
    if not user.razorpay_customer_id or not token_id.startswith("token_") or len(token_id) > 40:
        raise NotFound("Card")
    try:
        await razorpay.delete_token(user.razorpay_customer_id, token_id)
    except razorpay.GatewayError as exc:
        raise ApiError(f"Could not remove the card: {exc}", "gateway_error", 502) from exc
    audit(session, user, "card.remove", "user", user.id, token_id)
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- admin


@router.get("/api/admin/regional")
async def admin_regional(admin: Perm("settings"), session: SessionDep) -> dict:
    from app.ai.client import configured

    cfg = await regional.get_regional(session)
    counts = dict((await session.execute(select(Translation.lang, func.count()).group_by(Translation.lang))).all())
    return {**cfg, "popular_currencies": regional.POPULAR_CURRENCIES, "popular_languages": regional.POPULAR_LANGUAGES,
            "pay_method_keys": list(regional.PAY_METHODS), "card_network_keys": list(regional.CARD_NETWORKS),
            "translation_counts": counts, "ai_ready": await configured(session, "translate")}


@router.put("/api/admin/regional")
async def save_regional(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    await regional.update(session, body)
    audit(session, admin, "regional.update", "settings", "regional", ", ".join(sorted(k for k in body if k in regional.DEFAULTS))[:200])
    await session.commit()
    return await admin_regional(admin, session)


@router.post("/api/admin/regional/rates")
async def refresh_rates(admin: Perm("settings"), session: SessionDep) -> dict:
    changed, msg = await regional.refresh_rates(session, force=True)
    if changed:
        audit(session, admin, "regional.rates", "settings", "regional", msg[:200])
    await session.commit()
    return {"changed": changed, "message": msg, **(await admin_regional(admin, session))}


@router.get("/api/admin/translations")
async def list_translations(admin: Perm("settings"), session: SessionDep, lang: str = Query(max_length=12), q: str = Query(default="", max_length=100),
                            origin: str = Query(default="", pattern=r"^(|ai|manual)$"), page: int = Query(default=1, ge=1, le=10000)) -> dict:
    where = [Translation.lang == lang]
    if q.strip():
        like = f"%{q.strip()}%"
        where.append(or_(Translation.source.ilike(like), Translation.text.ilike(like)))
    if origin:
        where.append(Translation.origin == origin)
    total = (await session.execute(select(func.count()).select_from(Translation).where(*where))).scalar_one()
    rows = (await session.execute(select(Translation).where(*where).order_by(Translation.source).offset((page - 1) * 50).limit(50))).scalars()
    return {"total": total, "page": page, "items": [{"id": str(r.id), "source": r.source, "text": r.text, "origin": r.origin,
                                                     "updated_at": r.updated_at.isoformat()} for r in rows]}


class TranslationIn(BaseModel):
    lang: str = Field(min_length=2, max_length=12)
    source: str = Field(min_length=1, max_length=translate.MAX_LEN)
    text: str = Field(min_length=1, max_length=translate.MAX_LEN * 3)


@router.put("/api/admin/translations")
async def save_translation(body: TranslationIn, admin: Perm("settings"), session: SessionDep) -> dict:
    """A staff correction: kept for good, never replaced by the AI."""
    await translate.save(session, body.lang, {body.source: body.text.strip()}, "manual")
    audit(session, admin, "translation.edit", "translation", body.lang, body.source[:120])
    await session.commit()
    return {"ok": True}


@router.delete("/api/admin/translations")
async def clear_translations(admin: Perm("settings"), session: SessionDep, lang: str = Query(max_length=12),
                             id: str = Query(default="", max_length=40), only_ai: bool = True) -> dict:
    """Removes one line, or every AI line of a language (to translate again, e.g. after switching to a better model)."""
    stmt = delete(Translation).where(Translation.lang == lang)
    if id:
        stmt = stmt.where(Translation.id == id)
    elif only_ai:
        stmt = stmt.where(Translation.origin == "ai")
    n = (await session.execute(stmt)).rowcount
    audit(session, admin, "translation.clear", "translation", lang, f"{n} lines")
    await session.commit()
    return {"removed": n}
