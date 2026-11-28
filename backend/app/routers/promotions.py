"""Deals, sponsored products and the discovery pages (Today's Deals, Bestsellers, Hot New Releases, Coupons).

Sellers propose deals and run ad campaigns from the seller hub; staff approve, reject or stop them (Admin → Deals,
Admin → Advertising) and set the rules in the same pages. Shoppers see deals with timers and "Sponsored" products."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import case, func, or_, select

from app.core.deps import ApprovedSeller, CurrentUser, SellerAccount, SessionDep, audit, client_ip
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import Perm
from app.db import utcnow
from app.models import AdCampaign, AdCampaignProduct, AdClick, AdStat, Category, Coupon, Deal, LedgerEntry, OrderItem, Product, Seller, SubOrder, Variant
from app.routers.catalog import _category_tree, product_cards
from app.services import ads as ads_svc
from app.services import deals as deals_svc
from app.services.catalog import category_descendant_ids, images_for, public_product_filter, variant_label
from app.services.notify import notify_seller
from app.services.platform_settings import get_settings
from app.services.product_page import LIVE_PACKAGE, offer_text

router = APIRouter(tags=["promotions"])
IST = timezone(timedelta(hours=5, minutes=30))


def _aware(v: datetime | None) -> datetime | None:
    if v is None:
        return None
    return v.replace(tzinfo=IST) if v.tzinfo is None else v  # a time without a zone is India time


def _rules(cfg: dict) -> dict:
    return {"enabled": cfg["feature_deals"], "need_approval": cfg["deals_need_approval"], "min_discount_pct": cfg["deal_min_discount_pct"],
            "max_hours_lightning": cfg["deal_max_hours_lightning"], "max_hours_day": cfg["deal_max_hours_day"],
            "max_days_limited": cfg["deal_max_days_limited"], "kinds": deals_svc.KINDS}


# ============================================================================ deals: seller


class DealIn(BaseModel):
    variant_id: uuid.UUID
    kind: Literal["lightning", "deal_of_day", "limited"]
    deal_price_paise: int = Field(gt=0, le=100_000_000)
    starts_at: datetime
    ends_at: datetime
    qty_limit: int | None = Field(default=None, ge=1, le=100_000)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _tz(cls, v: datetime) -> datetime:
        return _aware(v)


@router.get("/api/seller/deals")
async def seller_deals(seller: SellerAccount, session: SessionDep, status: str | None = None) -> dict:
    if await deals_svc.sync(session):
        await session.commit()
    stmt = select(Deal).where(Deal.seller_id == seller.id)
    if status:
        stmt = stmt.where(Deal.status == status)
    items = await deals_svc.deal_rows(session, stmt.order_by(Deal.created_at.desc()).limit(200))
    counts = dict((await session.execute(select(Deal.status, func.count()).where(Deal.seller_id == seller.id).group_by(Deal.status))).all())
    return {"items": items, "counts": counts, "rules": _rules(await get_settings(session))}


@router.get("/api/seller/deals/options")
async def seller_deal_options(seller: SellerAccount, session: SessionDep, q: str = Query(default="", max_length=80)) -> dict:
    """The seller's live products and versions, for the "New deal" form."""
    stmt = select(Product).where(Product.seller_id == seller.id, Product.status == "approved")
    if q.strip():
        stmt = stmt.where(Product.title.ilike(f"%{q.strip()}%"))
    products = list((await session.execute(stmt.order_by(Product.title).limit(100))).scalars())
    imgs = await images_for(session, [p.id for p in products])
    vs: dict = {}
    for v in (await session.execute(select(Variant).where(Variant.product_id.in_([p.id for p in products]), Variant.is_active.is_(True)))).scalars():
        vs.setdefault(v.product_id, []).append(v)
    busy = await deals_svc.active_variant_ids(session, [v.id for lst in vs.values() for v in lst])
    return {"products": [{"id": str(p.id), "title": p.title, "image": (imgs.get(p.id) or [""])[0], "variants": [
        {"id": str(v.id), "label": variant_label(v.options) or "Single version", "price": v.price_paise, "mrp": v.mrp_paise, "stock": v.stock, "in_deal": v.id in busy}
        for v in vs.get(p.id, [])]} for p in products if vs.get(p.id)]}


