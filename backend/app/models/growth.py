from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, UniqueConstraint
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
