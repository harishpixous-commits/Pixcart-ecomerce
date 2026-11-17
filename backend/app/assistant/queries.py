"""Read-only business queries behind the assistant's tools.

Every figure the assistant states comes from here, computed in SQL. Definitions match the dashboard
(``app.services.analytics.kpis``):

- Sales (GMV): package totals of orders that were placed (not awaiting payment), excluding cancelled packages.
- Orders: distinct orders with at least one such package (cancelled ones included, as on the dashboard).
- Net sales: sales minus the value of items returned.
- Average order value: sales ÷ orders.
Amounts are integer paise in data and Indian-formatted rupees in cards. Dates are IST calendar days.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import Select, and_, case, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import STATES
from app.db import utcnow
from app.models import (
    Category,
    Coupon,
    InventoryLevel,
    LedgerEntry,
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    Payout,
    Product,
    Refund,
    ReturnRequest,
    Review,
    Seller,
    SubOrder,
    SupportTicket,
    User,
    Variant,
)
from app.services.reports import IST

from .periods import Period

LIVE_PACKAGE = SubOrder.status.notin_(("pending_payment",))
SOLD_PACKAGE = SubOrder.status.notin_(("pending_payment", "cancelled"))


def inr(paise: int | float | None) -> str:
    """₹ with Indian digit grouping: 1234567.5 rupees → ₹12,34,567.50."""
    value = (paise or 0) / 100
    sign = "-" if value < 0 else ""
    whole, frac = f"{abs(value):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups) + "," + tail
    return f"{sign}₹{whole}.{frac}"


def num(n: int | float | None) -> str:
    return inr((n or 0) * 100)[1:-3] if isinstance(n, int) or (n is not None and float(n).is_integer()) else f"{n:,.2f}"


def pct(a: float, b: float) -> float:
    return round(a * 100 / b, 1) if b else 0.0


def ist(dt) -> str:
    return dt.astimezone(IST).strftime("%d %b %Y, %I:%M %p") if dt else ""


def ist_day(dt) -> str:
    return dt.astimezone(IST).strftime("%d %b %Y") if dt else ""


def _like(text: str) -> str:
    return "%" + text.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ----------------------------------------------------------------------------- sales


def _sub_filters(period: Period, seller_id: uuid.UUID | None, category_id: uuid.UUID | None, payment_method: str | None, state_code: str | None) -> list:
    f = [LIVE_PACKAGE, SubOrder.created_at >= period.start, SubOrder.created_at < period.end]
    if seller_id:
        f.append(SubOrder.seller_id == seller_id)
    if payment_method:
        f.append(SubOrder.order_id.in_(select(Order.id).where(Order.payment_method == payment_method)))
    if state_code:
        f.append(SubOrder.order_id.in_(select(Order.id).where(Order.ship_to["state_code"].astext == state_code)))
    if category_id:
        f.append(SubOrder.id.in_(select(OrderItem.sub_order_id).join(Product, Product.id == OrderItem.product_id).where(Product.category_id == category_id)))
    return f


async def sales_summary(
    session: AsyncSession, period: Period, *, seller_id: uuid.UUID | None = None, category_id: uuid.UUID | None = None,
    payment_method: str | None = None, state_code: str | None = None,
) -> dict[str, Any]:
    f = _sub_filters(period, seller_id, category_id, payment_method, state_code)
    sold = SubOrder.status != "cancelled"
    row = (
        await session.execute(
            select(
                func.count(distinct(SubOrder.order_id)),
                func.count(SubOrder.id),
                func.coalesce(func.sum(case((sold, SubOrder.total), else_=0)), 0),
                func.coalesce(func.sum(case((SubOrder.status == "cancelled", 1), else_=0)), 0),
                func.coalesce(func.sum(case((SubOrder.status == "cancelled", SubOrder.total), else_=0)), 0),
                func.coalesce(func.sum(case((sold, SubOrder.commission_paise), else_=0)), 0),
                func.coalesce(func.sum(case((sold, SubOrder.platform_discount + SubOrder.seller_discount), else_=0)), 0),
                func.coalesce(func.sum(SubOrder.returned_total), 0),
                func.coalesce(func.sum(case((sold, SubOrder.tcs_paise), else_=0)), 0),
                func.coalesce(func.sum(case((sold, SubOrder.shipping_fee), else_=0)), 0),
                func.coalesce(func.sum(case((SubOrder.status == "delivered", 1), else_=0)), 0),
            ).where(*f)
        )
    ).one()
    orders, packages, gmv, cancelled, cancelled_value, commission, discounts, returned, tcs, shipping, delivered = (int(x) for x in row)
    units = int((await session.execute(
        select(func.coalesce(func.sum(OrderItem.qty), 0)).join(SubOrder, SubOrder.id == OrderItem.sub_order_id).where(*f, SubOrder.status != "cancelled")
    )).scalar_one())
    mix = dict((await session.execute(
        select(Order.payment_method, func.count(distinct(Order.id))).join(SubOrder, SubOrder.order_id == Order.id).where(*f).group_by(Order.payment_method)
    )).all())
    out = {
        "period": period.as_dict(),
        "sales": gmv, "orders": orders, "packages": packages, "units": units,
        "average_order_value": gmv // orders if orders else 0,
        "net_sales": gmv - returned, "returned_value": returned,
        "cancelled_packages": cancelled, "cancelled_value": cancelled_value, "cancellation_rate_pct": pct(cancelled, packages),
        "commission": commission, "discounts": discounts, "delivery_fees": shipping, "tcs_collected": tcs, "delivered_packages": delivered,
        "cod_orders": int(mix.get("cod", 0)), "online_orders": int(mix.get("online", 0)),
    }
    if not (seller_id or category_id or payment_method or state_code):
        out["new_customers"] = int((await session.execute(
            select(func.count()).select_from(User).where(User.created_at >= period.start, User.created_at < period.end, User.is_admin.is_(False))
        )).scalar_one())
        out["refunds_paid"] = int((await session.execute(
            select(func.coalesce(func.sum(Refund.amount_paise), 0)).where(Refund.status == "processed", Refund.updated_at >= period.start, Refund.updated_at < period.end)
        )).scalar_one()) if hasattr(Refund, "updated_at") else 0
        out["awaiting_payment_orders"] = int((await session.execute(
            select(func.count()).select_from(Order).where(Order.status == "pending_payment", Order.created_at >= period.start, Order.created_at < period.end)
        )).scalar_one())
    return out


BREAKDOWNS = ("day", "week", "month", "hour", "seller", "category", "product", "state", "payment_method", "status")


async def sales_breakdown(
    session: AsyncSession, period: Period, by: str, *, seller_id: uuid.UUID | None = None, category_id: uuid.UUID | None = None,
    payment_method: str | None = None, limit: int = 20,
) -> dict[str, Any]:
    if by not in BREAKDOWNS:
        raise ValueError(f"Group by one of: {', '.join(BREAKDOWNS)}")
    f = _sub_filters(period, seller_id, category_id, payment_method, None)
    limit = max(1, min(limit, 100))
    local = func.timezone("Asia/Kolkata", SubOrder.created_at)
    sales = func.coalesce(func.sum(case((SubOrder.status != "cancelled", SubOrder.total), else_=0)), 0)
    orders = func.count(distinct(SubOrder.order_id))
    if by in ("day", "week", "month", "hour"):
        trunc = {"day": func.date(local), "week": func.date_trunc("week", local), "month": func.date_trunc("month", local), "hour": func.extract("hour", local)}[by]
        rows = (await session.execute(select(trunc.label("k"), sales, orders).where(*f).group_by("k").order_by("k"))).all()
        got = {}
        for k, s, o in rows:
            key = int(k) if by == "hour" else (k.date() if hasattr(k, "date") and callable(k.date) else k)
            got[key] = (int(s), int(o))
        items = []
        if by == "day":
            for i in range(period.days):
                d = period.first_day + timedelta(days=i)
                s, o = got.get(d, (0, 0))
                items.append({"label": d.strftime("%d %b"), "key": d.isoformat(), "sales": s, "orders": o})
        elif by == "hour":
            for h in range(24):
                s, o = got.get(h, (0, 0))
                items.append({"label": f"{h:02d}:00", "key": str(h), "sales": s, "orders": o})
        else:
            for k, (s, o) in sorted(got.items()):
                items.append({"label": (k.strftime("%b %Y") if by == "month" else "Week of " + k.strftime("%d %b")), "key": k.isoformat(), "sales": s, "orders": o})
        return {"period": period.as_dict(), "by": by, "items": items}
    if by == "seller":
        stmt = select(Seller.display_name, sales, orders).join(Seller, Seller.id == SubOrder.seller_id).where(*f).group_by(Seller.display_name)
    elif by == "status":
        stmt = select(SubOrder.status, func.coalesce(func.sum(SubOrder.total), 0), orders).where(*f).group_by(SubOrder.status)
    elif by == "payment_method":
        stmt = select(Order.payment_method, sales, orders).join(Order, Order.id == SubOrder.order_id).where(*f).group_by(Order.payment_method)
    elif by == "state":
        stmt = select(Order.ship_to["state_code"].astext, sales, orders).join(Order, Order.id == SubOrder.order_id).where(*f).group_by(Order.ship_to["state_code"].astext)
    else:
        line_sales = func.coalesce(func.sum(OrderItem.line_total - OrderItem.seller_discount), 0)
        units = func.coalesce(func.sum(OrderItem.qty), 0)
        base = select().select_from(OrderItem).join(SubOrder, SubOrder.id == OrderItem.sub_order_id).where(*f, SubOrder.status != "cancelled")
        if by == "category":
            stmt = base.add_columns(Category.name, line_sales, units).join(Product, Product.id == OrderItem.product_id).join(Category, Category.id == Product.category_id).group_by(Category.name)
        else:
            stmt = base.add_columns(OrderItem.title, line_sales, units).group_by(OrderItem.title)
        rows = (await session.execute(stmt.order_by(line_sales.desc()).limit(limit))).all()
        return {"period": period.as_dict(), "by": by, "items": [{"label": n or "—", "sales": int(s), "units": int(u)} for n, s, u in rows]}
    rows = (await session.execute(stmt.order_by(sales.desc() if by != "status" else orders.desc()).limit(limit))).all()
    items = []
    for k, s, o in rows:
        label = STATES.get(k or "", k or "Unknown") if by == "state" else ({"cod": "Cash on delivery", "online": "Paid online"}.get(k, k) if by == "payment_method" else k)
        items.append({"label": label or "—", "sales": int(s), "orders": int(o)})
    return {"period": period.as_dict(), "by": by, "items": items}


# ----------------------------------------------------------------------------- orders


PACKAGE_STATUSES = ("placed", "confirmed", "packed", "shipped", "delivered", "cancelled")


async def find_packages(
    session: AsyncSession, *, period: Period | None, status: str | None = None, q: str | None = None, seller_id: uuid.UUID | None = None,
    payment_method: str | None = None, late_to_ship_hours: int | None = None, limit: int = 25,
) -> dict[str, Any]:
    stmt: Select = (
        select(SubOrder, Order.number, Order.payment_method, Order.ship_to, Seller.display_name, User.name, User.phone)
        .join(Order, Order.id == SubOrder.order_id).join(Seller, Seller.id == SubOrder.seller_id).join(User, User.id == Order.user_id)
        .where(LIVE_PACKAGE)
    )
    if period:
        stmt = stmt.where(SubOrder.created_at >= period.start, SubOrder.created_at < period.end)
    if status:
        if status not in PACKAGE_STATUSES:
            raise ValueError(f"Package status is one of: {', '.join(PACKAGE_STATUSES)}")
        stmt = stmt.where(SubOrder.status == status)
    if seller_id:
        stmt = stmt.where(SubOrder.seller_id == seller_id)
    if payment_method:
        stmt = stmt.where(Order.payment_method == payment_method)
    if late_to_ship_hours:
        stmt = stmt.where(SubOrder.status.in_(("placed", "confirmed", "packed")), SubOrder.created_at < utcnow() - timedelta(hours=late_to_ship_hours))
    if q:
        like = _like(q)
        stmt = stmt.where(or_(SubOrder.number.ilike(like), Order.number.ilike(like), User.phone.ilike(like), User.name.ilike(like), SubOrder.tracking_number.ilike(like)))
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    value = int((await session.execute(select(func.coalesce(func.sum(stmt.subquery().c.total), 0)))).scalar_one())
    rows = (await session.execute(stmt.order_by(SubOrder.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {
        "period": period.as_dict() if period else None, "total": total, "total_value": value,
        "items": [
            {"package": s.number, "order": onum, "order_id": str(s.order_id), "placed": ist(s.created_at), "status": s.status, "seller": seller,
             "customer": cname or "", "phone": phone or "", "payment": "COD" if pm == "cod" else "Online", "total": s.total,
             "city": (ship or {}).get("city", ""), "state": STATES.get((ship or {}).get("state_code", ""), ""), "awb": s.tracking_number}
            for s, onum, pm, ship, seller, cname, phone in rows
        ],
    }


async def order_detail(session: AsyncSession, ref: str) -> dict[str, Any] | None:
    ref = ref.strip().upper()
    o = (await session.execute(select(Order).where(Order.number == ref))).scalar_one_or_none()
    if o is None:
        sub = (await session.execute(select(SubOrder).where(or_(SubOrder.number == ref, SubOrder.tracking_number == ref)))).scalar_one_or_none()
        if sub is None:
            try:
                o = await session.get(Order, uuid.UUID(ref.lower()))
            except ValueError:
                o = None
        else:
            o = await session.get(Order, sub.order_id)
    if o is None:
        return None
    u = await session.get(User, o.user_id)
    subs = list((await session.execute(select(SubOrder, Seller.display_name).join(Seller, Seller.id == SubOrder.seller_id).where(SubOrder.order_id == o.id).order_by(SubOrder.number))).all())
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s, _ in subs])))).scalars()) if subs else []
    pays = list((await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at))).scalars())
    refunds = list((await session.execute(select(Refund).where(Refund.order_id == o.id).order_by(Refund.created_at))).scalars())
    events = list((await session.execute(select(OrderEvent).where(OrderEvent.order_id == o.id).order_by(OrderEvent.created_at).limit(40))).scalars())
    returns = list((await session.execute(select(ReturnRequest).where(ReturnRequest.sub_order_id.in_([s.id for s, _ in subs])))).scalars()) if subs else []
    ship = o.ship_to or {}
    return {
        "order_id": str(o.id), "number": o.number, "status": o.status, "placed": ist(o.placed_at or o.created_at), "payment_method": o.payment_method,
        "payment_status": o.payment_status, "grand_total": o.grand_total, "items_total": o.items_total, "shipping_total": o.shipping_total,
        "discount_total": o.discount_total, "coupon": o.coupon_code, "refunded_total": getattr(o, "refunded_total", 0),
        "customer": {"id": str(u.id) if u else "", "name": u.name if u else "", "phone": u.phone if u else "", "email": (u.email or "") if u else ""},
        "ship_to": {"name": ship.get("full_name", ""), "city": ship.get("city", ""), "state": ship.get("state", ""), "pincode": ship.get("pincode", ""),
                    "address": ", ".join(x for x in (ship.get("line1"), ship.get("line2"), ship.get("landmark")) if x)},
        "packages": [
            {"package": s.number, "seller": seller, "status": s.status, "total": s.total, "commission": s.commission_paise, "seller_payout": s.seller_payout_paise,
             "courier": s.courier_name, "awb": s.tracking_number, "shipped": ist(s.shipped_at), "delivered": ist(s.delivered_at), "cancel_reason": s.cancel_reason,
             "invoice": s.invoice_number}
            for s, seller in subs
        ],
        "items": [{"sku": i.sku, "title": i.title, "option": i.variant_label, "qty": i.qty, "unit_price": i.unit_price, "line_total": i.line_total, "returned_qty": i.returned_qty}
                  for i in items],
        "payments": [{"status": p.status, "method": p.method, "amount": p.amount_paise, "gateway_payment_id": p.provider_payment_id or ""} for p in pays],
        "refunds": [{"id": str(r.id), "amount": r.amount_paise, "status": r.status, "reason": r.reason, "attempts": r.attempts} for r in refunds],
        "returns": [{"number": r.number, "status": r.status, "reason": r.reason, "refund_amount": r.refund_amount} for r in returns],
        "timeline": [{"at": ist(e.created_at), "change": f"{e.from_status or 'new'} → {e.to_status}", "by": e.actor, "note": e.note[:160]} for e in events],
    }


# ----------------------------------------------------------------------------- customers


async def find_customers(session: AsyncSession, *, q: str | None, period: Period | None = None, sort: str = "recent", limit: int = 25) -> dict[str, Any]:
    spent = func.coalesce(func.sum(Order.grand_total - Order.refunded_total), 0)
    agg = select(Order.user_id, func.count().label("n"), spent.label("spent"), func.max(Order.placed_at).label("last")).where(Order.status == "placed")
    if period:
        agg = agg.where(Order.placed_at >= period.start, Order.placed_at < period.end)
    agg = agg.group_by(Order.user_id).subquery()
    stmt = select(User, agg.c.n, agg.c.spent, agg.c.last).outerjoin(agg, agg.c.user_id == User.id).where(User.is_admin.is_(False), User.deleted_at.is_(None))
    if q:
        like = _like(q)
        stmt = stmt.where(or_(User.name.ilike(like), User.phone.ilike(like), User.email.ilike(like)))
    if sort == "top_spenders" or period:
        stmt = stmt.where(agg.c.n.is_not(None)).order_by(agg.c.spent.desc().nullslast())
    else:
        stmt = stmt.order_by(User.created_at.desc())
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    rows = (await session.execute(stmt.limit(max(1, min(limit, 200))))).all()
    return {
        "period": period.as_dict() if period else None, "total": total,
        "items": [{"id": str(u.id), "name": u.name or "", "phone": u.phone or "", "email": u.email or "", "joined": ist_day(u.created_at),
                   "orders": int(n or 0), "spent": int(sp or 0), "last_order": ist_day(last), "active": u.is_active} for u, n, sp, last in rows],
    }


async def customer_detail(session: AsyncSession, ref: str) -> dict[str, Any] | None:
    ref = ref.strip()
    digits = "".join(ch for ch in ref if ch.isdigit())
    cond = [User.email == ref.lower()]
    if len(digits) >= 10:
        cond.append(User.phone == digits[-10:])
    try:
        cond.append(User.id == uuid.UUID(ref))
    except ValueError:
        pass
    u = (await session.execute(select(User).where(or_(*cond), User.is_admin.is_(False)))).scalars().first()
    if u is None:
        u = (await session.execute(select(User).where(User.name.ilike(_like(ref)), User.is_admin.is_(False)).limit(2))).scalars().all()
        if len(u) != 1:
            return None
        u = u[0]
    o = (await session.execute(select(func.count(), func.coalesce(func.sum(Order.grand_total - Order.refunded_total), 0), func.min(Order.placed_at), func.max(Order.placed_at))
                               .where(Order.user_id == u.id, Order.status == "placed"))).one()
    recent = (await session.execute(select(Order).where(Order.user_id == u.id).order_by(Order.created_at.desc()).limit(10))).scalars().all()
    returns = int((await session.execute(select(func.count()).select_from(ReturnRequest).join(SubOrder, SubOrder.id == ReturnRequest.sub_order_id)
                                         .join(Order, Order.id == SubOrder.order_id).where(Order.user_id == u.id))).scalar_one())
    cancelled = int((await session.execute(select(func.count()).select_from(SubOrder).join(Order, Order.id == SubOrder.order_id)
                                           .where(Order.user_id == u.id, SubOrder.status == "cancelled"))).scalar_one())
    tickets = (await session.execute(select(SupportTicket.number, SupportTicket.subject, SupportTicket.status).where(SupportTicket.user_id == u.id)
                                     .order_by(SupportTicket.created_at.desc()).limit(5))).all()
    return {
        "id": str(u.id), "name": u.name or "", "phone": u.phone or "", "email": u.email or "", "joined": ist_day(u.created_at), "active": u.is_active,
        "marketing_consent": bool(getattr(u, "marketing_opt_in", False)), "last_login": ist(getattr(u, "last_login_at", None)),
        "orders": int(o[0]), "net_spend": int(o[1]), "first_order": ist_day(o[2]), "last_order": ist_day(o[3]),
        "average_order_value": int(o[1]) // int(o[0]) if o[0] else 0, "returns": returns, "cancelled_packages": cancelled,
        "recent_orders": [{"number": r.number, "placed": ist_day(r.placed_at or r.created_at), "status": r.status, "payment": r.payment_method, "total": r.grand_total} for r in recent],
        "tickets": [{"number": n, "subject": s, "status": st} for n, s, st in tickets],
    }


# ----------------------------------------------------------------------------- catalogue and stock


async def find_products(
    session: AsyncSession, *, q: str | None = None, status: str | None = None, seller_id: uuid.UUID | None = None, category_id: uuid.UUID | None = None,
    max_stock: int | None = None, sort: str = "recent", limit: int = 25,
) -> dict[str, Any]:
    stock = func.coalesce(func.sum(Variant.stock), 0)
    stmt = (
        select(Product, Seller.display_name, Category.name, stock.label("stock"), func.min(Variant.sku))
        .join(Seller, Seller.id == Product.seller_id).join(Category, Category.id == Product.category_id)
        .outerjoin(Variant, and_(Variant.product_id == Product.id, Variant.is_active.is_(True)))
        .group_by(Product.id, Seller.display_name, Category.name)
    )
    if status:
        stmt = stmt.where(Product.status == status)
    if seller_id:
        stmt = stmt.where(Product.seller_id == seller_id)
    if category_id:
        stmt = stmt.where(Product.category_id == category_id)
    if q:
        like = _like(q)
        stmt = stmt.where(or_(Product.title.ilike(like), Product.brand.ilike(like), Product.id.in_(select(Variant.product_id).where(Variant.sku.ilike(like)))))
    if max_stock is not None:
        stmt = stmt.having(stock <= max_stock)
    order = {"best_selling": Product.sold_count.desc(), "rating": Product.rating_avg.desc().nullslast(), "price_high": Product.price_from.desc(),
             "price_low": Product.price_from.asc(), "stock_low": stock.asc()}.get(sort, Product.updated_at.desc())
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    rows = (await session.execute(stmt.order_by(order).limit(max(1, min(limit, 200))))).all()
    return {"total": total, "items": [
        {"id": str(p.id), "title": p.title, "sku": sku or "", "seller": seller, "category": cat, "status": p.status, "price": p.price_from, "mrp": p.mrp_from,
         "stock": int(st or 0), "sold": p.sold_count, "rating": float(p.rating_avg or 0), "reviews": p.rating_count}
        for p, seller, cat, st, sku in rows]}


async def stock_alerts(session: AsyncSession, *, threshold: int = 5, seller_id: uuid.UUID | None = None, limit: int = 50) -> dict[str, Any]:
    qty = func.coalesce(func.sum(InventoryLevel.quantity), 0)
    stmt = (
        select(Variant.sku, Product.title, Variant.options, Seller.display_name, qty.label("qty"), Product.sold_count)
        .join(Product, Product.id == Variant.product_id).join(Seller, Seller.id == Variant.seller_id)
        .outerjoin(InventoryLevel, InventoryLevel.variant_id == Variant.id)
        .where(Product.status == "approved", Variant.is_active.is_(True))
        .group_by(Variant.id, Product.title, Seller.display_name, Product.sold_count).having(qty <= threshold)
    )
    if seller_id:
        stmt = stmt.where(Variant.seller_id == seller_id)
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    rows = (await session.execute(stmt.order_by(qty.asc(), Product.sold_count.desc()).limit(max(1, min(limit, 200))))).all()
    return {"threshold": threshold, "total": total, "out_of_stock": sum(1 for r in rows if int(r.qty) <= 0), "items": [
        {"sku": sku, "product": title, "option": ", ".join(f"{k}: {v}" for k, v in (opts or {}).items()), "seller": seller, "stock": int(q), "sold": sold}
        for sku, title, opts, seller, q, sold in rows]}


# ----------------------------------------------------------------------------- sellers


async def find_sellers(session: AsyncSession, *, q: str | None = None, status: str | None = None, period: Period | None = None, limit: int = 25) -> dict[str, Any]:
    p = period
    sales_q = select(SubOrder.seller_id, func.coalesce(func.sum(SubOrder.total), 0).label("sales"), func.count(SubOrder.id).label("packages")).where(SOLD_PACKAGE)
    if p:
        sales_q = sales_q.where(SubOrder.created_at >= p.start, SubOrder.created_at < p.end)
    sales_q = sales_q.group_by(SubOrder.seller_id).subquery()
    live = select(Product.seller_id, func.count().label("n")).where(Product.status == "approved").group_by(Product.seller_id).subquery()
    stmt = (select(Seller, sales_q.c.sales, sales_q.c.packages, live.c.n)
            .outerjoin(sales_q, sales_q.c.seller_id == Seller.id).outerjoin(live, live.c.seller_id == Seller.id))
    if status:
        stmt = stmt.where(Seller.status == status)
    if q:
        like = _like(q)
        stmt = stmt.where(or_(Seller.display_name.ilike(like), Seller.legal_name.ilike(like), Seller.gstin.ilike(like), Seller.pickup_city.ilike(like)))
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    rows = (await session.execute(stmt.order_by(sales_q.c.sales.desc().nullslast(), Seller.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {"period": p.as_dict() if p else None, "total": total, "items": [
        {"id": str(s.id), "store": s.display_name, "legal_name": s.legal_name, "status": s.status, "city": s.pickup_city, "gstin": s.gstin or "",
         "sales": int(sales or 0), "packages": int(pk or 0), "live_listings": int(n or 0), "rating": float(s.rating_avg or 0), "phone": s.contact_phone, "email": s.contact_email}
        for s, sales, pk, n in rows]}


async def resolve_seller(session: AsyncSession, ref: str | None) -> Seller | None:
    if not ref:
        return None
    try:
        s = await session.get(Seller, uuid.UUID(ref))
        if s:
            return s
    except ValueError:
        pass
    rows = (await session.execute(select(Seller).where(or_(Seller.display_name.ilike(ref.strip()), Seller.gstin == ref.strip().upper(), Seller.legal_name.ilike(ref.strip()))))).scalars().all()
    if len(rows) == 1:
        return rows[0]
    rows = (await session.execute(select(Seller).where(Seller.display_name.ilike(_like(ref))).limit(2))).scalars().all()
    return rows[0] if len(rows) == 1 else None


async def resolve_category(session: AsyncSession, ref: str | None) -> Category | None:
    if not ref:
        return None
    try:
        c = await session.get(Category, uuid.UUID(ref))
        if c:
            return c
    except ValueError:
        pass
    rows = (await session.execute(select(Category).where(or_(Category.name.ilike(ref.strip()), Category.slug == ref.strip().lower())))).scalars().all()
    if len(rows) == 1:
        return rows[0]
    rows = (await session.execute(select(Category).where(Category.name.ilike(_like(ref))).limit(2))).scalars().all()
    return rows[0] if len(rows) == 1 else None


async def seller_detail(session: AsyncSession, seller: Seller, period: Period) -> dict[str, Any]:
    summary = await sales_summary(session, period, seller_id=seller.id)
    now = utcnow()
    due = int((await session.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
        LedgerEntry.seller_id == seller.id, LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now))).scalar_one())
    pending = int((await session.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
        LedgerEntry.seller_id == seller.id, LedgerEntry.payout_id.is_(None), LedgerEntry.available_at > now))).scalar_one())
    counts = dict((await session.execute(select(Product.status, func.count()).where(Product.seller_id == seller.id).group_by(Product.status))).all())
    late = int((await session.execute(select(func.count()).select_from(SubOrder).where(
        SubOrder.seller_id == seller.id, SubOrder.status.in_(("placed", "confirmed", "packed")), SubOrder.created_at < now - timedelta(hours=48)))).scalar_one())
    from app.ai.briefs import seller_risk

    brief = await seller_risk(session, seller)
    return {
        "id": str(seller.id), "store": seller.display_name, "legal_name": seller.legal_name, "status": seller.status, "gstin": seller.gstin or "",
        "city": seller.pickup_city, "state": STATES.get(seller.pickup_state_code, ""), "phone": seller.contact_phone, "email": seller.contact_email,
        "joined": ist_day(seller.created_at), "rating": float(seller.rating_avg or 0), "rating_count": seller.rating_count, "holiday_mode": seller.holiday_mode,
        "commission_override_pct": (seller.commission_bps_override / 100) if seller.commission_bps_override is not None else None,
        "listings": {k: int(v) for k, v in counts.items()}, "payout_due_now": due, "payout_on_hold": pending, "packages_late_to_ship": late,
        "sales": summary, "health": {"score": brief["score"], "level": brief["level"], "headline": brief["headline"], "factors": brief["factors"][:5]},
    }


# ----------------------------------------------------------------------------- returns, refunds, support, payouts


async def find_returns(session: AsyncSession, *, period: Period | None, status: str | None = None, seller_id: uuid.UUID | None = None, limit: int = 25) -> dict[str, Any]:
    stmt = select(ReturnRequest, SubOrder.number, Seller.display_name).join(SubOrder, SubOrder.id == ReturnRequest.sub_order_id).join(Seller, Seller.id == ReturnRequest.seller_id)
    if period:
        stmt = stmt.where(ReturnRequest.created_at >= period.start, ReturnRequest.created_at < period.end)
    if status:
        stmt = stmt.where(ReturnRequest.status == status)
    if seller_id:
        stmt = stmt.where(ReturnRequest.seller_id == seller_id)
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    counts_stmt = select(ReturnRequest.status, func.count())
    if period:
        counts_stmt = counts_stmt.where(ReturnRequest.created_at >= period.start, ReturnRequest.created_at < period.end)
    counts = dict((await session.execute(counts_stmt.group_by(ReturnRequest.status))).all())
    reasons = dict((await session.execute(select(ReturnRequest.reason, func.count()).where(*( [ReturnRequest.created_at >= period.start, ReturnRequest.created_at < period.end] if period else [])).group_by(ReturnRequest.reason))).all())
    rows = (await session.execute(stmt.order_by(ReturnRequest.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {"period": period.as_dict() if period else None, "total": total, "by_status": {k: int(v) for k, v in counts.items()},
            "by_reason": {k: int(v) for k, v in reasons.items()},
            "items": [{"id": str(r.id), "number": r.number, "package": sub, "seller": seller, "requested": ist(r.created_at), "status": r.status, "reason": r.reason,
                       "refund_amount": r.refund_amount} for r, sub, seller in rows]}


async def find_refunds(session: AsyncSession, *, status: str | None = None, period: Period | None = None, limit: int = 25) -> dict[str, Any]:
    stmt = select(Refund, Order.number).join(Order, Order.id == Refund.order_id)
    if status:
        stmt = stmt.where(Refund.status == status)
    if period:
        stmt = stmt.where(Refund.created_at >= period.start, Refund.created_at < period.end)
    counts = dict((await session.execute(select(Refund.status, func.count()).group_by(Refund.status))).all())
    total_value = int((await session.execute(select(func.coalesce(func.sum(stmt.subquery().c.amount_paise), 0)))).scalar_one())
    rows = (await session.execute(stmt.order_by(Refund.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {"by_status": {k: int(v) for k, v in counts.items()}, "total_value": total_value, "items": [
        {"id": str(r.id), "order": num_, "amount": r.amount_paise, "status": r.status, "reason": r.reason, "attempts": r.attempts, "last_error": (r.last_error or "")[:120],
         "created": ist(r.created_at)} for r, num_ in rows]}


async def find_tickets(session: AsyncSession, *, status: str | None = None, overdue_only: bool = False, q: str | None = None, limit: int = 25) -> dict[str, Any]:
    stmt = select(SupportTicket, Order.number).outerjoin(Order, Order.id == SupportTicket.order_id)
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    if overdue_only:
        stmt = stmt.where(SupportTicket.status.notin_(("resolved", "closed")), or_(
            and_(SupportTicket.acknowledged_at.is_(None), SupportTicket.ack_due_at < func.now()), SupportTicket.resolve_due_at < func.now()))
    if q:
        like = _like(q)
        stmt = stmt.where(or_(SupportTicket.number.ilike(like), SupportTicket.subject.ilike(like)))
    counts = dict((await session.execute(select(SupportTicket.status, func.count()).group_by(SupportTicket.status))).all())
    total = int((await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one())
    rows = (await session.execute(stmt.order_by(SupportTicket.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {"by_status": {k: int(v) for k, v in counts.items()}, "total": total, "items": [
        {"id": str(t.id), "number": t.number, "subject": t.subject, "category": t.category, "status": t.status, "priority": t.priority, "grievance": t.is_grievance,
         "opened": ist(t.created_at), "order": onum or "", "reply_due": ist(t.ack_due_at), "replied": ist(t.acknowledged_at), "resolve_due": ist(t.resolve_due_at)}
        for t, onum in rows]}


async def payouts_overview(session: AsyncSession, *, status: str | None = None, limit: int = 25) -> dict[str, Any]:
    now = utcnow()
    due = (await session.execute(
        select(Seller.display_name, func.sum(LedgerEntry.amount)).join(Seller, Seller.id == LedgerEntry.seller_id)
        .where(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now).group_by(Seller.display_name).having(func.sum(LedgerEntry.amount) > 0)
        .order_by(func.sum(LedgerEntry.amount).desc())
    )).all()
    on_hold = int((await session.execute(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at > now))).scalar_one())
    stmt = select(Payout, Seller.display_name).join(Seller, Seller.id == Payout.seller_id)
    if status:
        stmt = stmt.where(Payout.status == status)
    counts = dict((await session.execute(select(Payout.status, func.count()).group_by(Payout.status))).all())
    rows = (await session.execute(stmt.order_by(Payout.created_at.desc()).limit(max(1, min(limit, 200))))).all()
    return {"due_now_total": sum(int(a) for _, a in due), "due_now": [{"seller": n, "amount": int(a)} for n, a in due[:50]], "on_hold_total": on_hold,
            "by_status": {k: int(v) for k, v in counts.items()},
            "items": [{"number": p.number, "seller": n, "amount": p.amount, "status": p.status, "mode": p.mode, "utr": p.utr, "created": ist_day(p.created_at),
                       "paid": ist_day(p.paid_at), "failure": p.failure_reason} for p, n in rows]}


async def pending_work(session: AsyncSession) -> dict[str, Any]:
    """The queue of things waiting for staff, for "what needs my attention?"."""
    now = utcnow()

    async def count(stmt) -> int:
        return int((await session.execute(stmt)).scalar_one())

    return {
        "sellers_to_review": await count(select(func.count()).select_from(Seller).where(Seller.status == "submitted")),
        "listings_to_review": await count(select(func.count()).select_from(Product).where(Product.status == "pending")),
        "packages_late_to_ship_48h": await count(select(func.count()).select_from(SubOrder).where(SubOrder.status.in_(("placed", "confirmed", "packed")), SubOrder.created_at < now - timedelta(hours=48))),
        "returns_waiting": await count(select(func.count()).select_from(ReturnRequest).where(ReturnRequest.status.in_(("requested", "received")))),
        "refunds_failed": await count(select(func.count()).select_from(Refund).where(Refund.status == "failed")),
        "tickets_reply_overdue": await count(select(func.count()).select_from(SupportTicket).where(SupportTicket.status.notin_(("resolved", "closed")), SupportTicket.acknowledged_at.is_(None), SupportTicket.ack_due_at < func.now())),
        "tickets_open": await count(select(func.count()).select_from(SupportTicket).where(SupportTicket.status.in_(("open",)))),
        "reviews_to_moderate": await count(select(func.count()).select_from(Review).where(Review.status == "pending")),
        "payouts_failed": await count(select(func.count()).select_from(Payout).where(Payout.status == "failed")),
        "out_of_stock_options": await count(select(func.count()).select_from(Variant).join(Product, Product.id == Variant.product_id).where(Product.status == "approved", Variant.is_active.is_(True), Variant.stock <= 0)),
    }


async def coupons_overview(session: AsyncSession, *, active_only: bool = False) -> dict[str, Any]:
    stmt = select(Coupon).order_by(Coupon.created_at.desc())
    if active_only:
        stmt = stmt.where(Coupon.is_active.is_(True))
    rows = (await session.execute(stmt.limit(100))).scalars().all()
    return {"items": [{"code": c.code, "kind": c.kind, "value": c.value, "min_order": c.min_order_paise, "max_discount": c.max_discount_paise, "active": c.is_active,
                       "used": c.used_count, "usage_limit": c.usage_limit, "ends": ist_day(c.ends_at), "funded_by": c.funded_by} for c in rows]}
