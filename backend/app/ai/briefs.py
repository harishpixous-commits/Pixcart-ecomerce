"""Deterministic risk briefs (no AI call, always available, explainable).

Pattern from Metanic's lending approval brief: a weighted score from facts already in the database,
bucketed GREEN / AMBER / RED, with every contributing factor listed so a person can see why.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import (
    Order,
    Product,
    ReturnRequest,
    Seller,
    SubOrder,
    SupportTicket,
    User,
)

BUCKETS = (("GREEN", 30), ("AMBER", 60), ("RED", 101))
HEADLINES = {
    "GREEN": "Low risk: looks routine",
    "AMBER": "Worth a look: a few flags",
    "RED": "High risk: check before acting",
}


def _level(score: int) -> str:
    return next(level for level, ceiling in BUCKETS if score < ceiling)


def _result(factors: list[tuple[int, str]], notes: list[str], insufficient: bool = False) -> dict:
    score = min(100, sum(w for w, _ in factors))
    level = _level(score)
    return {"score": score, "level": level, "headline": HEADLINES[level], "factors": [{"weight": w, "text": t} for w, t in factors],
            "notes": notes, "insufficient_history": insufficient}


async def seller_risk(session: AsyncSession, seller: Seller) -> dict:
    since = utcnow() - timedelta(days=90)
    total, cancelled_by_seller, late, rto = (await session.execute(
        select(
            func.count(),
            func.count().filter(SubOrder.status == "cancelled", SubOrder.cancelled_by == "seller", SubOrder.shipped_at.is_(None)),
            func.count().filter(SubOrder.shipped_at.is_not(None), SubOrder.shipped_at - SubOrder.created_at > timedelta(days=max(1, seller.dispatch_days) + 1)),
            # shipped by the seller's own courier and brought back (marked "Returned to me")
            func.count().filter(SubOrder.status == "cancelled", SubOrder.cancelled_by == "seller", SubOrder.shipped_at.is_not(None)),
        ).where(SubOrder.seller_id == seller.id, SubOrder.created_at >= since, SubOrder.status != "pending_payment")
    )).one()
    delivered = (await session.execute(select(func.count()).where(SubOrder.seller_id == seller.id, SubOrder.delivered_at >= since))).scalar_one()
    returns = (await session.execute(select(func.count()).select_from(ReturnRequest).where(ReturnRequest.seller_id == seller.id, ReturnRequest.created_at >= since))).scalar_one()
    rejected_listings = (await session.execute(select(func.count()).where(Product.seller_id == seller.id, Product.status == "rejected"))).scalar_one()
    factors: list[tuple[int, str]] = []
    notes = [f"{total} packages in the last 90 days, {delivered} delivered."]
    if total:
        cancel_rate = cancelled_by_seller / total
        if cancel_rate > 0.05:
            factors.append((min(35, int(cancel_rate * 200)), f"Seller cancelled {cancel_rate:.0%} of packages (target under 5%)"))
        late_rate = late / total
        if late_rate > 0.1:
            factors.append((min(25, int(late_rate * 100)), f"{late_rate:.0%} shipped later than promised"))
        rto_rate = rto / total
        if rto_rate > 0.1:
            factors.append((min(25, int(rto_rate * 100)), f"{rto_rate:.0%} of packages came back undelivered (RTO), by the seller's own courier"))
    if rto:
        notes.append(f"{rto} package(s) marked as returned to the seller (RTO).")
    if delivered:
        return_rate = returns / delivered
        if return_rate > 0.1:
            factors.append((min(25, int(return_rate * 120)), f"Return rate {return_rate:.0%} (target under 10%)"))
    if seller.rating_count >= 5 and float(seller.rating_avg or 0) < 3.5:
        factors.append((20, f"Store rating {float(seller.rating_avg):.1f} from {seller.rating_count} reviews"))
    if rejected_listings >= 3:
        factors.append((10, f"{rejected_listings} listings rejected in moderation"))
    if seller.approved_at and utcnow() - seller.approved_at < timedelta(days=30):
        factors.append((10, "Approved less than 30 days ago"))
    return _result(factors, notes, insufficient=total < 5)


async def order_risk(session: AsyncSession, order: Order) -> dict:
    """Cash-on-delivery and fraud signals for one order."""
    user = await session.get(User, order.user_id)
    factors: list[tuple[int, str]] = []
    notes: list[str] = []
    placed = (await session.execute(select(func.count()).where(Order.user_id == order.user_id, Order.status == "placed"))).scalar_one()
    cancelled = (await session.execute(
        select(func.count()).select_from(SubOrder).join(Order, Order.id == SubOrder.order_id)
        .where(Order.user_id == order.user_id, SubOrder.status == "cancelled", SubOrder.cancelled_by == "customer")
    )).scalar_one()
    returns = (await session.execute(select(func.count()).select_from(ReturnRequest).where(ReturnRequest.user_id == order.user_id))).scalar_one()
    rto_pin = (await session.execute(
        select(func.count()).select_from(SubOrder).join(Order, Order.id == SubOrder.order_id)
        .where(Order.ship_to["pincode"].astext == str(order.ship_to.get("pincode", "")), SubOrder.status == "cancelled", SubOrder.shipped_at.is_not(None))
    )).scalar_one()
    tickets = (await session.execute(select(func.count()).select_from(SupportTicket).where(SupportTicket.user_id == order.user_id))).scalar_one()
    notes.append(f"Customer has {placed} placed orders, {returns} returns and {tickets} support tickets.")
    if order.payment_method == "cod":
        if order.grand_total >= 500_000:
            factors.append((25, "Cash on delivery above ₹5,000"))
        elif order.grand_total >= 200_000:
            factors.append((10, "Cash on delivery above ₹2,000"))
    if user and user.created_at and utcnow() - user.created_at < timedelta(days=2):
        factors.append((15, "Account created in the last 2 days"))
    if placed <= 1:
        factors.append((10, "First order"))
    if cancelled >= 3:
        factors.append((20, f"Customer cancelled {cancelled} packages before"))
    if returns >= 3 and placed and returns / placed > 0.5:
        factors.append((20, f"Returned {returns} times across {placed} orders"))
    if rto_pin >= 3:
        factors.append((15, f"{rto_pin} shipments to PIN {order.ship_to.get('pincode')} came back undelivered"))
    if order.coupon_code and placed <= 1 and order.discount_total >= 20_000:
        factors.append((5, f"Large first-order coupon ({order.coupon_code})"))
    return _result(factors, notes, insufficient=placed < 2)
