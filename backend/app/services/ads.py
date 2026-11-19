"""Sponsored products (seller advertising).

A seller's campaign promotes chosen products in search results, on other product pages and on the home page, paying a
cost per click (CPC) within a daily budget and an optional total budget. Ads are ranked by bid, then rating, and shown
only while the campaign is active and has budget left. Each click is charged once per visitor per day; repeat clicks
are recorded at no cost. Spend (plus GST) is posted to the seller's ledger for each finished day and comes off their
next payout. Orders a shopper places for the product within 7 days of clicking count as ad sales.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import settings
from app.db import utcnow
from app.models import AdCampaign, AdCampaignProduct, AdClick, AdStat, LedgerEntry, Order, OrderItem, Product, SubOrder
from app.services.catalog import public_product_filter
from app.services.platform_settings import get_settings

IST = timezone(timedelta(hours=5, minutes=30))
PLACEMENTS = {"search": "Search results", "product": "Product pages", "home": "Home page"}
LIVE = ("placed", "confirmed", "packed", "shipped", "delivered")
ATTRIBUTION_DAYS = 7


def today_ist() -> date:
    return datetime.now(IST).date()


def visitor_key(ip: str, agent: str) -> str:
    return hashlib.sha256(f"{settings.jwt_secret[:16]}|{ip}|{agent[:200]}".encode()).hexdigest()[:40]


def _mac(payload: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:24]


def sign(campaign_id: uuid.UUID, product_id: uuid.UUID, placement: str) -> str:
    payload = f"{campaign_id.hex}.{product_id.hex}.{placement}.{int(time.time())}"
    return base64.urlsafe_b64encode(f"{payload}.{_mac(payload)}".encode()).decode().rstrip("=")


def verify(token: str) -> tuple[uuid.UUID, uuid.UUID, str] | None:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        cid, pid, placement, ts, mac = raw.split(".")
        if not hmac.compare_digest(mac, _mac(f"{cid}.{pid}.{placement}.{ts}")) or placement not in PLACEMENTS:
            return None
        if time.time() - int(ts) > 2 * 86400:  # links from very old pages are not charged
            return None
        return uuid.UUID(cid), uuid.UUID(pid), placement
    except Exception:  # noqa: BLE001 - any malformed token is simply not an ad click
        return None


def _spent_today():
    return (select(AdStat.campaign_id, func.coalesce(func.sum(AdStat.spend_paise), 0).label("spent"))
            .where(AdStat.day == today_ist()).group_by(AdStat.campaign_id).subquery())


def _running(now: datetime, spent):
    return and_(
        AdCampaign.status == "active", AdCampaign.starts_at <= now, or_(AdCampaign.ends_at.is_(None), AdCampaign.ends_at > now),
        func.coalesce(spent.c.spent, 0) + AdCampaign.bid_paise <= AdCampaign.daily_budget_paise,
        or_(AdCampaign.total_budget_paise.is_(None), AdCampaign.spend_paise + AdCampaign.bid_paise <= AdCampaign.total_budget_paise),
    )


def _words(text: str) -> list[str]:
    return [w for w in re.split(r"[^\w]+", text.lower()) if len(w) > 1]


async def serve(session, placement: str, *, query: str = "", product: Product | None = None, exclude: set | None = None,
                limit: int | None = None) -> list[tuple[Product, str]]:
    """Products to show as "Sponsored" here, with the signed click link for each. Records an impression for each."""
    cfg = await get_settings(session)
    if not cfg["feature_ads"] or not cfg.get(f"ads_{placement}", False):
        return []
    limit = limit or cfg["ads_per_rail"]
    exclude = set(exclude or ())
    now = utcnow()
    spent = _spent_today()
    stmt = (
        select(AdCampaign, Product)
        .join(AdCampaignProduct, AdCampaignProduct.campaign_id == AdCampaign.id)
        .join(Product, Product.id == AdCampaignProduct.product_id)
        .outerjoin(spent, spent.c.campaign_id == AdCampaign.id)
        .where(_running(now, spent), AdCampaign.placements.contains([placement]), *public_product_filter(), Product.in_stock.is_(True),
               Product.seller_id == AdCampaign.seller_id)
    )
    words: list[str] = []
    if placement == "search":
        words = _words(query)
        if not words:
            return []
        title_match = or_(*[Product.title.ilike(f"%{w}%") for w in words[:6]], Product.brand.ilike(query.strip()))
        stmt = stmt.where(or_(title_match, func.jsonb_array_length(AdCampaign.keywords) > 0))
    elif placement == "product" and product is not None:
        stmt = stmt.where(Product.category_id == product.category_id, Product.id != product.id)
        exclude.add(product.id)
    rows = (await session.execute(stmt.order_by(AdCampaign.bid_paise.desc(), Product.rating_avg.desc(), Product.sold_count.desc()).limit(limit * 4))).all()
    picked: list[tuple[AdCampaign, Product]] = []
    seen: set[uuid.UUID] = set()
    for c, p in rows:
        if p.id in seen or p.id in exclude:
            continue
        if placement == "search" and c.keywords:
            q = query.lower()
            title_hit = any(w in p.title.lower() for w in words)
            if not (any(k in q for k in c.keywords) or title_hit):
                continue
        seen.add(p.id)
        picked.append((c, p))
        if len(picked) >= limit:
            break
    if picked:
        day = today_ist()
        for c, p in picked:
            ins = pg_insert(AdStat).values(campaign_id=c.id, product_id=p.id, day=day, impressions=1, clicks=0, spend_paise=0, billed=False)
            await session.execute(ins.on_conflict_do_update(index_elements=["campaign_id", "product_id", "day"],
                                                            set_={"impressions": AdStat.impressions + 1}))
        await session.commit()
    return [(p, sign(c.id, p.id, placement)) for c, p in picked]


async def click(session, token: str, *, visitor: str) -> tuple[Product | None, AdClick | None]:
    """Records a click and charges it (once per visitor per day). Returns the product to open."""
    parsed = verify(token)
    if parsed is None:
        return None, None
    cid, pid, placement = parsed
    p = await session.get(Product, pid)
    c = (await session.execute(select(AdCampaign).where(AdCampaign.id == cid).with_for_update())).scalar_one_or_none()
    if p is None or c is None:
        return p, None
    now = utcnow()
    repeat = (await session.execute(select(AdClick.id).where(AdClick.campaign_id == cid, AdClick.product_id == pid, AdClick.visitor == visitor,
                                                             AdClick.created_at > now - timedelta(hours=24)).limit(1))).first()
    cost = 0
    day = today_ist()
    if not repeat and c.status == "active" and c.starts_at <= now and (c.ends_at is None or c.ends_at > now):
        spent = int((await session.execute(select(func.coalesce(func.sum(AdStat.spend_paise), 0)).where(AdStat.campaign_id == cid, AdStat.day == day))).scalar_one())
        room = c.daily_budget_paise - spent
        if c.total_budget_paise is not None:
            room = min(room, c.total_budget_paise - c.spend_paise)
        cost = max(0, min(c.bid_paise, room))
    ck = AdClick(campaign_id=cid, product_id=pid, placement=placement, visitor=visitor, cost_paise=cost, created_at=now)
    session.add(ck)
    ins = pg_insert(AdStat).values(campaign_id=cid, product_id=pid, day=day, impressions=0, clicks=0 if repeat else 1, spend_paise=cost, billed=False)
    await session.execute(ins.on_conflict_do_update(index_elements=["campaign_id", "product_id", "day"], set_={
        "clicks": AdStat.clicks + (0 if repeat else 1), "spend_paise": AdStat.spend_paise + cost}))
    c.spend_paise += cost
    if c.total_budget_paise is not None and c.spend_paise >= c.total_budget_paise:
        c.status, c.note = "ended", "The total budget is used up"
    await session.commit()
    return p, ck


async def bill(session) -> int:
    """Posts each finished day's spend (plus GST on the service) to the seller ledger. Returns entries posted."""
    cfg = await get_settings(session)
    today = today_ist()
    rows = (await session.execute(
        select(AdCampaign.seller_id, AdStat.day, func.sum(AdStat.spend_paise), func.sum(AdStat.clicks))
        .join(AdCampaign, AdCampaign.id == AdStat.campaign_id)
        .where(AdStat.billed.is_(False), AdStat.day < today).group_by(AdCampaign.seller_id, AdStat.day))).all()
    posted = 0
    now = utcnow()
    for seller_id, day, spend, clicks in rows:
        spend = int(spend or 0)
        if spend > 0:
            gst = spend * cfg["commission_gst_bps"] // 10_000
            session.add(LedgerEntry(seller_id=seller_id, kind="ad_spend", amount=-(spend + gst), available_at=now, created_at=now,
                                    description=f"Sponsored products {day.isoformat()}: {int(clicks or 0)} clicks, ₹{spend / 100:,.2f} + GST ₹{gst / 100:,.2f}"))
            posted += 1
        await session.execute(AdStat.__table__.update().where(
            AdStat.day == day, AdStat.billed.is_(False),
            AdStat.campaign_id.in_(select(AdCampaign.id).where(AdCampaign.seller_id == seller_id))).values(billed=True))
    await session.commit()
    return posted


