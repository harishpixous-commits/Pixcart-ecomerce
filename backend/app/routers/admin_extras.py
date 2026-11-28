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
from app.core.deps import AdminUser, CurrentUser, SessionDep, audit
from app.core.errors import ApiError, Conflict, Forbidden, NotFound
from app.core.permissions import OWNER, Perm, load_roles, permissions_for, role_code, role_name, two_step_missing
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
    ProductReport,
    ReturnRequest,
    Review,
    ReviewReport,
    Seller,
    SubOrder,
    SupportTicket,
    TicketMessage,
    User,
)
from app.routers.customer import ReturnIn, refresh_ratings, ticket_out
from app.routers.orders import run_refunds
from app.routers.seller_extras import (
    SellerCouponIn,
    _check_coupon_values,
    coupon_admin_out,
)
from app.services import ledger, review_settings, storage
from app.services import returns as returns_svc
from app.services.analytics import kpis
from app.services.cms import (
    DEFAULT_PAGES,
    SECTION_KINDS,
    ensure_default_sections,
    get_site,
    is_video_url,
    save_site,
    section_out,
    validate_section,
)
from app.services.notify import EVENTS, notify
from app.services.platform_settings import PRODUCT_REPORT_REASONS, get_settings
from app.services.reports import IST

router = APIRouter(prefix="/api/admin", tags=["admin-extras"])


# ----------------------------------------------------------------------------- me


@router.get("/me")
async def admin_me(user: AdminUser, session: SessionDep) -> dict:
    """Who is signed in to the admin panel. Answers even when two-step sign-in is still missing, so the panel can send
    the person to set it up instead of failing on every page."""
    await load_roles(session)
    if "dashboard" not in permissions_for(user):
        raise Forbidden("Your role does not allow this (dashboard)")
    code = role_code(user)
    return {"role": code, "role_label": role_name(code), "permissions": sorted(permissions_for(user)), "totp_enabled": user.totp_enabled,
            "name": user.name, "is_owner": code == OWNER, "two_step_required": await two_step_missing(session, user)}


# ----------------------------------------------------------------------------- KPIs


@router.get("/analytics")
async def analytics(admin: Perm("dashboard"), session: SessionDep, days: int = Query(default=30, ge=7, le=365)) -> dict:
    return await kpis(session, days)


# ----------------------------------------------------------------------------- coupons


class AdminCouponIn(SellerCouponIn):
    kind: Literal["percent", "flat", "bxgy", "bundle", "volume"]  # "volume" = buy_qty or more units of the chosen products (or the whole cart): value percent off all of them; "bundle" = every product in product_slugs (2 to 10) in the cart: value percent off one of each, per complete set; "bxgy" = buy X get Y: buy_qty, get_qty, value = percent off those get_qty units (100 = free)
    buy_qty: int = Field(default=0, ge=0, le=20)
    get_qty: int = Field(default=0, ge=0, le=20)
    product_slugs: list[str] = Field(default_factory=list, max_length=30)  # only these products count; empty = the whole cart
    category_id: uuid.UUID | None = None
    first_order_only: bool = False
    show_on_checkout: bool = True
    is_automatic: bool = False


def _check_bxgy(body: AdminCouponIn) -> None:
    if body.kind == "bxgy" and (body.buy_qty < 1 or body.get_qty < 1):
        raise ApiError("A buy X get Y offer needs at least 1 item to buy and 1 to get", "invalid_value")
    if body.kind == "bundle" and not 2 <= len(dict.fromkeys(s.strip().lower() for s in body.product_slugs if s.strip())) <= 10:
        raise ApiError("A bundle needs between 2 and 10 products", "invalid_value")
    if body.kind == "volume" and body.buy_qty < 2:
        raise ApiError("A volume offer needs a minimum of at least 2 items", "invalid_value")
    if body.kind != "volume" and body.kind != "bxgy":
        body.buy_qty = 0
    if body.kind != "bxgy":
        body.get_qty = 0


async def _product_ids(session, slugs: list[str]) -> list[str]:
    """Product slugs typed by staff to product ids; an unknown slug is an error, not silently ignored."""
    clean = list(dict.fromkeys(s.strip().lower().rsplit("/", 1)[-1] for s in slugs if s.strip()))
    if not clean:
        return []
    rows = dict((await session.execute(select(Product.slug, Product.id).where(func.lower(Product.slug).in_(clean)))).all())
    rows = {k.lower(): v for k, v in rows.items()}
    missing = [s for s in clean if s not in rows]
    if missing:
        raise ApiError(f"No product with the link name: {', '.join(missing)}", "product_not_found")
    return [str(rows[s]) for s in clean]


