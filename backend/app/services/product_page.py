"""The extra blocks of the product page: social proof, best-seller rank, seller snapshot, offers, customer
photos and review topics. Every figure comes from live data; nothing is invented, and lines that would be
weak (a handful of sales, too few ratings) are left out rather than shown."""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import and_, func, select

from app.db import utcnow
from app.models import Category, Coupon, OrderItem, Product, Review, Seller, SubOrder, User
from app.services.catalog import public_product_filter
from app.services.review_settings import topic_regex

LIVE_PACKAGE = ("placed", "confirmed", "packed", "shipped", "delivered")


def bucket(n: int) -> str:
    """Rounded-down count in the style shoppers know: 7, 40+, 300+, 2K+."""
    if n >= 1000:
        return f"{n // 1000}K+"
    if n >= 100:
        return f"{(n // 100) * 100}+"
    if n >= 10:
        return f"{(n // 10) * 10}+"
    return str(n)


async def bought_last_month(session, product_id: uuid.UUID, minimum: int) -> str | None:
    since = utcnow() - timedelta(days=30)
    units = (
        await session.execute(
            select(func.coalesce(func.sum(OrderItem.qty), 0))
            .join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(OrderItem.product_id == product_id, SubOrder.status.in_(LIVE_PACKAGE), SubOrder.created_at >= since)
        )
    ).scalar_one()
    units = int(units)
    return f"{bucket(units)} bought in the past month" if units >= minimum else None


async def bestseller_rank(session, p: Product) -> dict | None:
    if p.sold_count <= 0:
        return None
    ahead = (
        await session.execute(
            select(func.count()).select_from(Product).where(*public_product_filter(), Product.category_id == p.category_id, Product.sold_count > p.sold_count)
        )
    ).scalar_one()
    cat = await session.get(Category, p.category_id)
    return {"rank": int(ahead) + 1, "category": cat.name if cat else "", "slug": cat.slug if cat else ""}


async def seller_snapshot(session, s: Seller, cfg: dict) -> dict:
    now = utcnow()
    since = now - timedelta(days=90)
    good, total = (
        await session.execute(
            select(func.count().filter(Review.rating >= 4), func.count())
            .join(Product, Product.id == Review.product_id)
            .where(Product.seller_id == s.id, Review.status == "published")
        )
    ).one()
    orders = (
        await session.execute(
            select(func.count()).select_from(SubOrder).where(SubOrder.seller_id == s.id, SubOrder.status.in_(LIVE_PACKAGE), SubOrder.created_at >= since)
        )
    ).scalar_one()
    on_time, shipped = (
        await session.execute(
            select(
                func.count().filter(SubOrder.shipped_at <= SubOrder.created_at + func.make_interval(0, 0, 0, s.dispatch_days + 1)),
                func.count(),
            ).where(SubOrder.seller_id == s.id, SubOrder.shipped_at.is_not(None), SubOrder.created_at >= since)
        )
    ).one()
    rating = float(s.rating_avg or 0)
    top = (rating * 10 >= cfg["top_seller_min_rating_x10"] and s.rating_count >= 5 and orders >= cfg["top_seller_min_orders"])
    started = s.approved_at or s.created_at
    months = max(0, (now.year - started.year) * 12 + now.month - started.month)
    return {
        "rating_avg": rating,
        "rating_count": s.rating_count,
        "positive_pct": round(100 * good / total) if total >= 3 else None,
        "orders_90d": bucket(int(orders)) if orders >= 5 else None,
        "on_time_pct": round(100 * on_time / shipped) if shipped >= 5 else None,
        "since": started.date().isoformat(),
        "years": months // 12,
        "months": months,
        "top_seller": bool(top),
        "dispatch_days": s.dispatch_days,
    }


async def _category_chain(session, category_id: uuid.UUID) -> list[uuid.UUID]:
    out = []
    cur = await session.get(Category, category_id)
    while cur is not None:
        out.append(cur.id)
        cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
    return out


def _rupees(paise: int) -> str:
    r = paise / 100
    return f"₹{r:,.0f}" if r == int(r) else f"₹{r:,.2f}"


def offer_text(c: Coupon) -> dict:
    if c.kind == "percent":
        title = f"{c.value / 100:g}% off"
        if c.max_discount_paise:
            title += f" up to {_rupees(c.max_discount_paise)}"
    elif c.kind == "bxgy":
        title = f"Buy {c.buy_qty}, get {c.get_qty} " + ("free" if c.value == 100 else f"at {c.value}% off")
    else:
        title = f"{_rupees(c.value)} off"
    terms = []
    if c.min_order_paise:
        terms.append(f"on orders of {_rupees(c.min_order_paise)} or more")
    if c.first_order_only:
        terms.append("on your first order")
    return {"title": title, "terms": ", ".join(terms)}