@router.post("/api/seller/deals", status_code=201)
async def seller_create_deal(body: DealIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    d = await deals_svc.create(session, seller, cfg, variant_id=body.variant_id, kind=body.kind, deal_price=body.deal_price_paise,
                               starts_at=body.starts_at, ends_at=body.ends_at, qty_limit=body.qty_limit)
    audit(session, user, "deal.create", "deal", d.id, f"{body.kind} at {body.deal_price_paise}")
    await deals_svc.sync(session, force=True)
    await session.commit()
    return (await deals_svc.deal_rows(session, select(Deal).where(Deal.id == d.id)))[0]


@router.post("/api/seller/deals/{deal_id}/cancel")
async def seller_cancel_deal(deal_id: uuid.UUID, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    d = (await session.execute(select(Deal).where(Deal.id == deal_id).with_for_update())).scalar_one_or_none()
    if d is None or d.seller_id != seller.id:
        raise NotFound("Deal")
    await deals_svc.cancel(session, d, "Cancelled by the seller")
    audit(session, user, "deal.cancel", "deal", d.id)
    await session.commit()
    return {"ok": True}


# ============================================================================ deals: admin


class ReasonIn(BaseModel):
    reason: str = Field(default="", max_length=300)


@router.get("/api/admin/deals")
async def admin_deals(admin: Perm("catalog"), session: SessionDep, status: str | None = "pending", q: str = Query(default="", max_length=80),
                      page: int = Query(default=1, ge=1, le=1_000_000)) -> dict:
    if await deals_svc.sync(session):
        await session.commit()
    stmt = select(Deal)
    if status and status != "all":
        stmt = stmt.where(Deal.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Deal.product_id.in_(select(Product.id).where(Product.title.ilike(like))),
                              Deal.seller_id.in_(select(Seller.id).where(Seller.display_name.ilike(like)))))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    items = await deals_svc.deal_rows(session, stmt.order_by(Deal.starts_at.desc()).offset((page - 1) * 30).limit(30))
    counts = dict((await session.execute(select(Deal.status, func.count()).group_by(Deal.status))).all())
    return {"items": items, "total": total, "page": page, "page_size": 30, "counts": counts, "rules": _rules(await get_settings(session))}


@router.post("/api/admin/deals/{deal_id}/{action}")
async def admin_deal_action(deal_id: uuid.UUID, action: Literal["approve", "reject", "cancel"], body: ReasonIn, admin: Perm("catalog"), session: SessionDep) -> dict:
    d = (await session.execute(select(Deal).where(Deal.id == deal_id).with_for_update())).scalar_one_or_none()
    if d is None:
        raise NotFound("Deal")
    p = await session.get(Product, d.product_id)
    if action == "approve":
        if d.status != "pending":
            raise Conflict(f"A {d.status} deal cannot be approved", "invalid_status")
        if d.ends_at <= utcnow():
            raise Conflict("This deal's time has already passed", "expired")
        d.status, d.note = "approved", ""
        message = f"Your {deals_svc.KINDS[d.kind].lower()} was approved. It runs from {d.starts_at.astimezone(IST):%d %b, %I:%M %p}."
    elif action == "reject":
        if d.status != "pending":
            raise Conflict(f"A {d.status} deal cannot be rejected", "invalid_status")
        if len(body.reason.strip()) < 5:
            raise ApiError("Give the seller a reason (at least 5 characters)", "reason_required")
        d.status, d.note = "rejected", body.reason.strip()
        message = f"Your deal was not approved: {d.note}"
    else:
        if len(body.reason.strip()) < 5:
            raise ApiError("Give the seller a reason (at least 5 characters)", "reason_required")
        await deals_svc.cancel(session, d, f"Stopped by the marketplace: {body.reason.strip()}")
        message = d.note
    audit(session, admin, f"deal.{action}", "deal", d.id, body.reason[:200])
    await notify_seller(session, d.seller_id, "listing_update", {"status": f"deal {d.status}", "title": p.title if p else "", "message": message},
                        link="/seller/deals")
    await deals_svc.sync(session, force=True)
    await session.commit()
    return {"ok": True, "status": d.status}


# ============================================================================ deals: shoppers


@router.get("/api/catalog/deals")
async def deals_page(
    session: SessionDep,
    tab: Literal["live", "upcoming", "discounts"] = "live",
    kind: Literal["lightning", "deal_of_day", "limited"] | None = None,
    category: str | None = Query(default=None, max_length=90),
    min_discount: int | None = Query(default=None, ge=0, le=95),
    min_rating: float | None = Query(default=None, ge=0, le=5),
    min_price: int | None = Query(default=None, ge=0),
    max_price: int | None = Query(default=None, ge=0),
    sort: Literal["featured", "ending", "discount", "price_asc", "price_desc", "rating"] = "featured",
    page: int = Query(default=1, ge=1, le=200),
) -> dict:
    cfg = await get_settings(session)
    if await deals_svc.sync(session):
        await session.commit()
    discount = (Product.mrp_from - Product.price_from) * 100 / func.nullif(Product.mrp_from, 0)
    conds = list(public_product_filter())
    if category:
        cat = (await session.execute(select(Category).where(Category.slug == category))).scalar_one_or_none()
        if cat is None:
            raise NotFound("Category")
        conds.append(Product.category_id.in_(await category_descendant_ids(session, cat.id)))
    if min_discount:
        conds.append((Product.mrp_from - Product.price_from) * 100 >= Product.mrp_from * min_discount)
    if min_rating:
        conds.append(Product.rating_avg >= min_rating)
    if min_price is not None:
        conds.append(Product.price_from >= min_price)
    if max_price is not None:
        conds.append(Product.price_from <= max_price)
    upcoming: list[dict] = []
    if tab == "upcoming":
        soon = (select(Deal.product_id, func.min(Deal.starts_at).label("starts_at")).where(
            Deal.status == "approved", Deal.starts_at > utcnow(), Deal.starts_at <= utcnow() + timedelta(days=7)).group_by(Deal.product_id).subquery())
        stmt = select(Product, soon.c.starts_at).join(soon, soon.c.product_id == Product.id).where(*conds).order_by(soon.c.starts_at)
        rows = (await session.execute(stmt.limit(60))).all()
        cards = await product_cards(session, [r[0] for r in rows])
        for card, (_, starts) in zip(cards, rows, strict=True):
            card["starts_at"] = starts.isoformat()
        return {"items": cards, "total": len(cards), "page": 1, "page_size": 60, "facets": {}, "tab": tab}
    if tab == "discounts":
        conds.append(Product.mrp_from > Product.price_from)
        conds.append(Product.in_stock.is_(True))
        stmt = select(Product).where(*conds)
        order = {"price_asc": [Product.price_from], "price_desc": [Product.price_from.desc()], "rating": [Product.rating_avg.desc()]}.get(sort, [discount.desc()])
    else:
        live = select(Deal.product_id, func.min(Deal.ends_at).label("ends_at"),
                      func.max(case((Deal.kind == "lightning", 3), (Deal.kind == "deal_of_day", 2), else_=1)).label("rank")).where(Deal.status == "active")
        if kind:
            live = live.where(Deal.kind == kind)
        live = live.group_by(Deal.product_id).subquery()
        stmt = select(Product).join(live, live.c.product_id == Product.id).where(*conds)
        order = {"ending": [live.c.ends_at], "discount": [discount.desc()], "price_asc": [Product.price_from], "price_desc": [Product.price_from.desc()],
                 "rating": [Product.rating_avg.desc()]}.get(sort, [live.c.rank.desc(), discount.desc()])
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await session.execute(stmt.order_by(*order, Product.id).offset((page - 1) * 30).limit(30))).scalars())
    # departments (top-level categories) with counts, for the filter list
    tree = await _category_tree(session)
    dept_counts = []
    if tab == "live":
        live_ids = select(Deal.product_id).where(Deal.status == "active")
        for root in tree:
            ids = await category_descendant_ids(session, uuid.UUID(root["id"]))
            n = (await session.execute(select(func.count()).select_from(Product).where(*public_product_filter(), Product.id.in_(live_ids), Product.category_id.in_(ids)))).scalar_one()
            if n:
                dept_counts.append({"name": root["name"], "slug": root["slug"], "count": n})
    kinds = dict((await session.execute(select(Deal.kind, func.count(func.distinct(Deal.product_id))).where(Deal.status == "active").group_by(Deal.kind))).all())
    upcoming_count = (await session.execute(select(func.count(func.distinct(Deal.product_id))).where(
        Deal.status == "approved", Deal.starts_at > utcnow(), Deal.starts_at <= utcnow() + timedelta(days=7)))).scalar_one()
    return {"items": await product_cards(session, rows), "total": total, "page": page, "page_size": 30, "tab": tab,
            "facets": {"departments": dept_counts, "kinds": {k: kinds.get(k, 0) for k in deals_svc.KINDS}, "upcoming": upcoming_count},
            "enabled": cfg["feature_deals"], "upcoming": upcoming}


