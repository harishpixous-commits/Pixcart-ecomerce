"""Collections: pages of chosen products. Staff make them (hand-picked list, or rules on category, brand and price);
customers open /collections/{slug}."""
from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import Perm
from app.core.validators import slugify
from app.models import Category, Product, ProductCollection
from app.routers.catalog import product_cards
from app.services.catalog import category_descendant_ids, public_product_filter

router = APIRouter(prefix="/api", tags=["collections"])
MAX_SHOWN = 60


class CollectionIn(BaseModel):
    title: str = Field(min_length=2, max_length=120)
    slug: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=1000)
    image_url: str = Field(default="", max_length=500)
    is_active: bool = True
    position: int = Field(default=0, ge=0, le=10_000)
    product_slugs: list[str] = Field(default_factory=list, max_length=60)  # product link names, in the order shown
    category_slug: str = Field(default="", max_length=120)
    brand: str = Field(default="", max_length=80)
    min_price_paise: int | None = Field(default=None, ge=0, le=100_000_000)
    max_price_paise: int | None = Field(default=None, ge=0, le=100_000_000)

    @model_validator(mode="after")
    def _one_way_to_pick(self):
        if self.min_price_paise is not None and self.max_price_paise is not None and self.min_price_paise > self.max_price_paise:
            raise ValueError("The lowest price is above the highest price")
        if not (self.product_slugs or self.category_slug.strip() or self.brand.strip() or self.min_price_paise is not None or self.max_price_paise is not None):
            raise ValueError("Pick products by link name, or give a category, brand or price range")
        return self


async def _slugs_to_ids(session, slugs: list[str]) -> list[str]:
    clean = list(dict.fromkeys(s.strip().lower().rsplit("/", 1)[-1] for s in slugs if s.strip()))
    if not clean:
        return []
    rows = {k.lower(): v for k, v in (await session.execute(select(Product.slug, Product.id).where(func.lower(Product.slug).in_(clean)))).all()}
    missing = [s for s in clean if s not in rows]
    if missing:
        raise ApiError(f"No product with the link name: {', '.join(missing)}", "product_not_found")
    return [str(rows[s]) for s in clean]


async def _out(session, c: ProductCollection) -> dict:
    ids = {uuid.UUID(i) for i in (c.product_ids or [])}
    names = {str(i): s for i, s in (await session.execute(select(Product.id, Product.slug).where(Product.id.in_(ids)))).all()} if ids else {}
    return {"id": str(c.id), "slug": c.slug, "title": c.title, "description": c.description, "image_url": c.image_url, "is_active": c.is_active,
            "position": c.position, "product_slugs": [names[i] for i in (c.product_ids or []) if i in names], "category_slug": c.category_slug,
            "brand": c.brand, "min_price_paise": c.min_price_paise, "max_price_paise": c.max_price_paise}


async def _unique_slug(session, wanted: str, but: uuid.UUID | None = None) -> str:
    base = slugify(wanted, 70)
    slug, n = base, 1
    while True:
        stmt = select(ProductCollection.id).where(ProductCollection.slug == slug)
        if but:
            stmt = stmt.where(ProductCollection.id != but)
        if (await session.execute(stmt)).first() is None:
            return slug
        n += 1
        slug = f"{base}-{n}"


async def _apply(session, c: ProductCollection, body: CollectionIn) -> None:
    if body.category_slug.strip() and (await session.execute(select(Category.id).where(Category.slug == body.category_slug.strip()))).first() is None:
        raise ApiError(f"No category with the link name: {body.category_slug.strip()}", "category_not_found")
    c.title, c.description, c.image_url = body.title.strip(), body.description.strip(), body.image_url.strip()
    c.is_active, c.position = body.is_active, body.position
    c.product_ids = await _slugs_to_ids(session, body.product_slugs)
    c.category_slug, c.brand = body.category_slug.strip(), body.brand.strip()
    c.min_price_paise, c.max_price_paise = body.min_price_paise, body.max_price_paise


@router.get("/admin/collections")
async def admin_collections(admin: Perm("marketing"), session: SessionDep) -> dict:
    rows = (await session.execute(select(ProductCollection).order_by(ProductCollection.position, ProductCollection.created_at))).scalars().all()
    return {"items": [await _out(session, c) for c in rows]}


@router.post("/admin/collections", status_code=201)
async def create_collection(body: CollectionIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = ProductCollection(slug=await _unique_slug(session, body.slug or body.title), title=body.title)
    await _apply(session, c, body)
    session.add(c)
    audit(session, admin, "collection.create", "collection", c.slug)
    await session.commit()
    return await _out(session, c)


@router.put("/admin/collections/{collection_id}")
async def edit_collection(collection_id: uuid.UUID, body: CollectionIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = await session.get(ProductCollection, collection_id)
    if c is None:
        raise NotFound("Collection")
    if body.slug.strip() and slugify(body.slug, 70) != c.slug:
        c.slug = await _unique_slug(session, body.slug, c.id)
    await _apply(session, c, body)
    audit(session, admin, "collection.edit", "collection", c.slug)
    await session.commit()
    return await _out(session, c)


@router.delete("/admin/collections/{collection_id}")
async def delete_collection(collection_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    c = await session.get(ProductCollection, collection_id)
    if c is None:
        raise NotFound("Collection")
    audit(session, admin, "collection.delete", "collection", c.slug)
    await session.delete(c)
    await session.commit()
    return {"ok": True}


@router.get("/catalog/collections")
async def public_collections(session: SessionDep) -> dict:
    rows = (await session.execute(select(ProductCollection).where(ProductCollection.is_active.is_(True)).order_by(ProductCollection.position, ProductCollection.created_at))).scalars().all()
    return {"items": [{"slug": c.slug, "title": c.title, "description": c.description, "image_url": c.image_url} for c in rows]}


async def collection_products(session, c: ProductCollection) -> list[Product]:
    """The products a collection shows (also used by home page rows set to "a collection")."""
    base = select(Product).where(*public_product_filter())
    if c.product_ids:
        ids = [uuid.UUID(i) for i in c.product_ids]
        rows = {p.id: p for p in (await session.execute(base.where(Product.id.in_(ids)))).scalars()}
        products = [rows[i] for i in ids if i in rows][:MAX_SHOWN]
    else:
        if c.category_slug:
            cat = (await session.execute(select(Category).where(Category.slug == c.category_slug))).scalar_one_or_none()
            if cat is None:
                return []
            base = base.where(Product.category_id.in_(await category_descendant_ids(session, cat.id)))
        if c.brand:
            base = base.where(func.lower(Product.brand) == c.brand.lower())
        if c.min_price_paise is not None:
            base = base.where(Product.price_from >= c.min_price_paise)
        if c.max_price_paise is not None:
            base = base.where(Product.price_from <= c.max_price_paise)
        products = list((await session.execute(base.order_by(Product.sold_count.desc(), Product.id).limit(MAX_SHOWN))).scalars())
    return products


@router.get("/catalog/collections/{slug}")
async def public_collection(slug: str, session: SessionDep) -> dict:
    c = (await session.execute(select(ProductCollection).where(ProductCollection.slug == slug.lower(), ProductCollection.is_active.is_(True)))).scalar_one_or_none()
    if c is None:
        raise NotFound("Collection")
    products = await collection_products(session, c)
    return {"slug": c.slug, "title": c.title, "description": c.description, "image_url": c.image_url, "products": await product_cards(session, products)}
