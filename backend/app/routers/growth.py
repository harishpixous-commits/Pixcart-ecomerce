"""Admin -> Growth: settings for loyalty, referral, abandoned carts, flash sales, gift cards, seller scorecard,
COD risk, SEO, bulk edit and segments; plus the seller scorecard itself."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field

from fastapi import Request

from app.core.deps import ApprovedSeller, CurrentUser, SessionDep, audit, client_ip, rate_limit
from app.core.errors import ApiError, NotFound
from app.core.permissions import Perm
from app.db import utcnow
from app.models import LoyaltyEntry, NewsletterSubscriber
from app.config import settings
from app.services import campaigns, cart_reminders, gift_cards, growth, loyalty, referral, saved_searches, segments, seo
from app.services import newsletter

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


@router.get("/newsletter")
async def newsletter_list(admin: Perm("marketing"), session: SessionDep) -> dict:
    """Addresses collected by the footer newsletter box, newest first."""
    return {"enabled": (await newsletter.config(session))["enabled"], **await newsletter.listing(session)}


@router.delete("/newsletter/{subscriber_id}")
async def newsletter_remove(subscriber_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    row = await session.get(NewsletterSubscriber, subscriber_id)
    if row is None:
        raise NotFound("Subscriber")
    await session.delete(row)
    audit(session, admin, "newsletter.remove", "newsletter", subscriber_id, "")
    await session.commit()
    return {"ok": True}


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


class CampaignIn(BaseModel):
    segment: str
    title: str = Field(max_length=80)
    message: str = Field(max_length=300)
    link: str = Field(default="", max_length=200)
    dry_run: bool = True
    send_at: datetime | None = None  # hold it until then (2 minutes to 30 days ahead)
    repeat_days: int = Field(default=0, ge=0, le=30)  # with send_at: send again every 7, 14 or 30 days ...
    repeat_times: int = Field(default=0, ge=0, le=12)  # ... this many more times


@router.post("/campaigns")
async def send_campaign(body: CampaignIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    """In-app message to a customer segment. dry_run=true (default) only counts who would get it."""
    res = await campaigns.send(session, admin, body.segment, body.title, body.message, body.link, body.dry_run, body.send_at, body.repeat_days, body.repeat_times)
    if not body.dry_run:
        audit(session, admin, "campaign.schedule" if res.get("scheduled") else "campaign.send", "segment", body.segment, f"{body.title[:60]} x{res['recipients']}")
    await session.commit()
    return res


@router.delete("/campaigns/{campaign_id}")
async def cancel_campaign(campaign_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    if not await campaigns.cancel(session, campaign_id):
        raise ApiError("Only a scheduled campaign can be cancelled", "not_scheduled")
    audit(session, admin, "campaign.cancel", "segment", str(campaign_id))
    await session.commit()
    return {"ok": True}


@router.get("/campaigns")
async def campaign_log(admin: Perm("marketing"), session: SessionDep) -> dict:
    return {"items": await campaigns.recent(session)}


@router.get("/loyalty")
async def loyalty_overview(admin: Perm("marketing"), session: SessionDep) -> dict:
    """Points held by members (and their rupee value), plus points earned, redeemed and expired in the last 30 days."""
    return await loyalty.overview(session)


@router.get("/loyalty/{user_id}")
async def member_loyalty(user_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    """One member's points, tier and the latest history rows (Admin -> Customers -> a customer)."""
    out = await loyalty.summary(session, user_id)
    await session.commit()  # summary lapses expired points and gives back unused redemptions
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


class NewsletterIn(BaseModel):
    email: str = Field(max_length=254)


@me_router.get("/newsletter")
async def newsletter_box(session: SessionDep) -> dict:
    """Whether the footer shows the newsletter box, and its heading."""
    cfg = await newsletter.config(session)
    return {"enabled": cfg["enabled"], "title": cfg["title"]}


@me_router.post("/newsletter", status_code=201)
async def newsletter_join(body: NewsletterIn, request: Request, session: SessionDep) -> dict:
    if not (await newsletter.config(session))["enabled"]:
        raise ApiError("The newsletter is not open", "newsletter_off")
    await rate_limit(session, f"newsletter:ip:{client_ip(request)}", limit=10, window_seconds=3600)
    email = newsletter.clean_email(body.email)
    if email is None:
        raise ApiError("Enter a valid email address", "invalid_email", fields={"email": "Invalid"})
    await newsletter.subscribe(session, email)  # an address already on the list gets the same answer
    await session.commit()
    return {"ok": True}


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


@router.post("/gift-card-purchases/{purchase_id}/check")
async def staff_check_gift_card_purchase(purchase_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    """Asks the gateway about a purchase the shopper never came back to check. Issues the card once if it was paid in full."""
    out = await gift_cards.check_purchase(session, None, purchase_id)
    audit(session, admin, "gift_card.purchase_check", "gift_card_purchase", purchase_id, out["status"])
    await session.commit()
    return {k: v for k, v in out.items() if k != "code"}  # the code goes to the buyer, staff see it in the cards list


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


class SavedSearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=120)
    max_price_paise: int | None = Field(default=None, ge=0, le=100_000_000)


@me_router.get("/saved-searches")
async def my_saved_searches(user: CurrentUser, session: SessionDep) -> dict:
    return await saved_searches.list_for(session, user.id)


@me_router.post("/saved-searches", status_code=201)
async def follow_search(body: SavedSearchIn, user: CurrentUser, session: SessionDep) -> dict:
    out = await saved_searches.add(session, user.id, body.query, body.max_price_paise)
    await session.commit()
    return out


@me_router.delete("/saved-searches/{search_id}")
async def unfollow_search(search_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    await saved_searches.remove(session, user.id, search_id)
    await session.commit()
    return {"ok": True}
