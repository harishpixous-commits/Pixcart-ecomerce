"""Seller catalogue management: listings with variants and images, submission for review, stock."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, exists, func, or_, select

from app.config import settings
from app.core.deps import CurrentUser, SellerAccount, SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.db import utcnow
from app.models import Category, OrderItem, Product, ProductImage, Seller, Variant
from app.models.catalog import GST_RATES_BPS
from app.services import bulk_edit, inventory, storage
from app.services.catalog import (
    apply_videos,
    check_image_url,
    check_video_url,
    discount_pct,
    images_for,
    leaf_category,
    listing_return_window,
    refresh_product_aggregates,
    unique_product_slug,
    variant_label,
    videos_for,
)
from app.services.platform_settings import get_settings
from app.services.product_info import REQUIRABLE, ProductDetails, details_of, effective_required, missing_required

router = APIRouter(prefix="/api/seller", tags=["seller-products"])

MAX_IMAGES = 8
MAX_VARIANTS = 50
CONTENT_FIELDS = ("category_id", "title", "brand", "description", "highlights", "specs", "hsn_code", "gst_bps", "country_of_origin", "return_window_days",
                  "details", "size_guide")


class VariantIn(BaseModel):
    id: uuid.UUID | None = None
    sku: str = Field(min_length=1, max_length=60, pattern=r"^[A-Za-z0-9._\-/]+$")
    options: dict[str, str] = Field(default_factory=dict)
    mrp_paise: int = Field(gt=0, le=100_000_000)
    price_paise: int = Field(gt=0, le=100_000_000)
    stock: int = Field(ge=0, le=1_000_000)
    weight_grams: int = Field(default=500, ge=1, le=100_000)
    net_qty: float | None = Field(default=None, gt=0, le=1_000_000)  # in the listing's net quantity unit
    is_active: bool = True

    @field_validator("options")
    @classmethod
    def _options(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 3:
            raise ValueError("At most 3 option types (e.g. Size, Colour)")
        clean = {}
        for k, val in v.items():
            k, val = k.strip()[:30], str(val).strip()[:40]
            if not k or not val:
                raise ValueError("Option names and values cannot be empty")
            clean[k] = val
        return clean

    @model_validator(mode="after")
    def _price(self) -> VariantIn:
        if self.price_paise > self.mrp_paise:
            raise ValueError("Selling price cannot be more than MRP")
        return self


class VideoIn(BaseModel):
    url: str
    poster_url: str = ""
    title: str = Field(default="", max_length=120)
    duration_s: int = Field(default=0, ge=0, le=3600)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        return check_video_url(v)

    @field_validator("poster_url")
    @classmethod
    def _poster(cls, v: str) -> str:
        return check_image_url(v) if v else ""


async def check_videos(session, videos: list[VideoIn]) -> None:
    """Admin switches: videos on or off, and how many a listing may have."""
    if not videos:
        return
    cfg = await get_settings(session)
    if not cfg["feature_product_videos"]:
        raise ApiError("Product videos are switched off on this marketplace", "videos_off")
    if len(videos) > cfg["max_videos_per_listing"]:
        raise ApiError(f"At most {cfg['max_videos_per_listing']} videos per listing", "too_many_videos")


class ProductIn(BaseModel):
    category_id: uuid.UUID
    title: str = Field(min_length=10, max_length=200)
    brand: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=10_000)
    highlights: list[str] = Field(default_factory=list, max_length=10)
    specs: dict[str, str] = Field(default_factory=dict)
    hsn_code: str = Field(pattern=r"^\d{4}(\d{2}){0,2}$")
    gst_bps: int
    country_of_origin: str = Field(default="India", min_length=2, max_length=60)
    return_window_days: int | None = Field(default=None, ge=0, le=30)  # none: the category's default
    size_guide: str = Field(default="", max_length=2000)  # empty: the category's guide is shown
    images: list[str] = Field(default_factory=list, max_length=MAX_IMAGES)
    videos: list[VideoIn] = Field(default_factory=list, max_length=10)
    variants: list[VariantIn] = Field(min_length=1, max_length=MAX_VARIANTS)
    details: ProductDetails = Field(default_factory=ProductDetails)

    @field_validator("size_guide")
    @classmethod
    def _size_guide(cls, v: str) -> str:
        from app.services.size_guide import clean

        return clean(v)

    @field_validator("gst_bps")
    @classmethod
    def _gst(cls, v: int) -> int:
        if v not in GST_RATES_BPS:
            raise ValueError("Choose a valid GST rate")
        return v

    @field_validator("highlights")
    @classmethod
    def _highlights(cls, v: list[str]) -> list[str]:
        return [h.strip()[:200] for h in v if h.strip()]

    @field_validator("specs")
    @classmethod
    def _specs(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 40:
            raise ValueError("At most 40 specifications")
        return {k.strip()[:60]: str(val).strip()[:300] for k, val in v.items() if k.strip() and str(val).strip()}

    @field_validator("images")
    @classmethod
    def _images(cls, v: list[str]) -> list[str]:
        return [check_image_url(u) for u in v]

    @model_validator(mode="after")
    def _variants(self) -> ProductIn:
        skus = [x.sku.lower() for x in self.variants]
        if len(set(skus)) != len(skus):
            raise ValueError("Each variant needs a different SKU")
        if len(self.variants) > 1:
            keys = {tuple(sorted(x.options)) for x in self.variants}
            if len(keys) != 1 or keys == {()}:
                raise ValueError("All variants must use the same option types (e.g. Size and Colour)")
            combos = [tuple(sorted(x.options.items())) for x in self.variants]
            if len(set(combos)) != len(combos):
                raise ValueError("Two variants have the same options")
        return self


class VariantPatch(BaseModel):
    price_paise: int | None = Field(default=None, gt=0, le=100_000_000)
    mrp_paise: int | None = Field(default=None, gt=0, le=100_000_000)
    stock: int | None = Field(default=None, ge=0, le=1_000_000)
    is_active: bool | None = None


def variant_out(v: Variant) -> dict:
    return {
        "id": str(v.id),
        "sku": v.sku,
        "options": v.options,
        "label": variant_label(v.options),
        "mrp_paise": v.mrp_paise,
        "price_paise": v.price_paise,
        "discount_pct": discount_pct(v.price_paise, v.mrp_paise),
        "stock": v.stock,
        "weight_grams": v.weight_grams,
        "net_qty": float(v.net_qty) if v.net_qty is not None else None,
        "is_active": v.is_active,
    }


async def product_detail(session, p: Product) -> dict:
    variants = list((await session.execute(select(Variant).where(Variant.product_id == p.id).order_by(Variant.created_at))).scalars())
    imgs = (await images_for(session, [p.id])).get(p.id, [])
    vids = (await videos_for(session, [p.id])).get(p.id, [])
    cat = await session.get(Category, p.category_id)
    details = details_of(p.details)
    required = await required_for(session, p.category_id)
    missing = missing_required(required, brand=p.brand, country_of_origin=p.country_of_origin, details=details,
                               net_qtys=[v.net_qty for v in variants if v.is_active])
    return {
        "id": str(p.id),
        "slug": p.slug,
        "status": p.status,
        "rejection_reason": p.rejection_reason,
        "category_id": str(p.category_id),
        "category_name": cat.name if cat else "",
        "title": p.title,
        "brand": p.brand,
        "description": p.description,
        "highlights": p.highlights,
        "specs": p.specs,
        "hsn_code": p.hsn_code,
        "gst_bps": p.gst_bps,
        "country_of_origin": p.country_of_origin,
        "return_window_days": p.return_window_days,
        "size_guide": p.size_guide or "",
        "images": imgs,
        "videos": vids,
        "details": details.model_dump(),
        "required_details": required,
        "missing_details": missing,
        "variants": [variant_out(v) for v in variants],
        "price_from": p.price_from,
        "mrp_from": p.mrp_from,
        "in_stock": p.in_stock,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


async def required_for(session, category_id: uuid.UUID) -> list[str]:
    """Product information the category (or a parent) makes compulsory."""
    chain = []
    cur = await session.get(Category, category_id)
    while cur is not None:
        chain.append(cur)
        cur = await session.get(Category, cur.parent_id) if cur.parent_id else None
    return effective_required(chain)


async def _owned(session, seller_id: uuid.UUID, product_id: uuid.UUID, *, lock: bool = False) -> Product:
    stmt = select(Product).where(Product.id == product_id)
    if lock:
        stmt = stmt.with_for_update()
    p = (await session.execute(stmt)).scalar_one_or_none()
    if p is None or p.seller_id != seller_id:
        raise NotFound("Product")
    return p


async def _sku_conflict(session, seller_id: uuid.UUID, sku: str, exclude_variant: uuid.UUID | None) -> bool:
    stmt = select(Variant.id).where(Variant.seller_id == seller_id, func.lower(Variant.sku) == sku.lower())
    if exclude_variant:
        stmt = stmt.where(Variant.id != exclude_variant)
    return (await session.execute(stmt)).first() is not None


async def _apply_variants(session, seller: Seller, product: Product, items: list[VariantIn], actor_id=None) -> None:
    seller_id = seller.id
    existing = {v.id: v for v in (await session.execute(select(Variant).where(Variant.product_id == product.id))).scalars()}
    from app.services.deals import active_variant_ids

    in_deal = await active_variant_ids(session, list(existing))
    seen: set[uuid.UUID] = set()
    for item in items:
        if await _sku_conflict(session, seller_id, item.sku, item.id):
            raise Conflict(f"SKU '{item.sku}' is already used in another of your listings", "sku_taken")
        if item.id is not None:
            v = existing.get(item.id)
            if v is None:
                raise ApiError("A variant in this request does not belong to this product", "variant_mismatch")
            seen.add(v.id)
            if v.id in in_deal and item.price_paise != v.price_paise:
                raise Conflict(f"'{item.sku}' is in a running deal; change its price after the deal ends (or cancel the deal)", "deal_running")
        else:
            v = Variant(product_id=product.id, seller_id=seller_id)
            session.add(v)
        v.sku, v.options = item.sku, item.options
        v.mrp_paise, v.price_paise = item.mrp_paise, item.price_paise
        v.weight_grams, v.is_active = item.weight_grams, item.is_active
        v.net_qty = item.net_qty
        if v.stock is None:
            v.stock = 0
        await session.flush()
        if item.stock != v.stock:
            await inventory.set_total_via_default(session, seller, v, item.stock, actor_id=actor_id)
    for vid, v in existing.items():
        if vid in seen:
            continue
        used = (await session.execute(select(exists().where(OrderItem.variant_id == vid)))).scalar()
        if used:
            v.is_active = False  # keep history for past orders
        else:
            await session.delete(v)
    await session.flush()


async def _apply_images(session, product: Product, urls: list[str]) -> None:
    await session.execute(delete(ProductImage).where(ProductImage.product_id == product.id))
    for i, url in enumerate(urls):
        session.add(ProductImage(product_id=product.id, url=url, position=i))


@router.get("/listing-requirements")
async def listing_requirements(seller: SellerAccount, session: SessionDep, category_id: uuid.UUID) -> dict:
    """What a listing in this category must include, for the product editor."""
    return {"required": await required_for(session, category_id), "labels": REQUIRABLE}


@router.post("/images", status_code=201)
async def upload_image(seller: SellerAccount, file: UploadFile = File(...)) -> dict:
    data = await file.read(settings.max_image_bytes + 1)  # never buffer more than the limit
    url = await storage.save_image(data, "products")
    return {"url": url}


@router.post("/videos", status_code=201)
async def upload_video(seller: SellerAccount, session: SessionDep, file: UploadFile = File(...)) -> dict:
    cfg = await get_settings(session)
    if not cfg["feature_product_videos"]:
        raise ApiError("Product videos are switched off on this marketplace", "videos_off")
    limit = cfg["max_video_mb"] * 1024 * 1024
    data = await file.read(limit + 1)  # never buffer more than the limit
    return {"url": await storage.save_video(data, limit)}


@router.get("/products")
async def list_products(
    seller: SellerAccount,
    session: SessionDep,
    status: Literal["draft", "pending", "approved", "rejected", "archived"] | None = None,
    q: str = Query(default="", max_length=100),
    low_stock: bool = False,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> dict:
    stmt = select(Product).where(Product.seller_id == seller.id)
    if status:
        stmt = stmt.where(Product.status == status)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Product.title.ilike(like), Product.id.in_(select(Variant.product_id).where(Variant.sku.ilike(like)))))
    if low_stock:
        stmt = stmt.where(Product.id.in_(select(Variant.product_id).where(Variant.is_active.is_(True),
                                                                         Variant.stock <= (await get_settings(session))["low_stock_threshold"])))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await session.execute(stmt.order_by(Product.updated_at.desc()).offset((page - 1) * page_size).limit(page_size))).scalars())
    imgs = await images_for(session, [p.id for p in rows])
    stock = dict(
        (await session.execute(
            select(Variant.product_id, func.coalesce(func.sum(Variant.stock), 0))
            .where(Variant.product_id.in_([p.id for p in rows]), Variant.is_active.is_(True))
            .group_by(Variant.product_id)
        )).all()
    ) if rows else {}
    counts = dict((await session.execute(select(Product.status, func.count()).where(Product.seller_id == seller.id).group_by(Product.status))).all())
    return {
        "items": [
            {
                "id": str(p.id),
                "title": p.title,
                "slug": p.slug,
                "status": p.status,
                "rejection_reason": p.rejection_reason,
                "image": (imgs.get(p.id) or [""])[0],
                "price_from": p.price_from,
                "mrp_from": p.mrp_from,
                "total_stock": int(stock.get(p.id, 0)),
                "updated_at": p.updated_at.isoformat(),
            }
            for p in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
        "status_counts": counts,
        "low_stock_threshold": (await get_settings(session))["low_stock_threshold"],
    }


@router.post("/products", status_code=201)
async def create_product(body: ProductIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    if seller.status in ("suspended",):
        raise Conflict("Your seller account is suspended", "seller_suspended")
    cat = await leaf_category(session, body.category_id)
    body.return_window_days = listing_return_window(cat, body.return_window_days)
    p = Product(
        seller_id=seller.id,
        slug=await unique_product_slug(session, body.title),
        status="draft",
        **body.model_dump(include=set(CONTENT_FIELDS)),
    )
    p.title, p.brand = body.title.strip(), body.brand.strip()
    session.add(p)
    await session.flush()
    await check_videos(session, body.videos)
    await _apply_variants(session, seller, p, body.variants, user.id)
    await _apply_images(session, p, body.images)
    await apply_videos(session, p.id, body.videos)
    await refresh_product_aggregates(session, p)
    audit(session, user, "product.create", "product", p.id)
    await session.commit()
    return await product_detail(session, p)


@router.get("/products/import-template.csv")
async def import_template(seller: SellerAccount) -> Response:
    from app.services.product_import import template_csv

    return Response(template_csv(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="listing-upload-template.csv"'})


@router.post("/products/import")
async def import_products(seller: SellerAccount, user: CurrentUser, session: SessionDep, file: UploadFile = File(...), dry_run: bool = Query(default=True)) -> dict:
    """Bulk listing upload. dry_run=true (default) only checks the file; false creates the valid products as drafts."""
    from app.core.deps import rate_limit
    from app.services.product_import import MAX_BYTES, parse

    if seller.status == "suspended":
        raise Conflict("Your seller account is suspended", "seller_suspended")
    await rate_limit(session, f"product-import:{seller.id}", limit=30, window_seconds=3600)
    products, file_errors = await parse(session, seller, await file.read(MAX_BYTES + 1))
    created = []
    if not dry_run:
        for item in products:
            body = item["payload"]
            if body is None:
                continue
            p = Product(seller_id=seller.id, slug=await unique_product_slug(session, body.title), status="draft", **body.model_dump(include=set(CONTENT_FIELDS)))
            p.title, p.brand = body.title.strip(), body.brand.strip()
            session.add(p)
            await session.flush()
            await _apply_variants(session, seller, p, body.variants, user.id)
            await refresh_product_aggregates(session, p)
            created.append({"key": item["key"], "id": str(p.id), "title": p.title})
        audit(session, user, "product.import", "seller", seller.id, f"{len(created)} products from {file.filename}"[:200])
        await session.commit()
    else:
        await session.commit()  # keep the rate-limit record
    return {
        "dry_run": dry_run,
        "file_errors": file_errors,
        "products": [{k: v for k, v in p.items() if k != "payload"} for p in products],
        "valid": sum(1 for p in products if p["payload"] is not None),
        "invalid": sum(1 for p in products if p["payload"] is None),
        "created": created,
    }


@router.get("/products/{product_id}")
async def get_product(product_id: uuid.UUID, seller: SellerAccount, session: SessionDep) -> dict:
    return await product_detail(session, await _owned(session, seller.id, product_id))


@router.put("/products/{product_id}")
async def update_product(product_id: uuid.UUID, body: ProductIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    p = await _owned(session, seller.id, product_id, lock=True)
    if p.status == "archived":
        raise Conflict("Restore this product before editing it", "archived")
    cat = await leaf_category(session, body.category_id)
    body.return_window_days = listing_return_window(cat, p.return_window_days if body.return_window_days is None else body.return_window_days)
    before = {f: getattr(p, f) for f in CONTENT_FIELDS}
    before["details"] = details_of(p.details).model_dump()  # compare like with like (older rows have fewer keys)
    before_images = (await images_for(session, [p.id])).get(p.id, [])
    before_videos = [v["url"] for v in (await videos_for(session, [p.id])).get(p.id, [])]
    dumped = body.model_dump(include=set(CONTENT_FIELDS))
    for f in CONTENT_FIELDS:
        setattr(p, f, dumped[f])
    p.title, p.brand = body.title.strip(), body.brand.strip()
    content_changed = (any(before[f] != getattr(p, f) for f in CONTENT_FIELDS) or before_images != body.images
                       or before_videos != [v.url for v in body.videos])
    if [v.url for v in body.videos] != before_videos:
        await check_videos(session, body.videos)
    await _apply_variants(session, seller, p, body.variants, user.id)
    await _apply_images(session, p, body.images)
    await apply_videos(session, p.id, body.videos)
    await refresh_product_aggregates(session, p)
    if content_changed and p.status == "approved":
        # Listing content must be re-checked before customers see it again (price/stock edits do not).
        p.status = "pending"
        p.submitted_at = utcnow()
    audit(session, user, "product.update", "product", p.id, "content changed" if content_changed else "price/stock")
    await session.commit()
    return await product_detail(session, p)


@router.patch("/variants/{variant_id}")
async def patch_variant(variant_id: uuid.UUID, body: VariantPatch, seller: SellerAccount, session: SessionDep) -> dict:
    v = (await session.execute(select(Variant).where(Variant.id == variant_id).with_for_update())).scalar_one_or_none()
    if v is None or v.seller_id != seller.id:
        raise NotFound("Variant")
    price = body.price_paise if body.price_paise is not None else v.price_paise
    mrp = body.mrp_paise if body.mrp_paise is not None else v.mrp_paise
    from app.services.deals import active_variant_ids

    if price != v.price_paise and v.id in await active_variant_ids(session, [v.id]):
        raise Conflict("This version is in a running deal; change its price after the deal ends (or cancel the deal)", "deal_running")
    if price > mrp:
        raise ApiError("Selling price cannot be more than MRP", "price_above_mrp")
    v.price_paise, v.mrp_paise = price, mrp
    if body.stock is not None and body.stock != v.stock:
        await inventory.set_total_via_default(session, seller, v, body.stock)
    if body.is_active is not None:
        v.is_active = body.is_active
    p = await session.get(Product, v.product_id)
    await refresh_product_aggregates(session, p)
    await session.commit()
    return variant_out(v)


class BulkEditIn(BaseModel):
    variant_ids: list[uuid.UUID] = Field(min_length=1, max_length=5000)
    action: str
    value: int | None = None
    dry_run: bool = True


@router.post("/variants/bulk-edit")
async def bulk_edit_variants(body: BulkEditIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    """Change price (by percent), stock or on/off for many of your versions at once. dry_run=true (default) only previews."""
    res = await bulk_edit.apply(session, seller, body.variant_ids, body.action, body.value, body.dry_run)
    if not body.dry_run and res["changed"]:
        audit(session, user, "variant.bulk_edit", "seller", seller.id, f"{body.action} {body.value} x{res['changed']}")
    await session.commit()
    return res


@router.get("/variants/bulk-edit.csv")
async def bulk_edit_csv_download(seller: SellerAccount, session: SessionDep) -> Response:
    """Your versions as a CSV (id, sku, product, price in rupees, stock, active) to edit in a spreadsheet."""
    return Response(await bulk_edit.export_csv(session, seller), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="my-versions.csv"'})


@router.post("/variants/bulk-edit.csv")
async def bulk_edit_csv_upload(seller: SellerAccount, user: CurrentUser, session: SessionDep, file: UploadFile = File(...), dry_run: bool = Query(default=True)) -> dict:
    """Upload the edited CSV. dry_run=true (default) only previews; false applies the rows that are fine."""
    from app.core.deps import rate_limit

    if seller.status == "suspended":
        raise Conflict("Your seller account is suspended", "seller_suspended")
    await rate_limit(session, f"bulk-edit-csv:{seller.id}", limit=60, window_seconds=3600)
    res = await bulk_edit.apply_csv(session, seller, await file.read(bulk_edit.CSV_MAX_BYTES + 1), dry_run)
    if not dry_run and res["changed"]:
        audit(session, user, "variant.bulk_edit_csv", "seller", seller.id, f"x{res['changed']} from {file.filename}"[:200])
    await session.commit()
    return res


@router.post("/products/{product_id}/submit")
async def submit_product(product_id: uuid.UUID, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    p = await _owned(session, seller.id, product_id, lock=True)
    if p.status not in ("draft", "rejected"):
        raise Conflict(f"A {p.status} product cannot be submitted", "invalid_status")
    imgs = (await images_for(session, [p.id])).get(p.id, [])
    active = (await session.execute(select(func.count()).where(Variant.product_id == p.id, Variant.is_active.is_(True)))).scalar_one()
    problems = []
    if not imgs:
        problems.append("add at least one image")
    if not active:
        problems.append("add at least one active variant")
    if len(p.description.strip()) < 30:
        problems.append("write a description of at least 30 characters")
    required = await required_for(session, p.category_id)
    if required:
        net = [v for v in (await session.execute(select(Variant.net_qty).where(Variant.product_id == p.id, Variant.is_active.is_(True)))).scalars()]
        missing = missing_required(required, brand=p.brand, country_of_origin=p.country_of_origin, details=details_of(p.details), net_qtys=net)
        if missing:
            problems.append("fill in " + ", ".join(m.lower() for m in missing))
    if problems:
        raise ApiError("Before submitting, " + ", ".join(problems), "listing_incomplete")
    p.status = "pending"
    p.submitted_at = utcnow()
    p.rejection_reason = ""
    audit(session, user, "product.submit", "product", p.id)
    from app.services.notify import notify_staff

    await notify_staff(session, "catalog", "staff_review", {"subject": "Listing waiting for review", "message": f"{seller.display_name} submitted \"{p.title[:80]}\"."}, link=f"/admin/products/{p.id}")
    await session.commit()
    return await product_detail(session, p)


@router.post("/products/{product_id}/archive")
async def archive_product(product_id: uuid.UUID, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    p = await _owned(session, seller.id, product_id, lock=True)
    p.status = "archived"
    audit(session, user, "product.archive", "product", p.id)
    await session.commit()
    return await product_detail(session, p)


@router.post("/products/{product_id}/restore")
async def restore_product(product_id: uuid.UUID, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    p = await _owned(session, seller.id, product_id, lock=True)
    if p.status != "archived":
        raise Conflict("Only archived products can be restored", "invalid_status")
    p.status = "draft"
    audit(session, user, "product.restore", "product", p.id)
    await session.commit()
    return await product_detail(session, p)


@router.get("/categories")
async def seller_categories(seller: SellerAccount, session: SessionDep) -> list[dict]:
    """Leaf categories with their commission, default GST and return policy, for the listing form."""
    cats = list((await session.execute(select(Category).where(Category.is_active.is_(True)).order_by(Category.position, Category.name))).scalars())
    parents = {c.parent_id for c in cats if c.parent_id}
    by_id = {c.id: c for c in cats}
    out = []
    for c in cats:
        if c.id in parents:
            continue
        path = [c.name]
        cur = c
        while cur.parent_id and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            path.insert(0, cur.name)
        bps = seller.commission_bps_override if seller.commission_bps_override is not None else c.commission_bps
        out.append({"id": str(c.id), "name": c.name, "path": " › ".join(path), "commission_bps": bps, "default_gst_bps": c.default_gst_bps,
                    "return_window_days": c.return_window_days, "min_return_window_days": c.min_return_window_days})
    return sorted(out, key=lambda x: x["path"])


@router.get("/fees")
async def seller_fees(seller: SellerAccount, session: SessionDep) -> dict:
    """What each sale pays besides the category commission, at the rates set in Admin → Marketplace settings (the
    same ones the payout statement uses), for the fee preview in the listing form."""
    cfg = await get_settings(session)
    return {k: cfg[k] for k in ("commission_gst_bps", "tcs_bps", "tds_bps")}

