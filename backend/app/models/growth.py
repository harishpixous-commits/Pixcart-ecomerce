from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin


class LoyaltyEntry(IdMixin, Base):
    """Loyalty points of a customer. Positive = earned, negative = spent or taken back. One 'earn' per package."""

    __tablename__ = "loyalty_ledger"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(10))
    points: Mapped[int] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("kind IN ('earn','redeem','expire','adjust','reverse')", name="kind"),
        UniqueConstraint("sub_order_id", "kind", name="uq_loyalty_sub_kind"),
    )


class Referral(IdMixin, Base):
    """A friend who joined with a customer's code. One row per friend. Rewards are credited as loyalty points."""

    __tablename__ = "referrals"

    referrer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    referee_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    status: Mapped[str] = mapped_column(String(10), default="joined")
    reward_paise: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    rewarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('joined','rewarded','capped')", name="status"),)


class CartReminder(IdMixin, Base):
    """One abandoned-cart reminder sent to a customer (stage 1, 2, ...). The stages of a cart restart when its items change."""

    __tablename__ = "cart_reminders"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    stage: Mapped[int] = mapped_column(Integer)
    cart_paise: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GiftCard(IdMixin, Base):
    """A prepaid gift card. Staff issue it; the holder turns some or all of the balance into a single-use coupon."""

    __tablename__ = "gift_cards"

    code: Mapped[str] = mapped_column(String(20), unique=True)
    initial_paise: Mapped[int] = mapped_column(Integer)
    balance_paise: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(8), default="active")
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('active','void')", name="status"), CheckConstraint("balance_paise >= 0", name="balance"))


class GiftCardUse(IdMixin, Base):
    """Balance moved into a coupon. If the coupon runs out unused, the amount goes back to the card (restored)."""

    __tablename__ = "gift_card_uses"

    gift_card_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("gift_cards.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    coupon_code: Mapped[str] = mapped_column(String(30))
    amount_paise: Mapped[int] = mapped_column(Integer)
    restored: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GiftCardPurchase(IdMixin, Base):
    """A shopper buying a gift card online. The card is issued only after the gateway itself reports the money as captured."""

    __tablename__ = "gift_card_purchases"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    amount_paise: Mapped[int] = mapped_column(Integer)
    gateway: Mapped[str] = mapped_column(String(20))
    gateway_ref: Mapped[str] = mapped_column(String(100))
    client_data: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(8), default="created")
    gift_card_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("gift_cards.id", ondelete="SET NULL"))
    error: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('created','issued','failed')", name="status"),
                      UniqueConstraint("gateway", "gateway_ref", name="uq_gift_purchase_ref"))


class SegmentCampaign(IdMixin, Base):
    """One in-app message staff sent to a customer segment (opted-in customers only)."""

    __tablename__ = "segment_campaigns"

    segment: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(80))
    message: Mapped[str] = mapped_column(String(300))
    link: Mapped[str] = mapped_column(String(200), default="")
    recipients: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(10), default="sent", server_default="sent")  # sent | scheduled | cancelled
    send_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SavedSearch(IdMixin, Base):
    """A search a shopper follows. When a newly approved product matches every word (and the price limit), the shopper gets one in-app note."""

    __tablename__ = "saved_searches"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    query: Mapped[str] = mapped_column(String(120))
    max_price_paise: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OrderNote(IdMixin, Base):
    """A private note staff leave on an order. Customers and sellers never see it. Notes are not edited or deleted, so they stay a record."""

    __tablename__ = "order_notes"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    author_name: Mapped[str] = mapped_column(String(120), default="")
    note: Mapped[str] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
