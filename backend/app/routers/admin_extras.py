"""Admin panel, part 2: staff and roles, KPIs, coupons, reviews, returns, payouts, support desk,
notification templates, storefront CMS, integrations and exports. Every endpoint checks one permission."""
from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update

from app.config import settings
from app.core.deps import CurrentUser, SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import OWNER, Perm, permissions_for, role_code, role_name
from app.core.validators import slugify
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import (
    CmsPage,
    Coupon,
    HomeSection,
    MediaAsset,
    Notification,
    NotificationTemplate,
    Order,
    Payout,
    Product,
    ReturnRequest,
    Review,
    Seller,
    SubOrder,
    SupportTicket,
    TicketMessage,
    User,
)
from app.routers.customer import refresh_ratings, ticket_out
from app.routers.orders import run_refunds
from app.routers.seller_extras import (
    SellerCouponIn,
    _check_coupon_values,
    coupon_admin_out,
)
from app.services import ledger, storage
from app.services import returns as returns_svc
from app.services.analytics import kpis
from app.services.cms import (
    DEFAULT_PAGES,
    SECTION_KINDS,
    ensure_default_sections,
    get_site,
    save_site,
    section_out,
    validate_section,
)
from app.services.notify import EVENTS, notify
from app.services.reports import IST

router = APIRouter(prefix="/api/admin", tags=["admin-extras"])


# ----------------------------------------------------------------------------- me


@router.get("/me")
async def admin_me(user: Perm("dashboard")) -> dict:
    code = role_code(user)
    return {"role": code, "role_label": role_name(code), "permissions": sorted(permissions_for(user)), "totp_enabled": user.totp_enabled,
            "name": user.name, "is_owner": code == OWNER}


# ----------------------------------------------------------------------------- KPIs


@router.get("/analytics")
async def analytics(admin: Perm("dashboard"), session: SessionDep, days: int = Query(default=30, ge=7, le=365)) -> dict:
    return await kpis(session, days)


# ----------------------------------------------------------------------------- coupons


class AdminCouponIn(SellerCouponIn):
    category_id: uuid.UUID | None = None
    first_order_only: bool = False
    show_on_checkout: bool = True


@router.get("/coupons")
async def coupons(admin: Perm("marketing"), session: SessionDep) -> list[dict]:
    return [coupon_admin_out(c) for c in (await session.execute(select(Coupon).order_by(Coupon.created_at.desc()))).scalars()]


@router.post("/coupons", status_code=201)
async def create_coupon(body: AdminCouponIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    _check_coupon_values(body.kind, body.value)
    if (await session.execute(select(Coupon.id).where(func.upper(Coupon.code) == body.code.upper()))).first():
        raise Conflict("This code is already used", "code_taken")
    c = Coupon(**body.model_dump(exclude={"code"}), code=body.code.upper(), funded_by="platform")
    session.add(c)
    audit(session, admin, "coupon.create", "coupon", c.code)
    await session.commit()
    return coupon_admin_out(c)


@router.put("/coupons/{coupon_id}")
async def update_coupon(coupon_id: uuid.UUID, body: AdminCouponIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = await session.get(Coupon, coupon_id)
    if c is None:
        raise NotFound("Coupon")
    _check_coupon_values(body.kind, body.value)
    for k, v in body.model_dump(exclude={"code"}).items():
        if c.funded_by == "seller" and k == "category_id":
            continue
        setattr(c, k, v)
    audit(session, admin, "coupon.update", "coupon", c.code)
    await session.commit()
    return coupon_admin_out(c)


# ----------------------------------------------------------------------------- reviews


@router.get("/reviews")
async def reviews(admin: Perm("catalog"), session: SessionDep, status: str | None = None, rating: int | None = None, page: int = Query(default=1, ge=1),
                  q: str = Query(default="", max_length=80)) -> dict:
    stmt = select(Review, Product.title, User.name).join(Product, Product.id == Review.product_id).join(User, User.id == Review.user_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Review.title.ilike(like), Review.body.ilike(like)))
    if status:
        stmt = stmt.where(Review.status == status)
    if rating:
        stmt = stmt.where(Review.rating == rating)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(Review.created_at.desc()).offset((page - 1) * 30).limit(30))).all()
    return {"items": [{"id": str(r.id), "product": t, "author": n, "rating": r.rating, "title": r.title, "body": r.body, "status": r.status, "at": r.created_at.isoformat()} for r, t, n in rows],
            "total": total, "page": page, "page_size": 30}


