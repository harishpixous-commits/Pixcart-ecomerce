"""Customer support tickets: one place for the rules, used by the support pages and the shop assistant."""
from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import Order, SupportTicket, TicketMessage, User

CATEGORIES = {
    "order": "A problem with an order",
    "delivery": "Delivery or tracking",
    "payment": "Payment or refund",
    "return": "Return or replacement",
    "product": "Product quality or listing",
    "account": "My account",
    "other": "Something else",
}

MAX_OPEN = 10


async def create_ticket(session: AsyncSession, user: User, *, category: str, subject: str, message: str,
                        order_id: uuid.UUID | None = None, is_grievance: bool = False) -> SupportTicket:
    """Opens a ticket with the customer's first message. The caller commits."""
    if category not in CATEGORIES:
        raise ApiError("Choose what your request is about", "invalid_category")
    if order_id:
        o = await session.get(Order, order_id)
        if o is None or o.user_id != user.id:
            raise NotFound("Order")
    open_count = (await session.execute(select(func.count()).select_from(SupportTicket).where(
        SupportTicket.user_id == user.id, SupportTicket.status.in_(("open", "awaiting_customer"))))).scalar_one()
    if open_count >= MAX_OPEN:
        raise ApiError(f"You have {MAX_OPEN} open requests. Please wait for a reply on those first.", "too_many_tickets")
    now = utcnow()
    t = SupportTicket(
        number=f"TK{now:%y%m%d}{secrets.token_hex(2).upper()}", user_id=user.id, order_id=order_id, category=category,
        subject=subject.strip(), is_grievance=is_grievance, priority="high" if is_grievance else "normal",
        # Consumer Protection (E-Commerce) Rules 2020: acknowledge within 48 hours, resolve within one month.
        ack_due_at=now + timedelta(hours=48), resolve_due_at=now + timedelta(days=30),
    )
    session.add(t)
    await session.flush()
    session.add(TicketMessage(ticket_id=t.id, author_id=user.id, author_role="customer", body=message.strip(), created_at=now))
    from app.services.notify import notify_staff

    label = "New grievance" if is_grievance else "New support request"
    await notify_staff(session, "support", "staff_ticket", {"subject": f"{label} {t.number}", "message": f"{subject.strip()}. A reply is due within 48 hours."}, link=f"/admin/support/{t.id}")
    return t
