"""Customer checkout, order history, cancellation and Razorpay payment confirmation."""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Query, Request
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.core.deps import CurrentUser, SessionDep, rate_limit
from app.core.errors import ApiError, NotFound
from app.db import SessionLocal, utcnow
from app.integrations import get as get_integrations
from app.models import (
    DeliveryAssignment,
    DeliveryBoy,
    DeliveryComplaint,
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
from app.services import payment_gateways
from app.services import fees as fees_svc
from app.services import growth as growth_svc
from app.services import loyalty as loyalty_svc
from app.services import fleet, razorpay, regional
from app.services.cms import get_site
from app.services.coupons import evaluate
from app.services.orders import (
    cancel_sub_order,
    cart_payload,
    check_with_gateway,
    checkout_payload,
    confirm_with_gateway,
    customer_cancellable,
    group_by_seller,
    load_cart,
    mark_paid,
    notify_refund,
    place_order,
    process_refund,
    refund_on_cancel,
)
from app.services.platform_settings import get_settings

router = APIRouter(tags=["orders"])
log = logging.getLogger("pixcart.payments")


class QuoteIn(BaseModel):
    address_id: uuid.UUID
    payment_method: Literal["cod", "online"] = "online"
    coupon_code: str | None = Field(default=None, max_length=30)
    tip_paise: int = Field(default=0, ge=0, le=500_000)


class PlaceIn(QuoteIn):
    idempotency_key: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9\-_]+$")
    expected_total: int | None = None
    buyer_gstin: str = Field(default="", max_length=20)
    buyer_business: str = Field(default="", max_length=160)
    instructions: str | None = Field(default=None, max_length=300)  # empty: the address's saved instructions
    no_bag: bool = False
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")  # the shopper's currency (Admin → Languages and currencies)


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
    # what cancelling each package would refund now (the same rule cancel_sub_order applies), for the cancel dialog
    prepaid = o.payment_method == "online" and o.payment_status in ("paid", "partially_refunded")
    fees_back = bool((await fees_svc.get(session))["fees_refund_on_cancel"]) if prepaid else False
    live = sum(1 for s in subs if s.status != "cancelled")
    can_cancel_at = await customer_cancellable(session)

    def refund_if_cancelled(s: SubOrder) -> int:
        if not prepaid or s.status not in can_cancel_at:
            return 0
        return refund_on_cancel(s, o, others_live=live - 1, fees_back=fees_back)

    # the captured online payment (Razorpay), shown as "Payment received" with its reference
    captured = (await session.execute(select(Payment).where(Payment.order_id == o.id, Payment.status == "captured")
                                      .order_by(Payment.created_at.desc()))).scalars().first() if o.payment_method == "online" else None
    out = {
        "id": str(o.id),
        "number": o.number,
        "status": o.status,
        "payment_method": o.payment_method,
        "payment_status": o.payment_status,
        "currency": o.currency or "INR",
        "fx_rate": float(o.fx_rate or 1),
        "paid": {"amount": captured.amount_paise, "method": captured.method, "reference": captured.provider_payment_id or "",
                 "currency": captured.currency or "INR", "charge_amount": captured.charge_amount,
                 "at": captured.updated_at.isoformat() if captured.updated_at else None} if captured else None,
        "ship_to": o.ship_to,
        "items_total": o.items_total,
        "shipping_total": o.shipping_total,
        "cod_fee": o.cod_fee,
        "fees": o.fees or [],
        "fees_total": o.fees_total,
        "tip": o.tip_paise,
        "buyer_gstin": o.buyer_gstin,
        "buyer_business": o.buyer_business,
        "fee_invoice_number": o.fee_invoice_number or None,
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
                "can_cancel": s.status in can_cancel_at,
                "refund_if_cancelled": refund_if_cancelled(s),
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
        # packages carried by the own delivery fleet: partner, steps, OTP while on the way, live position
        "fleet": await fleet.customer_tracking(session, o),
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
    ck = await fees_svc.get(session)
    bounds = await growth_svc.seller_free_bounds(session)
    cfg = await growth_svc.with_state_threshold(session, cfg, address.state_code)
    view = cart_payload(group_by_seller(await load_cart(session, user.id), cfg, await growth_svc.remote_surcharge(session, address.pincode), bounds, await growth_svc.state_fee(session, address.state_code), await loyalty_svc.free_delivery(session, user.id)), cfg, (await get_integrations(session)).online_payments, ck, bounds)
    cod_fee = cfg["cod_fee_paise"] if body.payment_method == "cod" else 0
    view["summary"]["cod_fee"] = cod_fee
    view["summary"]["grand_total"] += cod_fee
    try:
        tip = fees_svc.tip_amount(ck, body.tip_paise)
    except ValueError:
        tip = 0
    view["summary"]["tip"] = tip
    view["summary"]["grand_total"] += tip
    view["address"] = {"instructions": address.instructions, "lat": float(address.lat) if address.lat is not None else None,
                       "lng": float(address.lng) if address.lng is not None else None}
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
    # maintenance mode (Admin → Marketplace settings): no new orders; staff may still place test orders
    if not user.is_admin and (await get_settings(session))["maintenance_mode"]:
        raise ApiError("The shop is closed for maintenance right now, so orders cannot be placed. Your cart is saved; please try again soon.",
                       code="maintenance", status_code=503)
    try:
        order, payment = await place_order(
            session,
            user,
            address_id=body.address_id,
            payment_method=body.payment_method,
            idempotency_key=body.idempotency_key,
            expected_total=body.expected_total,
            coupon_code=(body.coupon_code or "").strip() or None,
            tip_paise=body.tip_paise,
            buyer_gstin=body.buyer_gstin,
            buyer_business=body.buyer_business,
            instructions=body.instructions,
            no_bag=body.no_bag,
            currency=body.currency,
        )
    except IntegrityError:
        # Same idempotency key submitted twice at the same moment: return the winner.
        await session.rollback()
        order = (await session.execute(select(Order).where(Order.user_id == user.id, Order.idempotency_key == body.idempotency_key))).scalar_one()
        payment = (await session.execute(select(Payment).where(Payment.order_id == order.id))).scalar_one_or_none()
    return {"order": await order_detail(session, order), "payment": await shopper_checkout(session, order, payment, user)}


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
    return await _shopper_order(session, o, user)


async def _shopper_order(session, o: Order, user) -> dict:
    """The order as its shopper sees it, with what the payment window needs while it is unpaid."""
    data = await order_detail(session, o)
    payment = (await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at.desc()).limit(1))).scalar_one_or_none()
    data["payment"] = await shopper_checkout(session, o, payment, user)
    return data