@router.post("/reviews/{review_id}/{action}")
async def moderate_review(review_id: uuid.UUID, action: Literal["publish", "hide"], admin: Perm("catalog"), session: SessionDep) -> dict:
    r = await session.get(Review, review_id)
    if r is None:
        raise NotFound("Review")
    r.status = "published" if action == "publish" else "hidden"
    await session.flush()
    await refresh_ratings(session, r.product_id)
    audit(session, admin, f"review.{action}", "review", r.id)
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- returns


@router.get("/returns")
async def admin_returns(admin: Perm("orders"), session: SessionDep, status: str | None = None, page: int = Query(default=1, ge=1),
                        q: str = Query(default="", max_length=60), seller_id: uuid.UUID | None = None) -> dict:
    stmt = select(ReturnRequest)
    if status:
        stmt = stmt.where(ReturnRequest.status == status)
    if seller_id:
        stmt = stmt.where(ReturnRequest.seller_id == seller_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(ReturnRequest.number.ilike(like),
                              ReturnRequest.sub_order_id.in_(select(SubOrder.id).where(SubOrder.number.ilike(like))),
                              ReturnRequest.user_id.in_(select(User.id).where(or_(User.phone.ilike(like), User.name.ilike(like))))))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await session.execute(stmt.order_by(ReturnRequest.created_at.desc()).offset((page - 1) * 30).limit(30))).scalars())
    counts = dict((await session.execute(select(ReturnRequest.status, func.count()).group_by(ReturnRequest.status))).all())
    return {"items": [await returns_svc.return_out(session, r, with_upi=True) for r in rows], "status_counts": counts,
            "total": total, "page": page, "page_size": 30}


class AdminReturnAction(BaseModel):
    action: Literal["approve", "reject", "received", "mark_refunded"]
    note: str = Field(default="", max_length=2000)
    reference: str = Field(default="", max_length=60)


@router.post("/returns/{return_id}")
async def admin_return_action(return_id: uuid.UUID, body: AdminReturnAction, admin: Perm("refunds"), session: SessionDep, background: BackgroundTasks) -> dict:
    ret = (await session.execute(select(ReturnRequest).where(ReturnRequest.id == return_id).with_for_update())).scalar_one_or_none()
    if ret is None:
        raise NotFound("Return")
    if body.action == "mark_refunded":
        if not body.reference.strip():
            raise ApiError("Enter the UPI/bank reference of the refund you paid", "reference_required")
        refund_ids = await returns_svc.set_status(session, ret, "refunded", note=f"Refund reference {body.reference.strip()}")
    else:
        dst = {"approve": "approved", "reject": "rejected", "received": "received"}[body.action]
        refund_ids = await returns_svc.set_status(session, ret, dst, note=body.note)
    audit(session, admin, f"return.admin_{body.action}", "return", ret.id, body.note or body.reference)
    await session.commit()
    if refund_ids:
        background.add_task(run_refunds, refund_ids)
    return await returns_svc.return_out(session, ret, with_upi=True)


# ----------------------------------------------------------------------------- payouts


