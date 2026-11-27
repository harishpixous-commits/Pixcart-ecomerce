from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
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