# ============================================================================ bestsellers, new releases, coupons


async def _ranked(session, cat_ids: list | None, limit: int, *, new_since: datetime | None = None) -> list[Product]:
    since = utcnow() - timedelta(days=30)
    recent = (select(OrderItem.product_id, func.sum(OrderItem.qty).label("units")).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
              .where(SubOrder.status.in_(LIVE_PACKAGE), SubOrder.created_at >= since).group_by(OrderItem.product_id).subquery())
    stmt = select(Product).outerjoin(recent, recent.c.product_id == Product.id).where(*public_product_filter())
    if cat_ids is not None:
        stmt = stmt.where(Product.category_id.in_(cat_ids))
    order = [func.coalesce(recent.c.units, 0).desc(), Product.sold_count.desc(), Product.rating_avg.desc(), Product.id]
    if new_since is not None:
        stmt = stmt.where(Product.approved_at >= new_since)
        order = [func.coalesce(recent.c.units, 0).desc(), Product.approved_at.desc(), Product.id]
    return list((await session.execute(stmt.order_by(*order).limit(limit))).scalars())


@router.get("/api/catalog/top")
async def top_lists(session: SessionDep, list_: Literal["bestsellers", "new"] = Query(default="bestsellers", alias="list"),
                    category: str | None = Query(default=None, max_length=90)) -> dict:
    """Bestsellers (units sold in the last 30 days) or Hot New Releases (recently added, ranked the same way):
    one ranked list for a category, or the top 10 of every department."""
    cfg = await get_settings(session)
    new_since = utcnow() - timedelta(days=cfg["new_release_days"]) if list_ == "new" else None
    tree = await _category_tree(session)
    if category:
        cat = (await session.execute(select(Category).where(Category.slug == category, Category.is_active.is_(True)))).scalar_one_or_none()
        if cat is None:
            raise NotFound("Category")
        products = await _ranked(session, await category_descendant_ids(session, cat.id), 50, new_since=new_since)
        crumbs, cur = [], cat
        while cur is not None:
            crumbs.insert(0, {"name": cur.name, "slug": cur.slug})
            cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
        children = (await session.execute(select(Category).where(Category.parent_id == cat.id, Category.is_active.is_(True)).order_by(Category.position, Category.name))).scalars()
        return {"list": list_, "category": {"name": cat.name, "slug": cat.slug}, "breadcrumbs": crumbs,
                "children": [{"name": c.name, "slug": c.slug} for c in children], "items": await product_cards(session, products), "tree": tree}
    sections = []
    for root in tree:
        if not root["product_count"]:
            continue
        products = await _ranked(session, await category_descendant_ids(session, uuid.UUID(root["id"])), 10, new_since=new_since)
        if products:
            sections.append({"category": {"name": root["name"], "slug": root["slug"]}, "items": await product_cards(session, products)})
    return {"list": list_, "category": None, "sections": sections, "tree": tree, "new_release_days": cfg["new_release_days"]}


