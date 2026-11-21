"""Returns after delivery: request → approve/reject → picked up → received (restock, ledger reversal,
credit note) → refunded. Online payments are refunded through Razorpay automatically; cash-on-delivery
refunds are paid to the customer's UPI ID by finance and marked refunded with a reference."""
from __future__ import annotations

import re
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError, Conflict, NotFound
from app.db import utcnow
from app.models import (
    Order,
    OrderItem,
    Payment,
    Product,
    Refund,
    ReturnItem,
    ReturnRequest,
    Seller,
    SubOrder,
    User,
    Variant,
)
from app.services import inventory
from app.services.invoices import next_number
from app.services.ledger import post_return
from app.services.notify import notify, notify_seller
from app.services.platform_settings import RETURN_REASONS, get_settings

OPEN = ("requested", "approved", "picked_up")
UPI = re.compile(r"^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$")

STATUS_TEXT = {
    "requested": "We have sent your return request to the seller.",
    "approved": "Your return is approved. Keep the item packed; the seller will arrange a pickup.",
    "rejected": "The seller could not accept this return.",
    "picked_up": "Your return has been picked up.",
    "received": "The seller received your return. Your refund is on its way.",
    "refunded": "Your refund has been issued.",
    "cancelled": "You cancelled this return request.",
}


def paid_value(it: OrderItem, qty: int) -> int:
    """What the customer paid for `qty` units of this line (after any coupon)."""
    return (it.line_total - it.seller_discount - it.platform_discount) * qty // it.qty


def seller_value(it: OrderItem, qty: int) -> int:
    return (it.line_total - it.seller_discount) * qty // it.qty


async def returnable_items(session: AsyncSession, sub: SubOrder) -> list[dict]:
    if sub.status != "delivered" or not sub.delivered_at:
        return []
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalars())
    windows = dict((await session.execute(select(Product.id, Product.return_window_days).where(Product.id.in_([i.product_id for i in items])))).all())
    pending = dict(
        (
            await session.execute(
                # returns still on their way; a received one is already counted in returned_qty
                select(ReturnItem.order_item_id, func.sum(ReturnItem.qty))
                .join(ReturnRequest, ReturnRequest.id == ReturnItem.return_id)
                .where(ReturnRequest.sub_order_id == sub.id, ReturnRequest.status.in_(OPEN))
                .group_by(ReturnItem.order_item_id)
            )
        ).all()
    )
    now = utcnow()
    out = []
    for it in items:
        days = windows.get(it.product_id, 0)
        until = sub.delivered_at + timedelta(days=days)
        left = it.qty - it.returned_qty - int(pending.get(it.id, 0))
        out.append({
            "order_item_id": str(it.id), "title": it.title, "variant_label": it.variant_label, "image": it.image_url,
            "qty_left": max(0, left), "return_by": until.isoformat(), "eligible": days > 0 and now <= until and left > 0,
            "unit_refund": paid_value(it, 1),
        })
    return out


async def create(session: AsyncSession, user: User, sub_id: uuid.UUID, items: list[tuple[uuid.UUID, int]], reason: str, comment: str, refund_upi: str) -> ReturnRequest:
    cfg = await get_settings(session)
    if not cfg["feature_returns"]:
        raise ApiError("Returns are not available right now", "returns_off")
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == sub_id).with_for_update())).scalar_one_or_none()
    order = await session.get(Order, sub.order_id) if sub else None
    if sub is None or order.user_id != user.id:
        raise NotFound("Order")
    if reason not in RETURN_REASONS:
        raise ApiError("Choose a reason for the return", "invalid_reason")
    eligible = {r["order_item_id"]: r for r in await returnable_items(session, sub)}
    if not items:
        raise ApiError("Choose at least one item to return", "no_items")
    if order.payment_method == "cod" and not UPI.match(refund_upi or ""):
        raise ApiError("Enter the UPI ID where we should send your refund (for example name@okbank)", "upi_required", fields={"refund_upi": "Required"})
    ret = ReturnRequest(
        number=f"RT{utcnow():%y%m%d}{secrets.token_hex(3).upper()}", sub_order_id=sub.id, seller_id=sub.seller_id, user_id=user.id,
        reason=reason, comment=comment[:2000], refund_upi=refund_upi if order.payment_method == "cod" else "",
    )
    session.add(ret)
    await session.flush()
    total = 0
    for item_id, qty in items:
        e = eligible.get(str(item_id))
        if e is None or not e["eligible"]:
            raise ApiError("One of the items can no longer be returned", "not_returnable")
        if qty < 1 or qty > e["qty_left"]:
            raise ApiError(f"You can return at most {e['qty_left']} of '{e['title']}'", "invalid_qty")
        it = await session.get(OrderItem, item_id)
        amount = paid_value(it, qty)
        total += amount
        session.add(ReturnItem(return_id=ret.id, order_item_id=it.id, qty=qty, amount=amount))
    ret.refund_amount = total
    await notify_seller(session, sub.seller_id, "seller_return_requested", {"order_number": sub.number, "reason": RETURN_REASONS[reason]}, link="/seller/returns")
    if cfg["auto_approve_returns"]:
        await set_status(session, ret, "approved", note="Approved automatically")
    else:
        await _tell_customer(session, ret)
    return ret


