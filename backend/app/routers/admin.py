"""Marketplace administration: seller KYC review, listing moderation, categories, orders, refunds,
customers, settings, audit log and the monthly GST TCS (GSTR-8 basis) report."""
from __future__ import annotations

import uuid
from datetime import datetime, time, timedelta
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import exists, func, or_, select, update

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import Perm
from app.core.validators import STATES, slugify
from app.db import utcnow
from app.models import (
    AuditLog,
    Category,
    Order,
    Product,
    RefreshSession,
    Refund,
    Seller,
    SubOrder,
    User,
)
from app.models.catalog import GST_RATES_BPS
from app.routers.orders import order_detail, run_refunds
from app.routers.seller_onboarding import document_response, seller_profile
from app.routers.seller_products import product_detail
from app.services.catalog import images_for
from app.services.orders import cancel_sub_order, transition
from app.services.platform_settings import get_settings, update_settings
from app.services.reports import IST, tcs_report_data

router = APIRouter(prefix="/api/admin", tags=["admin"])


class ReasonIn(BaseModel):
    reason: str = Field(min_length=5, max_length=1000)


class CommissionIn(BaseModel):
    commission_bps_override: int | None = Field(default=None, ge=0, le=5000)


class CategoryIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    parent_id: uuid.UUID | None = None
    image_url: str = Field(default="", max_length=400)
    commission_bps: int = Field(ge=0, le=5000)
    default_gst_bps: int
    position: int = Field(default=0, ge=0, le=10_000)
    is_active: bool = True


def _page(page: int, size: int) -> tuple[int, int]:
    return (page - 1) * size, size


# ----------------------------------------------------------------------------- dashboard


@router.get("/dashboard")
async def dashboard(admin: Perm("dashboard"), session: SessionDep) -> dict:
    now = utcnow()
    since = now - timedelta(days=30)
    today = datetime.combine(now.astimezone(IST).date(), time.min, IST)  # midnight in India, not UTC
    gmv = (
        await session.execute(
            select(func.coalesce(func.sum(Order.grand_total - Order.refunded_total), 0), func.count()).where(Order.status == "placed", Order.placed_at >= since)
        )
    ).one()
    commission = (
        await session.execute(
            select(func.coalesce(func.sum(SubOrder.commission_paise), 0)).where(SubOrder.status.notin_(("pending_payment", "cancelled")), SubOrder.created_at >= since)
        )
    ).scalar_one()
    return {
        "sellers_pending_review": (await session.execute(select(func.count()).where(Seller.status == "submitted"))).scalar_one(),
        "products_pending_review": (await session.execute(select(func.count()).where(Product.status == "pending"))).scalar_one(),
        "orders_today": (await session.execute(select(func.count()).where(Order.status == "placed", Order.placed_at >= today))).scalar_one(),
        "gmv_30d": int(gmv[0]),
        "orders_30d": gmv[1],
        "commission_30d": int(commission),
        "refunds_needing_attention": (await session.execute(select(func.count()).where(Refund.status == "failed"))).scalar_one(),
        "active_sellers": (await session.execute(select(func.count()).where(Seller.status == "approved"))).scalar_one(),
        "customers": (await session.execute(select(func.count()).select_from(User))).scalar_one(),
        "live_products": (await session.execute(select(func.count()).where(Product.status == "approved"))).scalar_one(),
    }


# ----------------------------------------------------------------------------- sellers


