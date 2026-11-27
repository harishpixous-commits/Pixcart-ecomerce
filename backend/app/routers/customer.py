"""Customer features beyond checkout: wishlist, reviews, returns, invoices, notifications, support,
delivery estimates, privacy (DPDP) and product events for analytics."""
from __future__ import annotations

import re
import time
import uuid
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, File, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select, update

from app.config import settings
from app.core.deps import CurrentUser, OptionalUser, SessionDep, audit, client_ip, rate_limit
from app.services.notify import notify_staff
from app.core.errors import ApiError, Conflict, NotFound
from app.core.validators import STATES, validate_pincode
from app.db import utcnow
from app.models import (
    Address,
    Notification,
    Order,
    OrderItem,
    Product,
    ProductReport,
    RefreshSession,
    ReturnRequest,
    Review,
    ReviewReport,
    ReviewVote,
    Seller,
    SubOrder,
    SupportTicket,
    TicketMessage,
    User,
    Variant,
    Warehouse,
    LoyaltyEntry,
    WishlistItem,
)
from app.routers.catalog import product_cards
from app.routers.orders import run_refunds
from app.services import product_page, referral, review_settings, storage
from app.services import returns as returns_svc
from app.services import support as support_svc
from app.services.catalog import public_product_filter
from app.services.coupons import list_for_checkout
from app.services.delivery import estimate, state_for_pin
from app.services.invoices import credit_note_pdf, invoice_pdf
from app.services.platform_settings import DEFECT_REASONS, PRODUCT_REPORT_REASONS, get_settings
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
        product = await session.get(Product, product_id)
        session.add(WishlistItem(user_id=user.id, product_id=product_id, created_at=utcnow(), price_at_add=product.price_from if product else None))
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
# Anyone can read reviews. Writing, voting "helpful" and reporting need a signed-in customer; by default
# only customers whose order was delivered can write (Admin → Reviews → Settings).

_CONTACT = re.compile(r"(https?://|www\.|\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d))", re.IGNORECASE)


def _media_ok(url: str, folder: str) -> bool:
    return url.startswith(f"{settings.media_base_url.rstrip('/')}/{folder}/") and ".." not in url and len(url) <= 400


class ReviewMediaIn(BaseModel):
    kind: Literal["image", "video"]
    url: str = Field(max_length=400)
    poster_url: str = Field(default="", max_length=400)

    @model_validator(mode="after")
    def _urls(self) -> ReviewMediaIn:
        if not _media_ok(self.url, "reviews" if self.kind == "image" else "review-videos"):
            raise ValueError("Upload photos and videos here; links to other sites are not allowed")
        if self.poster_url and not _media_ok(self.poster_url, "reviews"):
            raise ValueError("Upload photos and videos here; links to other sites are not allowed")
        return self


class ReviewIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=4000)
    media: list[ReviewMediaIn] = Field(default_factory=list, max_length=12)


class ReportIn(BaseModel):
    reason: str = Field(max_length=20)
    note: str = Field(default="", max_length=500)


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