async def offers_for(session, p: Product, seller: Seller, limit: int) -> list[dict]:
    """Coupons a customer could use on this product: platform offers (store-wide or for its category) and
    the seller's own offers. Only offers marked to show in the offers list appear."""
    now = utcnow()
    chain = await _category_chain(session, p.category_id)
    rows = (
        await session.execute(
            select(Coupon).where(
                Coupon.is_active.is_(True),
                Coupon.show_on_checkout.is_(True),
                (Coupon.starts_at.is_(None)) | (Coupon.starts_at <= now),
                (Coupon.ends_at.is_(None)) | (Coupon.ends_at >= now),
                (Coupon.usage_limit.is_(None)) | (Coupon.used_count < Coupon.usage_limit),
                (Coupon.seller_id.is_(None)) | (Coupon.seller_id == p.seller_id),
                (Coupon.category_id.is_(None)) | (Coupon.category_id.in_(chain)),
            ).order_by(Coupon.ends_at.asc().nullslast(), Coupon.created_at.desc()).limit(limit)
        )
    ).scalars()
    out = []
    for c in rows:
        out.append({
            "code": c.code, **offer_text(c), "description": c.description,
            "kind": c.kind, "value": c.value, "max_discount_paise": c.max_discount_paise, "min_order_paise": c.min_order_paise,
            "first_order_only": c.first_order_only, "ends_at": c.ends_at.isoformat() if c.ends_at else None,
            "source": "seller" if c.seller_id else "platform", "source_name": seller.display_name if c.seller_id else "",
        })
    return out


def media_visible(cfg_reviews: dict, signed_in: bool) -> bool:
    return cfg_reviews["media_public"] or signed_in


async def customer_media(session, product_id: uuid.UUID, *, limit: int = 30, offset: int = 0) -> tuple[list[dict], int]:
    """Photos and videos from published reviews, newest first: (items, total number of items)."""
    base = and_(Review.product_id == product_id, Review.status == "published", Review.media_status == "published",
                func.jsonb_array_length(Review.media) > 0)
    total = (await session.execute(select(func.coalesce(func.sum(func.jsonb_array_length(Review.media)), 0)).where(base))).scalar_one()
    rows = (
        await session.execute(
            select(Review, User.name).join(User, User.id == Review.user_id).where(base).order_by(Review.created_at.desc(), Review.id).limit(200)
        )
    ).all()
    items: list[dict] = []
    for r, name in rows:
        for m in r.media:
            items.append({
                "kind": m.get("kind", "image"), "url": m.get("url", ""), "poster_url": m.get("poster_url", ""),
                "review_id": str(r.id), "rating": r.rating, "title": r.title, "body": r.body[:600],
                "author": (name or "Customer").split(" ")[0], "verified": r.verified, "created_at": r.created_at.isoformat(),
            })
    return items[offset:offset + limit], int(total)


def topic_stats(texts: list[tuple[int, str]], topics: list[dict], min_mentions: int = 2) -> list[dict]:
    """For each topic: how many reviews mention it and how many of those are positive (4-5 stars) or
    negative (1-2 stars). Topics mentioned fewer than ``min_mentions`` times are left out."""
    out = []
    for t in topics:
        rx = topic_regex(t["words"])
        hits = [rating for rating, text in texts if rx.search(text)]
        if len(hits) < min_mentions:
            continue
        pos = sum(1 for x in hits if x >= 4)
        neg = sum(1 for x in hits if x <= 2)
        pct = round(100 * pos / len(hits))
        tone = "positive" if pct >= 70 else "negative" if neg * 100 >= 60 * len(hits) else "mixed"
        out.append({"name": t["name"], "count": len(hits), "positive": pos, "negative": neg, "positive_pct": pct, "tone": tone})
    out.sort(key=lambda x: -x["count"])
    return out[:8]


async def review_topics(session, topics: list[dict], *, product_id: uuid.UUID | None = None, seller_id: uuid.UUID | None = None) -> list[dict]:
    stmt = select(Review.rating, Review.title, Review.body).where(Review.status == "published")
    if product_id:
        stmt = stmt.where(Review.product_id == product_id)
    if seller_id:
        stmt = stmt.join(Product, Product.id == Review.product_id).where(Product.seller_id == seller_id)
    rows = (await session.execute(stmt.order_by(Review.created_at.desc()).limit(2000))).all()
    return topic_stats([(r, f"{t} {b}") for r, t, b in rows], topics)
