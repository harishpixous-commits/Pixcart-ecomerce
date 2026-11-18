"""Public storefront catalogue: categories, home rails, search with facets, product pages, stores."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Query
from sqlalchemy import and_, desc, func, literal, or_, select

from app.integrations import get as get_integrations
from app.core.deps import SessionDep
from app.core.errors import NotFound
from app.core.validators import STATES
from app.models import Category, Product, Seller, Variant
from app.services.catalog import (
    category_descendant_ids,
    discount_pct,
    images_for,
    videos_for,
    public_product_filter,
    variant_label,
)
from app.services.platform_settings import get_settings

router = APIRouter(prefix="/api/catalog", tags=["catalog"])

SORTS = Literal["relevance", "price_asc", "price_desc", "newest", "rating", "discount", "popular"]


async def product_cards(session, products: list[Product]) -> list[dict]:
    imgs = await images_for(session, [p.id for p in products])
    sellers = {}
    if products:
        rows = (await session.execute(select(Seller.id, Seller.display_name, Seller.slug).where(Seller.id.in_({p.seller_id for p in products})))).all()
        sellers = {r.id: r for r in rows}
    return [
        {
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
        }
        for p in products
    ]


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
    nodes = {c.id: {"id": str(c.id), "name": c.name, "slug": c.slug, "image_url": c.image_url, "product_count": int(counts.get(c.id, 0)), "children": []} for c in cats}
    roots = []
    for c in cats:
        if c.parent_id and c.parent_id in nodes:
            nodes[c.parent_id]["children"].append(nodes[c.id])
        else:
            roots.append(nodes[c.id])

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


@router.get("/products")
async def search(
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
    page_size: int = Query(default=24, ge=1, le=60),
) -> dict:
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
        tsq = _prefix_tsquery(text)
        text_conds = [literal(text).op("<%")(Product.title), Product.brand.ilike(text)]
        if tsq:
            query = func.to_tsquery("simple", tsq)
            text_conds.insert(0, Product.search_vector.op("@@")(query))
            rank = func.ts_rank(Product.search_vector, query) + func.word_similarity(text, Product.title)
        else:
            rank = func.word_similarity(text, Product.title)
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
            select(Product.brand, func.count()).where(facet_where, Product.brand != "").group_by(Product.brand).order_by(func.count().desc()).limit(30)
        )
    ).all()
    price_range = (await session.execute(select(func.min(Product.price_from), func.max(Product.price_from)).where(facet_where))).one()
    return {
        "items": await product_cards(session, rows),
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
    tsq = _prefix_tsquery(text)
    conds = [literal(text).op("<%")(Product.title)]
    if tsq:
        conds.insert(0, Product.search_vector.op("@@")(func.to_tsquery("simple", tsq)))
    titles = (
        await session.execute(
            select(Product.title, Product.slug).where(*public_product_filter(), or_(*conds)).order_by(func.word_similarity(text, Product.title).desc()).limit(8)
        )
    ).all()
    cats = (await session.execute(select(Category.name, Category.slug).where(Category.is_active.is_(True), Category.name.ilike(f"%{text}%")).limit(4))).all()
    return {
        "products": [{"title": t, "slug": s} for t, s in titles],
        "categories": [{"name": n, "slug": s} for n, s in cats],
    }


@router.get("/products/{slug}")
async def product_page(slug: str, session: SessionDep) -> dict:
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
                select(Product).where(*public_product_filter(), Product.category_id == p.category_id, Product.id != p.id, Product.in_stock.is_(True)).order_by(Product.sold_count.desc(), Product.rating_avg.desc()).limit(12)
            )
        ).scalars()
    )
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
                "low_stock": 0 < v.stock <= 5,
                "stock_left": v.stock if v.stock <= 5 else None,
            }
            for v in variants
        ],
        # Consumer Protection (E-Commerce) Rules 2020, rule 6(5): seller identity shown to buyers.
        "seller": {
            "name": seller.display_name,
            "slug": seller.slug,
            "legal_name": seller.legal_name,
            "gstin": seller.gstin,
            "city": seller.pickup_city,
            "state": STATES.get(seller.pickup_state_code, ""),
            "grievance_officer": {"name": seller.grievance_name, "email": seller.grievance_email},
        },
        "similar": await product_cards(session, similar),
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