@router.get("/payouts")
async def payouts(admin: Perm("payouts"), session: SessionDep, status: str | None = None, page: int = Query(default=1, ge=1),
                  seller_id: uuid.UUID | None = None) -> dict:
    stmt = select(Payout, Seller.display_name).join(Seller, Seller.id == Payout.seller_id)
    if status:
        stmt = stmt.where(Payout.status == status)
    if seller_id:
        stmt = stmt.where(Payout.seller_id == seller_id)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(Payout.created_at.desc()).offset((page - 1) * 50).limit(50))).all()
    from app.models import LedgerEntry

    now = utcnow()
    due = (
        await session.execute(
            select(Seller.display_name, func.sum(LedgerEntry.amount)).join(Seller, Seller.id == LedgerEntry.seller_id)
            .where(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now).group_by(Seller.display_name).having(func.sum(LedgerEntry.amount) > 0)
        )
    ).all()
    ic = await get_integrations(session)
    return {
        "total": total, "page": page, "page_size": 50,
        "mode": ic.payout_mode,
        "razorpayx_ready": bool(ic.razorpay_enabled and ic.razorpayx_account_number),
        "due": [{"seller": n, "amount": int(a)} for n, a in due],
        "items": [ledger.payout_out(p, n) for p, n in rows],
    }


@router.post("/payouts/run")
async def run_payouts(admin: Perm("payouts"), session: SessionDep) -> dict:
    from app.services.platform_settings import get_settings

    cfg = await get_settings(session)
    created = await ledger.create_payouts(session, min_amount=cfg["payout_min_paise"])
    audit(session, admin, "payout.run", "payout", "batch", f"{len(created)} payouts")
    await session.commit()
    return {"created": len(created), "items": [ledger.payout_out(p) for p in created]}


@router.get("/payouts/bank-file.csv")
async def bank_file(admin: Perm("payouts"), session: SessionDep) -> Response:
    rows = (await session.execute(select(Payout, Seller).join(Seller, Seller.id == Payout.seller_id).where(Payout.status == "pending", Payout.mode == "manual"))).all()
    audit(session, admin, "payout.bank_file", "payout", "batch", f"{len(rows)} rows")
    await session.commit()
    brand = (await get_site(session))["brand_name"]
    name = f"{re.sub(r'[^a-z0-9]+', '-', brand.lower()).strip('-') or 'payouts'}-bank-transfer-{utcnow().astimezone(IST).date().isoformat()}.csv"
    return Response(ledger.bank_csv(list(rows), brand), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


class PaidIn(BaseModel):
    utr: str = Field(min_length=6, max_length=40, pattern=r"^[A-Za-z0-9]+$")


@router.post("/payouts/{payout_id}/paid")
async def payout_paid(payout_id: uuid.UUID, body: PaidIn, admin: Perm("payouts"), session: SessionDep) -> dict:
    p = (await session.execute(select(Payout).where(Payout.id == payout_id).with_for_update())).scalar_one_or_none()
    if p is None:
        raise NotFound("Payout")
    await ledger.mark_paid(session, p, body.utr)
    audit(session, admin, "payout.paid", "payout", p.id, body.utr)
    await session.commit()
    return ledger.payout_out(p)


@router.post("/payouts/{payout_id}/send")
async def payout_send(payout_id: uuid.UUID, admin: Perm("payouts"), session: SessionDep) -> dict:
    p = (await session.execute(select(Payout).where(Payout.id == payout_id).with_for_update())).scalar_one_or_none()
    if p is None:
        raise NotFound("Payout")
    if p.status not in ("pending",):
        raise Conflict(f"A {p.status} payout cannot be sent", "invalid_status")
    await ledger.execute_razorpayx(session, p)
    audit(session, admin, "payout.send", "payout", p.id)
    await session.commit()
    return ledger.payout_out(p)


@router.post("/payouts/{payout_id}/cancel")
async def payout_cancel(payout_id: uuid.UUID, admin: Perm("payouts"), session: SessionDep) -> dict:
    p = (await session.execute(select(Payout).where(Payout.id == payout_id).with_for_update())).scalar_one_or_none()
    if p is None or p.status != "pending":
        raise Conflict("Only pending payouts can be cancelled", "invalid_status")
    await ledger.fail_payout(session, p, "Cancelled by admin")
    p.status = "cancelled"
    audit(session, admin, "payout.cancel", "payout", p.id)
    await session.commit()
    return ledger.payout_out(p)


# ----------------------------------------------------------------------------- support desk


@router.get("/tickets")
async def tickets(admin: Perm("support"), session: SessionDep, status: str | None = "open", overdue: bool = False, grievance: bool = False,
                  page: int = Query(default=1, ge=1), q: str = Query(default="", max_length=60)) -> dict:
    stmt = select(SupportTicket, User.name, User.phone).join(User, User.id == SupportTicket.user_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(SupportTicket.number.ilike(like), SupportTicket.subject.ilike(like), User.phone.ilike(like), User.name.ilike(like)))
    if status:
        stmt = stmt.where(SupportTicket.status == status)
    if overdue:
        stmt = stmt.where(SupportTicket.acknowledged_at.is_(None), SupportTicket.ack_due_at < func.now())
    if grievance:
        stmt = stmt.where(SupportTicket.is_grievance.is_(True))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(SupportTicket.ack_due_at).offset((page - 1) * 30).limit(30))).all()
    counts = dict((await session.execute(select(SupportTicket.status, func.count()).group_by(SupportTicket.status))).all())
    return {"items": [ticket_out(t, staff=True) | {"customer": n or ph} for t, n, ph in rows], "status_counts": counts,
            "total": total, "page": page, "page_size": 30}


