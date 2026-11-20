"""Own delivery fleet: zones, delivery partners ("delivery boys"), assignments, status logs, payouts and cash deposits.

A package (sub-order) that the fleet delivers has ``shipping_provider = 'fleet'``. When the seller marks it ready for
pickup, staff or the auto-assigner offer it to a delivery partner: each offer is a ``DeliveryAssignment`` row. A
partner accepts within the offer time or rejects with a reason (the row stays as history and the next partner gets a new
row). The accepted row then carries the whole trip: reached the store, picked up (with the seller's pickup code), on the
way, reached, delivered (with the customer's OTP and a proof photo), the cash collected, the fee earned and the rating.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, SmallInteger, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

VEHICLES = ("bike", "scooter", "ev", "cycle", "auto", "van")
KYC_STATUSES = ("draft", "submitted", "approved", "rejected")
# offered: waiting for the partner to accept (expires_at). The rest follow the trip in order.
ASSIGNMENT_STATUSES = ("offered", "accepted", "at_store", "picked", "on_the_way", "reached", "delivered", "rejected", "expired", "cancelled", "failed")
ACTIVE = ("offered", "accepted", "at_store", "picked", "on_the_way", "reached")
ON_TRIP = ("accepted", "at_store", "picked", "on_the_way", "reached")


class DeliveryZone(IdMixin, TimestampMixin, Base):
    """A service area: the PIN codes the fleet covers in a city."""

    __tablename__ = "delivery_zones"

    name: Mapped[str] = mapped_column(String(80), unique=True)
    city: Mapped[str] = mapped_column(String(80))
    pincodes: Mapped[list] = mapped_column(JSONB, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    center_lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    center_lng: Mapped[float | None] = mapped_column(Numeric(9, 6))


class DeliveryBoy(IdMixin, TimestampMixin, Base):
    """A delivery partner. Signs in with their mobile number (an ordinary user account) and goes through KYC."""

    __tablename__ = "delivery_boys"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str] = mapped_column(String(15), index=True)
    photo: Mapped[str] = mapped_column(String(400), default="")
    city: Mapped[str] = mapped_column(String(80), default="")
    address: Mapped[str] = mapped_column(Text, default="")
    license_no: Mapped[str] = mapped_column(String(30), default="")
    license_doc: Mapped[str] = mapped_column(String(300), default="")  # private file key
    id_proof_type: Mapped[str] = mapped_column(String(12), default="")  # aadhaar | pan | voter | passport
    id_proof_last4: Mapped[str] = mapped_column(String(4), default="")
    id_proof_enc: Mapped[str] = mapped_column(Text, default="")  # full number, encrypted (never stored for Aadhaar)
    id_proof_doc: Mapped[str] = mapped_column(String(300), default="")
    vehicle_type: Mapped[str] = mapped_column(String(10), default="bike")
    vehicle_no: Mapped[str] = mapped_column(String(15), default="")
    vehicle_doc: Mapped[str] = mapped_column(String(300), default="")  # registration certificate (RC)
    zone_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_zones.id", ondelete="SET NULL"), index=True)
    is_online: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    kyc_status: Mapped[str] = mapped_column(String(10), default="draft", index=True)
    kyc_note: Mapped[str] = mapped_column(Text, default="")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[float | None] = mapped_column(Numeric(9, 6))
    location_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    online_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # {"holder": "...", "ifsc": "...", "account_last4": "1234", "account_enc": "<encrypted>", "upi": "name@bank"}
    bank_details: Mapped[dict] = mapped_column(JSONB, default=dict)
    rating_avg: Mapped[float] = mapped_column(Numeric(3, 2), default=0)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        CheckConstraint(f"kyc_status IN {KYC_STATUSES}", name="kyc_status"),
        CheckConstraint(f"vehicle_type IN {VEHICLES}", name="vehicle_type"),
        Index("ix_delivery_boys_pool", "zone_id", "is_online", "is_active"),
    )


class DeliveryAssignment(IdMixin, Base):
    """One offer of a package to one partner and, once accepted, that partner's trip."""

    __tablename__ = "delivery_assignments"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    sub_order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"), index=True)
    delivery_boy_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_boys.id", ondelete="RESTRICT"), index=True)
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))  # empty = auto
    mode: Mapped[str] = mapped_column(String(6), default="manual")  # manual | auto
    kind: Mapped[str] = mapped_column(String(8), default="delivery", server_default="delivery")  # delivery | return (back to the seller)
    status: Mapped[str] = mapped_column(String(10), default="offered", index=True)
    reject_reason: Mapped[str] = mapped_column(String(200), default="")
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    at_store_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    picked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    on_the_way_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reached_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # rejected, expired, cancelled or failed
    status_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # last status change, for stuck alerts
    stuck_alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cod_amount: Mapped[int] = mapped_column(BigInteger, default=0)  # to collect from the customer
    cod_collected: Mapped[int] = mapped_column(BigInteger, default=0)
    cod_method: Mapped[str] = mapped_column(String(6), default="")  # cash | upi
    proof_photo: Mapped[str] = mapped_column(String(300), default="")  # private file key
    picked_lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    picked_lng: Mapped[float | None] = mapped_column(Numeric(9, 6))
    drop_lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    drop_lng: Mapped[float | None] = mapped_column(Numeric(9, 6))
    distance_km: Mapped[float | None] = mapped_column(Numeric(7, 2))
    fee_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    tip_paise: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")  # the customer's tip, paid to the partner in full
    payout_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_payouts.id", ondelete="SET NULL"), index=True)
    fail_reason: Mapped[str] = mapped_column(String(200), default="")
    rating: Mapped[int | None] = mapped_column(SmallInteger)
    rating_comment: Mapped[str] = mapped_column(Text, default="")
    rated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(f"status IN {ASSIGNMENT_STATUSES}", name="status"),
        CheckConstraint("mode IN ('manual','auto')", name="mode"),
        CheckConstraint("kind IN ('delivery','return')", name="kind"),
        CheckConstraint("rating IS NULL OR rating BETWEEN 1 AND 5", name="rating"),
        CheckConstraint("cod_collected >= 0 AND cod_amount >= 0 AND fee_paise >= 0", name="money"),
        # one live offer or trip per package at a time, even when two staff assign at once
        Index("uq_delivery_assignments_active", "sub_order_id", unique=True, postgresql_where=text(f"status IN {ACTIVE}")),
        Index("ix_delivery_assignments_boy_status", "delivery_boy_id", "status"),
    )