@router.get("/api/catalog/coupons")
async def coupons_page(session: SessionDep) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_coupons"]:
        return {"items": [], "enabled": False}
    now = utcnow()
    rows = (await session.execute(
        select(Coupon, Seller.display_name, Seller.slug, Category.name, Category.slug)
        .outerjoin(Seller, Seller.id == Coupon.seller_id).outerjoin(Category, Category.id == Coupon.category_id)
        .where(Coupon.is_active.is_(True), Coupon.show_on_checkout.is_(True), or_(Coupon.starts_at.is_(None), Coupon.starts_at <= now),
               or_(Coupon.ends_at.is_(None), Coupon.ends_at >= now), or_(Coupon.usage_limit.is_(None), Coupon.used_count < Coupon.usage_limit))
        .order_by(Coupon.seller_id.is_not(None), Coupon.ends_at.asc().nullslast(), Coupon.created_at.desc()).limit(200))).all()
    items = []
    for c, sname, sslug, cname, cslug in rows:
        shop = f"/search?seller={sslug}" if sslug else f"/c/{cslug}" if cslug else "/search?sort=popular"
        items.append({"code": c.code, **offer_text(c), "description": c.description, "source": "seller" if c.seller_id else "platform",
                      "seller": sname or "", "category": cname or "", "shop_link": shop, "min_order_paise": c.min_order_paise,
                      "first_order_only": c.first_order_only, "ends_at": c.ends_at.isoformat() if c.ends_at else None})
    return {"items": items, "enabled": True}


# ============================================================================ sponsored products: shoppers


@router.get("/api/ads/serve")
async def ads_serve(request: Request, response: Response, session: SessionDep, placement: Literal["search", "product", "home"],
                    q: str = Query(default="", max_length=100), product: str | None = Query(default=None, max_length=230),
                    limit: int | None = Query(default=None, ge=1, le=20)) -> dict:
    prod = None
    if placement == "product":
        prod = (await session.execute(select(Product).where(Product.slug == product))).scalar_one_or_none() if product else None
        if prod is None:
            return {"items": []}
    vid = ads_svc.visitor_id(request)
    served = await ads_svc.serve(session, placement, visitor=vid, ip=client_ip(request), query=q, product=prod, limit=limit)
    if served:
        ads_svc.keep_visitor(response, vid)
    return {"items": await product_cards(session, [x[0] for x in served], sponsored={x[0].id: x[1] for x in served})}