@router.get("/tickets/{ticket_id}")
async def ticket(ticket_id: uuid.UUID, admin: Perm("support"), session: SessionDep) -> dict:
    t = await session.get(SupportTicket, ticket_id)
    if t is None:
        raise NotFound("Ticket")
    msgs = list((await session.execute(select(TicketMessage).where(TicketMessage.ticket_id == t.id).order_by(TicketMessage.created_at))).scalars())
    u = await session.get(User, t.user_id)
    o = await session.get(Order, t.order_id) if t.order_id else None
    return ticket_out(t, msgs, staff=True) | {"customer": {"name": u.name, "phone": u.phone, "email": u.email}, "order_number": o.number if o else None}


class StaffReply(BaseModel):
    body: str = Field(min_length=1, max_length=5000)
    internal: bool = False
    status: Literal["open", "awaiting_customer", "resolved", "closed"] | None = None
    priority: Literal["low", "normal", "high", "urgent"] | None = None
    ai_run_id: str | None = Field(default=None, max_length=40)  # the AI draft this reply started from


@router.post("/tickets/{ticket_id}/reply")
async def staff_reply(ticket_id: uuid.UUID, body: StaffReply, admin: Perm("support"), session: SessionDep) -> dict:
    t = (await session.execute(select(SupportTicket).where(SupportTicket.id == ticket_id).with_for_update())).scalar_one_or_none()
    if t is None:
        raise NotFound("Ticket")
    now = utcnow()
    session.add(TicketMessage(ticket_id=t.id, author_id=admin.id, author_role="staff", body=body.body.strip(), is_internal=body.internal, created_at=now))
    if not body.internal:
        t.acknowledged_at = t.acknowledged_at or now
        t.status = body.status or "awaiting_customer"
        await notify(session, "ticket_reply", await session.get(User, t.user_id), {"ticket_number": t.number, "subject": t.subject}, link=f"/support/{t.id}")
    elif body.status:
        t.status = body.status
    if body.priority:
        t.priority = body.priority
    if t.status in ("resolved", "closed"):
        t.resolved_at = t.resolved_at or now
    t.assigned_to = t.assigned_to or admin.id
    t.updated_at = now
    if body.ai_run_id and not body.internal:
        from app.ai import service as ai_service

        await ai_service.finish(session, body.ai_run_id, "sent", admin, final_text=body.body.strip())
    await session.commit()
    return await ticket(ticket_id, admin, session)


# ----------------------------------------------------------------------------- notification templates


class TemplateIn(BaseModel):
    subject: str = Field(default="", max_length=200)
    body: str = Field(max_length=5000)
    provider_template: str = Field(default="", max_length=80)
    is_active: bool = True