class OrderStatusLog(IdMixin, Base):
    """Every delivery step with who did it and where: the trail behind tracking, stuck alerts and disputes."""

    __tablename__ = "order_status_logs"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"), index=True)
    assignment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_assignments.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(20))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    actor: Mapped[str] = mapped_column(String(10), default="system")  # delivery | seller | admin | customer | system
    note: Mapped[str] = mapped_column(Text, default="")
    lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[float | None] = mapped_column(Numeric(9, 6))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DeliveryPayout(IdMixin, Base):
    """A partner's earnings for one week (Monday to Sunday), paid by staff."""

    __tablename__ = "delivery_payouts"

    delivery_boy_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_boys.id", ondelete="RESTRICT"), index=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    deliveries: Mapped[int] = mapped_column(Integer, default=0)
    amount: Mapped[int] = mapped_column(BigInteger, default=0)  # fees earned
    cod_deducted: Mapped[int] = mapped_column(BigInteger, default=0)  # cash the partner still held, when deduction is on
    net_amount: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(8), default="pending")  # pending | paid
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    reference: Mapped[str] = mapped_column(String(60), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("delivery_boy_id", "period_start", name="uq_delivery_payouts_boy_period"),
        CheckConstraint("status IN ('pending','paid')", name="status"),
        CheckConstraint("net_amount = amount - cod_deducted", name="net"),
    )


class DeliveryCashDeposit(IdMixin, Base):
    """Cash on delivery a partner handed over (or paid by UPI/bank) to the business."""

    __tablename__ = "delivery_cash_deposits"

    delivery_boy_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_boys.id", ondelete="RESTRICT"), index=True)
    amount: Mapped[int] = mapped_column(BigInteger)
    method: Mapped[str] = mapped_column(String(8), default="cash")  # cash | upi | bank | payout (deducted from a payout)
    reference: Mapped[str] = mapped_column(String(60), default="")
    note: Mapped[str] = mapped_column(String(300), default="")
    recorded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("amount > 0", name="amount"), CheckConstraint("method IN ('cash','upi','bank','payout')", name="method"))


class DeliveryComplaint(IdMixin, Base):
    """A customer's complaint about a delivery, handled in Admin → Delivery → Ratings and complaints."""

    __tablename__ = "delivery_complaints"

    assignment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_assignments.id", ondelete="CASCADE"), index=True)
    delivery_boy_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("delivery_boys.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    category: Mapped[str] = mapped_column(String(20))
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)  # open | resolved
    admin_note: Mapped[str] = mapped_column(Text, default="")
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('open','resolved')", name="status"),)


class PushToken(IdMixin, Base):
    """A device that receives push notifications through Firebase Cloud Messaging (web browser or the Android app)."""

    __tablename__ = "push_tokens"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(400), unique=True)
    platform: Mapped[str] = mapped_column(String(10), default="web")  # web | android | ios
    app: Mapped[str] = mapped_column(String(10), default="shop")  # shop | delivery | seller | admin
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
