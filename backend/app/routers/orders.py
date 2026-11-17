"""Customer checkout, order history, cancellation and Razorpay payment confirmation."""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.deps import CurrentUser, SessionDep
from app.core.errors import ApiError, NotFound
from app.db import SessionLocal, utcnow
from app.models import (
    Order,
    OrderEvent,
    OrderItem,
    Payment,
    Product,
    Refund,
    Seller,
    SubOrder,
    WebhookEvent,
)
from app.routers.addresses import get_owned_address
from app.integrations import get as get_integrations
from app.services import razorpay
from app.services.cms import get_site
from app.services.coupons import evaluate
from app.services.orders import (
    CUSTOMER_CANCELLABLE,
    cancel_sub_order,
    cart_payload,
    checkout_payload,
    confirm_with_gateway,
    group_by_seller,
    load_cart,
    mark_paid,
    place_order,
    process_refund,
)
from app.services.platform_settings import get_settings

router = APIRouter(tags=["orders"])
log = logging.getLogger("pixcart.payments")


class QuoteIn(BaseModel):
    address_id: uuid.UUID
    payment_method: Literal["cod", "online"] = "online"
    coupon_code: str | None = Field(default=None, max_length=30)


class PlaceIn(QuoteIn):
    idempotency_key: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")
    expected_total: int | None = None


class VerifyIn(BaseModel):
    razorpay_order_id: str = Field(max_length=40)
    razorpay_payment_id: str = Field(max_length=40)
    razorpay_signature: str = Field(max_length=128)


class CancelIn(BaseModel):
    reason: str = Field(default="Changed my mind", min_length=3, max_length=300)
    sub_order_id: uuid.UUID | None = None  # omit to cancel every cancellable part of the order


async def run_refunds(refund_ids: list[uuid.UUID]) -> None:
    for rid in refund_ids:
        async with SessionLocal() as s:
            try:
                await process_refund(s, rid)
            except Exception:  # the retry job picks it up
                log.exception("refund %s failed", rid)


def order_summary(o: Order, subs: list[SubOrder], first_items: dict[uuid.UUID, list[OrderItem]]) -> dict:
    items = [it for s in subs for it in first_items.get(s.id, [])]
    return {
        "id": str(o.id),
        "number": o.number,
        "status": o.status,
        "payment_method": o.payment_method,
        "payment_status": o.payment_status,
        "grand_total": o.grand_total,
        "created_at": o.created_at.isoformat(),
        "item_count": sum(i.qty for i in items),
        "items": [{"title": i.title, "image": i.image_url, "qty": i.qty} for i in items[:4]],
        "sub_statuses": [s.status for s in subs],
    }


async def order_detail(session, o: Order, *, for_admin: bool = False) -> dict:
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == o.id).order_by(SubOrder.number))).scalars())
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s in subs])))).scalars()) if subs else []
    sellers = {s.id: s for s in (await session.execute(select(Seller).where(Seller.id.in_([x.seller_id for x in subs])))).scalars()} if subs else {}
    events = list((await session.execute(select(OrderEvent).where(OrderEvent.order_id == o.id).order_by(OrderEvent.created_at))).scalars())
    refunds = list((await session.execute(select(Refund).where(Refund.order_id == o.id).order_by(Refund.created_at))).scalars())
    slugs = dict((await session.execute(select(Product.id, Product.slug).where(Product.id.in_({i.product_id for i in items})))).all()) if items else {}
    by_sub: dict[uuid.UUID, list[OrderItem]] = {}
    for it in items:
        by_sub.setdefault(it.sub_order_id, []).append(it)
    out = {
        "id": str(o.id),
        "number": o.number,
        "status": o.status,
        "payment_method": o.payment_method,
        "payment_status": o.payment_status,
        "ship_to": o.ship_to,
        "items_total": o.items_total,
        "shipping_total": o.shipping_total,
        "cod_fee": o.cod_fee,
        "grand_total": o.grand_total,
        "refunded_total": o.refunded_total,
        "discount_total": o.discount_total,
        "coupon_code": o.coupon_code,
        "created_at": o.created_at.isoformat(),
        "placed_at": o.placed_at.isoformat() if o.placed_at else None,
        "payment_expires_at": o.payment_expires_at.isoformat() if o.payment_expires_at else None,
        "sub_orders": [
            {
                "id": str(s.id),
                "number": s.number,
                "status": s.status,
                "invoice_number": s.invoice_number,
                "expected_delivery_at": s.expected_delivery_at.isoformat() if s.expected_delivery_at else None,
                "platform_discount": s.platform_discount,
                "seller_discount": s.seller_discount,
                "seller": {"name": sellers[s.seller_id].display_name, "slug": sellers[s.seller_id].slug} if s.seller_id in sellers else None,
                "items_total": s.items_total,
                "shipping_fee": s.shipping_fee,
                "total": s.total,
                "courier_name": s.courier_name,
                "tracking_number": s.tracking_number,
                "tracking_url": s.tracking_url,
                "shipped_at": s.shipped_at.isoformat() if s.shipped_at else None,
                "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
                "cancelled_at": s.cancelled_at.isoformat() if s.cancelled_at else None,
                "cancel_reason": s.cancel_reason,
                "cancelled_by": s.cancelled_by,
                "can_cancel": s.status in CUSTOMER_CANCELLABLE,
                "items": [
                    {
                        "title": i.title,
                        "product_slug": slugs.get(i.product_id, ""),
                        "variant_label": i.variant_label,
                        "image": i.image_url,
                        "qty": i.qty,
                        "unit_price": i.unit_price,
                        "unit_mrp": i.unit_mrp,
                        "line_total": i.line_total,
                        "sku": i.sku,
                        "hsn_code": i.hsn_code,
                        "gst_bps": i.gst_bps,
                        "taxable_value": i.taxable_value,
                        "cgst": i.cgst,
                        "sgst": i.sgst,
                        "igst": i.igst,
                    }
                    for i in by_sub.get(s.id, [])
                ],
                **(
                    {
                        "commission": s.commission_paise,
                        "commission_gst": s.commission_gst_paise,
                        "tcs": s.tcs_paise,
                        "tds": s.tds_paise,
                        "seller_payout": s.seller_payout_paise,
                        "settlement_status": s.settlement_status,
                    }
                    if for_admin
                    else {}
                ),
            }
            for s in subs
        ],
        "timeline": [
            {"sub_order_id": str(e.sub_order_id) if e.sub_order_id else None, "from": e.from_status, "to": e.to_status, "actor": e.actor, "note": e.note, "at": e.created_at.isoformat()}
            for e in events
        ],
        "refunds": [{"amount": r.amount_paise, "status": r.status, "reason": r.reason, "created_at": r.created_at.isoformat()} for r in refunds],
    }
    return out