@router.get("/api/ads/click")
async def ads_click(request: Request, session: SessionDep, t: str = Query(max_length=400)) -> RedirectResponse:
    """Opens the product behind a sponsored link. Only a genuine click is charged (services/ads.py); any other click is
    free and counted as invalid, but still opens the product."""
    p, ck = await ads_svc.click(session, t, visitor=request.cookies.get(ads_svc.VISITOR_COOKIE), ip=client_ip(request))
    if p is None:
        return RedirectResponse("/", status_code=302)
    return RedirectResponse(f"/p/{p.slug}" + (f"?sp={ck.id}" if ck else ""), status_code=302)


@router.post("/api/ads/clicks/{click_id}/claim")
async def ads_claim(click_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    """Links a recent ad click to the signed-in shopper, so an order they place counts as an ad sale."""
    ck = await session.get(AdClick, click_id)
    if ck and ck.user_id is None and ck.created_at > utcnow() - timedelta(hours=2):
        ck.user_id = user.id
        await session.commit()
    return {"ok": True}


# ============================================================================ sponsored products: seller


def _ads_rules(cfg: dict) -> dict:
    return {"enabled": cfg["feature_ads"], "need_approval": cfg["ads_need_approval"], "min_bid_paise": cfg["ads_min_bid_paise"],
            "min_daily_budget_paise": cfg["ads_min_daily_budget_paise"], "gst_bps": cfg["commission_gst_bps"],
            "placements": {k: {"label": v, "enabled": cfg[f"ads_{k}"]} for k, v in ads_svc.PLACEMENTS.items()},
            "attribution_days": ads_svc.ATTRIBUTION_DAYS, "link_hours": int(ads_svc.LINK_TTL.total_seconds() // 3600),
            "paid_clicks_per_address": cfg["ads_paid_clicks_per_address"], "paid_clicks_per_network": cfg["ads_paid_clicks_per_network"]}


class CampaignIn(BaseModel):
    name: str = Field(min_length=3, max_length=80)
    product_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    placements: list[Literal["search", "product", "home"]] = Field(min_length=1, max_length=3)
    keywords: list[str] = Field(default_factory=list, max_length=30)
    bid_paise: int = Field(gt=0, le=10_000_000)
    daily_budget_paise: int = Field(gt=0, le=100_000_000)
    total_budget_paise: int | None = Field(default=None, gt=0, le=10_000_000_000)
    starts_at: datetime | None = None
    ends_at: datetime | None = None

    @field_validator("keywords")
    @classmethod
    def _kw(cls, v: list[str]) -> list[str]:
        out = []
        for k in v:
            k = " ".join(str(k).lower().split())[:40]
            if len(k) >= 2 and k not in out:
                out.append(k)
        return out

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _tz(cls, v: datetime | None) -> datetime | None:
        return _aware(v)

    @model_validator(mode="after")
    def _money(self) -> CampaignIn:
        if self.daily_budget_paise < self.bid_paise:
            raise ValueError("The daily budget must cover at least one click")
        if self.total_budget_paise is not None and self.total_budget_paise < self.daily_budget_paise:
            raise ValueError("The total budget cannot be less than the daily budget")
        if self.starts_at and self.ends_at and self.ends_at <= self.starts_at:
            raise ValueError("The campaign must end after it starts")
        return self


async def _check_campaign(session, seller: Seller, body: CampaignIn, cfg: dict) -> None:
    if not cfg["feature_ads"]:
        raise ApiError("Sponsored products are switched off on this marketplace", "ads_off")
    if body.bid_paise < cfg["ads_min_bid_paise"]:
        raise ApiError(f"Bid at least ₹{cfg['ads_min_bid_paise'] / 100:,.2f} per click", "bid_too_low")
    if body.daily_budget_paise < cfg["ads_min_daily_budget_paise"]:
        raise ApiError(f"Set a daily budget of at least ₹{cfg['ads_min_daily_budget_paise'] / 100:,.0f}", "budget_too_low")
    owned = set((await session.execute(select(Product.id).where(Product.id.in_(body.product_ids), Product.seller_id == seller.id,
                                                                Product.status == "approved"))).scalars())
    if len(owned) != len(set(body.product_ids)):
        raise ApiError("Choose your own live products", "invalid_products")


async def _campaign_products(session, campaign_ids: list[uuid.UUID]) -> dict:
    rows = (await session.execute(select(AdCampaignProduct.campaign_id, Product.id, Product.title, Product.slug).join(Product, Product.id == AdCampaignProduct.product_id)
                                  .where(AdCampaignProduct.campaign_id.in_(campaign_ids)))).all() if campaign_ids else []
    imgs = await images_for(session, list({r[1] for r in rows}))
    out: dict = {}
    for cid, pid, title, slug in rows:
        out.setdefault(cid, []).append({"id": str(pid), "title": title, "slug": slug, "image": (imgs.get(pid) or [""])[0]})
    return out


async def _spent_today(session, campaign_ids: list[uuid.UUID]) -> dict:
    if not campaign_ids:
        return {}
    return dict((await session.execute(select(AdStat.campaign_id, func.sum(AdStat.spend_paise)).where(
        AdStat.campaign_id.in_(campaign_ids), AdStat.day == ads_svc.today_ist()).group_by(AdStat.campaign_id))).all())


async def _campaigns_out(session, campaigns: list[AdCampaign], *, since: date | None = None) -> list[dict]:
    ids = [c.id for c in campaigns]
    products = await _campaign_products(session, ids)
    stats = await ads_svc.campaign_report(session, ids, since=since)
    today = await _spent_today(session, ids)
    return [ads_svc.campaign_out(c, products.get(c.id, []), stats.get(c.id), int(today.get(c.id) or 0)) for c in campaigns]


@router.get("/api/seller/ads")
async def seller_ads(seller: SellerAccount, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    campaigns = list((await session.execute(select(AdCampaign).where(AdCampaign.seller_id == seller.id).order_by(AdCampaign.created_at.desc()))).scalars())
    items = await _campaigns_out(session, campaigns)
    since = ads_svc.today_ist() - timedelta(days=29)
    report = await ads_svc.campaign_report(session, [c.id for c in campaigns], since=since)
    totals = {k: sum(r[k] for r in report.values()) for k in ("impressions", "clicks", "invalid_clicks", "spend", "orders", "sales")}
    totals["acos"] = round(100 * totals["spend"] / totals["sales"], 1) if totals["sales"] else None
    billing = (await session.execute(select(LedgerEntry).where(LedgerEntry.seller_id == seller.id, LedgerEntry.kind == "ad_spend")
                                     .order_by(LedgerEntry.created_at.desc()).limit(10))).scalars()
    return {"campaigns": items, "rules": _ads_rules(cfg), "totals_30d": totals,
            "billing": [{"amount": e.amount, "description": e.description, "at": e.created_at.isoformat()} for e in billing]}


@router.get("/api/seller/ads/products")
async def seller_ads_products(seller: SellerAccount, session: SessionDep) -> list[dict]:
    rows = list((await session.execute(select(Product).where(Product.seller_id == seller.id, Product.status == "approved").order_by(Product.title).limit(300))).scalars())
    imgs = await images_for(session, [p.id for p in rows])
    return [{"id": str(p.id), "title": p.title, "image": (imgs.get(p.id) or [""])[0], "price": p.price_from, "in_stock": p.in_stock,
             "rating_avg": float(p.rating_avg or 0)} for p in rows]


async def _owned_campaign(session, seller: Seller, campaign_id: uuid.UUID) -> AdCampaign:
    c = (await session.execute(select(AdCampaign).where(AdCampaign.id == campaign_id).with_for_update())).scalar_one_or_none()
    if c is None or c.seller_id != seller.id:
        raise NotFound("Campaign")
    return c


async def _set_products(session, c: AdCampaign, product_ids: list[uuid.UUID]) -> None:
    await session.execute(AdCampaignProduct.__table__.delete().where(AdCampaignProduct.campaign_id == c.id))
    for pid in dict.fromkeys(product_ids):
        session.add(AdCampaignProduct(campaign_id=c.id, product_id=pid))


@router.post("/api/seller/ads", status_code=201)
async def seller_create_campaign(body: CampaignIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    await _check_campaign(session, seller, body, cfg)
    c = AdCampaign(seller_id=seller.id, name=body.name.strip(), status="pending" if cfg["ads_need_approval"] else "active",
                   placements=list(dict.fromkeys(body.placements)), keywords=body.keywords, bid_paise=body.bid_paise,
                   daily_budget_paise=body.daily_budget_paise, total_budget_paise=body.total_budget_paise,
                   starts_at=body.starts_at or utcnow(), ends_at=body.ends_at, spend_paise=0, note="")
    session.add(c)
    await session.flush()
    await _set_products(session, c, body.product_ids)
    audit(session, user, "ads.create", "ad_campaign", c.id, c.name)
    await session.commit()
    return (await _campaigns_out(session, [c]))[0]


@router.put("/api/seller/ads/{campaign_id}")
async def seller_update_campaign(campaign_id: uuid.UUID, body: CampaignIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    cfg = await get_settings(session)
    c = await _owned_campaign(session, seller, campaign_id)
    if c.status == "ended":
        raise Conflict("This campaign has ended; create a new one", "ended")
    await _check_campaign(session, seller, body, cfg)
    before = set((await session.execute(select(AdCampaignProduct.product_id).where(AdCampaignProduct.campaign_id == c.id))).scalars())
    targeting_changed = before != set(body.product_ids) or c.keywords != body.keywords
    c.name, c.placements, c.keywords = body.name.strip(), list(dict.fromkeys(body.placements)), body.keywords
    c.bid_paise, c.daily_budget_paise, c.total_budget_paise = body.bid_paise, body.daily_budget_paise, body.total_budget_paise
    c.starts_at, c.ends_at = body.starts_at or c.starts_at, body.ends_at
    await _set_products(session, c, body.product_ids)
    if c.status == "rejected" or (targeting_changed and cfg["ads_need_approval"] and c.status == "active"):
        c.status, c.note = "pending", ""
    audit(session, user, "ads.update", "ad_campaign", c.id, c.name)
    await session.commit()
    return (await _campaigns_out(session, [c]))[0]


@router.post("/api/seller/ads/{campaign_id}/{action}")
async def seller_campaign_action(campaign_id: uuid.UUID, action: Literal["pause", "resume", "end"], seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    c = await _owned_campaign(session, seller, campaign_id)
    if action == "pause" and c.status == "active":
        c.status = "paused"
    elif action == "resume" and c.status == "paused":
        c.status = "active"
    elif action == "end" and c.status in ("pending", "active", "paused"):
        c.status, c.note = "ended", "Ended by the seller"
    else:
        raise Conflict(f"A {c.status} campaign cannot be {action}d", "invalid_status")
    audit(session, user, f"ads.{action}", "ad_campaign", c.id)
    await session.commit()
    return {"ok": True, "status": c.status}


@router.get("/api/seller/ads/{campaign_id}/report")
async def seller_campaign_report(campaign_id: uuid.UUID, seller: SellerAccount, session: SessionDep, days: int = Query(default=30, ge=1, le=90)) -> dict:
    c = await session.get(AdCampaign, campaign_id)
    if c is None or c.seller_id != seller.id:
        raise NotFound("Campaign")
    since = ads_svc.today_ist() - timedelta(days=days - 1)
    sums = (func.sum(AdStat.impressions), func.sum(AdStat.clicks), func.sum(AdStat.invalid_clicks), func.sum(AdStat.spend_paise))
    by_day = (await session.execute(select(AdStat.day, *sums)
                                    .where(AdStat.campaign_id == c.id, AdStat.day >= since).group_by(AdStat.day).order_by(AdStat.day))).all()
    by_product = (await session.execute(select(Product.title, *sums)
                                        .join(Product, Product.id == AdStat.product_id).where(AdStat.campaign_id == c.id, AdStat.day >= since)
                                        .group_by(Product.title).order_by(func.sum(AdStat.clicks).desc()))).all()
    return {"days": [{"day": d.isoformat(), "impressions": int(i), "clicks": int(k), "invalid_clicks": int(x), "spend": int(s)} for d, i, k, x, s in by_day],
            "products": [{"title": t, "impressions": int(i), "clicks": int(k), "invalid_clicks": int(x), "spend": int(s)} for t, i, k, x, s in by_product]}


# ============================================================================ sponsored products: admin


@router.get("/api/admin/ads")
async def admin_ads(admin: Perm("marketing"), session: SessionDep, status: str | None = None, q: str = Query(default="", max_length=80),
                    page: int = Query(default=1, ge=1, le=1_000_000)) -> dict:
    stmt = select(AdCampaign)
    if status and status != "all":
        stmt = stmt.where(AdCampaign.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(AdCampaign.name.ilike(like), AdCampaign.seller_id.in_(select(Seller.id).where(Seller.display_name.ilike(like)))))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    campaigns = list((await session.execute(stmt.order_by(case((AdCampaign.status == "pending", 0), else_=1), AdCampaign.created_at.desc())
                                            .offset((page - 1) * 30).limit(30))).scalars())
    items = await _campaigns_out(session, campaigns)
    names = dict((await session.execute(select(Seller.id, Seller.display_name).where(Seller.id.in_({c.seller_id for c in campaigns})))).all()) if campaigns else {}
    for it, c in zip(items, campaigns, strict=True):
        it["seller"], it["seller_id"] = names.get(c.seller_id, ""), str(c.seller_id)
    since = ads_svc.today_ist() - timedelta(days=29)
    by_day = (await session.execute(select(AdStat.day, func.sum(AdStat.impressions), func.sum(AdStat.clicks), func.sum(AdStat.invalid_clicks),
                                           func.sum(AdStat.spend_paise)).where(AdStat.day >= since).group_by(AdStat.day).order_by(AdStat.day))).all()
    days = [{"day": d.isoformat(), "impressions": int(i), "clicks": int(k), "invalid_clicks": int(x), "spend": int(s)} for d, i, k, x, s in by_day]
    counts = dict((await session.execute(select(AdCampaign.status, func.count()).group_by(AdCampaign.status))).all())
    cfg = await get_settings(session)
    return {"items": items, "total": total, "page": page, "page_size": 30, "counts": counts, "rules": _ads_rules(cfg),
            "revenue_30d": {**{k: sum(r[k] for r in days) for k in ("impressions", "clicks", "invalid_clicks", "spend")}, "days": days}}


@router.post("/api/admin/ads/bill")
async def admin_ads_bill(admin: Perm("marketing"), session: SessionDep) -> dict:
    n = await ads_svc.bill(session)
    audit(session, admin, "ads.bill", "ads", "billing", f"{n} entries")
    await session.commit()
    return {"posted": n}


@router.post("/api/admin/ads/{campaign_id}/{action}")
async def admin_campaign_action(campaign_id: uuid.UUID, action: Literal["approve", "reject", "pause", "resume", "end"], body: ReasonIn,
                                admin: Perm("marketing"), session: SessionDep) -> dict:
    c = (await session.execute(select(AdCampaign).where(AdCampaign.id == campaign_id).with_for_update())).scalar_one_or_none()
    if c is None:
        raise NotFound("Campaign")
    allowed = {"approve": ("pending",), "reject": ("pending", "active", "paused"), "pause": ("active",), "resume": ("paused",), "end": ("pending", "active", "paused")}
    if c.status not in allowed[action]:
        raise Conflict(f"A {c.status} campaign cannot be {action}d", "invalid_status")
    if action in ("reject", "end") and len(body.reason.strip()) < 5:
        raise ApiError("Give the seller a reason (at least 5 characters)", "reason_required")
    c.status = {"approve": "active", "reject": "rejected", "pause": "paused", "resume": "active", "end": "ended"}[action]
    c.note = body.reason.strip()
    audit(session, admin, f"ads.{action}", "ad_campaign", c.id, body.reason[:200])
    await notify_seller(session, c.seller_id, "listing_update", {"status": f"ad campaign {c.status}", "title": c.name,
                        "message": c.note or "Open Advertising in your seller hub for details."}, link="/seller/advertising")
    await session.commit()
    return {"ok": True, "status": c.status}





# ============================================================================ personal rails


@router.get("/api/catalog/related")
async def related_products(session: SessionDep, ids: str = Query(default="", max_length=800), limit: int = Query(default=12, ge=1, le=24)) -> dict:
    """"Inspired by your browsing history": popular products from the categories of the products the shopper viewed."""
    seen = []
    for x in ids.split(",")[:20]:
        try:
            seen.append(uuid.UUID(x.strip()))
        except ValueError:
            continue
    if not seen:
        return {"items": []}
    cats = list((await session.execute(select(Product.category_id).where(Product.id.in_(seen)).distinct())).scalars())
    if not cats:
        return {"items": []}
    rows = list((await session.execute(select(Product).where(*public_product_filter(), Product.in_stock.is_(True), Product.category_id.in_(cats),
                                                             Product.id.not_in(seen)).order_by(Product.sold_count.desc(), Product.rating_avg.desc()).limit(limit))).scalars())
    return {"items": await product_cards(session, rows)}


@router.get("/api/orders/buy-again")
async def buy_again(user: CurrentUser, session: SessionDep, limit: int = Query(default=12, ge=1, le=24)) -> dict:
    """Products from the shopper's delivered orders that are still on sale, most recent first."""
    from app.models import Order

    last = (select(OrderItem.product_id, func.max(Order.created_at).label("at")).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .join(Order, Order.id == SubOrder.order_id).where(Order.user_id == user.id, SubOrder.status == "delivered")
            .group_by(OrderItem.product_id).subquery())
    rows = list((await session.execute(select(Product).join(last, last.c.product_id == Product.id).where(*public_product_filter())
                                       .order_by(last.c.at.desc()).limit(limit))).scalars())
    return {"items": await product_cards(session, rows)}
