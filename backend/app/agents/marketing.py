"""Marketing agent. Finds categories that have live stock but sold little in the last weeks, and proposes a time-limited platform
coupon for that category. Nothing is created until staff approve; the coupon is made with the same fields the admin Coupons page uses."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import Category, OrderItem, Product, SubOrder, Variant

from .core import AgentDef


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    window = cfg["marketing_window_days"]
    live = (await session.execute(
        select(Product.category_id, func.count(func.distinct(Product.id)))
        .join(Variant, Variant.product_id == Product.id)
        .where(Product.status == "approved", Variant.is_active.is_(True), Variant.stock > 0).group_by(Product.category_id))).all()
    sold = dict((await session.execute(
        select(Product.category_id, func.coalesce(func.sum(OrderItem.qty), 0))
        .join(Variant, Variant.id == OrderItem.variant_id).join(Product, Product.id == Variant.product_id)
        .join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
        .where(SubOrder.created_at >= now - timedelta(days=window), SubOrder.status.notin_(("pending_payment", "cancelled")))
        .group_by(Product.category_id))).all())
    names = {c.id: c.name for c in (await session.execute(select(Category))).scalars()}
    out = []
    month = now.strftime("%Y-%m")
    pct = cfg["marketing_discount_percent"]
    for cid, items in live:
        qty = int(sold.get(cid, 0))
        if items < cfg["marketing_min_items"] or qty > cfg["marketing_max_sold"] or cid not in names:
            continue
        name = names[cid]
        days = cfg["marketing_valid_days"]
        code = f"SLOW{pct}{str(cid).replace('-', '')[:6].upper()}{now.strftime('%m%d')}"
        out.append(dict(
            kind="create_coupon", key=f"{cid}:{month}",
            summary=f"Run {pct}% off {name} for {days} days: {items} items in stock but only {qty} sold in {window} days",
            details=[["Category", name], ["Items in stock", str(items)], [f"Sold in {window} days", str(qty)], ["Coupon", f"{pct}% off, code {code}, {days} days"]],
            params={"category_id": str(cid), "category": name, "code": code, "percent": pct, "days": days, "items": items, "sold": qty, "window": window},
            permission="marketing"))
    return out


AGENT = AgentDef(
    "marketing", "Marketing agent",
    "Finds categories with plenty of live stock but few recent sales and proposes a limited-time category coupon. Staff approve before any coupon exists.",
    "Only proposes category coupons. Does not send emails or ads, does not pick customers, and does not measure whether the coupon worked.",
    scan)
