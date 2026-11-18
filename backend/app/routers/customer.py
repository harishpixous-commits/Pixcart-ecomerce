"""Customer features beyond checkout: wishlist, reviews, returns, invoices, notifications, support,
delivery estimates, privacy (DPDP) and product events for analytics."""
from __future__ import annotations

import time
import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from app.core.deps import CurrentUser, OptionalUser, SessionDep, audit, client_ip
from app.core.errors import ApiError, Conflict, NotFound
from app.core.validators import validate_pincode
from app.db import utcnow
from app.models import (
    Address,
    Notification,
    Order,
    OrderItem,
    Product,
    RefreshSession,
    ReturnRequest,
    Review,
    Seller,
    SubOrder,
    SupportTicket,
    TicketMessage,
    User,
    Variant,
    Warehouse,
    WishlistItem,
)
from app.routers.catalog import product_cards
from app.routers.orders import run_refunds
from app.services import returns as returns_svc
from app.services import support as support_svc
from app.services.catalog import public_product_filter
from app.services.coupons import list_for_checkout
from app.services.delivery import estimate
from app.services.invoices import credit_note_pdf, invoice_pdf
from app.services.platform_settings import RETURN_REASONS, get_settings
from app.services.stats import bump

router = APIRouter(tags=["customer"])


# ----------------------------------------------------------------------------- wishlist


@router.get("/api/wishlist")
async def wishlist(user: CurrentUser, session: SessionDep) -> dict:
    rows = list(
        (
            await session.execute(
                select(Product).join(WishlistItem, WishlistItem.product_id == Product.id).where(WishlistItem.user_id == user.id).order_by(WishlistItem.created_at.desc())
            )
        ).scalars()
    )
    return {"items": await product_cards(session, rows), "ids": [str(p.id) for p in rows]}


