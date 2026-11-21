"""Sponsored products (seller advertising).

A seller's campaign promotes chosen products in search results, on other product pages and on the home page, paying a
cost per click (CPC) within a daily budget and an optional total budget. Ads are ranked by bid, then rating, and shown
only while the campaign is active and has budget left. Spend (plus GST) is posted to the seller's ledger for each
finished day and comes off their next payout. Orders a shopper places for the product within 7 days of clicking count
as ad sales.

Only genuine clicks are charged. Each ad served is an impression recorded for the visitor it is shown to (a random id
in a first-party cookie), and its signed click link carries that impression's one-use nonce. A click is charged on the
link's first use within 48 hours, by that visitor, while the campaign has not yet paid for its daily limit of clicks
from the same internet address or network (Admin -> Advertising), whatever the browser says it is. A visitor's repeat
clicks on a product within 24 hours are free. Every other click still opens the product, is free and counts as
invalid in the seller's and the staff's reports. Ad requests and clicks are rate limited per address, so a flood from
one place cannot inflate impressions either.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import and_, delete, func, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import settings
from app.core.deps import rate_limit
from app.core.errors import TooManyRequests
from app.db import utcnow
from app.models import AdCampaign, AdCampaignProduct, AdClick, AdImpression, AdStat, LedgerEntry, Order, OrderItem, Product, SubOrder
from app.services.catalog import public_product_filter
from app.services.platform_settings import get_settings

IST = timezone(timedelta(hours=5, minutes=30))
PLACEMENTS = {"search": "Search results", "product": "Product pages", "home": "Home page"}
LIVE = ("placed", "confirmed", "packed", "shipped", "delivered")
ATTRIBUTION_DAYS = 7
LINK_TTL = timedelta(hours=48)  # a click link from an older page opens the product but is not charged
VISITOR_COOKIE = "pc_vid"  # first-party visitor id: random, HttpOnly, sent only to /api; only a keyed hash is stored
VISITOR_DAYS = 30
SERVE_PER_MINUTE = 120  # ad requests per address a minute; beyond that no ads are shown or counted
CLICKS_PER_MINUTE = 30  # ad clicks per address a minute; beyond that a click only opens the product
_VISITOR_ID = re.compile(r"[A-Za-z0-9_-]{22}")


def today_ist() -> date:
    return datetime.now(IST).date()


def _digest(kind: str, value: str) -> str:
    """Keyed hash: visitor ids and addresses are stored only in this form."""
    return hmac.new(settings.jwt_secret.encode(), f"{kind}|{value}".encode(), hashlib.sha256).hexdigest()[:32]


def visitor_id(request) -> str:
    """The shopper's visitor id from the first-party cookie, or a new random one (send it back with `keep_visitor`)."""
    vid = request.cookies.get(VISITOR_COOKIE, "")
    return vid if _VISITOR_ID.fullmatch(vid) else secrets.token_urlsafe(16)


def keep_visitor(response, vid: str) -> None:
    response.set_cookie(VISITOR_COOKIE, vid, max_age=VISITOR_DAYS * 86400, httponly=True, secure=settings.cookie_secure,
                        samesite="lax", path="/api")