async def _own_order(session, user, order_id: uuid.UUID) -> Order:
    o = await session.get(Order, order_id)
    if o is None or o.user_id != user.id:
        raise NotFound("Order")
    return o


@router.post("/api/checkout/quote")
async def quote(body: QuoteIn, user: CurrentUser, session: SessionDep) -> dict:
    address = await get_owned_address(session, user.id, body.address_id)
    cfg = await get_settings(session)
    view = cart_payload(group_by_seller(await load_cart(session, user.id), cfg), cfg, (await get_integrations(session)).online_payments)
    cod_fee = cfg["cod_fee_paise"] if body.payment_method == "cod" else 0
    view["summary"]["cod_fee"] = cod_fee
    view["summary"]["grand_total"] += cod_fee
    view["coupon"] = None
    if body.coupon_code and body.coupon_code.strip():
        lines = await load_cart(session, user.id)
        try:
            res = await evaluate(session, body.coupon_code, user.id, lines)
            view["coupon"] = {"code": res.coupon.code, "discount": res.discount, "description": res.coupon.description, "error": None}
            view["summary"]["grand_total"] -= res.discount
            view["summary"]["coupon_discount"] = res.discount
        except ApiError as exc:
            view["coupon"] = {"code": body.coupon_code.strip().upper(), "discount": 0, "error": exc.message}
    view["cod_allowed"] = cfg["cod_enabled"] and view["summary"]["grand_total"] <= cfg["cod_max_order_paise"]
    view["address_id"] = str(address.id)
    return view


@router.post("/api/orders", status_code=201)
async def create_order(body: PlaceIn, user: CurrentUser, session: SessionDep) -> dict:
    try:
        order, payment = await place_order(
            session,
            user,
            address_id=body.address_id,
            payment_method=body.payment_method,
            idempotency_key=body.idempotency_key,
            expected_total=body.expected_total,
            coupon_code=(body.coupon_code or "").strip() or None,
        )
    except IntegrityError:
        # Same idempotency key submitted twice at the same moment: return the winner.
        await session.rollback()
        order = (await session.execute(select(Order).where(Order.user_id == user.id, Order.idempotency_key == body.idempotency_key))).scalar_one()
        payment = (await session.execute(select(Payment).where(Payment.order_id == order.id))).scalar_one_or_none()
    return {"order": await order_detail(session, order), "payment": checkout_payload(order, payment, user, (await get_site(session))["brand_name"], await get_integrations(session))}


@router.get("/api/orders")
async def my_orders(
    user: CurrentUser,
    session: SessionDep,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=50),
) -> dict:
    base = select(Order).where(Order.user_id == user.id)
    total = (await session.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    orders = list((await session.execute(base.order_by(Order.created_at.desc()).offset((page - 1) * page_size).limit(page_size))).scalars())
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id.in_([o.id for o in orders])).order_by(SubOrder.number))).scalars()) if orders else []
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_([s.id for s in subs])))).scalars()) if subs else []
    by_sub: dict[uuid.UUID, list[OrderItem]] = {}
    for it in items:
        by_sub.setdefault(it.sub_order_id, []).append(it)
    return {
        "items": [order_summary(o, [s for s in subs if s.order_id == o.id], by_sub) for o in orders],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/api/orders/{order_id}")
async def get_order(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    o = await _own_order(session, user, order_id)
    data = await order_detail(session, o)
    payment = (await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at.desc()).limit(1))).scalar_one_or_none()
    data["payment"] = checkout_payload(o, payment, user, (await get_site(session))["brand_name"], await get_integrations(session))
    return data