async def campaign_report(session, campaign_ids: list[uuid.UUID], *, since: date | None = None) -> dict[uuid.UUID, dict]:
    """Impressions, clicks, spend, attributed orders and sales per campaign."""
    if not campaign_ids:
        return {}
    stmt = select(AdStat.campaign_id, func.sum(AdStat.impressions), func.sum(AdStat.clicks), func.sum(AdStat.spend_paise)).where(
        AdStat.campaign_id.in_(campaign_ids)).group_by(AdStat.campaign_id)
    if since:
        stmt = stmt.where(AdStat.day >= since)
    out = {cid: {"impressions": int(i or 0), "clicks": int(k or 0), "spend": int(s or 0), "orders": 0, "sales": 0}
           for cid, i, k, s in (await session.execute(stmt)).all()}
    sales = (await session.execute(
        select(AdClick.campaign_id, func.count(func.distinct(Order.id)), func.coalesce(func.sum(OrderItem.line_total), 0))
        .join(Order, and_(Order.user_id == AdClick.user_id, Order.created_at >= AdClick.created_at,
                          Order.created_at <= AdClick.created_at + timedelta(days=ATTRIBUTION_DAYS)))
        .join(SubOrder, SubOrder.order_id == Order.id)
        .join(OrderItem, and_(OrderItem.sub_order_id == SubOrder.id, OrderItem.product_id == AdClick.product_id))
        .where(AdClick.campaign_id.in_(campaign_ids), AdClick.user_id.is_not(None), SubOrder.status.in_(LIVE))
        .group_by(AdClick.campaign_id))).all()
    for cid, orders, total in sales:
        out.setdefault(cid, {"impressions": 0, "clicks": 0, "spend": 0, "orders": 0, "sales": 0})
        out[cid]["orders"], out[cid]["sales"] = int(orders), int(total)
    for v in out.values():
        v["ctr"] = round(100 * v["clicks"] / v["impressions"], 2) if v["impressions"] else 0.0
        v["acos"] = round(100 * v["spend"] / v["sales"], 1) if v["sales"] else None
    return out


def campaign_out(c: AdCampaign, products: list[dict], stats: dict | None, spent_today: int = 0) -> dict:
    return {
        "id": str(c.id), "name": c.name, "status": c.status, "note": c.note, "placements": c.placements, "keywords": c.keywords,
        "bid_paise": c.bid_paise, "daily_budget_paise": c.daily_budget_paise, "total_budget_paise": c.total_budget_paise,
        "starts_at": c.starts_at.isoformat(), "ends_at": c.ends_at.isoformat() if c.ends_at else None, "spend_paise": c.spend_paise,
        "spent_today_paise": spent_today, "products": products,
        "stats": stats or {"impressions": 0, "clicks": 0, "spend": 0, "orders": 0, "sales": 0, "ctr": 0.0, "acos": None},
        "created_at": c.created_at.isoformat(),
    }

