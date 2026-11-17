from __future__ import annotations

import secrets
import uuid

from sqlalchemy import exists, select
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


def check_image_url(url: str) -> str:
    """Only images uploaded through this platform may be attached to a listing."""
    prefix = settings.media_base_url.rstrip("/") + "/products/"
    if not url.startswith(prefix) or ".." in url or len(url) > 400:
        raise ValueError("Upload images here; external image links are not allowed")
    return url


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