async def _coupon_outs(session, items: list[Coupon]) -> list[dict]:
    ids = {uuid.UUID(i) for c in items for i in (c.product_ids or [])}
    slugs = {str(i): s for i, s in (await session.execute(select(Product.id, Product.slug).where(Product.id.in_(ids)))).all()} if ids else {}
    out = []
    for c in items:
        o = coupon_admin_out(c)
        o["product_slugs"] = [slugs[i] for i in (c.product_ids or []) if i in slugs]
        out.append(o)
    return out


@router.get("/coupons")
async def coupons(admin: Perm("marketing"), session: SessionDep) -> list[dict]:
    return await _coupon_outs(session, list((await session.execute(select(Coupon).order_by(Coupon.created_at.desc()))).scalars()))


@router.post("/coupons", status_code=201)
async def create_coupon(body: AdminCouponIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    _check_coupon_values(body.kind, body.value)
    _check_bxgy(body)
    if (await session.execute(select(Coupon.id).where(func.upper(Coupon.code) == body.code.upper()))).first():
        raise Conflict("This code is already used", "code_taken")
    c = Coupon(**body.model_dump(exclude={"code", "product_slugs"}), product_ids=await _product_ids(session, body.product_slugs), code=body.code.upper(), funded_by="platform")
    session.add(c)
    audit(session, admin, "coupon.create", "coupon", c.code)
    await session.commit()
    return (await _coupon_outs(session, [c]))[0]


class CouponBatchIn(BaseModel):
    count: int = Field(ge=1, le=200)
    prefix: str = Field(min_length=2, max_length=10, pattern="^[A-Za-z0-9]+$")
    single_use: bool = True


_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


@router.post("/coupons/{coupon_id}/generate", status_code=201)
async def generate_coupons(coupon_id: uuid.UUID, body: CouponBatchIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    """Make `count` copies of a platform coupon, each with its own random code (for a mailer, a giveaway or a partner).
    Single-use copies can be redeemed once in total and stay off the checkout list."""
    base = await session.get(Coupon, coupon_id)
    if base is None:
        raise NotFound("Coupon")
    if base.funded_by != "platform" or base.only_user_id is not None:
        raise ApiError("Only a platform coupon can be copied in bulk", "not_copyable")
    prefix = body.prefix.upper()
    codes: list[str] = []
    while len(codes) < body.count:
        want = {prefix + "".join(secrets.choice(_CODE_CHARS) for _ in range(6)) for _ in range(body.count - len(codes))}
        taken = set((await session.execute(select(Coupon.code).where(Coupon.code.in_(want)))).scalars())
        codes += sorted(want - taken - set(codes))
    for code in codes:
        session.add(Coupon(
            code=code, description=base.description, kind=base.kind, value=base.value, product_ids=list(base.product_ids or []), buy_qty=base.buy_qty, get_qty=base.get_qty, max_discount_paise=base.max_discount_paise,
            min_order_paise=base.min_order_paise, starts_at=base.starts_at, ends_at=base.ends_at,
            usage_limit=1 if body.single_use else base.usage_limit, per_user_limit=1, funded_by="platform", category_id=base.category_id,
            first_order_only=base.first_order_only, is_active=base.is_active, show_on_checkout=False,
        ))
    audit(session, admin, "coupon.generate", "coupon", f"{base.code} x{len(codes)}")
    await session.commit()
    return {"count": len(codes), "codes": codes}


@router.put("/coupons/{coupon_id}")
async def update_coupon(coupon_id: uuid.UUID, body: AdminCouponIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = await session.get(Coupon, coupon_id)
    if c is None:
        raise NotFound("Coupon")
    _check_coupon_values(body.kind, body.value)
    _check_bxgy(body)
    for k, v in body.model_dump(exclude={"code", "product_slugs"}).items():
        if c.funded_by == "seller" and k == "category_id":
            continue
        setattr(c, k, v)
    if c.funded_by != "seller":
        c.product_ids = await _product_ids(session, body.product_slugs)
    audit(session, admin, "coupon.update", "coupon", c.code)
    await session.commit()
    return (await _coupon_outs(session, [c]))[0]


# ----------------------------------------------------------------------------- reviews


@router.get("/reviews")
async def reviews(admin: Perm("catalog"), session: SessionDep, status: Literal["published", "pending", "hidden"] | None = None,
                  rating: int | None = None, page: int = Query(default=1, ge=1), q: str = Query(default="", max_length=80),
                  reported: bool = False, media: bool = False, media_pending: bool = False, seller_id: uuid.UUID | None = None) -> dict:
    stmt = select(Review, Product.title, Product.slug, User.name, User.phone).join(Product, Product.id == Review.product_id).join(User, User.id == Review.user_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Review.title.ilike(like), Review.body.ilike(like), User.name.ilike(like)))
    if status:
        stmt = stmt.where(Review.status == status)
    if rating:
        stmt = stmt.where(Review.rating == rating)
    if reported:
        stmt = stmt.where(Review.report_count > 0)
    if media:
        stmt = stmt.where(func.jsonb_array_length(Review.media) > 0)
    if media_pending:
        stmt = stmt.where(Review.media_status == "pending", func.jsonb_array_length(Review.media) > 0)
    if seller_id:
        stmt = stmt.where(Product.seller_id == seller_id)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(Review.report_count.desc(), Review.created_at.desc()).offset((page - 1) * 30).limit(30))).all()
    reports: dict = {}
    if rows:
        for rid, reason, note in (await session.execute(
            select(ReviewReport.review_id, ReviewReport.reason, ReviewReport.note)
            .where(ReviewReport.review_id.in_([r.id for r, *_ in rows]), ReviewReport.status == "open"))).all():
            reports.setdefault(rid, []).append({"reason": review_settings.REPORT_REASONS.get(reason, reason), "note": note})
    counts = dict((await session.execute(select(Review.status, func.count()).group_by(Review.status))).all())
    return {"items": [{"id": str(r.id), "product": t, "slug": slug, "author": n, "phone": ph, "rating": r.rating, "title": r.title, "body": r.body,
                       "status": r.status, "verified": r.verified, "media": r.media, "media_status": r.media_status, "seller_reply": r.seller_reply,
                       "helpful_count": r.helpful_count, "report_count": r.report_count, "reports": reports.get(r.id, []), "at": r.created_at.isoformat()}
                      for r, t, slug, n, ph in rows],
            "total": total, "page": page, "page_size": 30,
            "counts": {"published": counts.get("published", 0), "pending": counts.get("pending", 0), "hidden": counts.get("hidden", 0),
                       "reported": (await session.execute(select(func.count()).select_from(Review).where(Review.report_count > 0))).scalar_one(),
                       "media_pending": (await session.execute(select(func.count()).select_from(Review).where(
                           Review.media_status == "pending", func.jsonb_array_length(Review.media) > 0))).scalar_one()}}


