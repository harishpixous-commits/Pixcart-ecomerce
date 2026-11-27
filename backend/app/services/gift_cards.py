"""Gift cards (Admin -> Growth -> Gift cards). Off by default.

Staff issue a card (code, amount between min_paise and max_paise, valid validity_days). The holder redeems all or part of the
balance: the amount moves into a single-use platform-funded flat coupon (30 days) that is applied at checkout like any
coupon, so discount, refund and cancellation rules stay the same. A coupon that runs out unused gives the amount back to the
card (while the card itself is still valid). Not built yet: shoppers buying a card online (that needs a payment flow)."""
from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import rate_limit
from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import Coupon, GiftCard, GiftCardUse
from app.services import growth

COUPON_DAYS = 30


def _cfg(g: dict) -> dict:
    return g["gift_cards"]


async def issue(session: AsyncSession, amount_paise: int, note: str = "", validity_days: int | None = None) -> GiftCard:
    cfg = _cfg(await growth.get(session))
    if not cfg["enabled"]:
        raise ApiError("Gift cards are switched off in Admin → Growth.", "gift_cards_off", 400)
    if not cfg["min_paise"] <= amount_paise <= cfg["max_paise"]:
        raise ApiError(f"Amount must be between ₹{cfg['min_paise'] / 100:,.0f} and ₹{cfg['max_paise'] / 100:,.0f}.", "invalid_amount", 400)
    now = utcnow()
    card = GiftCard(code="GC" + secrets.token_hex(5).upper(), initial_paise=amount_paise, balance_paise=amount_paise, status="active",
                    expires_at=now + timedelta(days=validity_days or cfg["validity_days"]), note=note.strip()[:200], created_at=now)
    session.add(card)
    await session.flush()
    return card


async def restore_expired(session: AsyncSession, card: GiftCard) -> int:
    now = utcnow()
    back = 0
    uses = (await session.execute(select(GiftCardUse).where(GiftCardUse.gift_card_id == card.id, GiftCardUse.restored.is_(False)))).scalars().all()
    for u in uses:
        cp = (await session.execute(select(Coupon).where(Coupon.code == u.coupon_code))).scalar_one_or_none()
        if cp is not None and cp.used_count == 0 and cp.ends_at is not None and cp.ends_at <= now:
            u.restored = True
            back += u.amount_paise
    if back:
        card.balance_paise += back
        await session.flush()
    return back


async def _find(session: AsyncSession, code: str, *, lock: bool = False) -> GiftCard:
    q = select(GiftCard).where(GiftCard.code == code.strip().upper())
    card = (await session.execute(q.with_for_update() if lock else q)).scalar_one_or_none()
    if card is None:
        raise ApiError("That gift card code is not valid.", "invalid_code", 400)
    return card


def view(card: GiftCard) -> dict:
    return {"balance_paise": card.balance_paise, "initial_paise": card.initial_paise, "expires_at": card.expires_at.isoformat(),
            "status": "expired" if card.status == "active" and card.expires_at <= utcnow() else card.status}


async def balance(session: AsyncSession, user_id: uuid.UUID, code: str) -> dict:
    await rate_limit(session, f"giftcard:{user_id}", limit=20, window_seconds=600)
    cfg = _cfg(await growth.get(session))
    if not cfg["enabled"]:
        raise ApiError("Gift cards are not available right now.", "gift_cards_off", 400)
    card = await _find(session, code)
    await restore_expired(session, card)
    return view(card)


async def redeem(session: AsyncSession, user_id: uuid.UUID, code: str, amount_paise: int | None) -> dict:
    await rate_limit(session, f"giftcard:{user_id}", limit=20, window_seconds=600)
    cfg = _cfg(await growth.get(session))
    if not cfg["enabled"]:
        raise ApiError("Gift cards are not available right now.", "gift_cards_off", 400)
    card = await _find(session, code, lock=True)
    now = utcnow()
    if card.status != "active" or card.expires_at <= now:
        raise ApiError("This gift card is not valid any more.", "card_unavailable", 400)
    await restore_expired(session, card)
    amount = card.balance_paise if amount_paise is None else amount_paise
    if amount <= 0 or amount > card.balance_paise:
        raise ApiError("That is more than the balance on this card.", "balance_too_low", 400)
    ccode = "GV" + secrets.token_hex(4).upper()
    session.add(Coupon(code=ccode, description="Gift card", kind="flat", value=amount, min_order_paise=amount, ends_at=now + timedelta(days=COUPON_DAYS),
                       usage_limit=1, per_user_limit=1, funded_by="platform", is_active=True, show_on_checkout=False))
    card.balance_paise -= amount
    session.add(GiftCardUse(gift_card_id=card.id, user_id=user_id, coupon_code=ccode, amount_paise=amount, created_at=now))
    await session.flush()
    return {"code": ccode, "discount_paise": amount, "min_order_paise": amount, "valid_days": COUPON_DAYS, "card_balance_paise": card.balance_paise}


async def void(session: AsyncSession, card_id: uuid.UUID) -> GiftCard:
    card = await session.get(GiftCard, card_id)
    if card is None:
        raise NotFound("Gift card")
    card.status = "void"
    await session.flush()
    return card
