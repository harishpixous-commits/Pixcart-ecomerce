"""Review reminders (Admin -> Growth -> Review reminders, off by default). A job sends one in-app note, once per delivered package,
after_days after delivery, when the shopper has not reviewed any product in it yet. Packages delivered more than max_age_days ago are
skipped, so switching the module on does not message old orders."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import Order, OrderItem, Review, SubOrder, User
from app.services import growth
from app.services.notify import notify


async def send_due(session: AsyncSession, batch: int = 200) -> int:
    cfg = (await growth.get(session))["review_reminders"]
    if not cfg["enabled"]:
        return 0
    now = utcnow()
    due = now - timedelta(days=cfg["after_days"])
    oldest = now - timedelta(days=cfg["max_age_days"])
    rows = (await session.execute(
        select(SubOrder, Order.user_id).join(Order, Order.id == SubOrder.order_id)
        .where(SubOrder.status == "delivered", SubOrder.review_reminded_at.is_(None), SubOrder.delivered_at <= due, SubOrder.delivered_at >= oldest)
        .order_by(SubOrder.delivered_at).limit(batch))).all()
    sent = 0
    for sub, user_id in rows:
        sub.review_reminded_at = now  # once, whether or not a note goes out
        item = (await session.execute(
            select(OrderItem.title).where(
                OrderItem.sub_order_id == sub.id,
                ~exists().where(Review.user_id == user_id, Review.product_id == OrderItem.product_id))
            .order_by(OrderItem.title).limit(1))).scalar_one_or_none()
        if item is None:
            continue  # everything in the package is already reviewed
        user = await session.get(User, user_id)
        if user is None:
            continue
        await notify(session, "review_reminder", user, {"item": item}, link=f"/orders/{sub.order_id}", channels=("inapp",))
        sent += 1
    await session.flush()
    return sent