async def _close_reports(session, review_id: uuid.UUID, outcome: str) -> None:
    await session.execute(update(ReviewReport).where(ReviewReport.review_id == review_id, ReviewReport.status == "open")
                          .values(status=outcome, resolved_at=utcnow()))


@router.post("/reviews/{review_id}/{action}")
async def moderate_review(review_id: uuid.UUID, action: Literal["publish", "hide", "publish-media", "hide-media", "dismiss-reports"],
                          admin: Perm("catalog"), session: SessionDep) -> dict:
    """publish / hide the review (publishing also closes its reports as dismissed, hiding as upheld);
    publish-media / hide-media for its photos and videos only; dismiss-reports keeps the review as it is."""
    r = await session.get(Review, review_id)
    if r is None:
        raise NotFound("Review")
    if action == "publish":
        r.status = "published"
        if r.report_count:
            await _close_reports(session, r.id, "dismissed")
            r.report_count = 0
    elif action == "hide":
        r.status = "hidden"
        if r.report_count:
            await _close_reports(session, r.id, "upheld")
            r.report_count = 0
    elif action == "publish-media":
        r.media_status = "published"
    elif action == "hide-media":
        r.media_status = "hidden"
    else:
        await _close_reports(session, r.id, "dismissed")
        r.report_count = 0
    await session.flush()
    await refresh_ratings(session, r.product_id)
    if action in ("publish", "hide"):
        from app.services import loyalty as loyalty_svc

        await (loyalty_svc.award_review(session, r) if action == "publish" else loyalty_svc.take_back_review(session, r))
    audit(session, admin, f"review.{action}", "review", r.id)
    await session.commit()
    return {"ok": True, "status": r.status, "media_status": r.media_status}


