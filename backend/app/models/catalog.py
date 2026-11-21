from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

PRODUCT_STATUSES = ("draft", "pending", "approved", "rejected", "archived")
# Rates in basis points. Covers the post-September-2025 slabs (0, 5, 18, 40) plus the
# special 0.25% / 3% rates and the legacy 12% / 28% slabs some goods still carry.
GST_RATES_BPS = (0, 25, 300, 500, 1200, 1800, 2800, 4000)


class Category(IdMixin, TimestampMixin, Base):
    __tablename__ = "categories"

    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="RESTRICT"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    slug: Mapped[str] = mapped_column(String(90), unique=True)
    image_url: Mapped[str] = mapped_column(String(400), default="")
    commission_bps: Mapped[int] = mapped_column(Integer, default=1000)
    default_gst_bps: Mapped[int] = mapped_column(Integer, default=1800)
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Product information sellers must fill in before a listing in this category can be submitted
    # (keys from services.product_info.REQUIRABLE); sub-categories inherit their parents' list.
    required_details: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # Return policy: the window a new listing starts with, and the shortest window a seller may set.
    return_window_days: Mapped[int] = mapped_column(Integer, default=7, server_default="7")
    min_return_window_days: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("commission_bps BETWEEN 0 AND 5000", name="commission"),
        CheckConstraint("default_gst_bps IN (0,25,300,500,1200,1800,2800,4000)", name="gst"),
        CheckConstraint("return_window_days BETWEEN 0 AND 30", name="return_window"),
        CheckConstraint("min_return_window_days BETWEEN 0 AND return_window_days", name="min_return_window"),
    )


class Product(IdMixin, TimestampMixin, Base):
    __tablename__ = "products"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="RESTRICT"), index=True)
    category_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="RESTRICT"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(230), unique=True)
    brand: Mapped[str] = mapped_column(String(80), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    highlights: Mapped[list] = mapped_column(JSONB, default=list)
    specs: Mapped[dict] = mapped_column(JSONB, default=dict)
    hsn_code: Mapped[str] = mapped_column(String(8), default="")
    gst_bps: Mapped[int] = mapped_column(Integer, default=1800)
    country_of_origin: Mapped[str] = mapped_column(String(60), default="India")
    return_window_days: Mapped[int] = mapped_column(Integer, default=7)
    status: Mapped[str] = mapped_column(String(10), default="draft", index=True)
    rejection_reason: Mapped[str] = mapped_column(Text, default="")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Denormalised from active variants so listing pages sort/filter without joins.
    price_from: Mapped[int] = mapped_column(BigInteger, default=0)
    mrp_from: Mapped[int] = mapped_column(BigInteger, default=0)
    in_stock: Mapped[bool] = mapped_column(Boolean, default=False)
    rating_avg: Mapped[float] = mapped_column(Numeric(3, 2), default=0)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)
    sold_count: Mapped[int] = mapped_column(Integer, default=0)
    review_summary: Mapped[str] = mapped_column(Text, default="", server_default="")
    review_summary_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Legal Metrology declarations and product information (see services.product_info.ProductDetails).
    details: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    search_vector: Mapped[str] = mapped_column(
        TSVECTOR,
        Computed(
            "setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || "
            "setweight(to_tsvector('simple'::regconfig, coalesce(brand, '')), 'A') || "
            "setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'C')",
            persisted=True,
        ),
    )

    __table_args__ = (
        CheckConstraint("status IN ('draft','pending','approved','rejected','archived')", name="status"),
        CheckConstraint("gst_bps IN (0,25,300,500,1200,1800,2800,4000)", name="gst"),
        CheckConstraint("return_window_days BETWEEN 0 AND 30", name="return_window"),
        Index("ix_products_search_vector", "search_vector", postgresql_using="gin"),
        Index("ix_products_title_trgm", "title", postgresql_using="gin", postgresql_ops={"title": "gin_trgm_ops"}),
        Index("ix_products_listing", "status", "category_id", "price_from"),
    )


class ProductImage(IdMixin, Base):
    __tablename__ = "product_images"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(400))
    position: Mapped[int] = mapped_column(Integer, default=0)


class ProductVideo(IdMixin, Base):
    """A product video (MP4 or WebM uploaded through the platform), shown in the gallery and its video player."""

    __tablename__ = "product_videos"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    url: Mapped[str] = mapped_column(String(400))
    poster_url: Mapped[str] = mapped_column(String(400), default="")  # a frame captured in the browser at upload
    title: Mapped[str] = mapped_column(String(120), default="")
    duration_s: Mapped[int] = mapped_column(Integer, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)


class Variant(IdMixin, TimestampMixin, Base):
    __tablename__ = "variants"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="RESTRICT"))
    sku: Mapped[str] = mapped_column(String(60))
    options: Mapped[dict] = mapped_column(JSONB, default=dict)  # e.g. {"Size": "M", "Colour": "Blue"}
    mrp_paise: Mapped[int] = mapped_column(BigInteger)
    price_paise: Mapped[int] = mapped_column(BigInteger)
    stock: Mapped[int] = mapped_column(Integer, default=0)
    weight_grams: Mapped[int] = mapped_column(Integer, default=500)
    # Net quantity in the product's unit (details["net_unit"]), for the unit sale price (e.g. 50 for 50 g).
    net_qty: Mapped[float | None] = mapped_column(Numeric(12, 3))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (
        UniqueConstraint("seller_id", "sku", name="uq_variants_seller_sku"),
        CheckConstraint("price_paise > 0", name="price_positive"),
        CheckConstraint("price_paise <= mrp_paise", name="price_le_mrp"),
        CheckConstraint("stock >= 0", name="stock_non_negative"),
    )
