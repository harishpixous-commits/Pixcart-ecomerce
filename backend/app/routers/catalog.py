"""Public storefront catalogue: categories, home rails, search with facets, product pages, stores."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import and_, desc, func, literal, or_, select

from app.core.deps import SessionDep, client_ip
from app.core.errors import NotFound
from app.core.validators import STATES
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import Category, Product, Seller, Variant
from app.services import size_guide as size_guide_svc
from app.services import growth as growth_svc
from app.services import product_page as pp
from app.services.orders import free_threshold
from app.services.catalog import (
    category_descendant_ids,
    discount_pct,
    images_for,
    public_product_filter,
    variant_label,
    videos_for,
)
from app.services.platform_settings import get_settings
from app.services.product_info import details_of, fmt_qty, important_info, info_rows, unit_price

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

SORTS = Literal["relevance", "price_asc", "price_desc", "newest", "rating", "discount", "popular"]


async def product_cards(session, products: list[Product], *, sponsored: dict | None = None, delivery: dict | None = None) -> list[dict]:
    """Cards for listings. Besides price and rating: the running deal, unit price, "bought in the past month", the
    version to add straight to the cart (when there is only one), and for ads the "Sponsored" link."""
    from datetime import timedelta

    from app.models import OrderItem, SubOrder
    from app.services import deals as deals_svc
    from app.services.product_info import details_of, unit_price
    from app.services.product_page import LIVE_PACKAGE, bucket

    if not products:
        return []
    ids = [p.id for p in products]
    imgs = await images_for(session, ids)
    rows = (await session.execute(select(Seller.id, Seller.display_name, Seller.slug).where(Seller.id.in_({p.seller_id for p in products})))).all()
    sellers = {r.id: r for r in rows}
    cfg = await get_settings(session)
    deal_map = await deals_svc.active_for_products(session, ids) if cfg["feature_deals"] else {}
    variants: dict = {}
    for v in (await session.execute(select(Variant).where(Variant.product_id.in_(ids), Variant.is_active.is_(True)).order_by(Variant.price_paise))).scalars():
        variants.setdefault(v.product_id, []).append(v)
    bought: dict = {}
    if cfg["pdp_bought_count"]:
        since = utcnow() - timedelta(days=30)
        bought = dict((await session.execute(
            select(OrderItem.product_id, func.sum(OrderItem.qty)).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(OrderItem.product_id.in_(ids), SubOrder.status.in_(LIVE_PACKAGE), SubOrder.created_at >= since)
            .group_by(OrderItem.product_id))).all())
    out = []
    for p in products:
        vs = variants.get(p.id, [])
        cheapest = next((v for v in vs if v.stock > 0), vs[0] if vs else None)
        unit = details_of(p.details).net_unit
        units = int(bought.get(p.id) or 0)
        card = {
            "id": str(p.id),
            "slug": p.slug,
            "title": p.title,
            "brand": p.brand,
            "image": (imgs.get(p.id) or [""])[0],
            "price": p.price_from,
            "mrp": p.mrp_from,
            "discount_pct": discount_pct(p.price_from, p.mrp_from),
            "rating_avg": float(p.rating_avg or 0),
            "rating_count": p.rating_count,
            "in_stock": p.in_stock,
            "seller_name": sellers[p.seller_id].display_name if p.seller_id in sellers else "",
            "deal": deal_map.get(p.id),
            "unit_price": unit_price(cheapest.price_paise, cheapest.net_qty, unit) if (cheapest and cfg["pdp_unit_price"]) else None,
            "bought": f"{bucket(units)} bought in past month" if units >= cfg["pdp_bought_min"] else None,
            "variant_count": len(vs),
            "variant_id": str(cheapest.id) if cheapest and len(vs) == 1 and cheapest.stock > 0 else None,
        }
        if sponsored and p.id in sponsored:
            card["sponsored"] = True
            card["href"] = f"/api/ads/click?t={sponsored[p.id]}"
        if delivery is not None:
            card["delivery_by"] = delivery.get(p.seller_id)
        out.append(card)
    return out


def _prefix_tsquery(q: str) -> str | None:
    tokens = [t for t in re.split(r"[^\w]+", q.lower()) if t][:8]
    if not tokens:
        return None
    return " & ".join(f"{t}:*" for t in tokens)


async def _category_tree(session) -> list[dict]:
    cats = list((await session.execute(select(Category).where(Category.is_active.is_(True)).order_by(Category.position, Category.name))).scalars())
    counts = dict(
        (await session.execute(select(Product.category_id, func.count()).where(*public_product_filter()).group_by(Product.category_id))).all()
    )
    nodes = {c.id: {"id": str(c.id), "name": c.name, "slug": c.slug, "image_url": c.image_url, "product_count": int(counts.get(c.id, 0)),
                    "required_details": list(c.required_details or []), "children": []} for c in cats}
    roots = []
    for c in cats:
        if c.parent_id and c.parent_id in nodes:
            nodes[c.parent_id]["children"].append(nodes[c.id])
        else:
            roots.append(nodes[c.id])

    def inherit(n: dict, parent: list[str]) -> None:
        # what a listing in this category must include: its own list plus its parents'
        n["required_details"] = list(dict.fromkeys(parent + n["required_details"]))
        for ch in n["children"]:
            inherit(ch, n["required_details"])

    for r in roots:
        inherit(r, [])

    def total(n: dict) -> int:
        n["product_count"] += sum(total(ch) for ch in n["children"])
        return n["product_count"]

    for r in roots:
        total(r)
    return roots


@router.get("/categories")
async def categories(session: SessionDep) -> list[dict]:
    return await _category_tree(session)


@router.get("/home")
async def home(session: SessionDep) -> dict:
    base = select(Product).where(*public_product_filter(), Product.in_stock.is_(True))

    async def rail(stmt, n: int = 12) -> list[dict]:
        return await product_cards(session, list((await session.execute(stmt.limit(n))).scalars()))

    discount_expr = (Product.mrp_from - Product.price_from) * 100 / func.nullif(Product.mrp_from, 0)
    return {
        "categories": await _category_tree(session),
        "deals": await rail(base.where(Product.mrp_from > Product.price_from).order_by(desc(discount_expr), Product.id)),
        "new_arrivals": await rail(base.order_by(Product.approved_at.desc().nullslast(), Product.id)),
        "top_rated": await rail(base.where(Product.rating_count > 0).order_by(Product.rating_avg.desc(), Product.rating_count.desc())),
        "bestsellers": await rail(base.where(Product.sold_count > 0).order_by(Product.sold_count.desc())),
    }


async def seller_delivery(session, seller_ids: list, pin: str) -> dict:
    """Fastest delivery estimate per seller to this PIN code: {seller_id: {"days": n, "date": "YYYY-MM-DD"}}."""
    from app.models import Warehouse
    from app.services.delivery import estimate

    if not seller_ids:
        return {}
    cfg = await get_settings(session)
    sellers = {s.id: s for s in (await session.execute(select(Seller).where(Seller.id.in_(seller_ids)))).scalars()}
    out: dict = {}
    for w in (await session.execute(select(Warehouse).where(Warehouse.seller_id.in_(seller_ids), Warehouse.is_active.is_(True)))).scalars():
        s = sellers.get(w.seller_id)
        if s is None:
            continue
        e = estimate(cfg, s.dispatch_days, w.pincode, w.state_code, pin, cutoff=s.dispatch_cutoff)
        if w.seller_id not in out or e["days_min"] < out[w.seller_id]["days"]:
            out[w.seller_id] = {"days": e["days_min"], "date": e["min_date"]}
    return out


@router.get("/products")
async def search(
    request: Request,
    response: Response,
    session: SessionDep,
    q: str = Query(default="", max_length=100),
    category: str | None = Query(default=None, max_length=90),
    brand: list[str] = Query(default_factory=list),
    seller: str | None = Query(default=None, max_length=90),
    min_price: int | None = Query(default=None, ge=0),
    max_price: int | None = Query(default=None, ge=0),
    min_rating: float | None = Query(default=None, ge=0, le=5),
    min_discount: int | None = Query(default=None, ge=0, le=100),
    in_stock: bool = False,
    sort: SORTS = "relevance",
    page: int = Query(default=1, ge=1, le=500),
    page_size: int | None = Query(default=None, ge=1, le=60),  # default: Admin → Marketplace settings
    pincode: str | None = Query(default=None, pattern=r"^[1-9][0-9]{5}$"),
    delivery: int | None = Query(default=None, ge=1, le=7),  # arrives within this many days at the PIN code
    deal: bool = False,
) -> dict:
    from app.models import Deal
    from app.services import ads as ads_svc

    lists = await get_settings(session)
    page_size = page_size or lists["search_page_size"]

    conds = list(public_product_filter())
    rank = literal(0.0)
    breadcrumbs: list[dict] = []
    current_category = None
    if category:
        cat = (await session.execute(select(Category).where(Category.slug == category, Category.is_active.is_(True)))).scalar_one_or_none()
        if cat is None:
            raise NotFound("Category")
        conds.append(Product.category_id.in_(await category_descendant_ids(session, cat.id)))
        current_category = {"id": str(cat.id), "name": cat.name, "slug": cat.slug}
        cur = cat
        while cur is not None:
            breadcrumbs.insert(0, {"name": cur.name, "slug": cur.slug})
            cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
    if seller:
        conds.append(Product.seller_id.in_(select(Seller.id).where(Seller.slug == seller)))
    text = q.strip()
    if text:
        from app.services.search_synonyms import parse_groups, variants

        text_conds = []
        ranks = []
        for variant in variants(text, parse_groups((await get_settings(session))["search_synonyms"])):
            tsq = _prefix_tsquery(variant)
            text_conds += [literal(variant).op("<%")(Product.title), Product.brand.ilike(variant)]
            if tsq:
                query = func.to_tsquery("simple", tsq)
                text_conds.insert(0, Product.search_vector.op("@@")(query))
                ranks.append(func.ts_rank(Product.search_vector, query) + func.word_similarity(variant, Product.title))
            else:
                ranks.append(func.word_similarity(variant, Product.title))
        rank = ranks[0] if len(ranks) == 1 else func.greatest(*ranks)
        conds.append(or_(*text_conds))

    # Facets are computed before brand/price filters so the user can widen them again.
    facet_conds = list(conds)
    if brand:
        conds.append(Product.brand.in_(brand))
    if min_price is not None:
        conds.append(Product.price_from >= min_price)
    if max_price is not None:
        conds.append(Product.price_from <= max_price)
    if min_rating is not None:
        conds.append(Product.rating_avg >= min_rating)
    if min_discount:
        conds.append((Product.mrp_from - Product.price_from) * 100 >= Product.mrp_from * min_discount)
    if in_stock:
        conds.append(Product.in_stock.is_(True))
    if deal:
        conds.append(Product.id.in_(select(Deal.product_id).where(Deal.status == "active")))
    eta: dict = {}
    if pincode:
        seller_ids = list((await session.execute(select(Product.seller_id).where(and_(*facet_conds)).distinct())).scalars())
        eta = await seller_delivery(session, seller_ids, pincode)
        if delivery:
            conds.append(Product.seller_id.in_([sid for sid, e in eta.items() if e["days"] <= delivery] or [None]))

    order = {
        "relevance": [Product.in_stock.desc(), desc(rank), Product.sold_count.desc(), Product.id],
        "price_asc": [Product.price_from.asc(), Product.id],
        "price_desc": [Product.price_from.desc(), Product.id],
        "newest": [Product.approved_at.desc().nullslast(), Product.id],
        "rating": [Product.rating_avg.desc(), Product.rating_count.desc(), Product.id],
        "discount": [desc((Product.mrp_from - Product.price_from) * 100 / func.nullif(Product.mrp_from, 0)), Product.id],
        "popular": [Product.sold_count.desc(), Product.id],
    }[sort]

    where = and_(*conds)
    total = (await session.execute(select(func.count()).select_from(Product).where(where))).scalar_one()
    rows = list((await session.execute(select(Product).where(where).order_by(*order).offset((page - 1) * page_size).limit(page_size))).scalars())

    facet_where = and_(*facet_conds)
    brands = (
        await session.execute(
            select(Product.brand, func.count()).where(facet_where, Product.brand != "").group_by(Product.brand).order_by(func.count().desc()).limit(lists["brand_filter_max"])
        )
    ).all()
    price_range = (await session.execute(select(func.min(Product.price_from), func.max(Product.price_from)).where(facet_where))).one()
    cat_counts = (await session.execute(
        select(Category.name, Category.slug, func.count()).join(Product, Product.category_id == Category.id)
        .where(facet_where).group_by(Category.name, Category.slug).order_by(func.count().desc()).limit(8))).all()
    sponsored: list[dict] = []
    sponsored_rail: list[dict] = []
    if text and page == 1:
        cfg = await get_settings(session)
        vid = ads_svc.visitor_id(request)
        served = await ads_svc.serve(session, "search", visitor=vid, ip=client_ip(request), query=text, limit=cfg["ads_per_search"] + cfg["ads_per_rail"])
        if served:
            ads_svc.keep_visitor(response, vid)
            cards = await product_cards(session, [x[0] for x in served], sponsored={x[0].id: x[1] for x in served},
                                        delivery={k: v["date"] for k, v in eta.items()} if pincode else None)
            sponsored, sponsored_rail = cards[: cfg["ads_per_search"]], cards[cfg["ads_per_search"]:]
    return {
        "items": await product_cards(session, rows, delivery={k: v["date"] for k, v in eta.items()} if pincode else None),
        "sponsored": sponsored,
        "sponsored_rail": sponsored_rail,
        "categories": [{"name": n, "slug": sl, "count": c} for n, sl, c in cat_counts],
        "total": total,
        "page": page,
        "page_size": page_size,
        "category": current_category,
        "breadcrumbs": breadcrumbs,
        "facets": {
            "brands": [{"name": b, "count": c} for b, c in brands],
            "price_min": price_range[0] or 0,
            "price_max": price_range[1] or 0,
        },
    }


@router.get("/suggest")
async def suggest(session: SessionDep, q: str = Query(min_length=1, max_length=60)) -> dict:
    text = q.strip()
    lists = await get_settings(session)
    from app.services.search_synonyms import parse_groups, variants

    conds = []
    for variant in variants(text, parse_groups(lists["search_synonyms"])):
        conds.append(literal(variant).op("<%")(Product.title))
        tsq = _prefix_tsquery(variant)
        if tsq:
            conds.insert(0, Product.search_vector.op("@@")(func.to_tsquery("simple", tsq)))
    titles = (
        await session.execute(
            select(Product.title, Product.slug).where(*public_product_filter(), or_(*conds)).order_by(func.word_similarity(text, Product.title).desc()).limit(lists["search_suggestions"])
        )
    ).all()
    cats = (await session.execute(select(Category.name, Category.slug).where(Category.is_active.is_(True), Category.name.ilike(f"%{text}%")).limit(min(4, lists["search_suggestions"])))).all()
    return {
        "products": [{"title": t, "slug": s} for t, s in titles],
        "categories": [{"name": n, "slug": s} for n, s in cats],
    }


@router.get("/products/{slug}")
async def product_page(slug: str, session: SessionDep) -> dict:
    from app.services import deals as deals_svc

    if await deals_svc.sync(session):
        await session.commit()
    p = (await session.execute(select(Product).where(Product.slug == slug, *public_product_filter()))).scalar_one_or_none()
    if p is None:
        raise NotFound("Product")
    seller = await session.get(Seller, p.seller_id)
    variants = list(
        (await session.execute(select(Variant).where(Variant.product_id == p.id, Variant.is_active.is_(True)).order_by(Variant.price_paise, Variant.created_at))).scalars()
    )
    images = (await images_for(session, [p.id])).get(p.id, [])
    cfg = await get_settings(session)
    videos = (await videos_for(session, [p.id])).get(p.id, []) if cfg["feature_product_videos"] else []
    cat = await session.get(Category, p.category_id)
    breadcrumbs = []
    cur = cat
    while cur is not None:
        breadcrumbs.insert(0, {"name": cur.name, "slug": cur.slug})
        cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
    size_guide_rows = size_guide_svc.rows(p.size_guide)  # the product's own table wins
    cur = cat
    while cur is not None and size_guide_rows is None:  # the nearest category with a guide, this one or a parent
        size_guide_rows = size_guide_svc.rows(cur.size_guide)
        cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
    details = details_of(p.details)
    unit = details.net_unit
    # option axes, e.g. {"Size": ["S","M","L"], "Colour": ["Red","Blue"]}
    axes: dict[str, list[str]] = {}
    for v in variants:
        for k, val in v.options.items():
            axes.setdefault(k, [])
            if val not in axes[k]:
                axes[k].append(val)
    similar = list(
        (
            await session.execute(
                select(Product).where(*public_product_filter(), Product.category_id == p.category_id, Product.id != p.id, Product.in_stock.is_(True)).order_by(Product.sold_count.desc(), Product.rating_avg.desc()).limit(max(1, cfg["similar_products"]))
            )
        ).scalars()
    ) if cfg["pdp_similar"] and cfg["similar_products"] > 0 else []
    bought_together: list[Product] = []
    bt = (await growth_svc.get(session))["bought_together"]
    if bt["enabled"]:
        from app.models import OrderItem, SubOrder
        from app.services.product_page import LIVE_PACKAGE

        with_this = select(SubOrder.order_id).join(OrderItem, OrderItem.sub_order_id == SubOrder.id).where(OrderItem.product_id == p.id, SubOrder.status.in_(LIVE_PACKAGE))
        bought_together = list((await session.execute(
            select(Product).join(OrderItem, OrderItem.product_id == Product.id).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
            .where(*public_product_filter(), Product.id != p.id, Product.in_stock.is_(True), SubOrder.status.in_(LIVE_PACKAGE), SubOrder.order_id.in_(with_this))
            .group_by(Product.id).order_by(func.count(func.distinct(SubOrder.order_id)).desc(), Product.sold_count.desc()).limit(int(bt["max_items"])))).scalars())
    key_specs = []
    if cfg["pdp_key_specs"]:
        names = details.key_specs or list(p.specs)[:5]
        key_specs = [{"label": k, "value": p.specs[k]} for k in names if k in p.specs][:6]
        if p.brand and not any(k["label"].lower() == "brand" for k in key_specs):
            key_specs.insert(0, {"label": "Brand", "value": p.brand})
    return {
        "id": str(p.id),
        "slug": p.slug,
        "title": p.title,
        "brand": p.brand,
        "description": p.description,
        "highlights": p.highlights,
        "specs": p.specs,
        "images": images,
        "videos": videos,
        "country_of_origin": p.country_of_origin,
        "return_window_days": p.return_window_days,
        "rating_avg": float(p.rating_avg or 0),
        "rating_count": p.rating_count,
        "price": p.price_from,
        "mrp": p.mrp_from,
        "discount_pct": discount_pct(p.price_from, p.mrp_from),
        "in_stock": p.in_stock,
        "breadcrumbs": breadcrumbs,
        "size_guide": size_guide_rows,
        "option_axes": axes,
        "variants": [
            {
                "id": str(v.id),
                "options": v.options,
                "label": variant_label(v.options),
                "price": v.price_paise,
                "mrp": v.mrp_paise,
                "discount_pct": discount_pct(v.price_paise, v.mrp_paise),
                "in_stock": v.stock > 0,
                "low_stock": 0 < v.stock <= cfg["low_stock_threshold"],
                "stock_left": v.stock if v.stock <= cfg["low_stock_threshold"] else None,
                "net_quantity": fmt_qty(v.net_qty, unit),
                "unit_price": unit_price(v.price_paise, v.net_qty, unit) if cfg["pdp_unit_price"] else None,
            }
            for v in variants
        ],
        "key_specs": key_specs,
        "info": info_rows(details, brand=p.brand, country_of_origin=p.country_of_origin),
        "important": important_info(details),
        "required_missing": [],  # filled for staff previews only
        "first_available": p.approved_at.date().isoformat() if p.approved_at else None,
        "bought_last_month": await pp.bought_last_month(session, p.id, cfg["pdp_bought_min"]) if cfg["pdp_bought_count"] else None,
        "bestseller": await pp.bestseller_rank(session, p) if cfg["pdp_bestseller_badge"] else None,
        "offers": await pp.offers_for(session, p, seller, cfg["pdp_offers_max"]) if cfg["pdp_offers"] and cfg["feature_coupons"] else [],
        "seller_snapshot": await pp.seller_snapshot(session, seller, cfg) if cfg["pdp_seller_snapshot"] else None,
        "returnable": p.return_window_days > 0,
        "deal": (await deals_svc.active_for_products(session, [p.id])).get(p.id) if cfg["feature_deals"] else None,
        # Consumer Protection (E-Commerce) Rules 2020, rule 6(5): seller identity shown to buyers.
        "seller": {
            "name": seller.display_name,
            "slug": seller.slug,
            "legal_name": seller.legal_name,
            "gstin": seller.gstin,
            "city": seller.pickup_city,
            "state": STATES.get(seller.pickup_state_code, ""),
            "grievance_officer": {"name": seller.grievance_name, "email": seller.grievance_email},
            "dispatch_days": seller.dispatch_days,
            # The amount from which this seller's package ships free (the seller's own when Seller shipping is on, else the marketplace's).
            "free_shipping_threshold_paise": free_threshold(seller, cfg, await growth_svc.seller_free_bounds(session)),
        },
        "similar": await product_cards(session, similar),
        # "Bought together": other products that appeared in the same orders (Admin → Growth; empty while it is off)
        "bought_together": await product_cards(session, bought_together),
    }


@router.get("/stores/{slug}")
async def store(slug: str, session: SessionDep) -> dict:
    s = (await session.execute(select(Seller).where(Seller.slug == slug, Seller.status == "approved"))).scalar_one_or_none()
    if s is None:
        raise NotFound("Store")
    count = (await session.execute(select(func.count()).select_from(Product).where(*public_product_filter(), Product.seller_id == s.id))).scalar_one()
    return {
        "name": s.display_name,
        "slug": s.slug,
        "description": s.description,
        "city": s.pickup_city,
        "state": STATES.get(s.pickup_state_code, ""),
        "since": s.approved_at.date().isoformat() if s.approved_at else None,
        "product_count": count,
    }



@router.get("/platform")
async def platform_info(session: SessionDep) -> dict:
    """Operator details the Consumer Protection (E-Commerce) Rules 2020 require on the platform."""
    cfg = await get_settings(session)
    from app.services.cms import get_site, public_business

    b = public_business(await get_site(session))
    return {
        "name": b["brand"],
        "legal_name": b["legal_name"],
        "gstin": b["gstin"],
        "registered_address": b["registered_address"],
        "grievance_officer": b["grievance"],
        "free_shipping_threshold_paise": cfg["free_shipping_threshold_paise"],
        "shipping_fee_paise": cfg["shipping_fee_paise"],
        "cod_enabled": cfg["cod_enabled"],
        "online_payments": (await get_integrations(session)).online_payments,
    }
