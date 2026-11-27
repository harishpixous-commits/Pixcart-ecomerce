from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

SELLER_STATUSES = ("draft", "submitted", "approved", "rejected", "suspended")
BUSINESS_TYPES = ("individual", "proprietorship", "partnership", "llp", "private_limited", "public_limited")
DOCUMENT_KINDS = ("pan_card", "gst_certificate", "cancelled_cheque", "address_proof")


class Seller(IdMixin, TimestampMixin, Base):
    __tablename__ = "sellers"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), unique=True)
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)

    display_name: Mapped[str] = mapped_column(String(80))
    slug: Mapped[str] = mapped_column(String(90), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    legal_name: Mapped[str] = mapped_column(String(160), default="")
    business_type: Mapped[str] = mapped_column(String(20), default="proprietorship")
    gstin: Mapped[str | None] = mapped_column(String(15), unique=True)
    pan_enc: Mapped[str | None] = mapped_column(Text)
    pan_last4: Mapped[str] = mapped_column(String(4), default="")
    contact_email: Mapped[str] = mapped_column(String(254), default="")
    contact_phone: Mapped[str] = mapped_column(String(15), default="")

    pickup_line1: Mapped[str] = mapped_column(String(200), default="")
    pickup_line2: Mapped[str] = mapped_column(String(200), default="")
    pickup_city: Mapped[str] = mapped_column(String(80), default="")
    pickup_state_code: Mapped[str] = mapped_column(String(2), default="")
    pickup_pincode: Mapped[str] = mapped_column(String(6), default="")

    bank_holder_name: Mapped[str] = mapped_column(String(120), default="")
    bank_account_enc: Mapped[str | None] = mapped_column(Text)
    bank_account_last4: Mapped[str] = mapped_column(String(4), default="")
    bank_ifsc: Mapped[str] = mapped_column(String(11), default="")

    # Consumer Protection (E-Commerce) Rules 2020: each seller names a grievance officer.
    grievance_name: Mapped[str] = mapped_column(String(120), default="")
    grievance_email: Mapped[str] = mapped_column(String(254), default="")
    grievance_phone: Mapped[str] = mapped_column(String(15), default="")

    commission_bps_override: Mapped[int | None] = mapped_column(Integer)
    rejection_reason: Mapped[str] = mapped_column(Text, default="")
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    razorpay_account_id: Mapped[str] = mapped_column(String(40), default="")
    dispatch_days: Mapped[int] = mapped_column(Integer, default=2, server_default="2")
    # "HH:MM" (IST). Orders placed after this time are packed the next working day; "" = no cut-off shown.
    dispatch_cutoff: Mapped[str] = mapped_column(String(5), default="", server_default="")
    # Own free-delivery threshold (paise); empty = the marketplace one. Used only while Growth -> Seller shipping is on.
    free_shipping_threshold_paise: Mapped[int | None] = mapped_column(BigInteger)
    holiday_mode: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    invoice_prefix: Mapped[str] = mapped_column(String(5), default="", server_default="")
    payout_contact_id: Mapped[str] = mapped_column(String(40), default="", server_default="")
    payout_fund_account_id: Mapped[str] = mapped_column(String(40), default="", server_default="")
    rating_avg: Mapped[float] = mapped_column(Numeric(3, 2), default=0, server_default="0")
    rating_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("status IN ('draft','submitted','approved','rejected','suspended')", name="status"),
        CheckConstraint(
            "business_type IN ('individual','proprietorship','partnership','llp','private_limited','public_limited')",
            name="business_type",
        ),
        CheckConstraint("commission_bps_override IS NULL OR commission_bps_override BETWEEN 0 AND 5000", name="commission"),
        CheckConstraint("dispatch_days BETWEEN 0 AND 10", name="dispatch_days"),
    )


class SellerDocument(IdMixin, Base):
    __tablename__ = "seller_documents"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(20))
    storage_key: Mapped[str] = mapped_column(String(300))
    filename: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(60))
    size_bytes: Mapped[int] = mapped_column(Integer)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("seller_id", "kind", name="uq_seller_documents_seller_kind"),
        CheckConstraint("kind IN ('pan_card','gst_certificate','cancelled_cheque','address_proof')", name="kind"),
    )
