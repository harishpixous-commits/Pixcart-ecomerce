"""Gift cards (Admin -> Growth -> Gift cards). Off by default.

Staff issue a card (code, amount between min_paise and max_paise, valid validity_days). The holder redeems all or part of the
balance: the amount moves into a single-use platform-funded flat coupon (30 days) that is applied at checkout like any
coupon, so discount, refund and cancellation rules stay the same. A coupon that runs out unused gives the amount back to the
card (while the card itself is still valid). Shoppers can also buy a card online when gift_cards.allow_purchase is on (see start_purchase / check_purchase): the card is
issued once, only after the gateway's own records show the money captured for the full amount. Razorpay is not used for this
(its path is tied to orders); the other gateways are. There is no webhook for purchases yet: the shopper's return page calls check."""
from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import rate_limit
from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import Coupon, GiftCard, GiftCardPurchase, GiftCardUse
from app.services import growth

COUPON_DAYS = 30


def _cfg(g: dict) -> dict:
    return g["gift_cards"]


def _check_amount(cfg: dict, amount_paise: int) -> None:
    if not cfg["min_paise"] <= amount_paise <= cfg["max_paise"]:
        raise ApiError(f"Amount must be between ₹{cfg['min_paise'] / 100:,.0f} and ₹{cfg['max_paise'] / 100:,.0f}.", "invalid_amount", 400)


async def issue(session: AsyncSession, amount_paise: int, note: str = "", validity_days: int | None = None) -> GiftCard:
    cfg = _cfg(await growth.get(session))
    if not cfg["enabled"]:
        raise ApiError("Gift cards are switched off in Admin → Growth.", "gift_cards_off", 400)
    _check_amount(cfg, amount_paise)
    return await _make_card(session, cfg, amount_paise, note, validity_days)


async def _make_card(session: AsyncSession, cfg: dict, amount_paise: int, note: str, validity_days: int | None = None) -> GiftCard:
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
                       usage_limit=1, per_user_limit=1, funded_by="platform", is_active=True, show_on_checkout=False, only_user_id=user_id))
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


# ----------------------------------------------------------------------------- buying a card online


def purchase_view(p: GiftCardPurchase, card: GiftCard | None = None) -> dict:
    out = {"id": str(p.id), "amount_paise": p.amount_paise, "status": p.status, "gateway": p.gateway, "error": p.error}
    if card is not None and p.status == "issued":
        out["code"] = card.code  # shown to the buyer only
        out["expires_at"] = card.expires_at.isoformat()
    return out


async def start_purchase(session: AsyncSession, user, amount_paise: int) -> dict:
    """Creates the gateway payment for a card. Nothing is issued here."""
    from app.integrations import get as get_integrations
    from app.services import gateways, payment_gateways

    await rate_limit(session, f"giftbuy:{user.id}", limit=10, window_seconds=3600)
    cfg = _cfg(await growth.get(session))
    if not (cfg["enabled"] and cfg["allow_purchase"]):
        raise ApiError("Gift cards cannot be bought right now.", "gift_cards_off", 400)
    _check_amount(cfg, amount_paise)
    icfg = await get_integrations(session)
    cands = [c for c in await payment_gateways.candidates(session, icfg, "INR") if c != "razorpay"]
    if not cands:
        raise ApiError("Online payment for gift cards is not available right now.", "online_unavailable", 409)
    pid = uuid.uuid4()
    base = icfg.public_web_url.rstrip("/")
    code = cands[0]
    try:
        made = await gateways.build(icfg, code, 8.0).create(amount_paise, "INR", f"GC-{pid.hex[:10]}", payment_gateways._customer(user),
                                                           f"{base}/api/payments/{code}/callback", f"{base}/api/payments/{code}/webhook")
    except gateways.GatewayError as exc:
        raise ApiError(f"Could not start the payment: {exc}", "gateway_error", 502) from exc
    p = GiftCardPurchase(id=pid, user_id=user.id, amount_paise=amount_paise, gateway=code, gateway_ref=made["reference"],
                         client_data={"mode": made["mode"], **made["fields"]}, created_at=utcnow())
    session.add(p)
    await session.flush()
    return {**purchase_view(p), "payment": p.client_data}


async def check_purchase(session: AsyncSession, user_id: uuid.UUID, purchase_id: uuid.UUID) -> dict:
    """Asks the gateway whether the money arrived. Issues the card once, only for a capture of the full amount."""
    from app.integrations import get as get_integrations
    from app.services import gateways, payment_gateways

    p = (await session.execute(select(GiftCardPurchase).where(GiftCardPurchase.id == purchase_id).with_for_update())).scalar_one_or_none()
    if p is None or p.user_id != user_id:
        raise NotFound("Purchase")
    if p.status == "issued":
        return purchase_view(p, await session.get(GiftCard, p.gift_card_id))
    icfg = await get_integrations(session)
    try:
        attempts = await gateways.build(icfg, p.gateway, 8.0).attempts(p.gateway_ref)
    except gateways.GatewayError as exc:
        raise ApiError("We could not reach the payment gateway. Try again in a minute.", "gateway_error", 502) from exc
    done = next((a for a in attempts if a["status"] in ("captured", "authorized")), None)
    if done is None:
        if attempts and all(a["status"] == "failed" for a in attempts):
            p.status, p.error = "failed", str(attempts[0].get("error") or "The payment did not go through")[:500]
        return purchase_view(p)
    if int(done["amount"]) != p.amount_paise:
        p.status, p.error = "failed", "The amount paid does not match the card. Contact support."
        return purchase_view(p)
    # paid in full: issue even if the shop switched purchases off meanwhile, the money is already taken
    card = await _make_card(session, _cfg(await growth.get(session)), p.amount_paise, f"Bought online ({p.gateway})")
    p.status, p.gift_card_id, p.error = "issued", card.id, ""
    await session.flush()
    return purchase_view(p, card)
