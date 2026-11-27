"""Abandoned-cart reminders (Admin -> Growth -> Abandoned cart reminders). Off by default.

A cart is abandoned when its newest change is older than `first_reminder_hours`, it is worth at least `min_cart_paise`
and the customer has not ordered since. Stage 1 goes after first_reminder_hours, stage 2 after second_reminder_hours, a
further stage after another second_reminder_hours each, up to max_reminders. Only customers who opted in to marketing
messages get one. Changing the cart starts the stages again. The optional coupon code is named in the message."""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import CartItem, CartReminder, Order, Product, User, Variant
from app.services import growth
from app.services.notify import notify

BATCH = 200


def due_hours(cfg: dict, stage: int) -> int:
    return cfg["first_reminder_hours"] if stage == 1 else cfg["second_reminder_hours"] * (stage - 1)


async def send_due(session: AsyncSession) -> int:
    """Queues the reminders that are due. Returns how many were sent."""
    from datetime import timedelta

    cfg = (await growth.get(session))["abandoned_cart"]
    if not cfg["enabled"]:
        return 0
    now = utcnow()
    newest = func.max(CartItem.updated_at)
    rows = (await session.execute(
        select(CartItem.user_id, newest).group_by(CartItem.user_id).having(newest <= now - timedelta(hours=cfg["first_reminder_hours"])).limit(BATCH)
    )).all()
    sent = 0
    for user_id, last in rows:
        user = await session.get(User, user_id)
        if user is None or user.deleted_at is not None or not user.is_active or not user.marketing_opt_in:
            continue
        if (await session.execute(select(Order.id).where(Order.user_id == user_id, Order.created_at >= last).limit(1))).first():
            continue
        done = (await session.execute(select(func.count()).select_from(CartReminder).where(CartReminder.user_id == user_id, CartReminder.sent_at >= last))).scalar_one()
        stage = done + 1
        if stage > cfg["max_reminders"] or now < last + timedelta(hours=due_hours(cfg, stage)):
            continue
        lines = (await session.execute(
            select(CartItem.qty, Variant.price_paise, Product.title).join(Variant, Variant.id == CartItem.variant_id).join(Product, Product.id == Variant.product_id)
            .where(CartItem.user_id == user_id, Variant.is_active.is_(True), Product.status == "approved").order_by(CartItem.created_at)
        )).all()
        total = sum(q * p for q, p, _ in lines)
        if not lines or total < cfg["min_cart_paise"]:
            continue
        coupon = cfg["offer_coupon"].strip()
        await notify(session, "abandoned_cart", user, {
            "item": lines[0][2], "more": f" and {len(lines) - 1} more" if len(lines) > 1 else "", "amount": f"₹{total / 100:,.2f}",
            "offer": f" Use code {coupon} at checkout." if coupon else "",
        }, link="/cart")
        session.add(CartReminder(user_id=user_id, stage=stage, cart_paise=total, sent_at=now))
        sent += 1
    await session.flush()
    return sent