@router.put("/api/wishlist/{product_id}")
async def wishlist_add(product_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    if await session.get(Product, product_id) is None:
        raise NotFound("Product")
    exists = await session.get(WishlistItem, (user.id, product_id))
    if not exists:
        count = (await session.execute(select(func.count()).select_from(WishlistItem).where(WishlistItem.user_id == user.id))).scalar_one()
        if count >= 200:
            raise ApiError("Your wishlist is full (200 items)", "wishlist_full")
        session.add(WishlistItem(user_id=user.id, product_id=product_id, created_at=utcnow()))
        await session.commit()
    return {"ok": True}


@router.delete("/api/wishlist/{product_id}")
async def wishlist_remove(product_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    row = await session.get(WishlistItem, (user.id, product_id))
    if row:
        await session.delete(row)
        await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- reviews


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=4000)


async def refresh_ratings(session, product_id: uuid.UUID) -> None:
    avg, count = (
        await session.execute(select(func.coalesce(func.avg(Review.rating), 0), func.count()).where(Review.product_id == product_id, Review.status == "published"))
    ).one()
    p = await session.get(Product, product_id)
    p.rating_avg, p.rating_count = round(float(avg), 2), int(count)
    savg, scount = (
        await session.execute(
            select(func.coalesce(func.avg(Review.rating), 0), func.count())
            .join(Product, Product.id == Review.product_id)
            .where(Product.seller_id == p.seller_id, Review.status == "published")
        )
    ).one()
    s = await session.get(Seller, p.seller_id)
    s.rating_avg, s.rating_count = round(float(savg), 2), int(scount)


@router.get("/api/catalog/products/{slug}/reviews")
async def product_reviews(
    slug: str,
    session: SessionDep,
    user: OptionalUser,
    sort: Literal["recent", "helpful", "high", "low"] = "recent",
    page: int = Query(default=1, ge=1),
) -> dict:
    p = (await session.execute(select(Product).where(Product.slug == slug))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    base = select(Review, User.name).join(User, User.id == Review.user_id).where(Review.product_id == p.id, Review.status == "published")
    order = {"recent": Review.created_at.desc(), "helpful": Review.helpful_count.desc(), "high": Review.rating.desc(), "low": Review.rating.asc()}[sort]
    rows = (await session.execute(base.order_by(order, Review.id).offset((page - 1) * 10).limit(10))).all()
    dist = dict((await session.execute(select(Review.rating, func.count()).where(Review.product_id == p.id, Review.status == "published").group_by(Review.rating))).all())
    can_review = False
    mine = None
    if user:
        mine_row = (await session.execute(select(Review).where(Review.product_id == p.id, Review.user_id == user.id))).scalar_one_or_none()
        mine = {"rating": mine_row.rating, "title": mine_row.title, "body": mine_row.body} if mine_row else None
        can_review = (await _delivered_sub(session, user.id, p.id)) is not None
    return {
        "rating_avg": float(p.rating_avg or 0),
        "rating_count": p.rating_count,
        "distribution": {str(k): dist.get(k, 0) for k in range(5, 0, -1)},
        "summary": p.review_summary,
        "can_review": can_review,
        "mine": mine,
        "items": [
            {
                "id": str(r.id), "rating": r.rating, "title": r.title, "body": r.body, "author": (name or "Customer").split(" ")[0],
                "verified": True, "seller_reply": r.seller_reply, "helpful_count": r.helpful_count, "created_at": r.created_at.isoformat(),
            }
            for r, name in rows
        ],
        "page": page,
        "has_more": len(rows) == 10,
    }


async def _delivered_sub(session, user_id: uuid.UUID, product_id: uuid.UUID) -> SubOrder | None:
    return (
        await session.execute(
            select(SubOrder)
            .join(Order, Order.id == SubOrder.order_id)
            .join(OrderItem, OrderItem.sub_order_id == SubOrder.id)
            .where(Order.user_id == user_id, OrderItem.product_id == product_id, SubOrder.status == "delivered")
            .limit(1)
        )
    ).scalar_one_or_none()


@router.put("/api/catalog/products/{slug}/reviews")
async def write_review(slug: str, body: ReviewIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_reviews"]:
        raise ApiError("Reviews are turned off", "reviews_off")
    p = (await session.execute(select(Product).where(Product.slug == slug))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    sub = await _delivered_sub(session, user.id, p.id)
    if sub is None:
        raise ApiError("You can review a product after it has been delivered to you", "not_purchased")
    r = (await session.execute(select(Review).where(Review.product_id == p.id, Review.user_id == user.id))).scalar_one_or_none()
    if r is None:
        r = Review(product_id=p.id, user_id=user.id, sub_order_id=sub.id)
        session.add(r)
    r.rating, r.title, r.body = body.rating, body.title.strip(), body.body.strip()
    r.status = "hidden" if cfg["reviews_need_approval"] else "published"
    await session.flush()
    await refresh_ratings(session, p.id)
    await session.commit()
    return {"ok": True, "status": r.status}


_helpful_seen: dict[tuple, float] = {}


@router.post("/api/reviews/{review_id}/helpful")
async def helpful(review_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    key = (user.id, review_id)
    if key in _helpful_seen:
        return {"ok": True}
    _helpful_seen[key] = time.time()
    if len(_helpful_seen) > 50_000:
        _helpful_seen.clear()
    await session.execute(update(Review).where(Review.id == review_id).values(helpful_count=Review.helpful_count + 1))
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- returns


class ReturnIn(BaseModel):
    sub_order_id: uuid.UUID
    items: list[dict] = Field(min_length=1, max_length=50)  # [{order_item_id, qty}]
    reason: str
    comment: str = Field(default="", max_length=2000)
    refund_upi: str = Field(default="", max_length=60)


@router.get("/api/returns/reasons")
async def return_reasons() -> dict:
    return {"reasons": [{"code": k, "label": v} for k, v in RETURN_REASONS.items()]}


@router.get("/api/orders/{order_id}/returnable")
async def returnable(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    o = await session.get(Order, order_id)
    if o is None or o.user_id != user.id:
        raise NotFound("Order")
    subs = list((await session.execute(select(SubOrder).where(SubOrder.order_id == o.id))).scalars())
    out = {}
    for s in subs:
        out[str(s.id)] = await returns_svc.returnable_items(session, s)
    rets = list((await session.execute(select(ReturnRequest).where(ReturnRequest.sub_order_id.in_([s.id for s in subs])).order_by(ReturnRequest.created_at.desc()))).scalars())
    return {"items": out, "returns": [await returns_svc.return_out(session, r) for r in rets], "needs_upi": o.payment_method == "cod"}


@router.post("/api/returns", status_code=201)
async def create_return(body: ReturnIn, user: CurrentUser, session: SessionDep) -> dict:
    try:
        items = [(uuid.UUID(str(i["order_item_id"])), int(i["qty"])) for i in body.items]
    except (KeyError, ValueError, TypeError) as exc:
        raise ApiError("Choose the items and quantities to return", "invalid_items") from exc
    ret = await returns_svc.create(session, user, body.sub_order_id, items, body.reason, body.comment, body.refund_upi.strip())
    await session.commit()
    return await returns_svc.return_out(session, ret)


@router.post("/api/returns/{return_id}/cancel")
async def cancel_return(return_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    ret = (await session.execute(select(ReturnRequest).where(ReturnRequest.id == return_id).with_for_update())).scalar_one_or_none()
    if ret is None or ret.user_id != user.id:
        raise NotFound("Return")
    await returns_svc.set_status(session, ret, "cancelled")
    await session.commit()
    return await returns_svc.return_out(session, ret)


# ----------------------------------------------------------------------------- invoices


async def _own_sub(session, user, sub_id) -> SubOrder:
    sub = await session.get(SubOrder, sub_id)
    if sub is None:
        raise NotFound("Invoice")
    order = await session.get(Order, sub.order_id)
    if order.user_id != user.id:
        raise NotFound("Invoice")
    return sub


@router.get("/api/invoices/{sub_id}.pdf")
async def invoice(sub_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Response:
    sub = await _own_sub(session, user, sub_id)
    if not sub.invoice_number:
        raise ApiError("The invoice is issued when the package ships", "invoice_not_ready")
    pdf = await invoice_pdf(session, sub)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="invoice-{sub.number}.pdf"', "Cache-Control": "private, no-store"})


@router.get("/api/credit-notes/{return_id}.pdf")
async def credit_note(return_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Response:
    ret = await session.get(ReturnRequest, return_id)
    if ret is None or ret.user_id != user.id or not ret.credit_note_number:
        raise NotFound("Credit note")
    pdf = await credit_note_pdf(session, ret)
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="credit-note-{ret.number}.pdf"', "Cache-Control": "private, no-store"})


# ----------------------------------------------------------------------------- notifications


@router.get("/api/notifications")
async def my_notifications(user: CurrentUser, session: SessionDep, page: int = Query(default=1, ge=1)) -> dict:
    rows = list(
        (
            await session.execute(
                select(Notification).where(Notification.user_id == user.id, Notification.channel == "inapp").order_by(Notification.created_at.desc()).offset((page - 1) * 20).limit(20)
            )
        ).scalars()
    )
    unread = (
        await session.execute(select(func.count()).select_from(Notification).where(Notification.user_id == user.id, Notification.channel == "inapp", Notification.read_at.is_(None)))
    ).scalar_one()
    return {
        "unread": unread,
        "items": [{"id": str(n.id), "title": n.subject, "body": n.body, "link": n.link, "read": n.read_at is not None, "at": n.created_at.isoformat()} for n in rows],
    }


@router.post("/api/notifications/read-all")
async def read_all(user: CurrentUser, session: SessionDep) -> dict:
    await session.execute(update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None)).values(read_at=utcnow()))
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- support tickets

CATEGORIES = support_svc.CATEGORIES


class TicketIn(BaseModel):
    category: str
    subject: str = Field(min_length=5, max_length=200)
    message: str = Field(min_length=10, max_length=5000)
    order_id: uuid.UUID | None = None
    is_grievance: bool = False


class MessageIn(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


def ticket_out(t: SupportTicket, messages: list[TicketMessage] | None = None, *, staff: bool = False) -> dict:
    now = utcnow()
    data = {
        "id": str(t.id), "number": t.number, "category": t.category, "category_label": CATEGORIES.get(t.category, t.category),
        "subject": t.subject, "status": t.status, "priority": t.priority, "is_grievance": t.is_grievance,
        "order_id": str(t.order_id) if t.order_id else None, "created_at": t.created_at.isoformat(), "updated_at": t.updated_at.isoformat(),
        "acknowledged_at": t.acknowledged_at.isoformat() if t.acknowledged_at else None, "resolved_at": t.resolved_at.isoformat() if t.resolved_at else None,
    }
    if staff:
        data |= {
            "ack_due_at": t.ack_due_at.isoformat(), "resolve_due_at": t.resolve_due_at.isoformat(),
            "ack_overdue": t.acknowledged_at is None and now > t.ack_due_at,
            "resolve_overdue": t.status not in ("resolved", "closed") and now > t.resolve_due_at,
            "assigned_to": str(t.assigned_to) if t.assigned_to else None,
        }
    if messages is not None:
        data["messages"] = [
            {"id": str(m.id), "author_role": m.author_role, "body": m.body, "internal": m.is_internal, "at": m.created_at.isoformat()}
            for m in messages if staff or not m.is_internal
        ]
    return data


@router.get("/api/support/categories")
async def support_categories() -> dict:
    return {"categories": [{"code": k, "label": v} for k, v in CATEGORIES.items()]}


@router.get("/api/support/tickets")
async def my_tickets(user: CurrentUser, session: SessionDep) -> dict:
    rows = (await session.execute(select(SupportTicket).where(SupportTicket.user_id == user.id).order_by(SupportTicket.updated_at.desc()).limit(100))).scalars()
    return {"items": [ticket_out(t) for t in rows]}


@router.post("/api/support/tickets", status_code=201)
async def open_ticket(body: TicketIn, user: CurrentUser, session: SessionDep) -> dict:
    t = await support_svc.create_ticket(session, user, category=body.category, subject=body.subject, message=body.message,
                                        order_id=body.order_id, is_grievance=body.is_grievance)
    await session.commit()
    return ticket_out(t, [])


@router.get("/api/support/tickets/{ticket_id}")
async def get_ticket(ticket_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    t = await session.get(SupportTicket, ticket_id)
    if t is None or t.user_id != user.id:
        raise NotFound("Request")
    msgs = list((await session.execute(select(TicketMessage).where(TicketMessage.ticket_id == t.id).order_by(TicketMessage.created_at))).scalars())
    return ticket_out(t, msgs)


@router.post("/api/support/tickets/{ticket_id}/messages")
async def reply_ticket(ticket_id: uuid.UUID, body: MessageIn, user: CurrentUser, session: SessionDep) -> dict:
    t = (await session.execute(select(SupportTicket).where(SupportTicket.id == ticket_id).with_for_update())).scalar_one_or_none()
    if t is None or t.user_id != user.id:
        raise NotFound("Request")
    if t.status == "closed":
        raise Conflict("This request is closed. Open a new one if you still need help.", "ticket_closed")
    session.add(TicketMessage(ticket_id=t.id, author_id=user.id, author_role="customer", body=body.body.strip(), created_at=utcnow()))
    t.status = "open"
    t.updated_at = utcnow()
    await session.commit()
    return await get_ticket(ticket_id, user, session)


@router.post("/api/support/tickets/{ticket_id}/close")
async def close_ticket(ticket_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    t = await session.get(SupportTicket, ticket_id)
    if t is None or t.user_id != user.id:
        raise NotFound("Request")
    t.status = "closed"
    t.resolved_at = t.resolved_at or utcnow()
    await session.commit()
    return await get_ticket(ticket_id, user, session)


# ----------------------------------------------------------------------------- delivery estimate & coupons


@router.get("/api/catalog/delivery-estimate")
async def delivery_estimate(session: SessionDep, variant_id: uuid.UUID, pincode: str = Query(min_length=6, max_length=6)) -> dict:
    try:
        pin = validate_pincode(pincode)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_pincode") from exc
    v = await session.get(Variant, variant_id)
    if v is None:
        raise NotFound("Product")
    seller = await session.get(Seller, v.seller_id)
    whs = list((await session.execute(select(Warehouse).where(Warehouse.seller_id == seller.id, Warehouse.is_active.is_(True)).order_by(Warehouse.is_default.desc()))).scalars())
    if not whs:
        return {"serviceable": False}
    cfg = await get_settings(session)
    best = min((estimate(cfg, seller.dispatch_days, w.pincode, w.state_code, pin) for w in whs), key=lambda e: e["days_min"])
    return {"serviceable": True, "cod_available": cfg["cod_enabled"], **best}


@router.get("/api/checkout/coupons")
async def checkout_coupons(user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    return {"items": await list_for_checkout(session) if cfg["feature_coupons"] else []}


# ----------------------------------------------------------------------------- analytics beacon

_seen: dict[tuple, float] = {}


class EventIn(BaseModel):
    type: Literal["view", "add_to_cart"]
    product_id: uuid.UUID


@router.post("/api/events", status_code=204)
async def event(body: EventIn, request: Request, session: SessionDep) -> Response:
    key = (client_ip(request), body.type, body.product_id)
    now = time.time()
    if now - _seen.get(key, 0) < 1800:  # count a visitor once per 30 minutes per product
        return Response(status_code=204)
    _seen[key] = now
    if len(_seen) > 100_000:
        _seen.clear()
    exists = (await session.execute(select(Product.id).where(Product.id == body.product_id, *public_product_filter()))).first()
    if exists:
        await bump(session, body.product_id, views=1 if body.type == "view" else 0, add_to_cart=1 if body.type == "add_to_cart" else 0)
        await session.commit()
    return Response(status_code=204)


# ----------------------------------------------------------------------------- privacy (DPDP Act 2023)


class ConsentIn(BaseModel):
    marketing_opt_in: bool


@router.put("/api/account/consent")
async def consent(body: ConsentIn, user: CurrentUser, session: SessionDep) -> dict:
    user.marketing_opt_in = body.marketing_opt_in
    audit(session, user, "account.consent", "user", user.id, f"marketing={body.marketing_opt_in}")
    await session.commit()
    return {"marketing_opt_in": user.marketing_opt_in}


@router.get("/api/account/export")
async def export_data(user: CurrentUser, session: SessionDep) -> dict:
    """Right to access: a summary of the personal data we hold."""
    addresses = (await session.execute(select(Address).where(Address.user_id == user.id, Address.is_deleted.is_(False)))).scalars()
    orders = (await session.execute(select(Order).where(Order.user_id == user.id).order_by(Order.created_at.desc()))).scalars()
    return {
        "profile": {"name": user.name, "phone": user.phone, "email": user.email, "marketing_opt_in": user.marketing_opt_in, "joined": user.created_at.isoformat()},
        "addresses": [{"name": a.full_name, "phone": a.phone, "line1": a.line1, "city": a.city, "pincode": a.pincode} for a in addresses],
        "orders": [{"number": o.number, "total": o.grand_total, "status": o.status, "placed": o.created_at.isoformat(), "ship_to": o.ship_to} for o in orders],
    }


@router.delete("/api/account")
async def delete_account(user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    """Right to erasure. Order and tax records are kept as the GST law requires (72 months), with the
    account itself anonymised so it can no longer be used or linked to the person."""
    if user.is_admin:
        raise Conflict("Staff accounts are removed by the owner", "staff_account")
    seller = (await session.execute(select(Seller).where(Seller.user_id == user.id))).scalar_one_or_none()
    if seller and seller.status in ("approved", "submitted"):
        raise Conflict("Close your seller account with seller support before deleting your login", "seller_active")
    open_subs = (
        await session.execute(
            select(func.count()).select_from(SubOrder).join(Order, Order.id == SubOrder.order_id)
            .where(Order.user_id == user.id, SubOrder.status.in_(("pending_payment", "placed", "confirmed", "packed", "shipped")))
        )
    ).scalar_one()
    if open_subs:
        raise Conflict("You have orders on the way. You can delete your account after they are delivered or cancelled.", "open_orders")
    await session.execute(update(Address).where(Address.user_id == user.id).values(is_deleted=True, full_name="Deleted", phone="0000000000", line1="Deleted", line2="", landmark=""))
    await session.execute(update(RefreshSession).where(RefreshSession.user_id == user.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))
    user.name, user.phone, user.email = "Deleted user", None, f"deleted-{user.id}@deleted.invalid"
    user.password_hash, user.is_active, user.deleted_at, user.marketing_opt_in = None, False, utcnow(), False
    audit(session, None, "account.deleted", "user", user.id)
    await session.commit()
    return {"ok": True}


_ = (run_refunds,)