async def shopper_checkout(session, order: Order, payment: Payment | None, user) -> dict | None:
    """What the payment window needs: the amount and currency, which ways to pay the admin offers, and the shopper's
    Razorpay customer so Razorpay can offer their saved cards and save new ones (with their consent, in its window)."""
    data = checkout_payload(order, payment, user, (await get_site(session))["brand_name"], await get_integrations(session))
    if data is None:
        return None
    reg = await regional.get_regional(session)
    data["alternatives"] = await payment_gateways.alternatives(session, await get_integrations(session), data["currency"], data["provider"])
    data["methods"] = reg["pay_methods"]
    data["card_networks"] = reg["card_networks"]
    if reg["save_cards"] and (user.phone or user.email):
        if not user.razorpay_customer_id:
            try:
                cust = await razorpay.create_customer(user.name, f"+91{user.phone}" if user.phone else "", user.email or "")
                user.razorpay_customer_id = str(cust.get("id") or "")[:40] or None
                await session.commit()
            except razorpay.GatewayError as exc:
                log.warning("razorpay customer for saved cards not created: %s", exc)
        data["customer_id"] = user.razorpay_customer_id or ""
    return data


@router.post("/api/orders/{order_id}/cancel")
async def cancel(order_id: uuid.UUID, body: CancelIn, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    o = await _own_order(session, user, order_id)
    refund_ids = await customer_cancel(session, o, body.sub_order_id, body.reason)
    await session.commit()
    background.add_task(run_refunds, refund_ids)
    return await order_detail(session, o)


async def _delivered_trip(session, o: Order, sub_order_id: uuid.UUID) -> DeliveryAssignment:
    sub = await session.get(SubOrder, sub_order_id)
    if sub is None or sub.order_id != o.id:
        raise NotFound("Order part")
    a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.sub_order_id == sub.id, DeliveryAssignment.kind == "delivery",
                                                                DeliveryAssignment.status == "delivered").limit(1).with_for_update())).scalar_one_or_none()
    if a is None:
        raise ApiError("You can rate the delivery once it is delivered", "not_delivered")
    return a