@router.get("/review-settings")
async def get_review_settings(admin: Perm("catalog"), session: SessionDep) -> dict:
    from app.services.platform_settings import get_settings

    cfg = await get_settings(session)
    return {**await review_settings.get(session), "feature_reviews": cfg["feature_reviews"], "reviews_need_approval": cfg["reviews_need_approval"],
            "report_reasons": review_settings.REPORT_REASONS, "default_topics": review_settings.DEFAULT_TOPICS,
            "default_guidelines": review_settings.DEFAULT_GUIDELINES}


@router.put("/review-settings")
async def put_review_settings(body: dict[str, Any], admin: Perm("catalog"), session: SessionDep) -> dict:
    from app.services.platform_settings import update_settings

    body = dict(body)
    market = {k: body.pop(k) for k in ("feature_reviews", "reviews_need_approval") if k in body}
    try:
        if market:
            await update_settings(session, market)
        await review_settings.update(session, body)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "settings.reviews", "settings", "reviews", ", ".join(sorted([*market, *body]))[:200])
    await session.commit()
    return await get_review_settings(admin, session)


# ----------------------------------------------------------------------------- product reports


@router.get("/product-reports")
async def product_reports(admin: Perm("catalog"), session: SessionDep, status: Literal["open", "resolved", "dismissed"] | None = "open",
                          reason: str | None = None, q: str = Query(default="", max_length=80), seller_id: uuid.UUID | None = None,
                          page: int = Query(default=1, ge=1)) -> dict:
    stmt = (select(ProductReport, Product.title, Product.slug, Product.status, Seller.display_name, User.name, User.phone)
            .join(Product, Product.id == ProductReport.product_id).join(Seller, Seller.id == ProductReport.seller_id)
            .outerjoin(User, User.id == ProductReport.user_id))
    if status:
        stmt = stmt.where(ProductReport.status == status)
    if reason:
        stmt = stmt.where(ProductReport.reason == reason)
    if seller_id:
        stmt = stmt.where(ProductReport.seller_id == seller_id)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Product.title.ilike(like), ProductReport.note.ilike(like), Seller.display_name.ilike(like)))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(ProductReport.created_at.desc()).offset((page - 1) * 30).limit(30))).all()
    per_product = dict((await session.execute(select(ProductReport.product_id, func.count()).where(ProductReport.status == "open")
                                              .group_by(ProductReport.product_id))).all())
    counts = dict((await session.execute(select(ProductReport.status, func.count()).group_by(ProductReport.status))).all())
    return {
        "items": [{"id": str(x.id), "product_id": str(x.product_id), "product": t, "slug": slug, "product_status": pstatus, "seller": sname,
                   "seller_id": str(x.seller_id), "customer": cname or "Deleted account", "phone": cphone or "", "reason": x.reason,
                   "reason_label": PRODUCT_REPORT_REASONS.get(x.reason, x.reason), "note": x.note, "url": x.url, "status": x.status,
                   "admin_note": x.admin_note, "seller_note": x.seller_note, "open_for_product": int(per_product.get(x.product_id, 0)),
                   "at": x.created_at.isoformat(), "resolved_at": x.resolved_at.isoformat() if x.resolved_at else None}
                  for x, t, slug, pstatus, sname, cname, cphone in rows],
        "total": total, "page": page, "page_size": 30, "reasons": PRODUCT_REPORT_REASONS,
        "counts": {k: counts.get(k, 0) for k in ("open", "resolved", "dismissed")},
    }


class ProductReportAction(BaseModel):
    status: Literal["resolved", "dismissed"]
    admin_note: str = Field(default="", max_length=2000)
    take_down: bool = False  # also take the listing off the store (the seller is told why)
    notify_seller: bool = True