async def _tell_customer(session: AsyncSession, ret: ReturnRequest, extra: str = "") -> None:
    user = await session.get(User, ret.user_id)
    sub = await session.get(SubOrder, ret.sub_order_id)
    await notify(
        session, "return_update", user,
        {"return_number": ret.number, "status": ret.status.replace("_", " "), "message": (STATUS_TEXT.get(ret.status, "") + (" " + extra if extra else "")).strip()},
        link=f"/orders/{sub.order_id}",
    )


ALLOWED = {
    "requested": ("approved", "rejected", "cancelled"),
    "approved": ("picked_up", "received", "cancelled"),
    "picked_up": ("received",),
    "received": ("refunded",),
}


async def set_status(session: AsyncSession, ret: ReturnRequest, dst: str, *, note: str = "", courier: str = "", tracking: str = "",
                     by_fleet: bool = False, conditions: dict[uuid.UUID, str] | None = None) -> list[uuid.UUID]:
    """Moves a return forward. Returns refund ids to send to the gateway after commit.

    For a package our own delivery partners delivered, approving the return asks a partner to collect it (the customer
    gets a pickup code); cancelling it, or the seller handing it to a courier, stops that pickup. ``conditions`` (on
    receipt): order item id → "sellable" (back in stock) or "damaged" (kept out of stock); see ``default_condition``."""
    from app.services import fleet

    if dst not in ALLOWED.get(ret.status, ()):
        raise Conflict(f"A {ret.status.replace('_', ' ')} return cannot become {dst.replace('_', ' ')}", "illegal_transition")
    now = utcnow()
    refund_ids: list[uuid.UUID] = []
    extra = note if dst == "rejected" else ""
    ret.status = dst
    if note:
        ret.seller_note = note[:2000]
    if dst == "approved":
        ret.approved_at = now
        await session.flush()
        await fleet.request_return_pickup(session, ret)
        if ret.fleet_requested_at:
            extra = f"Our delivery partner will collect it. Give pickup code {ret.pickup_otp} when you hand it over."
    elif dst == "picked_up":
        ret.pickup_courier, ret.pickup_tracking = courier[:60], tracking[:60]
        if ret.fleet_requested_at and not by_fleet:
            await fleet.cancel_return_pickup(session, ret, "The seller arranged another pickup")
    elif dst == "received":
        ret.received_at = now
        refund_ids = await _receive(session, ret, conditions or {})
        await fleet.close_pickup_on_receive(session, ret, None)
    elif dst == "refunded":
        ret.refunded_at = now
    elif dst == "cancelled" and ret.fleet_requested_at:
        await fleet.cancel_return_pickup(session, ret, "The customer cancelled the return")
    await session.flush()
    await _tell_customer(session, ret, extra)
    return refund_ids


NOT_RESTOCKED_BY_DEFAULT = ("damaged", "defective", "missing_parts", "wrong_item")