async def _product_by_slug(session, slug: str) -> Product:
    p = (await session.execute(select(Product).where(Product.slug == slug))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    return p


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


async def _review_gate(session, p: Product, user, cfg: dict, rcfg: dict) -> tuple[str | None, SubOrder | None]:
    """(reason the user cannot write a review or None, the delivered package that verifies the purchase)."""
    if not cfg["feature_reviews"]:
        return "off", None
    if user is None:
        return "sign_in", None
    seller = await session.get(Seller, p.seller_id)
    if seller and seller.user_id == user.id:
        return "own_product", None
    sub = await _delivered_sub(session, user.id, p.id)
    if sub is None and rcfg["buyers_only"]:
        return "not_purchased", None
    return None, sub


def review_out(r: Review, name: str | None, *, show_media: bool, voted: set, reported: set, user_id) -> dict:
    return {
        "id": str(r.id), "rating": r.rating, "title": r.title, "body": r.body, "author": (name or "Customer").split(" ")[0],
        "verified": r.verified, "seller_reply": r.seller_reply, "helpful_count": r.helpful_count, "created_at": r.created_at.isoformat(),
        "media": r.media if show_media and r.media_status == "published" else [],
        "voted": r.id in voted, "reported": r.id in reported, "mine": user_id is not None and r.user_id == user_id,
    }


@router.get("/api/catalog/products/{slug}/reviews")
async def product_reviews(
    slug: str,
    session: SessionDep,
    user: OptionalUser,
    sort: Literal["recent", "helpful", "high", "low"] = "recent",
    page: int = Query(default=1, ge=1, le=500),
    star: int | None = Query(default=None, ge=1, le=5),
    media: bool = False,
    verified: bool = False,
    topic: str = Query(default="", max_length=30),
) -> dict:
    p = await _product_by_slug(session, slug)
    cfg = await get_settings(session)
    rcfg = await review_settings.get(session)
    show_media = rcfg["media_public"] or user is not None
    conds = [Review.product_id == p.id, Review.status == "published"]
    if star:
        conds.append(Review.rating == star)
    if media:
        conds += [func.jsonb_array_length(Review.media) > 0, Review.media_status == "published"]
    if verified:
        conds.append(Review.verified.is_(True))
    if topic:
        t = next((t for t in rcfg["topics"] if t["name"].lower() == topic.lower()), None)
        if t:
            conds.append(func.concat(Review.title, " ", Review.body).op("~*")(review_settings.topic_pattern(t["words"])))
    base = select(Review, User.name).join(User, User.id == Review.user_id).where(*conds)
    order = {"recent": Review.created_at.desc(), "helpful": Review.helpful_count.desc(), "high": Review.rating.desc(), "low": Review.rating.asc()}[sort]
    size = cfg["reviews_page_size"]
    rows = (await session.execute(base.order_by(order, Review.created_at.desc(), Review.id).offset((page - 1) * size).limit(size))).all()
    total = (await session.execute(select(func.count()).select_from(Review).where(*conds))).scalar_one()
    dist = dict((await session.execute(select(Review.rating, func.count()).where(Review.product_id == p.id, Review.status == "published").group_by(Review.rating))).all())
    with_media = (await session.execute(select(func.count()).select_from(Review).where(
        Review.product_id == p.id, Review.status == "published", Review.media_status == "published", func.jsonb_array_length(Review.media) > 0))).scalar_one()
    verified_count = (await session.execute(select(func.count()).select_from(Review).where(Review.product_id == p.id, Review.status == "published", Review.verified.is_(True)))).scalar_one()
    why_not, _sub = await _review_gate(session, p, user, cfg, rcfg)
    mine = None
    voted: set = set()
    reported: set = set()
    if user:
        mine_row = (await session.execute(select(Review).where(Review.product_id == p.id, Review.user_id == user.id))).scalar_one_or_none()
        if mine_row:
            mine = {"rating": mine_row.rating, "title": mine_row.title, "body": mine_row.body, "media": mine_row.media,
                    "status": mine_row.status, "media_status": mine_row.media_status}
            if why_not in ("not_purchased",):
                why_not = None  # an existing review can always be edited or deleted
        ids = [r.id for r, _ in rows]
        if ids:
            voted = set((await session.execute(select(ReviewVote.review_id).where(ReviewVote.user_id == user.id, ReviewVote.review_id.in_(ids)))).scalars())
            reported = set((await session.execute(select(ReviewReport.review_id).where(ReviewReport.user_id == user.id, ReviewReport.review_id.in_(ids)))).scalars())
    gallery, media_total = (await product_page.customer_media(session, p.id, limit=max(12, cfg["customer_photos_shown"]))) if show_media else ([], 0)
    return {
        "rating_avg": float(p.rating_avg or 0),
        "rating_count": p.rating_count,
        "distribution": {str(k): dist.get(k, 0) for k in range(5, 0, -1)},
        "summary": p.review_summary,
        "topics": await product_page.review_topics(session, rcfg["topics"], product_id=p.id) if rcfg["topics_enabled"] else [],
        "with_media_count": with_media,
        "verified_count": verified_count,
        "media": gallery,
        "media_total": media_total,
        "media_hidden": not show_media and with_media > 0,
        "can_review": why_not is None,
        "cannot_review_reason": why_not,
        "mine": mine,
        "settings": review_settings.public(rcfg),
        "items": [review_out(r, name, show_media=show_media, voted=voted, reported=reported, user_id=user.id if user else None) for r, name in rows],
        "total": total,
        "page": page,
        "has_more": page * size < total,
    }


@router.get("/api/catalog/products/{slug}/media")
async def product_customer_media(slug: str, session: SessionDep, user: OptionalUser, page: int = Query(default=1, ge=1, le=100)) -> dict:
    """All customer photos and videos for the full-screen viewer, 30 at a time."""
    p = await _product_by_slug(session, slug)
    rcfg = await review_settings.get(session)
    if not (rcfg["media_public"] or user is not None):
        return {"items": [], "total": 0, "page": page, "has_more": False, "sign_in_to_see": True}
    items, total = await product_page.customer_media(session, p.id, limit=30, offset=(page - 1) * 30)
    return {"items": items, "total": total, "page": page, "has_more": page * 30 < total}


@router.put("/api/catalog/products/{slug}/reviews")
async def write_review(slug: str, body: ReviewIn, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    rcfg = await review_settings.get(session)
    p = await _product_by_slug(session, slug)
    existing = (await session.execute(select(Review).where(Review.product_id == p.id, Review.user_id == user.id))).scalar_one_or_none()
    why_not, sub = await _review_gate(session, p, user, cfg, rcfg)
    if why_not == "off":
        raise ApiError("Reviews are turned off", "reviews_off")
    if why_not == "own_product":
        raise ApiError("Sellers cannot review their own products", "own_product")
    if why_not == "not_purchased" and existing is None:
        raise ApiError("You can review a product after it has been delivered to you", "not_purchased")
    title, text = body.title.strip(), body.body.strip()
    if rcfg["min_body_chars"] and len(text) < rcfg["min_body_chars"]:
        raise ApiError(f"Write at least {rcfg['min_body_chars']} characters about the product", "review_too_short")
    photos = [m for m in body.media if m.kind == "image"]
    videos = [m for m in body.media if m.kind == "video"]
    if photos and not (rcfg["photos"] and rcfg["max_photos"] > 0):
        raise ApiError("Photos in reviews are switched off", "photos_off")
    if len(photos) > rcfg["max_photos"]:
        raise ApiError(f"Add at most {rcfg['max_photos']} photos", "too_many_photos")
    if videos and not rcfg["videos"]:
        raise ApiError("Videos in reviews are switched off", "videos_off")
    if len(videos) > 1:
        raise ApiError("Add at most one video", "too_many_videos")
    media = [m.model_dump() for m in body.media]
    r = existing
    if r is None:
        r = Review(product_id=p.id, user_id=user.id)
        session.add(r)
    media_changed = r.media != media if existing else bool(media)
    if sub is not None or existing is None:
        r.sub_order_id, r.verified = (sub.id if sub else None), sub is not None
    r.rating, r.title, r.body, r.media = body.rating, title, text, media
    # Links, emails and phone numbers are not allowed in reviews: such reviews wait for a person to check.
    flagged = bool(_CONTACT.search(f"{title} {text}"))
    r.status = "pending" if (cfg["reviews_need_approval"] or flagged) else "published"
    if not media:
        r.media_status = "published"
    elif media_changed:
        r.media_status = "pending" if rcfg["media_need_approval"] else "published"
    await session.flush()
    await refresh_ratings(session, p.id)
    from app.services import loyalty as loyalty_svc  # review bonus points (off unless set in Admin -> Growth -> Loyalty)

    await loyalty_svc.award_review(session, r)
    await session.commit()
    return {"ok": True, "status": r.status, "media_status": r.media_status, "held_for_check": flagged}


@router.delete("/api/catalog/products/{slug}/reviews")
async def delete_review(slug: str, user: CurrentUser, session: SessionDep) -> dict:
    p = await _product_by_slug(session, slug)
    r = (await session.execute(select(Review).where(Review.product_id == p.id, Review.user_id == user.id))).scalar_one_or_none()
    if r is None:
        raise NotFound("Review")
    from app.services import loyalty as loyalty_svc

    await loyalty_svc.take_back_review(session, r)  # a deleted review keeps no bonus (once per package, so re-writing it does not pay again)
    await session.delete(r)
    await session.flush()
    await refresh_ratings(session, p.id)
    await session.commit()
    return {"ok": True}


@router.post("/api/reviews/media", status_code=201)
async def upload_review_media(user: CurrentUser, session: SessionDep, file: UploadFile = File(...)) -> dict:
    """A photo or video for a review (the review itself is saved with PUT .../reviews)."""
    cfg = await get_settings(session)
    rcfg = await review_settings.get(session)
    if not cfg["feature_reviews"]:
        raise ApiError("Reviews are turned off", "reviews_off")
    await rate_limit(session, f"review-media:{user.id}", limit=40, window_seconds=3600)
    video_limit = rcfg["max_video_mb"] * 1024 * 1024
    data = await file.read(max(video_limit, settings.max_image_bytes) + 1)
    try:
        storage.sniff_video(data)
        is_video = True
    except ApiError:
        is_video = False
    if is_video:
        if not rcfg["videos"]:
            raise ApiError("Videos in reviews are switched off", "videos_off")
        url = await storage.save_video(data, video_limit, "review-videos")
    else:
        if not (rcfg["photos"] and rcfg["max_photos"] > 0):
            raise ApiError("Photos in reviews are switched off", "photos_off")
        url = await storage.save_image(data, "reviews")
    await session.commit()  # keep the rate-limit record
    return {"url": url, "kind": "video" if is_video else "image"}


@router.post("/api/reviews/{review_id}/helpful")
async def helpful(review_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    """Marks a review helpful; a second call takes the vote back."""
    r = await session.get(Review, review_id)
    if r is None or r.status != "published":
        raise NotFound("Review")
    if r.user_id == user.id:
        raise ApiError("You cannot vote on your own review", "own_review")
    vote = await session.get(ReviewVote, (review_id, user.id))
    if vote:
        await session.delete(vote)
        delta = -1
    else:
        session.add(ReviewVote(review_id=review_id, user_id=user.id, created_at=utcnow()))
        delta = 1
    await session.execute(update(Review).where(Review.id == review_id).values(helpful_count=func.greatest(Review.helpful_count + delta, 0)))
    await session.commit()
    await session.refresh(r)
    return {"ok": True, "voted": delta == 1, "helpful_count": r.helpful_count}


async def file_review_report(session, r: Review, user_id: uuid.UUID, body: ReportIn) -> dict:
    if body.reason not in review_settings.REPORT_REASONS:
        raise ApiError("Choose a reason", "invalid_reason")
    if (await session.execute(select(ReviewReport.id).where(ReviewReport.review_id == r.id, ReviewReport.user_id == user_id))).first():
        return {"ok": True, "already": True}
    session.add(ReviewReport(review_id=r.id, user_id=user_id, reason=body.reason, note=body.note.strip(), status="open", created_at=utcnow()))
    r.report_count += 1
    rcfg = await review_settings.get(session)
    hidden = False
    if rcfg["report_hide_at"] and r.report_count >= rcfg["report_hide_at"] and r.status == "published":
        r.status = "pending"  # out of sight until staff look at it
        hidden = True
        await session.flush()
        await refresh_ratings(session, r.product_id)
    await session.commit()
    return {"ok": True, "already": False, "hidden": hidden}


@router.post("/api/reviews/{review_id}/report")
async def report_review(review_id: uuid.UUID, body: ReportIn, user: CurrentUser, session: SessionDep) -> dict:
    r = await session.get(Review, review_id)
    if r is None or r.status != "published":
        raise NotFound("Review")
    if r.user_id == user.id:
        raise ApiError("You cannot report your own review", "own_review")
    await rate_limit(session, f"review-report:{user.id}", limit=30, window_seconds=86400)
    return await file_review_report(session, r, user.id, body)


class ProductReportIn(BaseModel):
    reason: str = Field(max_length=20)
    note: str = Field(default="", max_length=2000)
    url: str = Field(default="", max_length=400)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip()
        if v and not re.match(r"^https?://[^\s]+$", v):
            raise ValueError("Enter a web address starting with https://")
        return v


@router.post("/api/catalog/products/{slug}/report", status_code=201)
async def report_product(slug: str, body: ProductReportIn, user: CurrentUser, session: SessionDep) -> dict:
    """Report an issue with this product. Staff see it in Admin → Product reports; the seller sees it
    without the customer's details."""
    cfg = await get_settings(session)
    if not cfg["pdp_report"]:
        raise ApiError("Reporting is switched off", "reports_off")
    if body.reason not in PRODUCT_REPORT_REASONS:
        raise ApiError("Choose what is wrong", "invalid_reason")
    if body.reason in ("wrong_info", "other", "counterfeit", "unsafe") and len(body.note.strip()) < 10:
        raise ApiError("Tell us a little more (at least 10 characters)", "note_required", fields={"note": "Too short"})
    p = (await session.execute(select(Product).where(Product.slug == slug, *public_product_filter()))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    await rate_limit(session, f"product-report:{user.id}", limit=10, window_seconds=86400)
    rep = (await session.execute(select(ProductReport).where(ProductReport.product_id == p.id, ProductReport.user_id == user.id,
                                                              ProductReport.status == "open"))).scalar_one_or_none()
    if rep is None:
        rep = ProductReport(product_id=p.id, seller_id=p.seller_id, user_id=user.id, status="open")
        session.add(rep)
    rep.reason, rep.note, rep.url = body.reason, body.note.strip(), body.url
    await session.commit()
    return {"ok": True, "id": str(rep.id)}


# ----------------------------------------------------------------------------- returns


class ReturnIn(BaseModel):
    sub_order_id: uuid.UUID
    items: list[dict] = Field(min_length=1, max_length=50)  # [{order_item_id, qty}]
    reason: str
    comment: str = Field(default="", max_length=2000)
    refund_upi: str = Field(default="", max_length=60)

    def lines(self) -> list[tuple[uuid.UUID, int]]:
        try:
            return [(uuid.UUID(str(i["order_item_id"])), int(i["qty"])) for i in self.items]
        except (KeyError, ValueError, TypeError) as exc:
            raise ApiError("Choose the items and quantities to return", "invalid_items") from exc


@router.get("/api/returns/reasons")
async def return_reasons(session: SessionDep) -> dict:
    from app.services import growth as growth_svc

    # `defect`: also allowed for items that can be returned only when they arrived damaged, faulty, wrong or incomplete
    return {"reasons": [{"code": k, "label": v, "defect": k in DEFECT_REASONS} for k, v in (await growth_svc.return_reasons(session)).items()]}


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
    ret = await returns_svc.create(session, user, body.sub_order_id, body.lines(), body.reason, body.comment, body.refund_upi.strip())
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


@router.get("/api/orders/{order_id}/fee-invoice.pdf")
async def fee_invoice(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> Response:
    """The marketplace's own tax invoice for the fees on the order (handling, platform, bad weather, ...)."""
    from app.services import fee_invoices

    order = await session.get(Order, order_id)
    if order is None or order.user_id != user.id or not order.fees_total:
        raise NotFound("Invoice")
    if not order.fee_invoice_number:
        raise ApiError("The invoice for the marketplace fees is issued when your first package is delivered", "invoice_not_ready")
    return Response(await fee_invoices.pdf(session, order), media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="fee-invoice-{order.number}.pdf"', "Cache-Control": "private, no-store"})


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
        "csat_rating": t.csat_rating, "csat_comment": t.csat_comment or "", "csat_at": t.csat_at.isoformat() if t.csat_at else None,
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
    await notify_staff(session, "support", "staff_ticket", {"subject": f"Customer replied on {t.number}", "message": body.body.strip()[:200]}, link=f"/admin/support/{t.id}")
    await session.commit()
    return await get_ticket(ticket_id, user, session)


class RatingIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=500)


@router.post("/api/support/tickets/{ticket_id}/rating")
async def rate_ticket(ticket_id: uuid.UUID, body: RatingIn, user: CurrentUser, session: SessionDep) -> dict:
    """The customer rates how the request was handled. Only once the request is resolved or closed, and only once."""
    t = (await session.execute(select(SupportTicket).where(SupportTicket.id == ticket_id).with_for_update())).scalar_one_or_none()
    if t is None or t.user_id != user.id:
        raise NotFound("Request")
    if t.status not in ("resolved", "closed"):
        raise Conflict("You can rate a request once it is resolved or closed.", "ticket_not_resolved")
    if t.csat_rating is not None:
        raise Conflict("You have already rated this request.", "already_rated")
    t.csat_rating = body.rating
    t.csat_comment = " ".join(body.comment.split())
    t.csat_at = utcnow()
    if body.rating <= 2:
        await notify_staff(session, "support", "staff_ticket", {"subject": f"Low rating on {t.number}", "message": f"{body.rating}/5. {t.csat_comment}".strip()}, link=f"/admin/support/{t.id}")
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
async def delivery_estimate(session: SessionDep, user: OptionalUser, variant_id: uuid.UUID, pincode: str = Query(min_length=6, max_length=6)) -> dict:
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
    best = min((estimate(cfg, seller.dispatch_days, w.pincode, w.state_code, pin, cutoff=seller.dispatch_cutoff) for w in whs),
               key=lambda e: e["days_min"])
    # The same rules as the checkout quote: the seller's own amount, the by-state amount and fee, the remote-area surcharge.
    from app.services import growth as growth_svc
    from app.services.orders import free_threshold

    state_code = state_for_pin(pin) or ""
    free_from = free_threshold(seller, await growth_svc.with_state_threshold(session, cfg, state_code), await growth_svc.seller_free_bounds(session))
    state_fee = None if v.price_paise >= free_from else await growth_svc.state_fee(session, state_code)
    fee = 0 if v.price_paise >= free_from else (cfg["shipping_fee_paise"] if state_fee is None else state_fee)
    extra, waive = await growth_svc.remote_surcharge(session, pin)
    if extra and not (waive and fee == 0):
        fee += extra
    from app.services import loyalty as loyalty_svc

    member_free = user is not None and await loyalty_svc.free_delivery(session, user.id)  # a signed-in member whose tier carries free delivery
    if member_free:
        fee = 0
    return {
        "serviceable": True, **best,
        "cod_available": cfg["cod_enabled"] and v.price_paise <= cfg["cod_max_order_paise"],
        "order_within_min": best["order_within_min"] if cfg["pdp_delivery_countdown"] else None,
        # delivery is charged per seller package; free once that seller's items reach the threshold
        "delivery_fee_paise": fee,
        "member_free_delivery": member_free,
        "free_delivery_from_paise": free_from,
        "state": STATES.get(state_for_pin(pin) or "", ""),
    }


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
    tickets = (await session.execute(select(SupportTicket).where(SupportTicket.user_id == user.id).order_by(SupportTicket.created_at.desc()).limit(500))).scalars()
    points = list((await session.execute(select(LoyaltyEntry).where(LoyaltyEntry.user_id == user.id).order_by(LoyaltyEntry.created_at.desc()).limit(500))).scalars())
    wished = (await session.execute(select(func.count()).select_from(WishlistItem).where(WishlistItem.user_id == user.id))).scalar_one()
    return {
        "support_tickets": [{"number": t.number, "subject": t.subject, "status": t.status, "created": t.created_at.isoformat()} for t in tickets],
        "loyalty": {"balance": sum(r.points for r in points), "history": [{"kind": r.kind, "points": r.points, "note": r.note, "at": r.created_at.isoformat()} for r in points]},
        "referral_code": referral.code_for(user.id),
        "wishlist_count": wished,
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