@router.post("/product-reports/{report_id}")
async def resolve_product_report(report_id: uuid.UUID, body: ProductReportAction, admin: Perm("catalog"), session: SessionDep) -> dict:
    from app.services.notify import notify_seller

    x = await session.get(ProductReport, report_id)
    if x is None:
        raise NotFound("Report")
    p = await session.get(Product, x.product_id)
    x.status, x.admin_note, x.resolved_at, x.resolved_by = body.status, body.admin_note.strip(), utcnow(), admin.id
    reason = PRODUCT_REPORT_REASONS.get(x.reason, x.reason)
    if body.take_down and p.status == "approved":
        p.status = "rejected"
        p.rejection_reason = f"Taken down after a customer report ({reason.lower()}). {body.admin_note.strip()}".strip()
        await notify_seller(session, p.seller_id, "listing_update", {"status": "taken down", "title": p.title,
                            "message": f"Reason: {p.rejection_reason} Fix the listing and send it for review again."}, link=f"/seller/products/{p.id}")
        # other open reports about the same listing are settled by the take-down
        await session.execute(update(ProductReport).where(ProductReport.product_id == p.id, ProductReport.status == "open", ProductReport.id != x.id)
                              .values(status="resolved", resolved_at=utcnow(), resolved_by=admin.id, admin_note="Listing taken down"))
    elif body.status == "resolved" and body.notify_seller:
        await notify_seller(session, p.seller_id, "listing_update", {"status": "reported by a customer", "title": p.title,
                            "message": f"{reason}. {body.admin_note.strip() or 'Please check the listing.'}"}, link="/seller/product-reports")
    audit(session, admin, f"product_report.{body.status}", "product", p.id, f"{reason}{' + take down' if body.take_down else ''}")
    await session.commit()
    return {"ok": True, "product_status": p.status}


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
    return {"items": [await returns_svc.return_out(session, r, with_upi=True, viewer="admin") for r in rows], "status_counts": counts,
            "total": total, "page": page, "page_size": 30}


@router.get("/orders/{order_id}/returnable")
async def admin_returnable(order_id: uuid.UUID, admin: Perm("orders"), session: SessionDep) -> dict:
    """What can still be returned from each package of the order, by the same rules as the customer's own request."""
    o = await session.get(Order, order_id)
    if o is None:
        raise NotFound("Order")
    subs = (await session.execute(select(SubOrder).where(SubOrder.order_id == o.id))).scalars()
    return {"items": {str(s.id): await returns_svc.returnable_items(session, s) for s in subs}, "needs_upi": o.payment_method == "cod"}


@router.post("/returns", status_code=201)
async def admin_open_return(body: ReturnIn, admin: Perm("orders"), session: SessionDep) -> dict:
    """Staff open a return for the customer (for example when they call support), with the customer's own checks."""
    order = (await session.execute(select(Order).join(SubOrder, SubOrder.order_id == Order.id).where(SubOrder.id == body.sub_order_id))).scalar_one_or_none()
    if order is None:
        raise NotFound("Order")
    customer = await session.get(User, order.user_id)
    ret = await returns_svc.create(session, customer, body.sub_order_id, body.lines(), body.reason, body.comment, body.refund_upi.strip())
    audit(session, admin, "return.admin_open", "return", ret.id, f"{ret.number} on order {order.number}, reason {body.reason}")
    await session.commit()
    return await returns_svc.return_out(session, ret, with_upi=True, viewer="admin")


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
    return await returns_svc.return_out(session, ret, with_upi=True, viewer="admin")


# ----------------------------------------------------------------------------- payouts


@router.get("/payouts")
async def payouts(admin: Perm("payouts"), session: SessionDep, status: str | None = None, page: int = Query(default=1, ge=1),
                  seller_id: uuid.UUID | None = None) -> dict:
    stmt = select(Payout, Seller).join(Seller, Seller.id == Payout.seller_id)
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
        "items": [ledger.payout_out(p, s.display_name, seller=s) for p, s in rows],
    }


@router.post("/payouts/{payout_id}/use-current-bank")
async def payout_use_current_bank(payout_id: uuid.UUID, admin: Perm("payouts"), session: SessionDep) -> dict:
    """After checking with the seller that their new bank account is genuine, pay this payout to it."""
    p = (await session.execute(select(Payout).where(Payout.id == payout_id).with_for_update())).scalar_one_or_none()
    if p is None or p.status != "pending":
        raise Conflict("Only pending payouts can be changed", "invalid_status")
    seller = await session.get(Seller, p.seller_id)
    before = (p.bank_snapshot or {}).get("account_last4", "")
    p.bank_snapshot = ledger.bank_snapshot(seller)
    audit(session, admin, "payout.bank_confirmed", "payout", p.id, f"account …{before} → …{p.bank_snapshot['account_last4']}")
    await session.commit()
    return ledger.payout_out(p, seller.display_name, seller=seller)


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