@router.get("/sellers")
async def list_sellers(
    admin: Perm("sellers"),
    session: SessionDep,
    status: Literal["draft", "submitted", "approved", "rejected", "suspended"] | None = None,
    q: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    stmt = select(Seller)
    if status:
        stmt = stmt.where(Seller.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Seller.display_name.ilike(like), Seller.legal_name.ilike(like), Seller.gstin.ilike(like), Seller.contact_phone.ilike(like)))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off, lim = _page(page, page_size)
    rows = list((await session.execute(stmt.order_by(Seller.submitted_at.asc().nullslast() if status == "submitted" else Seller.created_at.desc()).offset(off).limit(lim))).scalars())
    counts = dict((await session.execute(select(Seller.status, func.count()).group_by(Seller.status))).all())
    return {
        "items": [
            {
                "id": str(s.id),
                "display_name": s.display_name,
                "legal_name": s.legal_name,
                "gstin": s.gstin,
                "status": s.status,
                "city": s.pickup_city,
                "state": STATES.get(s.pickup_state_code, ""),
                "submitted_at": s.submitted_at.isoformat() if s.submitted_at else None,
                "created_at": s.created_at.isoformat(),
            }
            for s in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "status_counts": counts,
    }


async def _seller(session, seller_id: uuid.UUID, *, lock: bool = False) -> Seller:
    stmt = select(Seller).where(Seller.id == seller_id)
    s = (await session.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if s is None:
        raise NotFound("Seller")
    return s


@router.get("/sellers/{seller_id}")
async def get_seller(seller_id: uuid.UUID, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller(session, seller_id)
    data = await seller_profile(session, s, reveal=True)
    owner = await session.get(User, s.user_id)
    data["owner"] = {"name": owner.name, "phone": owner.phone, "email": owner.email} if owner else None
    data["product_counts"] = dict((await session.execute(select(Product.status, func.count()).where(Product.seller_id == s.id).group_by(Product.status))).all())
    audit(session, admin, "seller.view_kyc", "seller", s.id)
    await session.commit()
    return data


@router.get("/sellers/{seller_id}/documents/{kind}")
async def seller_document(seller_id: uuid.UUID, kind: str, admin: Perm("sellers"), session: SessionDep) -> Response:
    audit(session, admin, "seller.view_document", "seller", seller_id, kind)
    await session.commit()
    return await document_response(session, seller_id, kind)


@router.post("/sellers/{seller_id}/approve")
async def approve_seller(seller_id: uuid.UUID, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller(session, seller_id, lock=True)
    if s.status not in ("submitted", "suspended"):
        raise Conflict(f"A {s.status} seller cannot be approved", "invalid_status")
    s.status = "approved"
    s.approved_at = s.approved_at or utcnow()
    s.rejection_reason = ""
    audit(session, admin, "seller.approve", "seller", s.id)
    await session.commit()
    return await seller_profile(session, s, reveal=True)


@router.post("/sellers/{seller_id}/reject")
async def reject_seller(seller_id: uuid.UUID, body: ReasonIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    """Sends the application back to the seller with the reason; they can fix and resubmit."""
    s = await _seller(session, seller_id, lock=True)
    if s.status not in ("submitted", "approved"):
        raise Conflict(f"A {s.status} seller cannot be sent back", "invalid_status")
    s.status = "rejected"
    s.rejection_reason = body.reason
    audit(session, admin, "seller.reject", "seller", s.id, body.reason)
    await session.commit()
    return await seller_profile(session, s, reveal=True)


@router.post("/sellers/{seller_id}/suspend")
async def suspend_seller(seller_id: uuid.UUID, body: ReasonIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller(session, seller_id, lock=True)
    if s.status != "approved":
        raise Conflict("Only approved sellers can be suspended", "invalid_status")
    s.status = "suspended"
    s.rejection_reason = body.reason
    audit(session, admin, "seller.suspend", "seller", s.id, body.reason)
    await session.commit()
    return await seller_profile(session, s, reveal=True)


@router.put("/sellers/{seller_id}/commission")
async def seller_commission(seller_id: uuid.UUID, body: CommissionIn, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await _seller(session, seller_id, lock=True)
    s.commission_bps_override = body.commission_bps_override
    audit(session, admin, "seller.commission", "seller", s.id, str(body.commission_bps_override))
    await session.commit()
    return await seller_profile(session, s, reveal=True)


# ----------------------------------------------------------------------------- products


@router.get("/products")
async def list_products(
    admin: Perm("catalog"),
    session: SessionDep,
    status: Literal["draft", "pending", "approved", "rejected", "archived"] | None = "pending",
    q: str = Query(default="", max_length=100),
    seller_id: uuid.UUID | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    stmt = select(Product, Seller.display_name).join(Seller, Seller.id == Product.seller_id)
    if status:
        stmt = stmt.where(Product.status == status)
    if seller_id:
        stmt = stmt.where(Product.seller_id == seller_id)
    if q.strip():
        stmt = stmt.where(Product.title.ilike(f"%{q.strip()}%"))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off, lim = _page(page, page_size)
    order = Product.submitted_at.asc().nullslast() if status == "pending" else Product.updated_at.desc()
    rows = (await session.execute(stmt.order_by(order).offset(off).limit(lim))).all()
    imgs = await images_for(session, [r.Product.id for r in rows])
    counts = dict((await session.execute(select(Product.status, func.count()).group_by(Product.status))).all())
    return {
        "items": [
            {
                "id": str(r.Product.id),
                "title": r.Product.title,
                "slug": r.Product.slug,
                "status": r.Product.status,
                "seller_name": r.display_name,
                "image": (imgs.get(r.Product.id) or [""])[0],
                "price_from": r.Product.price_from,
                "mrp_from": r.Product.mrp_from,
                "submitted_at": r.Product.submitted_at.isoformat() if r.Product.submitted_at else None,
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "status_counts": counts,
    }


async def _product(session, product_id: uuid.UUID, *, lock: bool = False) -> Product:
    stmt = select(Product).where(Product.id == product_id)
    p = (await session.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    return p


@router.get("/products/{product_id}")
async def get_product(product_id: uuid.UUID, admin: Perm("catalog"), session: SessionDep) -> dict:
    p = await _product(session, product_id)
    data = await product_detail(session, p)
    s = await session.get(Seller, p.seller_id)
    data["seller"] = {"id": str(s.id), "name": s.display_name, "status": s.status}
    return data


@router.post("/products/{product_id}/approve")
async def approve_product(product_id: uuid.UUID, admin: Perm("catalog"), session: SessionDep) -> dict:
    p = await _product(session, product_id, lock=True)
    if p.status != "pending":
        raise Conflict(f"A {p.status} product cannot be approved", "invalid_status")
    p.status = "approved"
    p.approved_at = utcnow()
    p.rejection_reason = ""
    audit(session, admin, "product.approve", "product", p.id)
    await session.commit()
    return await product_detail(session, p)


@router.post("/products/{product_id}/reject")
async def reject_product(product_id: uuid.UUID, body: ReasonIn, admin: Perm("catalog"), session: SessionDep) -> dict:
    """Rejects a pending listing, or takes down a live one, with a reason the seller sees."""
    p = await _product(session, product_id, lock=True)
    if p.status not in ("pending", "approved"):
        raise Conflict(f"A {p.status} product cannot be rejected", "invalid_status")
    p.status = "rejected"
    p.rejection_reason = body.reason
    audit(session, admin, "product.reject", "product", p.id, body.reason)
    await session.commit()
    return await product_detail(session, p)


# ----------------------------------------------------------------------------- categories


def _cat_out(c: Category) -> dict:
    return {
        "id": str(c.id),
        "name": c.name,
        "slug": c.slug,
        "parent_id": str(c.parent_id) if c.parent_id else None,
        "image_url": c.image_url,
        "commission_bps": c.commission_bps,
        "default_gst_bps": c.default_gst_bps,
        "position": c.position,
        "is_active": c.is_active,
    }


@router.get("/categories")
async def list_categories(admin: Perm("catalog"), session: SessionDep) -> list[dict]:
    cats = (await session.execute(select(Category).order_by(Category.position, Category.name))).scalars()
    return [_cat_out(c) for c in cats]


async def _validate_category(session, body: CategoryIn, current: Category | None) -> None:
    if body.default_gst_bps not in GST_RATES_BPS:
        raise ApiError("Choose a valid GST rate", "invalid_gst", fields={"default_gst_bps": "Invalid"})
    if body.parent_id:
        parent = await session.get(Category, body.parent_id)
        if parent is None:
            raise ApiError("Parent category not found", "invalid_parent")
        # Refuse cycles: walk up from the new parent.
        cur = parent
        while cur is not None:
            if current is not None and cur.id == current.id:
                raise ApiError("A category cannot be placed inside itself", "category_cycle")
            cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
        has_products = (await session.execute(select(exists().where(Product.category_id == parent.id)))).scalar()
        if has_products:
            raise ApiError("The parent category already has products; choose a category without products", "parent_has_products")


@router.post("/categories", status_code=201)
async def create_category(body: CategoryIn, admin: Perm("catalog"), session: SessionDep) -> dict:
    await _validate_category(session, body, None)
    slug = slugify(body.name, 80)
    if (await session.execute(select(Category.id).where(Category.slug == slug))).first():
        slug = f"{slug}-{uuid.uuid4().hex[:4]}"
    c = Category(slug=slug, **body.model_dump())
    session.add(c)
    await session.flush()
    audit(session, admin, "category.create", "category", c.id, body.name)
    await session.commit()
    return _cat_out(c)


@router.put("/categories/{category_id}")
async def update_category(category_id: uuid.UUID, body: CategoryIn, admin: Perm("catalog"), session: SessionDep) -> dict:
    c = await session.get(Category, category_id)
    if c is None:
        raise NotFound("Category")
    await _validate_category(session, body, c)
    for k, v in body.model_dump().items():
        setattr(c, k, v)
    audit(session, admin, "category.update", "category", c.id)
    await session.commit()
    return _cat_out(c)


# ----------------------------------------------------------------------------- orders & refunds


@router.get("/orders")
async def list_orders(
    admin: Perm("orders"),
    session: SessionDep,
    status: Literal["pending_payment", "placed", "cancelled"] | None = None,
    q: str = Query(default="", max_length=40),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    stmt = select(Order, User.name, User.phone).join(User, User.id == Order.user_id)
    if status:
        stmt = stmt.where(Order.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Order.number.ilike(like), User.phone.ilike(like)))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off, lim = _page(page, page_size)
    rows = (await session.execute(stmt.order_by(Order.created_at.desc()).offset(off).limit(lim))).all()
    return {
        "items": [
            {
                "id": str(r.Order.id),
                "number": r.Order.number,
                "customer": r.name or r.phone,
                "phone": r.phone,
                "status": r.Order.status,
                "payment_method": r.Order.payment_method,
                "payment_status": r.Order.payment_status,
                "grand_total": r.Order.grand_total,
                "created_at": r.Order.created_at.isoformat(),
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/orders/{order_id}")
async def get_order(order_id: uuid.UUID, admin: Perm("orders"), session: SessionDep) -> dict:
    o = await session.get(Order, order_id)
    if o is None:
        raise NotFound("Order")
    data = await order_detail(session, o, for_admin=True)
    u = await session.get(User, o.user_id)
    data["customer"] = {"id": str(u.id), "name": u.name, "phone": u.phone, "email": u.email}
    refunds = (await session.execute(select(Refund).where(Refund.order_id == o.id).order_by(Refund.created_at))).scalars()
    data["refunds"] = [
        {"id": str(r.id), "amount": r.amount_paise, "status": r.status, "reason": r.reason, "attempts": r.attempts, "last_error": r.last_error, "provider_refund_id": r.provider_refund_id}
        for r in refunds
    ]
    return data


async def _sub(session, sub_id: uuid.UUID) -> SubOrder:
    s = (await session.execute(select(SubOrder).where(SubOrder.id == sub_id).with_for_update())).scalar_one_or_none()
    if s is None:
        raise NotFound("Sub-order")
    return s


@router.post("/sub-orders/{sub_id}/cancel")
async def admin_cancel(sub_id: uuid.UUID, body: ReasonIn, admin: Perm("orders"), session: SessionDep, background: BackgroundTasks) -> dict:
    s = await _sub(session, sub_id)
    refund = await cancel_sub_order(session, s, actor="admin", reason=body.reason)
    audit(session, admin, "suborder.admin_cancel", "sub_order", s.id, body.reason)
    await session.flush()
    rid = refund.id if refund else None
    await session.commit()
    if rid:
        background.add_task(run_refunds, [rid])
    return await order_detail(session, await session.get(Order, s.order_id), for_admin=True)


@router.post("/sub-orders/{sub_id}/deliver")
async def admin_deliver(sub_id: uuid.UUID, admin: Perm("orders"), session: SessionDep) -> dict:
    s = await _sub(session, sub_id)
    await transition(session, s, "delivered", "admin", "Marked delivered by admin")
    audit(session, admin, "suborder.admin_deliver", "sub_order", s.id)
    await session.commit()
    return await order_detail(session, await session.get(Order, s.order_id), for_admin=True)


@router.get("/refunds")
async def list_refunds(
    admin: Perm("refunds"),
    session: SessionDep,
    status: Literal["pending", "processed", "failed"] | None = None,
    page: int = Query(default=1, ge=1),
) -> dict:
    stmt = select(Refund, Order.number).join(Order, Order.id == Refund.order_id)
    if status:
        stmt = stmt.where(Refund.status == status)
    rows = (await session.execute(stmt.order_by(Refund.created_at.desc()).offset((page - 1) * 50).limit(50))).all()
    return {
        "items": [
            {
                "id": str(r.Refund.id),
                "order_id": str(r.Refund.order_id),
                "order_number": r.number,
                "amount": r.Refund.amount_paise,
                "status": r.Refund.status,
                "reason": r.Refund.reason,
                "attempts": r.Refund.attempts,
                "last_error": r.Refund.last_error,
                "created_at": r.Refund.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@router.post("/refunds/{refund_id}/retry")
async def retry_refund(refund_id: uuid.UUID, admin: Perm("refunds"), session: SessionDep, background: BackgroundTasks) -> dict:
    r = (await session.execute(select(Refund).where(Refund.id == refund_id).with_for_update())).scalar_one_or_none()
    if r is None:
        raise NotFound("Refund")
    if r.status != "failed":
        raise Conflict("Only failed refunds can be retried", "invalid_status")
    r.status, r.attempts, r.provider_refund_id = "pending", 0, None
    audit(session, admin, "refund.retry", "refund", r.id)
    await session.commit()
    background.add_task(run_refunds, [r.id])
    return {"ok": True}


# ----------------------------------------------------------------------------- customers


@router.get("/customers")
async def list_customers(
    admin: Perm("customers"),
    session: SessionDep,
    q: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    stmt = select(User)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(User.name.ilike(like), User.phone.ilike(like), User.email.ilike(like)))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off, lim = _page(page, page_size)
    users = list((await session.execute(stmt.order_by(User.created_at.desc()).offset(off).limit(lim))).scalars())
    order_counts = dict(
        (await session.execute(select(Order.user_id, func.count()).where(Order.user_id.in_([u.id for u in users]), Order.status == "placed").group_by(Order.user_id))).all()
    ) if users else {}
    return {
        "items": [
            {
                "id": str(u.id),
                "name": u.name,
                "phone": u.phone,
                "email": u.email,
                "is_admin": u.is_admin,
                "is_active": u.is_active,
                "orders": order_counts.get(u.id, 0),
                "created_at": u.created_at.isoformat(),
            }
            for u in users
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/customers/{user_id}/block")
async def block_user(user_id: uuid.UUID, body: ReasonIn, admin: Perm("customers"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None:
        raise NotFound("User")
    if u.id == admin.id or u.is_admin:
        raise Conflict("Admins cannot be blocked here", "invalid_target")
    u.is_active = False
    await session.execute(update(RefreshSession).where(RefreshSession.user_id == u.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))
    audit(session, admin, "user.block", "user", u.id, body.reason)
    await session.commit()
    return {"ok": True}


@router.post("/customers/{user_id}/unblock")
async def unblock_user(user_id: uuid.UUID, admin: Perm("customers"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None:
        raise NotFound("User")
    u.is_active = True
    audit(session, admin, "user.unblock", "user", u.id)
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- settings / audit / reports


@router.get("/settings")
async def read_settings(admin: Perm("settings"), session: SessionDep) -> dict:
    return await get_settings(session)


@router.put("/settings")
async def write_settings(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    try:
        result = await update_settings(session, body)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "settings.update", "settings", "marketplace", str(body)[:1000])
    await session.commit()
    return result


@router.get("/audit")
async def audit_log(
    admin: Perm("audit"),
    session: SessionDep,
    entity_id: str | None = Query(default=None, max_length=64),
    page: int = Query(default=1, ge=1),
) -> dict:
    stmt = select(AuditLog, User.name, User.phone).outerjoin(User, User.id == AuditLog.actor_user_id)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    rows = (await session.execute(stmt.order_by(AuditLog.created_at.desc()).offset((page - 1) * 50).limit(50))).all()
    return {
        "items": [
            {
                "action": r.AuditLog.action,
                "entity_type": r.AuditLog.entity_type,
                "entity_id": r.AuditLog.entity_id,
                "detail": r.AuditLog.detail,
                "actor": r.name or r.phone or "system",
                "at": r.AuditLog.created_at.isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/reports/tcs")
async def tcs_report(admin: Perm("reports"), session: SessionDep, month: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")) -> dict:
    """Supplier-wise net taxable value and TCS for GSTR-8, for sub-orders placed in the month (IST)."""
    return await tcs_report_data(session, month)
