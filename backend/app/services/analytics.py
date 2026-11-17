"""KPIs for the admin panel and the seller hub. Dates are IST calendar days."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import and_, case, distinct, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Category,
    Order,
    OrderItem,
    Product,
    ProductDailyStat,
    ReturnRequest,
    Seller,
    SubOrder,
    SupportTicket,
    User,
)

IST = timezone(timedelta(hours=5, minutes=30))


def _range(days: int) -> tuple[datetime, datetime, date, date]:
    end_d = datetime.now(IST).date()
    start_d = end_d - timedelta(days=days - 1)
    return datetime.combine(start_d, time.min, IST), datetime.combine(end_d + timedelta(days=1), time.min, IST), start_d, end_d


def _pct(a: float, b: float) -> float:
    return round(a * 100 / b, 1) if b else 0.0


async def kpis(session: AsyncSession, days: int = 30, seller_id: uuid.UUID | None = None) -> dict:
    start, end, start_d, end_d = _range(days)
    prev_start = start - (end - start)
    sub_filter = [SubOrder.status.notin_(("pending_payment",))]
    if seller_id:
        sub_filter.append(SubOrder.seller_id == seller_id)

    async def period(a: datetime, b: datetime) -> dict:
        row = (
            await session.execute(
                select(
                    func.count(distinct(SubOrder.order_id)),
                    func.count(SubOrder.id),
                    func.coalesce(func.sum(case((SubOrder.status != "cancelled", SubOrder.total), else_=0)), 0),
                    func.coalesce(func.sum(case((SubOrder.status == "cancelled", 1), else_=0)), 0),
                    func.coalesce(func.sum(case((SubOrder.status != "cancelled", SubOrder.commission_paise), else_=0)), 0),
                    func.coalesce(func.sum(SubOrder.returned_total), 0),
                    func.coalesce(func.sum(case((SubOrder.status != "cancelled", SubOrder.platform_discount + SubOrder.seller_discount), else_=0)), 0),
                ).where(*sub_filter, SubOrder.created_at >= a, SubOrder.created_at < b)
            )
        ).one()
        orders, packages, gmv, cancelled, commission, returned, discounts = (int(x) for x in row)
        return {"orders": orders, "packages": packages, "gmv": gmv, "cancelled": cancelled, "commission": commission, "returned": returned, "discounts": discounts}

    cur, prev = await period(start, end), await period(prev_start, start)
    units = (
        await session.execute(
            select(func.coalesce(func.sum(OrderItem.qty), 0)).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(*sub_filter, SubOrder.status != "cancelled", SubOrder.created_at >= start, SubOrder.created_at < end)
        )
    ).scalar_one()
    returns_count = (
        await session.execute(
            select(func.count()).select_from(ReturnRequest).where(
                ReturnRequest.created_at >= start, ReturnRequest.created_at < end, *( [ReturnRequest.seller_id == seller_id] if seller_id else [])
            )
        )
    ).scalar_one()
    delivered = (
        await session.execute(select(func.count()).where(*sub_filter, SubOrder.status == "delivered", SubOrder.delivered_at >= start, SubOrder.delivered_at < end))
    ).scalar_one()
    # Seller SLA: hours from order to shipped
    ship_hours = (
        await session.execute(
            select(func.avg(func.extract("epoch", SubOrder.shipped_at - SubOrder.created_at) / 3600)).where(*sub_filter, SubOrder.shipped_at >= start, SubOrder.shipped_at < end)
        )
    ).scalar_one()
    stat_filter = [ProductDailyStat.day >= start_d, ProductDailyStat.day <= end_d]
    if seller_id:
        stat_filter.append(ProductDailyStat.product_id.in_(select(Product.id).where(Product.seller_id == seller_id)))
    views, carts = (await session.execute(select(func.coalesce(func.sum(ProductDailyStat.views), 0), func.coalesce(func.sum(ProductDailyStat.add_to_cart), 0)).where(*stat_filter))).one()

    daily = (
        await session.execute(
            select(
                func.date(func.timezone("Asia/Kolkata", SubOrder.created_at)).label("d"),
                func.count(distinct(SubOrder.order_id)),
                func.coalesce(func.sum(case((SubOrder.status != "cancelled", SubOrder.total), else_=0)), 0),
            ).where(*sub_filter, SubOrder.created_at >= start, SubOrder.created_at < end).group_by("d").order_by("d")
        )
    ).all()
    by_day = {d: (int(o), int(g)) for d, o, g in daily}
    series = [{"date": (start_d + timedelta(days=i)).isoformat(), "orders": by_day.get(start_d + timedelta(days=i), (0, 0))[0], "gmv": by_day.get(start_d + timedelta(days=i), (0, 0))[1]} for i in range(days)]

    top_products = (
        await session.execute(
            select(OrderItem.product_id, OrderItem.title, func.sum(OrderItem.qty), func.sum(OrderItem.line_total - OrderItem.seller_discount))
            .join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(*sub_filter, SubOrder.status != "cancelled", SubOrder.created_at >= start, SubOrder.created_at < end)
            .group_by(OrderItem.product_id, OrderItem.title).order_by(func.sum(OrderItem.line_total).desc()).limit(10)
        )
    ).all()
    result = {
        "days": days,
        "from": start_d.isoformat(),
        "to": end_d.isoformat(),
        "gmv": cur["gmv"],
        "gmv_prev": prev["gmv"],
        "orders": cur["orders"],
        "orders_prev": prev["orders"],
        "aov": cur["gmv"] // cur["orders"] if cur["orders"] else 0,
        "units": int(units),
        "commission": cur["commission"],
        "discounts": cur["discounts"],
        "cancellation_rate": _pct(cur["cancelled"], cur["packages"]),
        "return_rate": _pct(returns_count, delivered),
        "returned_value": cur["returned"],
        "avg_hours_to_ship": round(float(ship_hours), 1) if ship_hours else None,
        "views": int(views),
        "add_to_cart": int(carts),
        "conversion_rate": _pct(min(cur["orders"], int(views)), int(views)),  # orders without a tracked view (e.g. ad-blocked beacons) cannot exceed 100%
        "cart_rate": _pct(min(int(carts), int(views)), int(views)),
        "series": series,
        "top_products": [{"product_id": str(pid), "title": t, "units": int(u), "revenue": int(r)} for pid, t, u, r in top_products],
    }
    if seller_id is None:
        new_customers = (await session.execute(select(func.count()).select_from(User).where(User.created_at >= start, User.created_at < end, User.is_admin.is_(False)))).scalar_one()
        buyers = select(Order.user_id).where(Order.status == "placed", Order.placed_at >= start, Order.placed_at < end).distinct().subquery()
        repeat = (
            await session.execute(
                select(func.count()).select_from(buyers).where(
                    select(func.count()).select_from(Order).where(Order.user_id == buyers.c.user_id, Order.status == "placed").scalar_subquery() > 1
                )
            )
        ).scalar_one()
        total_buyers = (await session.execute(select(func.count()).select_from(buyers))).scalar_one()
        top_sellers = (
            await session.execute(
                select(Seller.display_name, func.count(SubOrder.id), func.sum(SubOrder.total))
                .join(SubOrder, SubOrder.seller_id == Seller.id)
                .where(SubOrder.status.notin_(("pending_payment", "cancelled")), SubOrder.created_at >= start, SubOrder.created_at < end)
                .group_by(Seller.display_name).order_by(func.sum(SubOrder.total).desc()).limit(10)
            )
        ).all()
        top_categories = (
            await session.execute(
                select(Category.name, func.sum(OrderItem.line_total - OrderItem.seller_discount))
                .join(Product, Product.category_id == Category.id)
                .join(OrderItem, OrderItem.product_id == Product.id)
                .join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
                .where(SubOrder.status.notin_(("pending_payment", "cancelled")), SubOrder.created_at >= start, SubOrder.created_at < end)
                .group_by(Category.name).order_by(func.sum(OrderItem.line_total).desc()).limit(8)
            )
        ).all()
        pay_mix = dict(
            (await session.execute(select(Order.payment_method, func.count()).where(Order.status == "placed", Order.placed_at >= start, Order.placed_at < end).group_by(Order.payment_method))).all()
        )
        overdue = (
            await session.execute(
                select(func.count()).select_from(SupportTicket).where(
                    and_(SupportTicket.status.notin_(("resolved", "closed")), SupportTicket.acknowledged_at.is_(None), SupportTicket.ack_due_at < func.now())
                )
            )
        ).scalar_one()
        result |= {
            "new_customers": new_customers,
            "buyers": total_buyers,
            "repeat_buyer_rate": _pct(repeat, total_buyers),
            "top_sellers": [{"name": n, "packages": int(c), "gmv": int(g or 0)} for n, c, g in top_sellers],
            "top_categories": [{"name": n, "gmv": int(g or 0)} for n, g in top_categories],
            "payment_mix": {k: int(v) for k, v in pay_mix.items()},
            "tickets_ack_overdue": overdue,
        }
    return result


async def product_performance(session: AsyncSession, seller_id: uuid.UUID, days: int = 30) -> list[dict]:
    _, _, start_d, end_d = _range(days)
    rows = (
        await session.execute(
            select(
                Product.id, Product.title, Product.slug, Product.price_from, Product.in_stock,
                func.coalesce(func.sum(ProductDailyStat.views), 0), func.coalesce(func.sum(ProductDailyStat.add_to_cart), 0),
                func.coalesce(func.sum(ProductDailyStat.orders), 0), func.coalesce(func.sum(ProductDailyStat.units), 0),
                func.coalesce(func.sum(ProductDailyStat.revenue), 0),
            )
            .outerjoin(ProductDailyStat, and_(ProductDailyStat.product_id == Product.id, ProductDailyStat.day >= start_d, ProductDailyStat.day <= end_d))
            .where(Product.seller_id == seller_id, Product.status == "approved")
            .group_by(Product.id).order_by(func.coalesce(func.sum(ProductDailyStat.revenue), 0).desc()).limit(100)
        )
    ).all()
    return [
        {"id": str(pid), "title": t, "slug": s, "price": price, "in_stock": stock, "views": int(v), "add_to_cart": int(c),
         "orders": int(o), "units": int(u), "revenue": int(r), "conversion": _pct(int(o), int(v))}
        for pid, t, s, price, stock, v, c, o, u, r in rows
    ]