@router.post("/api/orders/{order_id}/cancel")
async def cancel(order_id: uuid.UUID, body: CancelIn, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    o = await _own_order(session, user, order_id)
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == o.id).order_by(SubOrder.number).with_for_update())).scalars())
    targets = [s for s in subs if (body.sub_order_id is None or s.id == body.sub_order_id)]
    if body.sub_order_id and not targets:
        raise NotFound("Order part")
    cancellable = [s for s in targets if s.status in CUSTOMER_CANCELLABLE or s.status == "pending_payment"]
    if not cancellable:
        raise ApiError("This order can no longer be cancelled. You can return it after delivery.", "not_cancellable")
    refund_ids = []
    for s in cancellable:
        refund = await cancel_sub_order(session, s, actor="customer", reason=body.reason)
        if refund:
            await session.flush()
            refund_ids.append(refund.id)
    await session.commit()
    background.add_task(run_refunds, refund_ids)
    return await order_detail(session, o)


@router.post("/api/payments/razorpay/verify")
async def verify_payment(body: VerifyIn, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    payment = (
        await session.execute(select(Payment).where(Payment.provider_order_id == body.razorpay_order_id).with_for_update())
    ).scalar_one_or_none()
    if payment is None:
        raise NotFound("Payment")
    order = await _own_order(session, user, payment.order_id)
    if not await razorpay.verify_payment_signature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature):
        raise ApiError("Payment verification failed", "bad_signature")
    try:
        result = await confirm_with_gateway(session, payment, body.razorpay_payment_id)
    except razorpay.GatewayError as exc:
        # The webhook (or the expiry job's gateway check) will still record the payment.
        raise ApiError(f"We could not confirm the payment yet: {exc}", "gateway_error", 502) from exc
    await session.commit()
    if result == "refund":
        ids = list((await session.execute(select(Refund.id).where(Refund.payment_id == payment.id, Refund.status == "pending"))).scalars())
        background.add_task(run_refunds, ids)
    if result == "not_captured":
        raise ApiError("The payment was not completed. You can try again.", "payment_not_captured")
    await session.refresh(order)
    return {"result": result, "order": await order_detail(session, order)}


@router.post("/api/payments/razorpay/webhook")
async def razorpay_webhook(request: Request, session: SessionDep, background: BackgroundTasks) -> dict:
    body = await request.body()
    if not await razorpay.verify_webhook_signature(body, request.headers.get("x-razorpay-signature", "")):
        raise ApiError("Invalid signature", "bad_signature", 400)
    event = json.loads(body)
    event_id = request.headers.get("x-razorpay-event-id") or hashlib.sha256(body).hexdigest()
    session.add(WebhookEvent(provider="razorpay", event_id=event_id[:80], event_type=str(event.get("event", ""))[:60], received_at=utcnow()))
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return {"ok": True, "duplicate": True}

    etype = event.get("event", "")
    payload = event.get("payload", {})
    refund_ids: list[uuid.UUID] = []
    if etype in ("payment.captured", "order.paid"):
        p = payload.get("payment", {}).get("entity", {})
        payment = (await session.execute(select(Payment).where(Payment.provider_order_id == p.get("order_id")).with_for_update())).scalar_one_or_none()
        if payment and p.get("status") == "captured":
            result = await mark_paid(session, payment, p["id"], p.get("method", ""), int(p.get("amount", 0)))
            if result == "refund":
                await session.flush()
                refund_ids = list((await session.execute(select(Refund.id).where(Refund.payment_id == payment.id, Refund.status == "pending"))).scalars())
    elif etype == "payment.failed":
        p = payload.get("payment", {}).get("entity", {})
        payment = (await session.execute(select(Payment).where(Payment.provider_order_id == p.get("order_id")))).scalar_one_or_none()
        if payment and payment.status != "captured":
            payment.error = str(p.get("error_description", ""))[:500]
    elif etype in ("refund.processed", "refund.failed"):
        r = payload.get("refund", {}).get("entity", {})
        refund = (await session.execute(select(Refund).where(Refund.provider_refund_id == r.get("id")))).scalar_one_or_none()
        if refund:
            refund.status = "processed" if etype == "refund.processed" else "failed"
            refund.last_error = "" if etype == "refund.processed" else "Gateway reported the refund failed"
    await session.commit()
    if refund_ids:
        background.add_task(run_refunds, refund_ids)
    return {"ok": True}
