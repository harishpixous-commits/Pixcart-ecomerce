"""Deals (lightning, deal of the day, limited time) and sponsored products (seller advertising)."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

DEAL_KINDS = ("lightning", "deal_of_day", "limited")
DEAL_STATUSES = ("pending", "approved", "rejected", "active", "ended", "cancelled")


class Deal(IdMixin, TimestampMixin, Base):
    """A time-boxed lower price on one product version. While it runs, the version's selling price *is* the deal
    price (so cart, checkout, invoices and payouts need no special case); the regular price is restored at the end."""

    __tablename__ = "deals"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    variant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("variants.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(12))
    deal_price_paise: Mapped[int] = mapped_column(BigInteger)
    regular_price_paise: Mapped[int | None] = mapped_column(BigInteger)  # saved when the deal starts
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    qty_limit: Mapped[int | None] = mapped_column(Integer)  # lightning deals: units available at the deal price
    sold_qty: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    note: Mapped[str] = mapped_column(String(300), default="")  # why it was rejected or ended

    __table_args__ = (
        CheckConstraint("kind IN ('lightning','deal_of_day','limited')", name="kind"),
        CheckConstraint("status IN ('pending','approved','rejected','active','ended','cancelled')", name="status"),
        CheckConstraint("deal_price_paise > 0", name="price"),
        CheckConstraint("ends_at > starts_at", name="window"),
        Index("ix_deals_status_starts_at", "status", "starts_at"),
    )


class AdCampaign(IdMixin, TimestampMixin, Base):
    """Sponsored products: a seller pays per click to show chosen products in search results, on product pages
    and on the home page, within a daily (and optional total) budget."""

    __tablename__ = "ad_campaigns"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    placements: Mapped[list] = mapped_column(JSONB, default=list)  # search | product | home
    keywords: Mapped[list] = mapped_column(JSONB, default=list)  # empty = automatic targeting
    bid_paise: Mapped[int] = mapped_column(BigInteger)  # cost per click
    daily_budget_paise: Mapped[int] = mapped_column(BigInteger)
    total_budget_paise: Mapped[int | None] = mapped_column(BigInteger)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    spend_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    note: Mapped[str] = mapped_column(String(300), default="")

    __table_args__ = (
        CheckConstraint("status IN ('pending','active','paused','rejected','ended')", name="status"),
        CheckConstraint("bid_paise > 0 AND daily_budget_paise > 0", name="money"),
    )


class AdCampaignProduct(Base):
    __tablename__ = "ad_campaign_products"

    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ad_campaigns.id", ondelete="CASCADE"), primary_key=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)


class AdStat(Base):
    """Impressions, clicks and spend per campaign, product and day (India time). Billed to the seller once the day is over."""

    __tablename__ = "ad_stats"

    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ad_campaigns.id", ondelete="CASCADE"), primary_key=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    spend_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    billed: Mapped[bool] = mapped_column(Boolean, default=False)


class AdClick(IdMixin, Base):
    __tablename__ = "ad_clicks"

    campaign_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("ad_campaigns.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"))
    placement: Mapped[str] = mapped_column(String(10))
    visitor: Mapped[str] = mapped_column(String(64), index=True)  # hash of address and browser; no raw IP is kept
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True)
    cost_paise: Mapped[int] = mapped_column(BigInteger, default=0)  # 0 = repeat click, not charged
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
