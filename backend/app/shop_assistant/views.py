"""Customer-safe views of records. Every field is listed explicitly (a whitelist): a new column on a model never
reaches the chat by accident. Commission, TCS/TDS, payouts, settlement, seller KYC, SKUs, tax splits and
staff-only ticket notes are deliberately absent.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, OrderItem, Product, Refund, ReturnRequest, Seller, SubOrder, SupportTicket, TicketMessage
from app.services import returns as returns_svc
from app.services.orders import CUSTOMER_CANCELLABLE
from app.services.platform_settings import RETURN_REASONS
from app.services.support import CATEGORIES

from .kb import inr

PACKAGE_STATUS = {
    "pending_payment": "Waiting for payment", "placed": "Order placed", "confirmed": "Confirmed by the seller", "packed": "Packed",
    "shipped": "Shipped", "delivered": "Delivered", "cancelled": "Cancelled",
}
STEPS = ("placed", "confirmed", "packed", "shipped", "delivered")
PAYMENT = {"cod": "Cash on delivery", "online": "Paid online"}
PAYMENT_STATUS = {"pending": "Payment pending", "paid": "Paid", "cod": "Pay on delivery", "failed": "Payment failed",
                  "refunded": "Refunded", "partially_refunded": "Partly refunded"}
REFUND_STATUS = {"pending": "Being processed", "processed": "Refunded", "failed": "Retrying"}
RETURN_STATUS = {"requested": "Requested", "approved": "Approved, pickup pending", "picked_up": "Picked up", "received": "Received by seller",
                 "refunded": "Refunded", "rejected": "Rejected", "cancelled": "Cancelled"}
TICKET_STATUS = {"open": "Open, with our team", "awaiting_customer": "Waiting for your reply", "resolved": "Resolved", "closed": "Closed"}


def _d(dt) -> str | None:
    return dt.isoformat() if dt else None


def order_status(subs: list[SubOrder]) -> str:
    st = [s.status for s in subs]
    if not st:
        return "Order placed"
    if all(s == "cancelled" for s in st):
        return "Cancelled"
    live = [s for s in st if s != "cancelled"]
    if all(s == "delivered" for s in live):
        return "Delivered"
    if any(s == "pending_payment" for s in live):
        return "Waiting for payment"
    if any(s in ("shipped", "delivered") for s in live):
        return "Partly delivered" if any(s == "delivered" for s in live) else "Shipped"
    return PACKAGE_STATUS.get(live[0], "In progress")


async def order_cards(session: AsyncSession, orders: list[Order]) -> list[dict[str, Any]]:
    if not orders:
        return []
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id.in_([o.id for o in orders])).order_by(SubOrder.number))).scalars())
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s in subs])))).scalars()) if subs else []
    out = []
    for o in orders:
        os_ = [s for s in subs if s.order_id == o.id]
        its = [i for i in items if i.sub_order_id in {s.id for s in os_}]
        out.append({
            "id": str(o.id), "number": o.number, "placed_at": _d(o.placed_at or o.created_at), "status": order_status(os_),
            "total": o.grand_total, "total_text": inr(o.grand_total), "payment": PAYMENT.get(o.payment_method, o.payment_method),
            "item_count": sum(i.qty for i in its), "items": [{"title": i.title, "image": i.image_url, "qty": i.qty} for i in its[:3]],
            "link": f"/orders/{o.id}",
        })
    return out


async def order_view(session: AsyncSession, o: Order) -> dict[str, Any]:
    """One order of the signed-in customer (the caller has checked ownership)."""
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == o.id).order_by(SubOrder.number))).scalars())
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s in subs])))).scalars()) if subs else []
    sellers = dict((await session.execute(select(Seller.id, Seller.display_name).where(Seller.id.in_({s.seller_id for s in subs})))).all()) if subs else {}
    windows = dict((await session.execute(select(Product.id, Product.return_window_days).where(Product.id.in_({i.product_id for i in items})))).all()) if items else {}
    refunds = list((await session.execute(select(Refund).where(Refund.order_id == o.id).order_by(Refund.created_at))).scalars())
    rets = list((await session.execute(select(ReturnRequest).where(ReturnRequest.sub_order_id.in_([s.id for s in subs])).order_by(ReturnRequest.created_at))).scalars()) if subs else []
    packages = []
    for s in subs:
        returnable = await returns_svc.returnable_items(session, s)
        reached = STEPS.index(s.status) if s.status in STEPS else -1
        packages.append({
            "id": str(s.id), "number": s.number, "status": s.status, "status_label": PACKAGE_STATUS.get(s.status, s.status),
            "seller": sellers.get(s.seller_id, ""),
            "steps": [{"key": k, "label": PACKAGE_STATUS[k], "done": s.status != "cancelled" and i <= reached} for i, k in enumerate(STEPS)],
            "items": [{"title": i.title, "variant": i.variant_label, "image": i.image_url, "qty": i.qty, "amount": inr(i.line_total),
                       "return_window_days": windows.get(i.product_id, 0)} for i in items if i.sub_order_id == s.id],
            "expected_delivery_at": _d(s.expected_delivery_at), "shipped_at": _d(s.shipped_at), "delivered_at": _d(s.delivered_at),
            "cancelled_at": _d(s.cancelled_at), "cancel_reason": s.cancel_reason if s.status == "cancelled" else "",
            "courier": s.courier_name, "tracking_number": s.tracking_number, "tracking_url": s.tracking_url,
            "can_cancel": s.status in CUSTOMER_CANCELLABLE,
            "can_return": any(r["eligible"] for r in returnable),
            "return_by": min((r["return_by"] for r in returnable if r["eligible"]), default=None),
            "invoice_ready": bool(s.invoice_number),
        })
    return {
        "id": str(o.id), "number": o.number, "placed_at": _d(o.placed_at or o.created_at), "status": order_status(subs),
        "payment": PAYMENT.get(o.payment_method, o.payment_method), "payment_status": PAYMENT_STATUS.get(o.payment_status, o.payment_status),
        "items_total": inr(o.items_total), "delivery": inr(o.shipping_total + o.cod_fee), "discount": inr(o.discount_total) if o.discount_total else "",
        "total": inr(o.grand_total), "refunded": inr(o.refunded_total) if o.refunded_total else "",
        "packages": packages,
        "refunds": [{"amount": inr(r.amount_paise), "status": REFUND_STATUS.get(r.status, r.status), "at": _d(r.created_at)} for r in refunds],
        "returns": [{"number": r.number, "status": RETURN_STATUS.get(r.status, r.status), "reason": RETURN_REASONS.get(r.reason, r.reason),
                     "refund_amount": inr(r.refund_amount) if r.refund_amount else "", "at": _d(r.created_at)} for r in rets],
        "link": f"/orders/{o.id}",
    }


def ticket_view(t: SupportTicket, messages: list[TicketMessage] | None = None) -> dict[str, Any]:
    out = {
        "id": str(t.id), "number": t.number, "subject": t.subject, "category": CATEGORIES.get(t.category, t.category),
        "status": t.status, "status_label": TICKET_STATUS.get(t.status, t.status), "is_grievance": t.is_grievance,
        "created_at": _d(t.created_at), "updated_at": _d(t.updated_at), "link": f"/support/{t.id}",
    }
    if messages is not None:
        public = [m for m in messages if not m.is_internal]  # staff-only notes never leave the support desk
        team = [m for m in public if m.author_role == "staff"]
        out["last_team_reply"] = {"text": team[-1].body[:600], "at": _d(team[-1].created_at)} if team else None
        out["message_count"] = len(public)
    return out


async def return_list(session: AsyncSession, user_id: uuid.UUID, limit: int = 10) -> list[dict[str, Any]]:
    rows = list((await session.execute(select(ReturnRequest, SubOrder).join(SubOrder, SubOrder.id == ReturnRequest.sub_order_id)
                                        .where(ReturnRequest.user_id == user_id).order_by(ReturnRequest.created_at.desc()).limit(limit))).all())
    return [{"number": r.number, "status": RETURN_STATUS.get(r.status, r.status), "reason": RETURN_REASONS.get(r.reason, r.reason),
             "refund_amount": inr(r.refund_amount) if r.refund_amount else "", "package": s.number, "at": _d(r.created_at),
             "link": f"/orders/{s.order_id}"} for r, s in rows]