def default_condition(reason: str) -> str:
    """Unless the seller says otherwise on receipt: an item returned as damaged, faulty or incomplete is not put back on
    sale, and for a wrong item the unit that comes back is not the ordered one, so the ordered one's stock is not raised."""
    return "damaged" if reason in NOT_RESTOCKED_BY_DEFAULT else "sellable"


async def _receive(session: AsyncSession, ret: ReturnRequest, conditions: dict[uuid.UUID, str]) -> list[uuid.UUID]:
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == ret.sub_order_id).with_for_update())).scalar_one()
    order = (await session.execute(select(Order).where(Order.id == sub.order_id).with_for_update())).scalar_one()
    seller = await session.get(Seller, sub.seller_id)
    rows = (await session.execute(select(ReturnItem, OrderItem).join(OrderItem, OrderItem.id == ReturnItem.order_item_id).where(ReturnItem.return_id == ret.id))).all()
    s_value = 0
    for ri, it in rows:
        it.returned_qty += ri.qty
        s_value += seller_value(it, ri.qty)
        ri.condition = conditions.get(it.id) or default_condition(ret.reason)
        if ri.condition != "sellable":
            continue  # recorded on the return; the customer is refunded all the same
        variant = (await session.execute(select(Variant).where(Variant.id == it.variant_id).with_for_update())).scalar_one()
        if sub.warehouse_id:
            await inventory.change(session, variant, sub.warehouse_id, ri.qty, "return", reference=ret.number)
    sub.returned_total += ret.refund_amount
    await post_return(session, sub, ret, s_value)
    ret.credit_note_number = await next_number(session, seller, "CN", utcnow())
    refund_ids: list[uuid.UUID] = []
    if order.payment_method == "online":
        payment = (await session.execute(select(Payment).where(Payment.order_id == order.id, Payment.status == "captured").limit(1))).scalar_one_or_none()
        if payment:
            refund = Refund(order_id=order.id, payment_id=payment.id, sub_order_id=sub.id, amount_paise=ret.refund_amount, reason=f"Return {ret.number}")
            session.add(refund)
            await session.flush()
            refund_ids.append(refund.id)
            ret.status = "refunded"
            ret.refunded_at = utcnow()
    order.refunded_total += ret.refund_amount
    order.payment_status = "refunded" if order.refunded_total >= order.grand_total else "partially_refunded"
    return refund_ids


async def return_out(session: AsyncSession, ret: ReturnRequest, *, with_upi: bool = False, viewer: str = "customer") -> dict:
    """A return for the customer, the seller or staff (``viewer``); each sees only the pickup code meant for them."""
    from app.services import fleet

    rows = (await session.execute(select(ReturnItem, OrderItem).join(OrderItem, OrderItem.id == ReturnItem.order_item_id).where(ReturnItem.return_id == ret.id))).all()
    sub = await session.get(SubOrder, ret.sub_order_id)
    return {
        "fleet_pickup": await fleet.pickup_tracking(session, ret, viewer=viewer),
        "id": str(ret.id), "number": ret.number, "status": ret.status, "reason": ret.reason, "reason_label": RETURN_REASONS.get(ret.reason, ret.reason),
        "comment": ret.comment, "seller_note": ret.seller_note, "refund_amount": ret.refund_amount,
        "refund_upi": ret.refund_upi if with_upi else (ret.refund_upi[:2] + "…@" + ret.refund_upi.split("@")[-1] if ret.refund_upi else ""),
        "pickup_courier": ret.pickup_courier, "pickup_tracking": ret.pickup_tracking, "credit_note_number": ret.credit_note_number,
        "sub_order_id": str(ret.sub_order_id), "sub_order_number": sub.number if sub else "", "order_id": str(sub.order_id) if sub else "",
        "created_at": ret.created_at.isoformat(), "approved_at": ret.approved_at.isoformat() if ret.approved_at else None,
        "received_at": ret.received_at.isoformat() if ret.received_at else None, "refunded_at": ret.refunded_at.isoformat() if ret.refunded_at else None,
        "items": [{"order_item_id": str(it.id), "title": it.title, "variant_label": it.variant_label, "image": it.image_url, "qty": ri.qty, "amount": ri.amount,
                   "condition": ri.condition, "suggested_condition": default_condition(ret.reason)} for ri, it in rows],
    }
