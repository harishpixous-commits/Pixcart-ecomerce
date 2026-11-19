"""Back-in-stock and price-drop alerts, "Frequently bought together" and product comparison."""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import func, select

from app.db import utcnow
from app.models import OrderItem, Product, StockAlert, SubOrder, User, Variant, WishlistItem
from app.services.catalog import public_product_filter, variant_label
from app.services.notify import notify
from app.services.platform_settings import get_settings
from app.services.product_page import LIVE_PACKAGE


def _rupees(paise: int) -> str:
    r = paise / 100
    return f"₹{r:,.0f}" if r == int(r) else f"₹{r:,.2f}"


async def send_stock_alerts(session) -> int:
    """Tells shoppers who asked to be notified that a version is back in stock (once per request)."""
    cfg = await get_settings(session)
    if not cfg["feature_stock_alerts"]:
        return 0
    rows = (await session.execute(
        select(StockAlert, Variant, Product).join(Variant, Variant.id == StockAlert.variant_id).join(Product, Product.id == Variant.product_id)
        .where(StockAlert.active.is_(True), StockAlert.notified_at.is_(None), Variant.stock > 0, Variant.is_active.is_(True), *public_product_filter())
        .limit(500))).all()
    now = utcnow()
    for alert, v, p in rows:
        user = await session.get(User, alert.user_id)
        label = variant_label(v.options)
        await notify(session, "back_in_stock", user, {"item": p.title + (f" ({label})" if label else ""), "price": _rupees(v.price_paise)}, link=f"/p/{p.slug}")
        alert.notified_at, alert.active = now, False
    await session.commit()
    return len(rows)


async def send_price_drops(session) -> int:
    """Tells shoppers when a product in their wishlist is cheaper than when they saved it (by the set percentage)."""
    cfg = await get_settings(session)
    if not cfg["feature_price_alerts"]:
        return 0
    pct = cfg["price_alert_min_drop_pct"]
    rows = (await session.execute(
        select(WishlistItem, Product).join(Product, Product.id == WishlistItem.product_id)
        .where(WishlistItem.price_at_add.is_not(None), Product.in_stock.is_(True), *public_product_filter(),
               Product.price_from * 100 <= WishlistItem.price_at_add * (100 - pct),
               (WishlistItem.alerted_price.is_(None)) | (Product.price_from < WishlistItem.alerted_price))
        .limit(500))).all()
    for w, p in rows:
        user = await session.get(User, w.user_id)
        await notify(session, "price_drop", user, {"item": p.title, "price": _rupees(p.price_from), "old_price": _rupees(w.price_at_add)}, link=f"/p/{p.slug}")
        w.alerted_price = p.price_from
    await session.commit()
    return len(rows)


async def bought_together(session, product: Product, limit: int = 3) -> list[Product]:
    """Products most often in the same order as this one (last 180 days, live orders), still on sale."""
    since = utcnow() - timedelta(days=180)
    mine = (select(SubOrder.order_id).join(OrderItem, OrderItem.sub_order_id == SubOrder.id)
            .where(OrderItem.product_id == product.id, SubOrder.status.in_(LIVE_PACKAGE), SubOrder.created_at >= since))
    other = (select(OrderItem.product_id, func.count(func.distinct(SubOrder.order_id)).label("n")).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
             .where(SubOrder.order_id.in_(mine), OrderItem.product_id != product.id, SubOrder.status.in_(LIVE_PACKAGE))
             .group_by(OrderItem.product_id).subquery())
    rows = (await session.execute(select(Product).join(other, other.c.product_id == Product.id)
                                  .where(*public_product_filter(), Product.in_stock.is_(True)).order_by(other.c.n.desc(), Product.sold_count.desc()).limit(limit))).scalars()
    return list(rows)


async def compare_rows(session, ids: list[uuid.UUID]) -> list[Product]:
    rows = {p.id: p for p in (await session.execute(select(Product).where(Product.id.in_(ids), *public_product_filter()))).scalars()}
    return [rows[i] for i in ids if i in rows]