def address_and_network(ip: str) -> tuple[str, str]:
    """What the click limits count: an IPv4 address and its /24, or an IPv6 /64 (one home or phone, whose devices keep
    changing the rest of the address) and its /48."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip, ip
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    own, net = (32, 24) if addr.version == 4 else (64, 48)
    return str(ipaddress.ip_network(f"{addr}/{own}", strict=False)), str(ipaddress.ip_network(f"{addr}/{net}", strict=False))


async def _within(session, key: str, per_minute: int) -> bool:
    try:
        await rate_limit(session, key, limit=per_minute, window_seconds=60)
    except TooManyRequests:
        return False
    return True


def _mac(payload: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:24]


def sign(impression_id: uuid.UUID, campaign_id: uuid.UUID, product_id: uuid.UUID, placement: str, served_at: datetime) -> str:
    payload = f"{impression_id.hex}.{campaign_id.hex}.{product_id.hex}.{placement}.{int(served_at.timestamp())}"
    return base64.urlsafe_b64encode(f"{payload}.{_mac(payload)}".encode()).decode().rstrip("=")


def verify(token: str) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID, str, datetime] | None:
    """(impression, campaign, product, placement, time served) from a click link, or None if it is not one of ours."""
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)).decode()
        iid, cid, pid, placement, ts, mac = raw.split(".")
        if not hmac.compare_digest(mac, _mac(f"{iid}.{cid}.{pid}.{placement}.{ts}")) or placement not in PLACEMENTS:
            return None
        return uuid.UUID(iid), uuid.UUID(cid), uuid.UUID(pid), placement, datetime.fromtimestamp(int(ts), timezone.utc)
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


async def serve(session, placement: str, *, visitor: str, ip: str, query: str = "", product: Product | None = None,
                exclude: set | None = None, limit: int | None = None) -> list[tuple[Product, str]]:
    """Products to show as "Sponsored" here, with the signed click link for each. Records an impression for each, for
    the visitor id it is shown to (the caller keeps that id in the visitor cookie)."""
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
    # A flood of requests from one address gets no ads: impressions stay honest and no links are handed out.
    if not await _within(session, f"adserve:{address_and_network(ip)[0]}", SERVE_PER_MINUTE):
        return []
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
    if not picked:
        return []
    shown_to = _digest("visitor", visitor)
    nonces = [uuid.uuid4() for _ in picked]
    await session.execute(insert(AdImpression), [{"id": n, "visitor": shown_to, "created_at": now} for n in nonces])
    # one row order for every request, so two pages counting the same ads at once never deadlock
    keys = sorted((c.id, p.id) for c, p in picked)
    ins = pg_insert(AdStat).values([{"campaign_id": cid, "product_id": pid, "day": today_ist(), "impressions": 1, "clicks": 0,
                                     "invalid_clicks": 0, "spend_paise": 0, "billed": False} for cid, pid in keys])
    await session.execute(ins.on_conflict_do_update(index_elements=["campaign_id", "product_id", "day"],
                                                    set_={"impressions": AdStat.impressions + 1}))
    await session.commit()
    return [(p, sign(n, c.id, p.id, placement, now)) for (c, p), n in zip(picked, nonces, strict=True)]


async def _count(session, campaign_id: uuid.UUID, product_id: uuid.UUID, day: date, **add: int) -> None:
    """Adds to a campaign product's counters for the day (clicks, invalid_clicks, spend_paise)."""
    row = {"impressions": 0, "clicks": 0, "invalid_clicks": 0, "spend_paise": 0} | add
    ins = pg_insert(AdStat).values(campaign_id=campaign_id, product_id=product_id, day=day, billed=False, **row)
    await session.execute(ins.on_conflict_do_update(index_elements=["campaign_id", "product_id", "day"],
                                                    set_={k: getattr(AdStat, k) + v for k, v in add.items()}))


