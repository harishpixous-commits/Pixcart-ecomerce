"""Per-product daily counters (views, add-to-cart, orders, units, revenue) for funnels and KPIs."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ProductDailyStat

IST = timezone(timedelta(hours=5, minutes=30))


def today_ist() -> date:
    return datetime.now(IST).date()


async def bump(session: AsyncSession, product_id: uuid.UUID, *, views: int = 0, add_to_cart: int = 0, orders: int = 0, units: int = 0, revenue: int = 0) -> None:
    stmt = insert(ProductDailyStat).values(
        product_id=product_id, day=today_ist(), views=views, add_to_cart=add_to_cart, orders=orders, units=units, revenue=revenue
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[ProductDailyStat.product_id, ProductDailyStat.day],
        set_={
            "views": ProductDailyStat.views + views,
            "add_to_cart": ProductDailyStat.add_to_cart + add_to_cart,
            "orders": ProductDailyStat.orders + orders,
            "units": ProductDailyStat.units + units,
            "revenue": ProductDailyStat.revenue + revenue,
        },
    )
    await session.execute(stmt)
