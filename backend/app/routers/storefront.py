"""Public storefront configuration: site settings (brand, theme, menus), the home page sections with their
products resolved, and CMS pages."""
from __future__ import annotations

import uuid

from fastapi import APIRouter
from sqlalchemy import desc, func, or_, select

from app.ai import service as ai_service
from app.ai.settings import get_ai_settings
from app.config import settings as env
from app.core.deps import SessionDep
from app.core.errors import NotFound
from app.db import utcnow
from app.models import Category, CmsPage, HomeSection, Product
from app.routers.catalog import _category_tree, product_cards
from app.services.catalog import category_descendant_ids, public_product_filter
from app.services.cms import DEFAULT_PAGES, ensure_default_sections, get_site
from app.integrations import get as get_integrations
from app.services.platform_settings import get_settings

router = APIRouter(prefix="/api", tags=["storefront"])


@router.get("/site")
async def site(session: SessionDep) -> dict:
    s = await get_site(session)
    cfg = await get_settings(session)
    features = {k.removeprefix("feature_"): v for k, v in cfg.items() if k.startswith("feature_")}
    ai_cfg = await get_ai_settings(session)
    # Sellers see AI buttons when AI studio is on and a key is set (or, outside production, in sandbox mode).
    features["ai"] = bool(ai_cfg["enabled"]) and (await ai_service.mode() == "live" or env.environment != "production")
    ic = await get_integrations(session)
    return {**s, "features": features, "cod_enabled": cfg["cod_enabled"], "online_payments": ic.online_payments,
            "free_shipping_threshold_paise": cfg["free_shipping_threshold_paise"],
            "gallery": {"zoom": cfg["gallery_zoom"], "zoom_level": cfg["gallery_zoom_level"] / 10,
                        "max_video_mb": cfg["max_video_mb"], "max_videos": cfg["max_videos_per_listing"]}}


async def _products_for(session, cfg: dict) -> list[dict]:
    base = select(Product).where(*public_product_filter(), Product.in_stock.is_(True))
    source, limit = cfg.get("source", "deals"), int(cfg.get("limit", 12))
    if source == "deals":
        stmt = base.where(Product.mrp_from > Product.price_from).order_by(desc((Product.mrp_from - Product.price_from) * 100 / func.nullif(Product.mrp_from, 0)), Product.id)
    elif source == "bestsellers":
        stmt = base.order_by(Product.sold_count.desc(), Product.id)
    elif source == "top_rated":
        stmt = base.where(Product.rating_count > 0).order_by(Product.rating_avg.desc(), Product.rating_count.desc())
    elif source == "new":
        stmt = base.order_by(Product.approved_at.desc().nullslast(), Product.id)
    elif source == "category":
        cat = (await session.execute(select(Category).where(Category.slug == cfg.get("category_slug")))).scalar_one_or_none()
        if cat is None:
            return []
        stmt = base.where(Product.category_id.in_(await category_descendant_ids(session, cat.id))).order_by(Product.sold_count.desc(), Product.id)
    elif source == "manual":
        ids = []
        for x in cfg.get("product_ids", []):
            try:
                ids.append(uuid.UUID(x))
            except ValueError:
                continue
        rows = {p.id: p for p in (await session.execute(base.where(Product.id.in_(ids)))).scalars()}
        return await product_cards(session, [rows[i] for i in ids if i in rows])
    else:
        return []
    return await product_cards(session, list((await session.execute(stmt.limit(limit))).scalars()))


@router.get("/home")
async def home(session: SessionDep) -> dict:
    await ensure_default_sections(session)
    await session.commit()
    now = utcnow()
    sections = list(
        (
            await session.execute(
                select(HomeSection)
                .where(
                    HomeSection.is_active.is_(True),
                    or_(HomeSection.starts_at.is_(None), HomeSection.starts_at <= now),
                    or_(HomeSection.ends_at.is_(None), HomeSection.ends_at >= now),
                )
                .order_by(HomeSection.position, HomeSection.created_at)
            )
        ).scalars()
    )
    tree = await _category_tree(session)
    out = []
    for s in sections:
        data: dict = {"id": str(s.id), "kind": s.kind, "title": s.title, "device": s.device, "config": s.config}
        if s.kind == "products":
            data["products"] = await _products_for(session, s.config)
            if not data["products"]:
                continue
        elif s.kind == "categories":
            slugs = s.config.get("slugs") or []
            flat = {c["slug"]: c for c in tree} | {ch["slug"]: ch for c in tree for ch in c["children"]}
            data["categories"] = [flat[x] for x in slugs if x in flat] if slugs else tree
        out.append(data)
    return {"sections": out, "categories": tree}


@router.get("/pages/{slug}")
async def page(slug: str, session: SessionDep) -> dict:
    p = (await session.execute(select(CmsPage).where(CmsPage.slug == slug))).scalar_one_or_none()
    if p is None:
        if slug in DEFAULT_PAGES:
            title, body = DEFAULT_PAGES[slug]
            return {"slug": slug, "title": title, "body": body, "meta_description": "", "updated_at": None}
        raise NotFound("Page")
    if not p.is_published:
        raise NotFound("Page")
    return {"slug": p.slug, "title": p.title, "body": p.body, "meta_description": p.meta_description, "updated_at": p.updated_at.isoformat()}