async def click(session, token: str, *, visitor: str | None, ip: str) -> tuple[Product | None, AdClick | None]:
    """A shopper followed a sponsored link: records the click and charges it when it is genuine (see the notes at the
    top). Returns the product to open, and the click when it is a valid one (so a later order counts as an ad sale)."""
    parsed = verify(token)
    if parsed is None:
        return None, None
    iid, cid, pid, placement, served_at = parsed
    p = await session.get(Product, pid)
    address, network = address_and_network(ip)
    if p is None or not await _within(session, f"adclick:{address}", CLICKS_PER_MINUTE):
        return p, None  # a flood from one address only opens the product
    now = utcnow()
    imp = None
    if now - served_at <= LINK_TTL:
        imp = (await session.execute(select(AdImpression).where(AdImpression.id == iid).with_for_update())).scalar_one_or_none()
    first_use = imp is not None and imp.clicked_at is None
    if first_use:
        imp.clicked_at = now  # each link is charged at most once
    # FOR NO KEY UPDATE: serializes this campaign's clicks without blocking the ads being served meanwhile
    c = (await session.execute(select(AdCampaign).where(AdCampaign.id == cid).with_for_update(key_share=True))).scalar_one_or_none()
    if c is None:
        await session.commit()
        return p, None
    who = _digest("visitor", visitor) if visitor else ""
    ip_hash, net_hash = _digest("ip", address), _digest("net", network)
    day = today_ist()
    valid = first_use and who == imp.visitor  # only the visitor the ad was shown to
    repeat = valid and (await session.execute(select(AdClick.id).where(
        AdClick.campaign_id == cid, AdClick.product_id == pid, AdClick.visitor == who, AdClick.created_at > now - timedelta(hours=24)).limit(1))).first() is not None
    if valid and not repeat:
        cfg = await get_settings(session)
        day_start = datetime(day.year, day.month, day.day, tzinfo=IST)
        by_address, by_network = (await session.execute(
            select(func.count().filter(AdClick.ip_hash == ip_hash), func.count().filter(AdClick.net_hash == net_hash))
            .where(AdClick.campaign_id == cid, AdClick.cost_paise > 0, AdClick.created_at >= day_start))).one()
        valid = by_address < cfg["ads_paid_clicks_per_address"] and by_network < cfg["ads_paid_clicks_per_network"]
    if not valid:
        await _count(session, cid, pid, day, invalid_clicks=1)
        await session.commit()
        return p, None
    cost = 0
    if not repeat and c.status == "active" and c.starts_at <= now and (c.ends_at is None or c.ends_at > now):
        spent = int((await session.execute(select(func.coalesce(func.sum(AdStat.spend_paise), 0)).where(AdStat.campaign_id == cid, AdStat.day == day))).scalar_one())
        room = c.daily_budget_paise - spent
        if c.total_budget_paise is not None:
            room = min(room, c.total_budget_paise - c.spend_paise)
        cost = max(0, min(c.bid_paise, room))
    ck = AdClick(campaign_id=cid, product_id=pid, placement=placement, visitor=who, ip_hash=ip_hash, net_hash=net_hash, cost_paise=cost, created_at=now)
    session.add(ck)
    await _count(session, cid, pid, day, clicks=0 if repeat else 1, spend_paise=cost)
    c.spend_paise += cost
    if c.total_budget_paise is not None and c.spend_paise >= c.total_budget_paise:
        c.status, c.note = "ended", "The total budget is used up"
    await session.commit()
    return p, ck


async def prune_impressions(session) -> None:
    """Deletes impressions whose click links have expired (cleanup job)."""
    await session.execute(delete(AdImpression).where(AdImpression.created_at < utcnow() - LINK_TTL))


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
    """Impressions, clicks (and invalid ones, never charged), spend, attributed orders and sales per campaign."""
    if not campaign_ids:
        return {}
    stmt = select(AdStat.campaign_id, func.sum(AdStat.impressions), func.sum(AdStat.clicks), func.sum(AdStat.invalid_clicks),
                  func.sum(AdStat.spend_paise)).where(AdStat.campaign_id.in_(campaign_ids)).group_by(AdStat.campaign_id)
    if since:
        stmt = stmt.where(AdStat.day >= since)
    out = {cid: {"impressions": int(i or 0), "clicks": int(k or 0), "invalid_clicks": int(x or 0), "spend": int(s or 0), "orders": 0, "sales": 0}
           for cid, i, k, x, s in (await session.execute(stmt)).all()}
    sales = (await session.execute(
        select(AdClick.campaign_id, func.count(func.distinct(Order.id)), func.coalesce(func.sum(OrderItem.line_total), 0))
        .join(Order, and_(Order.user_id == AdClick.user_id, Order.created_at >= AdClick.created_at,
                          Order.created_at <= AdClick.created_at + timedelta(days=ATTRIBUTION_DAYS)))
        .join(SubOrder, SubOrder.order_id == Order.id)
        .join(OrderItem, and_(OrderItem.sub_order_id == SubOrder.id, OrderItem.product_id == AdClick.product_id))
        .where(AdClick.campaign_id.in_(campaign_ids), AdClick.user_id.is_not(None), SubOrder.status.in_(LIVE))
        .group_by(AdClick.campaign_id))).all()
    for cid, orders, total in sales:
        out.setdefault(cid, {"impressions": 0, "clicks": 0, "invalid_clicks": 0, "spend": 0, "orders": 0, "sales": 0})
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
        "stats": stats or {"impressions": 0, "clicks": 0, "invalid_clicks": 0, "spend": 0, "orders": 0, "sales": 0, "ctr": 0.0, "acos": None},
        "created_at": c.created_at.isoformat(),
    }
