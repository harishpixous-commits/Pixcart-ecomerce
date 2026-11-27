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
from app.services import cart_reminders, gift_cards, growth, loyalty, referral, segments, seo

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


@router.get("/cart-reminders")
async def cart_reminder_log(admin: Perm("marketing"), session: SessionDep) -> dict:
    """The latest abandoned-cart reminders sent and how many customers ordered afterwards."""
    return await cart_reminders.recent(session)


@router.get("/segments")
async def customer_segments(admin: Perm("marketing"), session: SessionDep, segment: str | None = None) -> dict:
    """Counts for every customer segment; add ?segment=vip (new, never_ordered, repeat, vip, lapsed) to list who is in it."""
    cfg = (await growth.get(session))["segments"]
    if not cfg["enabled"]:
        raise ApiError("Customer segments are switched off. Turn them on in Admin > Growth.", "segments_off")
    if segment is not None and segment not in segments.SEGMENTS:
        raise ApiError("Unknown segment", "invalid_segment")
    out: dict = {"segments": [{"key": k, "label": v, "count": n} for (k, v), n in zip(segments.SEGMENTS.items(), (await segments.counts(session, cfg)).values())]}
    if segment:
        out["items"] = await segments.members(session, cfg, segment)
    return out


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
    out = await loyalty.summary(session, user.id)
    await session.commit()
    return out


class RedeemIn(BaseModel):
    points: int = Field(ge=1, le=1000000)


@me_router.post("/loyalty/redeem")
async def redeem_points(body: RedeemIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await loyalty.redeem(session, user.id, body.points)
    await session.commit()
    return out


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


class GiftIssueIn(BaseModel):
    amount_paise: int = Field(ge=100, le=100000000)
    note: str = Field(default="", max_length=200)
    quantity: int = Field(default=1, ge=1, le=50)
    validity_days: int | None = Field(default=None, ge=1, le=3650)


@router.post("/gift-cards")
async def issue_gift_cards(body: GiftIssueIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    cards = [await gift_cards.issue(session, body.amount_paise, body.note, body.validity_days) for _ in range(body.quantity)]
    audit(session, admin, "gift_card.issue", "settings", "gift_cards", f"{body.quantity} x {body.amount_paise}")
    await session.commit()
    return {"items": [{"id": str(c.id), "code": c.code, **gift_cards.view(c)} for c in cards]}


@router.get("/gift-cards")
async def list_gift_cards(admin: Perm("marketing"), session: SessionDep) -> dict:
    from sqlalchemy import select
    from app.models import GiftCard
    rows = (await session.execute(select(GiftCard).order_by(GiftCard.created_at.desc()).limit(200))).scalars().all()
    return {"items": [{"id": str(c.id), "code": c.code, "note": c.note, **gift_cards.view(c)} for c in rows]}


@router.get("/gift-card-purchases")
async def list_gift_card_purchases(admin: Perm("marketing"), session: SessionDep) -> dict:
    """Cards bought online, newest first. A purchase still 'created' after the shopper paid is the one to look at."""
    from sqlalchemy import select
    from app.models import GiftCardPurchase, User
    rows = (await session.execute(select(GiftCardPurchase, User).join(User, User.id == GiftCardPurchase.user_id)
                                  .order_by(GiftCardPurchase.created_at.desc()).limit(200))).all()
    return {"items": [{"id": str(p.id), "user": u.name, "phone": u.phone, "amount_paise": p.amount_paise, "gateway": p.gateway, "status": p.status,
                       "error": p.error, "gift_card_id": str(p.gift_card_id) if p.gift_card_id else None, "created_at": p.created_at.isoformat()} for p, u in rows]}


@router.post("/gift-cards/{card_id}/void")
async def void_gift_card(card_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = await gift_cards.void(session, card_id)
    audit(session, admin, "gift_card.void", "settings", str(card_id), c.code)
    await session.commit()
    return {"id": str(c.id), "code": c.code, **gift_cards.view(c)}


class GiftRedeemIn(BaseModel):
    code: str = Field(min_length=4, max_length=20)
    amount_paise: int | None = Field(default=None, ge=1, le=100000000)


@me_router.post("/gift-cards/balance")
async def gift_card_balance(body: GiftRedeemIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await gift_cards.balance(session, user.id, body.code)
    await session.commit()
    return out


@me_router.post("/gift-cards/redeem")
async def redeem_gift_card(body: GiftRedeemIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await gift_cards.redeem(session, user.id, body.code, body.amount_paise)
    await session.commit()
    return out


@me_router.get("/gift-cards/options")
async def gift_card_options(user: CurrentUser, session: SessionDep) -> dict:
    """What the Rewards page needs to show a Buy button: only when staff switched gift cards and buying on."""
    cfg = (await growth.get(session))["gift_cards"]
    return {"can_buy": bool(cfg["enabled"] and cfg["allow_purchase"]), "min_paise": cfg["min_paise"], "max_paise": cfg["max_paise"]}


class GiftBuyIn(BaseModel):
    amount_paise: int = Field(ge=100, le=100000000)


@me_router.post("/gift-cards/purchase", status_code=201)
async def buy_gift_card(body: GiftBuyIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await gift_cards.start_purchase(session, user, body.amount_paise)
    await session.commit()
    return out


@me_router.post("/gift-cards/purchase/{purchase_id}/check")
async def check_gift_card_purchase(purchase_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    out = await gift_cards.check_purchase(session, user.id, purchase_id)
    await session.commit()
    return out


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
