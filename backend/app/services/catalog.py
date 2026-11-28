from __future__ import annotations

import secrets
import uuid

from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.errors import ApiError
from app.core.validators import slugify
from app.models import Category, Product, ProductImage, Seller, Variant


async def refresh_product_aggregates(session: AsyncSession, product: Product) -> None:
    variants = list(
        (
            await session.execute(
                select(Variant)
                .where(Variant.product_id == product.id, Variant.is_active.is_(True))
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )
    if not variants:
        product.price_from, product.mrp_from, product.in_stock = 0, 0, False
        return
    in_stock = [v for v in variants if v.stock > 0]
    cheapest = min(in_stock or variants, key=lambda v: v.price_paise)
    product.price_from = cheapest.price_paise
    product.mrp_from = cheapest.mrp_paise
    product.in_stock = bool(in_stock)


async def unique_product_slug(session: AsyncSession, title: str) -> str:
    base = slugify(title, 200)
    slug = base
    while (await session.execute(select(Product.id).where(Product.slug == slug))).first():
        slug = f"{base}-{secrets.token_hex(3)}"
    return slug


async def leaf_category(session: AsyncSession, category_id: uuid.UUID) -> Category:
    cat = await session.get(Category, category_id)
    if cat is None or not cat.is_active:
        raise ApiError("Choose a valid category", "invalid_category", fields={"category_id": "Invalid"})
    has_children = (await session.execute(select(exists().where(Category.parent_id == cat.id)))).scalar()
    if has_children:
        raise ApiError("Choose the most specific sub-category", "category_not_leaf", fields={"category_id": "Pick a sub-category"})
    return cat


def listing_return_window(cat: Category, days: int | None) -> int:
    """A listing's return window: the category's default when the seller gives none, never shorter than the category's
    minimum (Admin → Categories)."""
    if days is None:
        return cat.return_window_days
    if days < cat.min_return_window_days:
        raise ApiError(f"Listings in {cat.name} need a return window of at least {cat.min_return_window_days} days",
                       "return_window_too_short", fields={"return_window_days": f"At least {cat.min_return_window_days} days"})
    return days


def check_image_url(url: str) -> str:
    """Only images uploaded through this platform may be attached to a listing."""
    prefix = settings.media_base_url.rstrip("/") + "/products/"
    if not url.startswith(prefix) or ".." in url or len(url) > 400:
        raise ValueError("Upload images here; external image links are not allowed")
    return url


def check_video_url(url: str) -> str:
    """Only videos uploaded through this platform may be attached to a listing."""
    prefix = settings.media_base_url.rstrip("/") + "/videos/"
    if not url.startswith(prefix) or ".." in url or len(url) > 400:
        raise ValueError("Upload videos here; external video links are not allowed")
    return url


async def videos_for(session: AsyncSession, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[dict]]:
    from app.models import ProductVideo

    if not product_ids:
        return {}
    rows = (await session.execute(select(ProductVideo).where(ProductVideo.product_id.in_(product_ids)).order_by(ProductVideo.position))).scalars()
    out: dict[uuid.UUID, list[dict]] = {}
    for v in rows:
        out.setdefault(v.product_id, []).append({"url": v.url, "poster_url": v.poster_url, "title": v.title, "duration_s": v.duration_s})
    return out


async def apply_videos(session: AsyncSession, product_id: uuid.UUID, videos: list) -> None:
    """Replaces a listing's videos (order = display order)."""
    from sqlalchemy import delete

    from app.models import ProductVideo

    await session.execute(delete(ProductVideo).where(ProductVideo.product_id == product_id))
    for i, v in enumerate(videos):
        session.add(ProductVideo(product_id=product_id, url=v.url, poster_url=v.poster_url, title=v.title, duration_s=v.duration_s, position=i))


async def category_descendant_ids(session: AsyncSession, root_id: uuid.UUID) -> list[uuid.UUID]:
    rows = (await session.execute(select(Category.id, Category.parent_id).where(Category.is_active.is_(True)))).all()
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for cid, pid in rows:
        children.setdefault(pid, []).append(cid)
    out, stack = [], [root_id]
    while stack:
        cur = stack.pop()
        out.append(cur)
        stack.extend(children.get(cur, []))
    return out


def public_product_filter():
    """SQL conditions for a product that customers may see and buy."""
    return (
        Product.status == "approved",
        or_(Product.publish_at.is_(None), Product.publish_at <= func.now()),   # scheduled publish: not live before its time
        Product.price_from > 0,
        Product.seller_id.in_(select(Seller.id).where(Seller.status == "approved", Seller.holiday_mode.is_(False))),
    )


async def images_for(session: AsyncSession, product_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[str]]:
    if not product_ids:
        return {}
    rows = (
        await session.execute(
            select(ProductImage.product_id, ProductImage.url).where(ProductImage.product_id.in_(product_ids)).order_by(ProductImage.position)
        )
    ).all()
    out: dict[uuid.UUID, list[str]] = {}
    for pid, url in rows:
        out.setdefault(pid, []).append(url)
    return out


def variant_label(options: dict) -> str:
    return " / ".join(f"{k}: {v}" for k, v in (options or {}).items())


def discount_pct(price: int, mrp: int) -> int:
    if mrp <= 0 or price >= mrp:
        return 0
    return int((mrp - price) * 100 // mrp)