@router.get("/tickets/satisfaction")
async def ticket_satisfaction(admin: Perm("support"), session: SessionDep) -> dict:
    """How customers rated the handling of their requests: count, average, spread and the latest comments."""
    from sqlalchemy import func
    rated = SupportTicket.csat_rating.is_not(None)
    total, avg = (await session.execute(select(func.count(), func.avg(SupportTicket.csat_rating)).where(rated))).one()
    spread = dict((await session.execute(select(SupportTicket.csat_rating, func.count()).where(rated).group_by(SupportTicket.csat_rating))).all())
    recent = (await session.execute(select(SupportTicket).where(rated).order_by(SupportTicket.csat_at.desc()).limit(10))).scalars().all()
    unrated = (await session.execute(select(func.count()).where(SupportTicket.status.in_(("resolved", "closed")), SupportTicket.csat_rating.is_(None)))).scalar_one()
    return {
        "rated": int(total), "unrated_closed": int(unrated), "average": round(float(avg), 2) if avg is not None else None,
        "spread": {str(i): int(spread.get(i, 0)) for i in range(1, 6)},
        "recent": [{"id": str(t.id), "number": t.number, "subject": t.subject, "rating": t.csat_rating, "comment": t.csat_comment, "at": t.csat_at.isoformat()} for t in recent],
    }


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


class ThemeIn(BaseModel):
    theme: str = Field(max_length=24)
    # {theme id: {"preset": str, "colors": {key: hex}}}; themes left out keep their saved settings
    settings: dict[str, Any] = Field(default_factory=dict)


@router.put("/storefront/theme")
async def cms_theme_save(body: ThemeIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    """Switches the storefront theme and saves theme presets and colours, leaving every other site setting as it is
    (so an unsaved edit in another Storefront tab is never overwritten)."""
    site = await get_site(session)
    site["theme"] = body.theme
    site["theme_settings"] = {**site.get("theme_settings", {}), **body.settings}
    try:
        saved = await save_site(session, site)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_theme") from exc
    audit(session, admin, "storefront.theme", "settings", "site", f"theme={saved['theme']}")
    await session.commit()
    return {"theme": saved["theme"], "theme_settings": saved["theme_settings"]}


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


def _media_out(m: MediaAsset) -> dict:
    # the kind comes from the file type in the address (videos are stored as .mp4 or .webm, images as .webp)
    return {"id": str(m.id), "url": m.url, "label": m.label, "at": m.created_at.isoformat(), "kind": "video" if is_video_url(m.url) else "image"}


@router.get("/media")
async def media(admin: Perm("marketing"), session: SessionDep, kind: Literal["image", "video"] | None = None) -> list[dict]:
    """The media library, newest first; `kind` lists only images or only videos."""
    stmt = select(MediaAsset)
    if kind:
        video = MediaAsset.url.regexp_match(r"\.(mp4|webm)([?#].*)?$", flags="i")
        stmt = stmt.where(video if kind == "video" else ~video)
    rows = (await session.execute(stmt.order_by(MediaAsset.created_at.desc()).limit(200))).scalars()
    return [_media_out(m) for m in rows]


@router.post("/media", status_code=201)
async def upload_media(admin: Perm("marketing"), session: SessionDep, file: UploadFile = File(...), label: str = "") -> dict:
    """Adds an image or a video, told apart by the file's content (never its name). Images take the product photo
    pipeline (checked, resized, saved as WebP); MP4 and WebM videos are stored as uploaded, up to the largest video
    size set for product videos (Admin → Product page)."""
    video_limit = (await get_settings(session))["max_video_mb"] * 1024 * 1024
    data = await file.read(max(settings.max_image_bytes, video_limit) + 1)  # never buffer more than the larger limit
    if storage.is_video(data):
        url = await storage.save_video(data, video_limit)
    else:
        url = await storage.save_image(data, "products")  # same validated pipeline as product photos
    m = MediaAsset(id=uuid.uuid4(), url=url, label=(label or file.filename or "")[:120], created_at=utcnow())
    session.add(m)
    out = _media_out(m)
    audit(session, admin, "storefront.media_upload", "media", m.id, out["kind"])
    await session.commit()
    return out


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