class DeliveryRatingIn(BaseModel):
    sub_order_id: uuid.UUID
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=500)


@router.post("/api/orders/{order_id}/delivery-rating")
async def rate_delivery(order_id: uuid.UUID, body: DeliveryRatingIn, user: CurrentUser, session: SessionDep) -> dict:
    o = await _own_order(session, user, order_id)
    a = await _delivered_trip(session, o, body.sub_order_id)
    boy = (await session.execute(select(DeliveryBoy).where(DeliveryBoy.id == a.delivery_boy_id).with_for_update())).scalar_one()
    old = a.rating
    a.rating, a.rating_comment, a.rated_at = body.rating, " ".join(body.comment.split()), utcnow()
    total = float(boy.rating_avg or 0) * boy.rating_count - (old or 0) + body.rating
    boy.rating_count += 0 if old else 1
    boy.rating_avg = round(total / boy.rating_count, 2) if boy.rating_count else 0
    await session.commit()
    return {"ok": True, "rating": a.rating}


class DeliveryComplaintIn(BaseModel):
    sub_order_id: uuid.UUID
    category: Literal["late", "rude", "damaged", "not_received", "extra_money", "other"]
    text: str = Field(default="", max_length=1000)


@router.post("/api/orders/{order_id}/delivery-complaint", status_code=201)
async def delivery_complaint(order_id: uuid.UUID, body: DeliveryComplaintIn, user: CurrentUser, session: SessionDep) -> dict:
    from app.core.deps import rate_limit
    from app.services.notify import notify_staff

    o = await _own_order(session, user, order_id)
    await rate_limit(session, f"dcomplaint:{user.id}", limit=10, window_seconds=86400)
    a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.sub_order_id == body.sub_order_id, DeliveryAssignment.order_id == o.id,
                                                                DeliveryAssignment.kind == "delivery", DeliveryAssignment.status.in_(("delivered", "failed")))
                                .order_by(DeliveryAssignment.created_at.desc()).limit(1))).scalar_one_or_none()
    if a is None:
        raise ApiError("There is no delivery to complain about yet", "no_delivery")
    c = DeliveryComplaint(assignment_id=a.id, delivery_boy_id=a.delivery_boy_id, user_id=user.id, category=body.category, text=" ".join(body.text.split()),
                          status="open", created_at=utcnow())
    session.add(c)
    await notify_staff(session, "delivery", "staff_message", {"subject": f"Delivery complaint on {o.number}", "message": body.text[:200] or body.category},
                       link="/admin/delivery/feedback")
    await session.commit()
    return {"ok": True, "id": str(c.id)}


