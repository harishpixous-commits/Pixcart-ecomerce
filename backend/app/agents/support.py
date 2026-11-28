"""Support agent. Finds open tickets where the customer wrote last and nobody on staff has answered for a while, and writes a first reply
for staff to approve. The reply only acknowledges the message: it never promises a refund, a date or compensation. Rule based."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import SupportTicket, TicketMessage, User

from .core import AgentDef


def draft(first_name: str, subject: str) -> str:
    who = first_name or "there"
    return (f"Hi {who}, thank you for writing to us about \"{subject[:80]}\". We have your message and a member of our team is looking into it. "
            "We will reply here as soon as we have checked. Please do not share OTPs, passwords or card details with anyone, including us.")


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    now = utcnow()
    cutoff = now - timedelta(hours=cfg["support_wait_hours"])
    rows = (await session.execute(select(SupportTicket).where(SupportTicket.status == "open", SupportTicket.acknowledged_at.is_(None),
                                                              SupportTicket.created_at >= now - timedelta(days=cfg["support_max_age_days"])).order_by(SupportTicket.created_at).limit(100))).scalars().all()
    out = []
    for t in rows:
        msgs = list((await session.execute(select(TicketMessage).where(TicketMessage.ticket_id == t.id, TicketMessage.is_internal.is_(False)).order_by(TicketMessage.created_at))).scalars())
        if not msgs or msgs[-1].author_role != "customer" or msgs[-1].created_at > cutoff:
            continue
        u = await session.get(User, t.user_id)
        first = (u.name or "").split(" ")[0] if u else ""
        body = draft(first, t.subject)
        out.append(dict(kind="reply_ticket", key=f"{t.id}:{len(msgs)}",
                        summary=f"Send a first reply on ticket {t.number}: \"{t.subject[:80]}\" has waited {int((now - msgs[-1].created_at).total_seconds() // 3600)} hours",
                        details=[["Ticket", t.number], ["Category", t.category], ["Priority", t.priority], ["Draft reply", body]],
                        params={"ticket_id": str(t.id), "messages": len(msgs), "body": body}, permission="support"))
    return out


AGENT = AgentDef(
    "support", "Support agent",
    "Finds open tickets that nobody has answered after a few hours and drafts a first acknowledging reply for staff to approve.",
    "Only the first acknowledgement. It does not decide refunds or replacements, read attachments or answer follow-up questions. Staff still resolve the ticket.",
    scan)
