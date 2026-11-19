"""Deals: a lower price on one product version for a limited time.

While a deal runs, the version's selling price is the deal price, so the cart, checkout, invoices, GST, commission
and payouts all work unchanged. ``sync`` starts and ends deals (a job runs it every minute, and checkout and the deal
pages run it too, so prices change on time). Lightning deals also stop when their quantity is sold.
"""
from __future__ import annotations

import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import and_, or_, select, update

from app.core.errors import ApiError, Conflict
from app.db import utcnow
from app.models import Deal, Product, Seller, Variant
from app.services.catalog import images_for, refresh_product_aggregates, variant_label

KINDS = {"lightning": "Lightning deal", "deal_of_day": "Deal of the Day", "limited": "Limited time deal"}
OPEN = ("pending", "approved", "active")
_last_sync = 0.0


async def _start(session, d: Deal) -> None:
    v = (await session.execute(select(Variant).where(Variant.id == d.variant_id).with_for_update())).scalar_one_or_none()
    p = await session.get(Product, d.product_id)
    if v is None or not v.is_active or p is None or p.status != "approved":
        d.status, d.note = "ended", "The product was not on sale when the deal was due to start"
        return
    if d.deal_price_paise >= v.price_paise:
        d.status, d.note = "ended", "The selling price was already at or below the deal price"
        return
    d.regular_price_paise = v.price_paise
    v.price_paise = d.deal_price_paise
    d.status = "active"
    await refresh_product_aggregates(session, p)


async def _end(session, d: Deal, note: str, status: str = "ended") -> None:
    v = (await session.execute(select(Variant).where(Variant.id == d.variant_id).with_for_update())).scalar_one_or_none()
    if d.status == "active" and v is not None and d.regular_price_paise and v.price_paise == d.deal_price_paise:
        v.price_paise = min(d.regular_price_paise, v.mrp_paise)
    d.status, d.note = status, note[:300]
    p = await session.get(Product, d.product_id)
    if p is not None:
        await refresh_product_aggregates(session, p)


async def sync(session, *, force: bool = False) -> int:
    """Start due deals and end finished ones. Does not commit. Returns how many deals changed."""
    global _last_sync
    if not force and time.monotonic() - _last_sync < 10:
        return 0
    _last_sync = time.monotonic()
    now = utcnow()
    changed = 0
    for d in (await session.execute(select(Deal).where(Deal.status == "active", Deal.ends_at <= now).with_for_update(skip_locked=True))).scalars().all():
        await _end(session, d, "The deal time is over")
        changed += 1
    res = await session.execute(update(Deal).where(Deal.status == "approved", Deal.ends_at <= now).values(status="ended", note="The deal time passed"))
    changed += res.rowcount or 0
    due = (await session.execute(select(Deal).where(Deal.status == "approved", Deal.starts_at <= now, Deal.ends_at > now)
                                 .order_by(Deal.starts_at).with_for_update(skip_locked=True))).scalars().all()
    for d in due:
        await _start(session, d)
        changed += 1
    if changed:
        await session.flush()
    return changed


async def record_sale(session, variant_id: uuid.UUID, qty: int) -> None:
    """Called while an order is placed (the version row is already locked): counts units sold at the deal price and
    ends a lightning deal when its quantity is gone."""
    d = (await session.execute(select(Deal).where(Deal.variant_id == variant_id, Deal.status == "active").with_for_update())).scalar_one_or_none()
    if d is None:
        return
    d.sold_qty += qty
    if d.qty_limit and d.sold_qty >= d.qty_limit:
        await _end(session, d, "All deal units were claimed")


def _rules(cfg: dict) -> dict:
    return {
        "lightning": timedelta(hours=cfg["deal_max_hours_lightning"]),
        "deal_of_day": timedelta(hours=cfg["deal_max_hours_day"]),
        "limited": timedelta(days=cfg["deal_max_days_limited"]),
    }