@router.get("/api/orders/{order_id}/delivery-proof/{sub_order_id}")
async def delivery_proof(order_id: uuid.UUID, sub_order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Response:
    from app.routers.delivery import proof_response

    o = await _own_order(session, user, order_id)
    a = (await session.execute(select(DeliveryAssignment).where(DeliveryAssignment.sub_order_id == sub_order_id, DeliveryAssignment.order_id == o.id,
                                                                DeliveryAssignment.status == "delivered", DeliveryAssignment.kind == "delivery").limit(1))).scalar_one_or_none()
    if a is None:
        raise NotFound("Delivery photo")
    return await proof_response(a)


async def customer_cancel(session, o: Order, sub_order_id: uuid.UUID | None, reason: str) -> list[uuid.UUID]:
    """Cancels the customer's cancellable packages of an order (all, or one). Ownership is the caller's check.
    Returns refund ids to process after commit. Shared by the orders page and the shop assistant."""
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == o.id).order_by(SubOrder.number).with_for_update())).scalars())
    targets = [s for s in subs if (sub_order_id is None or s.id == sub_order_id)]
    if sub_order_id and not targets:
        raise NotFound("Order part")
    allowed = await customer_cancellable(session)
    cancellable = [s for s in targets if s.status in allowed or s.status == "pending_payment"]
    if not cancellable:
        raise ApiError("This order can no longer be cancelled. You can return it after delivery.", "not_cancellable")
    refund_ids = []
    for s in cancellable:
        refund = await cancel_sub_order(session, s, actor="customer", reason=reason)
        if refund:
            await session.flush()
            refund_ids.append(refund.id)
    return refund_ids


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


async def _check_and_refund(session, payment: Payment, background: BackgroundTasks) -> dict:
    """Asks Razorpay, saves what it says and starts any duplicate-payment refund."""
    out = await check_with_gateway(session, payment)
    await session.commit()
    if out["result"] == "refund":
        ids = list((await session.execute(select(Refund.id).where(Refund.payment_id == payment.id, Refund.status == "pending"))).scalars())
        background.add_task(run_refunds, ids)
    return out


@router.post("/api/orders/{order_id}/payment-status")
async def payment_status(order_id: uuid.UUID, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    """The shopper's "did my payment go through?": the order page asks this when they come back from a UPI app or the
    payment window, and every few seconds while a payment may still be on its way. The answer comes from Razorpay.

    status: paid | waiting (a UPI request is still open) | failed (with reason) | not_paid | unknown (Razorpay unreachable)"""
    o = await _own_order(session, user, order_id)
    payment = (await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at.desc()).limit(1)
                                     .with_for_update())).scalar_one_or_none()
    out: dict = {"status": "not_paid", "reason": ""}
    if o.payment_status in ("paid", "partially_refunded", "refunded") or (payment and payment.status == "captured"):
        out["status"] = "paid"
    elif payment is None or o.status != "pending_payment":
        out["status"] = "not_paid"
    else:
        await rate_limit(session, f"paycheck:{o.id}", limit=80, window_seconds=600)  # protects the Razorpay API quota
        try:
            res = await _check_and_refund(session, payment, background)
        except razorpay.GatewayError:
            out["status"] = "unknown"
        except ApiError as exc:
            log.warning("payment check for %s: %s", o.number, exc)
            out["status"] = "unknown"
        else:
            if res["result"] in ("paid", "already", "already_paid", "refund"):
                out["status"] = "paid"
            elif res["waiting"]:
                out["status"] = "waiting"
            elif res["reason"]:
                out["status"], out["reason"] = "failed", res["reason"]
    await session.commit()
    await session.refresh(o)
    out["order"] = await _shopper_order(session, o, user)
    return out


def _back_to_order(order_id: uuid.UUID | None, outcome: str, reason: str = "") -> RedirectResponse:
    """Sends the shopper's browser (or the app) to their order with the outcome. A relative address, so it lands on the
    same site the payment started from (the website proxies /api)."""
    from urllib.parse import urlencode

    query = {"payment": outcome}
    if reason:
        query["reason"] = reason[:160]
    return RedirectResponse(f"/orders/{order_id}?{urlencode(query)}" if order_id else f"/orders?{urlencode(query)}", status_code=303)


