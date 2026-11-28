"""Sourcing and reorder agent. For every live item it compares what is left with how fast it sold over the last weeks. When the stock
would run out within the cover period, it proposes asking the seller to restock, with a suggested quantity. It does not buy anything:
on this marketplace the seller owns the stock, so the "supplier" is the seller."""
from __future__ import annotations

import math
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import OrderItem, Product, Seller, SubOrder, Variant

from .core import AgentDef


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    window = cfg["reorder_window_days"]
    cover = cfg["reorder_cover_days"]
    sold = (select(OrderItem.variant_id.label("vid"), func.sum(OrderItem.qty).label("qty")).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(SubOrder.created_at >= now - timedelta(days=window), SubOrder.status.notin_(("pending_payment", "cancelled")))
            .group_by(OrderItem.variant_id).subquery())
    rows = (await session.execute(
        select(Variant, Product.title, Seller.display_name, sold.c.qty).join(sold, sold.c.vid == Variant.id).join(Product, Product.id == Variant.product_id)
        .join(Seller, Seller.id == Variant.seller_id)
        .where(Variant.is_active.is_(True), Product.status == "approved", sold.c.qty >= cfg["reorder_min_sold"]).limit(500))).all()
    out = []
    month = now.strftime("%Y-%m")
    for v, title, seller, qty in rows:
        rate = float(qty) / window  # units per day
        left = v.stock / rate
        if left > cover:
            continue
        suggest = max(1, math.ceil(rate * cover * 2) - v.stock)
        label = title + (" (" + ", ".join(str(x) for x in v.options.values()) + ")" if v.options else "")
        days_left = int(left)
        out.append(dict(
            kind="request_restock", key=f"{v.id}:{month}",
            summary=f"Ask {seller} to restock {label}: {v.stock} left, sells about {rate:.1f} a day, out in about {days_left} days",
            details=[["Item", label], ["Seller", seller], ["In stock", str(v.stock)], [f"Sold in {window} days", str(int(qty))], ["Suggested to add", str(suggest)]],
            params={"variant_id": str(v.id), "item": label[:100], "stock": v.stock, "sold": int(qty), "days": window, "left": days_left, "suggest": suggest}, permission="orders"))
    return out


AGENT = AgentDef(
    "reorder", "Sourcing and reorder agent",
    "Compares each live item's stock with how fast it sold recently. When it would run out within the cover period, proposes asking the seller to restock, with a suggested quantity.",
    "Does not buy stock, raise purchase orders or contact outside suppliers: on this marketplace sellers own their stock. Does not predict seasons or sales spikes, only the recent average.",
    scan)