async def create(session, seller: Seller, cfg: dict, *, variant_id: uuid.UUID, kind: str, deal_price: int, starts_at: datetime,
                 ends_at: datetime, qty_limit: int | None) -> Deal:
    if not cfg["feature_deals"]:
        raise ApiError("Deals are switched off on this marketplace", "deals_off")
    if kind not in KINDS:
        raise ApiError("Choose the kind of deal", "invalid_kind")
    v = await session.get(Variant, variant_id)
    if v is None or v.seller_id != seller.id:
        raise ApiError("Choose one of your product versions", "invalid_variant")
    p = await session.get(Product, v.product_id)
    if p.status != "approved" or not v.is_active:
        raise ApiError("Deals can only run on live products", "not_live")
    now = utcnow()
    if starts_at < now - timedelta(minutes=5):
        raise ApiError("The deal cannot start in the past", "invalid_window")
    if ends_at <= starts_at:
        raise ApiError("The deal must end after it starts", "invalid_window")
    if ends_at - starts_at > _rules(cfg)[kind]:
        limit = _rules(cfg)[kind]
        text = f"{int(limit.total_seconds() // 3600)} hours" if limit < timedelta(days=2) else f"{limit.days} days"
        raise ApiError(f"A {KINDS[kind].lower()} can run for at most {text}", "too_long")
    max_price = v.price_paise * (100 - cfg["deal_min_discount_pct"]) // 100
    if deal_price > max_price:
        raise ApiError(f"The deal price must be at least {cfg['deal_min_discount_pct']}% below the selling price (₹{max_price / 100:,.2f} or less)", "discount_too_small")
    if kind == "lightning":
        if not qty_limit or qty_limit < 1:
            raise ApiError("A lightning deal needs the number of units offered", "qty_required")
        if qty_limit > v.stock:
            raise ApiError(f"You have {v.stock} in stock; offer at most that many units", "qty_above_stock")
    else:
        qty_limit = qty_limit or None
    clash = (await session.execute(select(Deal.id).where(Deal.variant_id == v.id, Deal.status.in_(OPEN),
                                                         and_(Deal.starts_at < ends_at, Deal.ends_at > starts_at)))).first()
    if clash:
        raise Conflict("This version already has a deal at that time", "deal_overlap")
    d = Deal(seller_id=seller.id, product_id=p.id, variant_id=v.id, kind=kind, deal_price_paise=deal_price, starts_at=starts_at,
             ends_at=ends_at, qty_limit=qty_limit, sold_qty=0, status="pending" if cfg["deals_need_approval"] else "approved", note="")
    session.add(d)
    await session.flush()
    return d


async def cancel(session, d: Deal, note: str) -> None:
    if d.status not in OPEN:
        raise Conflict(f"A {d.status} deal cannot be cancelled", "invalid_status")
    await _end(session, d, note, status="cancelled")


async def active_variant_ids(session, variant_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    if not variant_ids:
        return set()
    return set((await session.execute(select(Deal.variant_id).where(Deal.variant_id.in_(variant_ids), Deal.status == "active"))).scalars())


def public(d: Deal) -> dict:
    claimed = round(100 * d.sold_qty / d.qty_limit) if d.qty_limit else None
    return {"kind": d.kind, "label": KINDS[d.kind], "ends_at": d.ends_at.isoformat(), "deal_price": d.deal_price_paise,
            "regular_price": d.regular_price_paise, "claimed_pct": min(100, claimed) if claimed is not None else None,
            "variant_id": str(d.variant_id)}


async def active_for_products(session, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """The running deal shown for each product (the lowest deal price when several versions have one)."""
    if not product_ids:
        return {}
    out: dict[uuid.UUID, Deal] = {}
    rows = (await session.execute(select(Deal).where(Deal.product_id.in_(product_ids), Deal.status == "active").order_by(Deal.deal_price_paise))).scalars()
    for d in rows:
        out.setdefault(d.product_id, d)
    return {k: public(v) for k, v in out.items()}


async def deal_rows(session, stmt) -> list[dict]:
    """Deals with their product and version, for the seller and admin lists."""
    rows = (await session.execute(stmt.join(Product, Product.id == Deal.product_id).join(Variant, Variant.id == Deal.variant_id)
                                  .join(Seller, Seller.id == Deal.seller_id).add_columns(Product.title, Product.slug, Variant, Seller.display_name))).all()
    imgs = await images_for(session, list({r[0].product_id for r in rows}))
    out = []
    for d, title, slug, v, seller_name in rows:
        mrp = v.mrp_paise
        out.append({
            "id": str(d.id), "kind": d.kind, "kind_label": KINDS[d.kind], "status": d.status, "note": d.note,
            "product": title, "slug": slug, "product_id": str(d.product_id), "variant_id": str(d.variant_id), "variant": variant_label(v.options),
            "image": (imgs.get(d.product_id) or [""])[0], "stock": v.stock,
            "seller": seller_name, "seller_id": str(d.seller_id), "deal_price": d.deal_price_paise,
            "regular_price": d.regular_price_paise or v.price_paise, "mrp": mrp,
            "discount_pct": round(100 * (mrp - d.deal_price_paise) / mrp) if mrp else 0,
            "starts_at": d.starts_at.isoformat(), "ends_at": d.ends_at.isoformat(), "qty_limit": d.qty_limit, "sold_qty": d.sold_qty,
            "created_at": d.created_at.isoformat(),
        })
    return out


def open_filter():
    return or_(Deal.status == "active", and_(Deal.status == "approved", Deal.ends_at > utcnow()))