@router.api_route("/api/payments/razorpay/callback", methods=["GET", "POST"])
async def razorpay_callback(request: Request, session: SessionDep, background: BackgroundTasks) -> Response:
    """Where Razorpay sends the shopper after paying (its callback_url), used on phones and in the app, where the shopper
    leaves for Google Pay, PhonePe or another UPI app and the page may be reloaded on the way back. Razorpay posts the
    payment ids and signature on success, or error[...] fields on failure. Nobody needs to be signed in here (the post
    comes from Razorpay's page): nothing is trusted from the post itself. The signature is checked and the payment is
    confirmed with Razorpay's API before the order is marked paid."""
    data: dict[str, str] = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            data.update({k: str(v) for k, v in form.items()})
        except Exception:  # noqa: BLE001 - a malformed post is treated as "no details"
            pass
    rzp_order = (data.get("razorpay_order_id") or "")[:40]
    rzp_payment = (data.get("razorpay_payment_id") or "")[:40]
    signature = (data.get("razorpay_signature") or "")[:128]
    reason = (data.get("error[description]") or "")[:300]
    if not rzp_order and data.get("error[metadata]"):
        try:
            meta = json.loads(data["error[metadata]"])
            rzp_order, rzp_payment = str(meta.get("order_id") or "")[:40], str(meta.get("payment_id") or "")[:40]
        except (ValueError, AttributeError):
            pass
    payment = None
    if rzp_order:
        payment = (await session.execute(select(Payment).where(Payment.provider_order_id == rzp_order).with_for_update())).scalar_one_or_none()
    if payment is None:
        return _back_to_order(None, "unknown")
    order_id = payment.order_id
    try:
        if rzp_payment and signature and await razorpay.verify_payment_signature(rzp_order, rzp_payment, signature):
            result = await confirm_with_gateway(session, payment, rzp_payment)
            await session.commit()
            if result == "refund":
                ids = list((await session.execute(select(Refund.id).where(Refund.payment_id == payment.id, Refund.status == "pending"))).scalars())
                background.add_task(run_refunds, ids)
            if result in ("paid", "already", "refund"):
                return _back_to_order(order_id, "success")
        # failure, a bad signature or a capture that did not complete: Razorpay's records decide
        res = await _check_and_refund(session, payment, background)
    except (razorpay.GatewayError, ApiError) as exc:
        log.warning("payment return for %s could not be confirmed yet: %s", rzp_order, exc)
        await session.rollback()
        return _back_to_order(order_id, "checking")  # the order page keeps checking; the webhook also records it
    if res["result"] in ("paid", "already", "already_paid", "refund"):
        return _back_to_order(order_id, "success")
    if res["waiting"] and not reason:
        return _back_to_order(order_id, "checking")
    return _back_to_order(order_id, "failed", reason or res["reason"] or "The payment did not go through")


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
            newly_processed = etype == "refund.processed" and refund.status != "processed"
            refund.status = "processed" if etype == "refund.processed" else "failed"
            refund.last_error = "" if etype == "refund.processed" else "Gateway reported the refund failed"
            if newly_processed:
                await notify_refund(session, refund)
    await session.commit()
    if refund_ids:
        background.add_task(run_refunds, refund_ids)
    return {"ok": True}


# ----------------------------------------------------------------------------- other gateways (docs/PAYMENT_GATEWAYS.md section 5)
_EXTRA = ("cashfree", "phonepe", "payu", "stripe")


class SwitchIn(BaseModel):
    provider: str | None = None


