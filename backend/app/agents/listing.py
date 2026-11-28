"""Listing agent. Looks at products waiting for review and runs the marketplace's own listing rules on each (restricted items, phone
numbers or links in the text, a suspicious discount, a very short description). Clean listings get a proposal to approve; the others get a
proposal to send back with the exact reasons. Staff decide every one. Rule based: no AI model is called."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import service as ai_service
from app.ai.tasks import rule_check
from app.models import Product

from .core import AgentDef


async def scan(session: AsyncSession, cfg: dict[str, Any]) -> list[dict]:
    out = []
    rows = (await session.execute(select(Product).where(Product.status == "pending").order_by(Product.updated_at).limit(100))).scalars().all()
    for p in rows:
        snap = await ai_service._product(session, str(p.id), None)
        if not snap:
            continue
        res = rule_check(snap)
        key = f"{p.id}:{p.updated_at.strftime('%Y%m%d%H%M%S') if p.updated_at else ''}"  # a re-submitted listing is looked at again
        if res["risk"] == "low":
            out.append(dict(kind="approve_listing", key=key, summary=f"Approve \"{p.title}\": passes every listing check",
                            details=[["Listing", p.title], ["Checks", "No restricted words, no contact details, discount looks normal, description is long enough"]],
                            params={"product_id": str(p.id), "title": p.title}, permission="catalog"))
        else:
            reason = "; ".join(res["issues"])[:900]
            out.append(dict(kind="reject_listing", key=key, summary=f"Send back \"{p.title}\": {res['issues'][0]}",
                            details=[["Listing", p.title], ["Risk", res["risk"]], *[["Issue", i] for i in res["issues"]]],
                            params={"product_id": str(p.id), "title": p.title, "reason": reason}, permission="catalog"))
    return out


AGENT = AgentDef(
    "listing", "Listing review agent",
    "Runs the listing rules on every product waiting for review. Proposes approving the clean ones and sending the rest back to the seller with the exact reasons.",
    "Checks text and price rules only. Does not look at photos, check the brand is genuine or compare against other sellers. Does not rewrite listings.",
    scan)