@router.get("/notifications/templates")
async def templates(admin: Perm("marketing"), session: SessionDep) -> dict:
    saved = {(t.event, t.channel): t for t in (await session.execute(select(NotificationTemplate))).scalars()}
    items = []
    for event, chans in EVENTS.items():
        for channel in ("inapp", "email", "sms", "whatsapp"):
            t = saved.get((event, channel))
            default = chans.get(channel)
            if t is None and default is None and channel != "whatsapp":
                continue
            items.append({
                "event": event, "channel": channel, "customised": t is not None,
                "subject": t.subject if t else (default[0] if default else ""), "body": t.body if t else (default[1] if default else ""),
                "provider_template": t.provider_template if t else "", "is_active": t.is_active if t else default is not None,
            })
    stats = dict((await session.execute(select(Notification.status, func.count()).where(Notification.channel != "inapp").group_by(Notification.status))).all())
    ic = await get_integrations(session)
    return {"items": items, "delivery": stats, "channels": {
        "email": bool(ic.smtp_host), "sms": ic.sms_provider == "msg91" and bool(ic.msg91_auth_key), "whatsapp": bool(ic.whatsapp_token)}}


@router.put("/notifications/templates/{event}/{channel}")
async def save_template(event: str, channel: Literal["inapp", "email", "sms", "whatsapp"], body: TemplateIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    if event not in EVENTS:
        raise NotFound("Event")
    t = (await session.execute(select(NotificationTemplate).where(NotificationTemplate.event == event, NotificationTemplate.channel == channel))).scalar_one_or_none()
    if t is None:
        t = NotificationTemplate(event=event, channel=channel)
        session.add(t)
    t.subject, t.body, t.provider_template, t.is_active = body.subject, body.body, body.provider_template.strip(), body.is_active
    audit(session, admin, "template.save", "template", f"{event}:{channel}")
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- storefront CMS


@router.get("/storefront/site")
async def cms_site(admin: Perm("marketing"), session: SessionDep) -> dict:
    return await get_site(session)


@router.put("/storefront/site")
async def cms_site_save(body: dict[str, Any], admin: Perm("marketing"), session: SessionDep) -> dict:
    try:
        site = await save_site(session, body)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_site") from exc
    audit(session, admin, "storefront.site", "settings", "site")
    await session.commit()
    return site


class SectionIn(BaseModel):
    kind: str
    title: str = Field(default="", max_length=120)
    config: dict[str, Any] = Field(default_factory=dict)
    is_active: bool = True
    device: Literal["all", "mobile", "desktop"] = "all"
    starts_at: datetime | None = None
    ends_at: datetime | None = None


@router.get("/storefront/sections")
async def cms_sections(admin: Perm("marketing"), session: SessionDep) -> dict:
    await ensure_default_sections(session)
    await session.commit()
    rows = (await session.execute(select(HomeSection).order_by(HomeSection.position, HomeSection.created_at))).scalars()
    return {"kinds": SECTION_KINDS, "items": [section_out(s) for s in rows]}


@router.post("/storefront/sections", status_code=201)
async def cms_section_add(body: SectionIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    try:
        cfg = validate_section(body.kind, body.config)
    except (ValueError, TypeError) as exc:
        raise ApiError(str(exc), "invalid_section") from exc
    top = (await session.execute(select(func.coalesce(func.max(HomeSection.position), 0)))).scalar_one()
    s = HomeSection(kind=body.kind, title=body.title, config=cfg, is_active=body.is_active, device=body.device, starts_at=body.starts_at, ends_at=body.ends_at, position=top + 10)
    session.add(s)
    audit(session, admin, "storefront.section_add", "section", body.kind)
    await session.commit()
    return section_out(s)


@router.put("/storefront/sections/{section_id}")
async def cms_section_save(section_id: uuid.UUID, body: SectionIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    s = await session.get(HomeSection, section_id)
    if s is None:
        raise NotFound("Section")
    try:
        cfg = validate_section(s.kind, body.config)
    except (ValueError, TypeError) as exc:
        raise ApiError(str(exc), "invalid_section") from exc
    s.title, s.config, s.is_active, s.device, s.starts_at, s.ends_at = body.title, cfg, body.is_active, body.device, body.starts_at, body.ends_at
    await session.commit()
    return section_out(s)


@router.delete("/storefront/sections/{section_id}")
async def cms_section_delete(section_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    s = await session.get(HomeSection, section_id)
    if s:
        await session.delete(s)
        audit(session, admin, "storefront.section_delete", "section", section_id)
        await session.commit()
    return {"ok": True}


class OrderIn(BaseModel):
    ids: list[uuid.UUID]


@router.put("/storefront/sections-order")
async def cms_reorder(body: OrderIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    for i, sid in enumerate(body.ids):
        await session.execute(update(HomeSection).where(HomeSection.id == sid).values(position=(i + 1) * 10))
    await session.commit()
    return {"ok": True}


class PageIn(BaseModel):
    slug: str = Field(min_length=2, max_length=80, pattern=r"^[a-z0-9\-]+$")
    title: str = Field(min_length=2, max_length=160)
    body: str = Field(max_length=100_000)
    meta_description: str = Field(default="", max_length=300)
    is_published: bool = True


@router.get("/storefront/pages")
async def cms_pages(admin: Perm("marketing"), session: SessionDep) -> list[dict]:
    rows = {p.slug: p for p in (await session.execute(select(CmsPage).order_by(CmsPage.title))).scalars()}
    out = [{"slug": p.slug, "title": p.title, "body": p.body, "meta_description": p.meta_description, "is_published": p.is_published, "saved": True, "updated_at": p.updated_at.isoformat()} for p in rows.values()]
    out += [{"slug": k, "title": t, "body": b, "meta_description": "", "is_published": True, "saved": False, "updated_at": None} for k, (t, b) in DEFAULT_PAGES.items() if k not in rows]
    return sorted(out, key=lambda x: x["title"])


@router.put("/storefront/pages/{slug}")
async def cms_page_save(slug: str, body: PageIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    p = (await session.execute(select(CmsPage).where(CmsPage.slug == slug))).scalar_one_or_none()
    if p is None:
        p = CmsPage(slug=body.slug)
        session.add(p)
    elif body.slug != slug and (await session.execute(select(CmsPage.id).where(CmsPage.slug == body.slug))).first():
        raise Conflict("Another page uses this address", "slug_taken")
    p.slug, p.title, p.body, p.meta_description, p.is_published = body.slug, body.title, body.body, body.meta_description, body.is_published
    audit(session, admin, "storefront.page", "page", body.slug)
    await session.commit()
    return {"ok": True, "slug": p.slug}


@router.delete("/storefront/pages/{slug}")
async def cms_page_delete(slug: str, admin: Perm("marketing"), session: SessionDep) -> dict:
    p = (await session.execute(select(CmsPage).where(CmsPage.slug == slug))).scalar_one_or_none()
    if p:
        await session.delete(p)
        await session.commit()
    return {"ok": True}


@router.get("/media")
async def media(admin: Perm("marketing"), session: SessionDep) -> list[dict]:
    rows = (await session.execute(select(MediaAsset).order_by(MediaAsset.created_at.desc()).limit(200))).scalars()
    return [{"id": str(m.id), "url": m.url, "label": m.label, "at": m.created_at.isoformat()} for m in rows]


@router.post("/media", status_code=201)
async def upload_media(admin: Perm("marketing"), session: SessionDep, file: UploadFile = File(...), label: str = "") -> dict:
    data = await file.read(settings.max_image_bytes + 1)
    url = await storage.save_image(data, "products")  # same validated pipeline as product photos
    m = MediaAsset(url=url, label=(label or file.filename or "")[:120], created_at=utcnow())
    session.add(m)
    await session.commit()
    return {"id": str(m.id), "url": url}


# ----------------------------------------------------------------------------- go-live readiness


@router.get("/setup-status")
async def setup_status(admin: Perm("dashboard"), session: SessionDep) -> dict:
    """What is still missing before going live: legal details the e-commerce rules require, pages, payments."""
    site = await get_site(session)
    ic = await get_integrations(session)
    b = site["business"]
    pages = {p.slug: p for p in (await session.execute(select(CmsPage))).scalars()}
    checks = [
        ("business_name", "Registered business name", bool(b["legal_name"]), "/admin/storefront?tab=business"),
        ("registered_address", "Registered address", bool(b["registered_address"]), "/admin/storefront?tab=business"),
        ("gstin", "Your GSTIN as an e-commerce operator", bool(b["gstin"]), "/admin/storefront?tab=business"),
        ("grievance", "Grievance officer name and email", bool(b["grievance"]["name"] and b["grievance"]["email"]), "/admin/storefront?tab=business"),
        ("contact", "Customer care email or phone", any(i["enabled"] and i["type"] in ("email", "phone") for i in site["contact"]["items"]), "/admin/storefront?tab=business"),
        ("terms", "Terms of use page", "terms" in pages and pages["terms"].is_published, "/admin/storefront?tab=pages"),
        ("privacy", "Privacy notice page", "privacy" in pages and pages["privacy"].is_published, "/admin/storefront?tab=pages"),
        ("returns", "Returns and refunds page", "returns-policy" in pages and pages["returns-policy"].is_published, "/admin/storefront?tab=pages"),
        ("payments", "Online payments (Razorpay)", bool(ic.online_payments and ic.razorpay_webhook_secret), "/admin/integrations#razorpay"),
        ("sms", "Login OTP by SMS (MSG91)", ic.sms_provider == "msg91" and bool(ic.msg91_auth_key), "/admin/integrations#msg91"),
        ("two_step", "Two-step sign-in on your admin account", bool(admin.totp_enabled), "/admin/account"),
    ]
    items = [{"key": k, "label": label, "done": done, "href": href} for k, label, done, href in checks]
    return {"done": sum(i["done"] for i in items), "total": len(items), "items": items}


# ----------------------------------------------------------------------------- integrations & AI


@router.get("/go-live")
async def go_live(admin: Perm("dashboard"), session: SessionDep) -> dict:
    """Everything between staging and launch, in order, with what is done. Mirrors docs/GO_LIVE.md."""
    from app.integrations import store as istore
    from app.llm import config as llm_config
    from app.services.platform_settings import get_settings

    site = await get_site(session)
    b = site["business"]
    ic = await get_integrations(session)
    st = {i["key"]: i for i in await istore.status(session)}
    cfg = await get_settings(session)
    pages = {p.slug: p for p in (await session.execute(select(CmsPage))).scalars()}
    placeholder = lambda slug: slug in pages and pages[slug].is_published and "placeholder" not in (pages[slug].body or "").lower()  # noqa: E731
    llm_ready = bool(await llm_config.targets(session, "assistant"))
    https = settings.public_web_url.startswith("https://")

    def item(key, label, done, detail="", href="", who="admin", required=True):
        return {"key": key, "label": label, "done": bool(done), "detail": detail, "href": href, "who": who, "required": required}

    sections = [
        {"title": "1. Servers and domain (Terraform, one time)", "items": [
            item("aws", "AWS account, Route 53 domain, Terraform state bucket", https, settings.public_web_url, who="terraform"),
            item("https", "Site served over HTTPS on your domain", https, "", who="terraform"),
            item("storage", "Images and KYC files on S3", settings.storage_backend == "s3", settings.storage_backend, who="terraform"),
            item("secrets", "JWT, encryption key and database password generated", settings.environment != "production" or not settings.jwt_secret.startswith("dev-only"), "AWS Secrets Manager", who="terraform"),
        ]},
        {"title": "2. Payments", "items": [
            item("razorpay", "Razorpay keys and webhook", st["razorpay"]["ready"] and ic.razorpay_webhook_secret, f"{st['razorpay']['mode'] or 'not set'} keys", "/admin/integrations#razorpay"),
            item("razorpay_live", "Live Razorpay keys (not test)", st["razorpay"]["mode"] == "live", "Switch after KYC is approved", "/admin/integrations#razorpay"),
            item("razorpayx", "RazorpayX automatic payouts", st["razorpayx"]["ready"], "Optional: bank file + UTR works without it", "/admin/integrations#razorpayx", required=False),
        ]},
        {"title": "3. Messages", "items": [
            item("msg91", "MSG91 SMS with DLT-approved OTP template", st["msg91"]["ready"], "Customers sign in with OTP", "/admin/integrations#msg91"),
            item("email", "Email through Amazon SES (verified domain)", st["email"]["ready"], ic.smtp_from or "", "/admin/integrations#email"),
            item("whatsapp", "WhatsApp Cloud API with approved templates", st["whatsapp"]["ready"], "", "/admin/integrations#whatsapp", required=False),
        ]},
        {"title": "4. Shipping, AI and monitoring", "items": [
            item("shiprocket", "Shiprocket API user and webhook", st["shiprocket"]["ready"], "Optional: sellers can enter AWB by hand", "/admin/integrations#shiprocket", required=False),
            item("ai", "AI model connected (Claude or another provider)", llm_ready, "Assistant and AI studio work in sandbox until then", "/admin/ai-providers", required=False),
            item("sentry", "Sentry error tracking", st["sentry"]["ready"], "", "/admin/integrations#sentry", required=False),
            item("analytics", "Google Analytics / Meta Pixel", site["analytics"]["google_analytics_id"] or site["analytics"]["meta_pixel_id"], "", "/admin/storefront?tab=brand", required=False),
        ]},
        {"title": "5. Business details (Consumer Protection (E-Commerce) Rules 2020)", "items": [
            item("legal_name", "Registered business name", b["legal_name"], b["legal_name"], "/admin/storefront?tab=business"),
            item("gstin", "E-commerce operator GSTIN", b["gstin"], b["gstin"], "/admin/storefront?tab=business"),
            item("address", "Registered address", b["registered_address"], "", "/admin/storefront?tab=business"),
            item("grievance", "Grievance officer name, email and phone", b["grievance"]["name"] and b["grievance"]["email"] and b["grievance"].get("phone"), b["grievance"]["name"], "/admin/storefront?tab=business"),
        ]},
        {"title": "6. Policies (your lawyer)", "items": [
            item("terms", "Terms of use reviewed and published", placeholder("terms"), "", "/admin/storefront?tab=pages", who="lawyer"),
            item("privacy", "Privacy notice (DPDP Act 2023) reviewed and published", placeholder("privacy"), "", "/admin/storefront?tab=pages", who="lawyer"),
            item("returns_policy", "Returns and refunds policy reviewed and published", placeholder("returns-policy"), "", "/admin/storefront?tab=pages", who="lawyer"),
        ]},
        {"title": "7. Tax rates (your CA)", "items": [
            item("tax", "TCS, TDS and GST on commission confirmed", True, f"TCS {cfg['tcs_bps'] / 100:g}% · TDS {cfg['tds_bps'] / 100:g}% · GST on commission {cfg['commission_gst_bps'] / 100:g}% — confirm, then change in Settings if needed",
                 "/admin/settings", who="ca"),
        ]},
        {"title": "8. Your own account", "items": [
            item("two_step", "Two-step sign-in on your admin account", admin.totp_enabled, "", "/admin/account"),
            item("staff", "Staff added with the right roles", True, "Owner, operations, finance, support…", "/admin/staff", required=False),
        ]},
    ]
    flat = [i for sec in sections for i in sec["items"]]
    req = [i for i in flat if i["required"]]
    return {"environment": settings.environment, "done": sum(i["done"] for i in req), "total": len(req), "ready": all(i["done"] for i in req), "sections": sections}


@router.post("/products/{product_id}/ai-check")
async def ai_check(product_id: uuid.UUID, admin: Perm("catalog"), session: SessionDep) -> dict:
    from app.ai import service as ai_service

    r, out = await ai_service.run(session, "listing_check", actor=admin, inputs={}, subject_id=str(product_id))
    await session.commit()
    return out | {"run_id": str(r.id), "mode": r.mode}


_ = (secrets, slugify, CurrentUser)