@router.post("/api/orders/{order_id}/payment/switch")
async def switch_payment(order_id: uuid.UUID, body: SwitchIn, user: CurrentUser, session: SessionDep) -> dict:
    """Pay another way: a new payment with the chosen gateway, or the next eligible one after the latest attempt."""
    o = await _own_order(session, user, order_id)
    latest = (await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at.desc()).limit(1).with_for_update())).scalar_one_or_none()
    if o.status != "pending_payment" or latest is None or latest.status == "captured":
        raise ApiError("Nothing is waiting to be paid on this order.", "not_pending", 409)
    if body.provider is not None and body.provider not in ("razorpay", *_EXTRA):
        raise ApiError("Unknown payment method", "unknown_gateway", 400)
    await rate_limit(session, f"payswitch:{o.id}", limit=20, window_seconds=600)
    cfg = await get_integrations(session)
    await payment_gateways.start_payment(session, o, user, amount=latest.amount_paise, charge=latest.charge_amount, charge_currency=latest.currency or "INR",
                                         cfg=cfg, preferred=body.provider, after=latest.provider)
    new = (await session.execute(select(Payment).where(Payment.order_id == o.id).order_by(Payment.created_at.desc()).limit(1))).scalar_one()
    await session.commit()
    return {"payment": await shopper_checkout(session, o, new, user)}


async def _params(request: Request) -> dict[str, str]:
    data: dict[str, str] = dict(request.query_params)
    if request.method == "POST":
        try:
            form = await request.form()
            data.update({k: str(v) for k, v in form.items()})
        except Exception:  # noqa: BLE001 - a malformed post counts as "no details"
            pass
    return data


async def _gateway_payment(session, code: str, ref: str | None) -> Payment | None:
    if not ref:
        return None
    return (await session.execute(select(Payment).where(Payment.provider == code, Payment.provider_order_id == ref[:100]).with_for_update())).scalar_one_or_none()


@router.api_route("/api/payments/{code}/callback", methods=["GET", "POST"])
async def gateway_callback(code: str, request: Request, session: SessionDep, background: BackgroundTasks) -> Response:
    """The shopper's return from a gateway page. Nothing in the request is trusted: the payment is found by the gateway's
    reference and checked with the gateway before the order is marked paid."""
    if code not in _EXTRA:
        raise NotFound("Gateway")
    adapter = payment_gateways.gateways.build(await get_integrations(session), code)
    payment = await _gateway_payment(session, code, adapter.reference_from_return(await _params(request)))
    if payment is None:
        return _back_to_order(None, "unknown")
    order_id = payment.order_id
    try:
        res = await _check_and_refund(session, payment, background)
    except (razorpay.GatewayError, ApiError) as exc:
        log.warning("%s return for %s could not be confirmed yet: %s", code, payment.provider_order_id, exc)
        await session.rollback()
        return _back_to_order(order_id, "checking")
    if res["result"] in ("paid", "already", "already_paid", "refund"):
        return _back_to_order(order_id, "success")
    if res["waiting"]:
        return _back_to_order(order_id, "checking")
    return _back_to_order(order_id, "failed", res["reason"] or "The payment did not go through")


@router.post("/api/payments/{code}/webhook")
async def gateway_webhook(code: str, request: Request, session: SessionDep, background: BackgroundTasks) -> dict:
    """A verified event only triggers a check with the gateway; the event body is never trusted for amounts or states."""
    if code not in _EXTRA:
        raise NotFound("Gateway")
    body = await request.body()
    adapter = payment_gateways.gateways.build(await get_integrations(session), code)
    ref = adapter.verify_webhook(dict(request.headers), body)
    if not ref:
        raise ApiError("Invalid signature", "bad_signature", 400)
    session.add(WebhookEvent(provider=code, event_id=hashlib.sha256(body).hexdigest()[:80], event_type="notification", received_at=utcnow()))
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        return {"ok": True, "duplicate": True}
    payment = await _gateway_payment(session, code, ref)
    if payment is not None:
        try:
            await _check_and_refund(session, payment, background)
        except (razorpay.GatewayError, ApiError) as exc:
            log.warning("%s webhook check for %s failed: %s", code, ref, exc)
            await session.rollback()
            raise ApiError("Could not check the payment yet", "gateway_error", 503) from exc
    await session.commit()
    return {"ok": True}
