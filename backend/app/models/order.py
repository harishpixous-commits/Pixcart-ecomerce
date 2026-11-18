from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

ORDER_STATUSES = ("pending_payment", "placed", "cancelled")
PAYMENT_STATUSES = ("pending", "paid", "cod", "failed", "refunded", "partially_refunded")
SUB_ORDER_STATUSES = (
    "pending_payment",
    "placed",
    "confirmed",
    "packed",
    "shipped",
    "delivered",
    "cancelled",
)


class CartItem(IdMixin, TimestampMixin, Base):
    __tablename__ = "cart_items"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    variant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("variants.id", ondelete="CASCADE"))
    qty: Mapped[int] = mapped_column(Integer)

    __table_args__ = (
        UniqueConstraint("user_id", "variant_id", name="uq_cart_items_user_variant"),
        CheckConstraint("qty BETWEEN 1 AND 10", name="qty"),
    )


class Order(IdMixin, TimestampMixin, Base):
    __tablename__ = "orders"

    number: Mapped[str] = mapped_column(String(20), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    status: Mapped[str] = mapped_column(String(16), index=True)
    payment_method: Mapped[str] = mapped_column(String(8))
    payment_status: Mapped[str] = mapped_column(String(20))
    ship_to: Mapped[dict] = mapped_column(JSONB)
    items_total: Mapped[int] = mapped_column(BigInteger)
    shipping_total: Mapped[int] = mapped_column(BigInteger)
    cod_fee: Mapped[int] = mapped_column(BigInteger, default=0)
    discount_total: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    coupon_code: Mapped[str] = mapped_column(String(30), default="", server_default="")
    grand_total: Mapped[int] = mapped_column(BigInteger)
    refunded_total: Mapped[int] = mapped_column(BigInteger, default=0)
    idempotency_key: Mapped[str] = mapped_column(String(64))
    payment_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    placed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_orders_user_idempotency"),
        CheckConstraint("status IN ('pending_payment','placed','cancelled')", name="status"),
        CheckConstraint("payment_method IN ('cod','online')", name="payment_method"),
        CheckConstraint(
            "payment_status IN ('pending','paid','cod','failed','refunded','partially_refunded')", name="payment_status"
        ),
        CheckConstraint("grand_total = items_total + shipping_total + cod_fee - discount_total", name="totals"),
    )


class SubOrder(IdMixin, TimestampMixin, Base):
    __tablename__ = "sub_orders"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="RESTRICT"), index=True)
    number: Mapped[str] = mapped_column(String(24), unique=True)
    status: Mapped[str] = mapped_column(String(16), index=True)

    items_total: Mapped[int] = mapped_column(BigInteger)
    shipping_fee: Mapped[int] = mapped_column(BigInteger)
    cod_fee: Mapped[int] = mapped_column(BigInteger, default=0)
    seller_discount: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")  # lowers the seller's sale value
    platform_discount: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")  # paid by the platform
    total: Mapped[int] = mapped_column(BigInteger)  # seller's sale value: items + shipping + cod - seller_discount
    taxable_total: Mapped[int] = mapped_column(BigInteger)  # items + shipping, excluding GST
    shipping_gst_bps: Mapped[int] = mapped_column(Integer, default=0)  # composite supply: highest item rate
    is_interstate: Mapped[bool] = mapped_column(Boolean)

    # Settlement figures (computed at placement, recomputed to zero on cancel).
    commission_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    commission_gst_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    tcs_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    tds_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    seller_payout_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    settlement_due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    settlement_status: Mapped[str] = mapped_column(String(10), default="not_due")

    warehouse_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id", ondelete="SET NULL"))
    invoice_number: Mapped[str] = mapped_column(String(20), default="", server_default="")
    invoice_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipping_provider: Mapped[str] = mapped_column(String(12), default="manual", server_default="manual")
    provider_order_id: Mapped[str] = mapped_column(String(40), default="", server_default="")
    provider_shipment_id: Mapped[str] = mapped_column(String(40), default="", server_default="")
    label_url: Mapped[str] = mapped_column(String(400), default="", server_default="")
    expected_delivery_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    returned_total: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    courier_name: Mapped[str] = mapped_column(String(60), default="")
    tracking_number: Mapped[str] = mapped_column(String(60), default="")
    tracking_url: Mapped[str] = mapped_column(String(400), default="")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    packed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[str] = mapped_column(String(10), default="")
    cancel_reason: Mapped[str] = mapped_column(String(300), default="")

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending_payment','placed','confirmed','packed','shipped','delivered','cancelled')",
            name="status",
        ),
        CheckConstraint("settlement_status IN ('not_due','pending','eligible','paid','void')", name="settlement_status"),
        CheckConstraint("total = items_total + shipping_fee + cod_fee - seller_discount", name="totals"),
        Index("ix_sub_orders_seller_status", "seller_id", "status"),
    )


class OrderItem(IdMixin, Base):
    __tablename__ = "order_items"

    sub_order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="RESTRICT"), index=True)
    variant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("variants.id", ondelete="RESTRICT"))
    title: Mapped[str] = mapped_column(String(200))
    variant_label: Mapped[str] = mapped_column(String(200), default="")
    image_url: Mapped[str] = mapped_column(String(400), default="")
    sku: Mapped[str] = mapped_column(String(60))
    hsn_code: Mapped[str] = mapped_column(String(8), default="")
    qty: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[int] = mapped_column(BigInteger)
    unit_mrp: Mapped[int] = mapped_column(BigInteger)
    line_total: Mapped[int] = mapped_column(BigInteger)
    gst_bps: Mapped[int] = mapped_column(Integer)
    taxable_value: Mapped[int] = mapped_column(BigInteger)
    cgst: Mapped[int] = mapped_column(BigInteger, default=0)
    sgst: Mapped[int] = mapped_column(BigInteger, default=0)
    igst: Mapped[int] = mapped_column(BigInteger, default=0)
    commission_bps: Mapped[int] = mapped_column(Integer)
    commission_paise: Mapped[int] = mapped_column(BigInteger)
    seller_discount: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    platform_discount: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    returned_qty: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty"),
        CheckConstraint("line_total = unit_price * qty", name="line_total"),
        CheckConstraint("taxable_value + cgst + sgst + igst = line_total - seller_discount", name="tax_split"),
        CheckConstraint("returned_qty BETWEEN 0 AND qty", name="returned_qty"),
    )


class OrderEvent(IdMixin, Base):
    __tablename__ = "order_events"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), index=True)
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"))
    from_status: Mapped[str] = mapped_column(String(16), default="")
    to_status: Mapped[str] = mapped_column(String(16))
    actor: Mapped[str] = mapped_column(String(10))  # customer | seller | admin | system | payment
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Payment(IdMixin, TimestampMixin, Base):
    __tablename__ = "payments"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), index=True)
    provider: Mapped[str] = mapped_column(String(12))  # razorpay
    provider_order_id: Mapped[str] = mapped_column(String(40), unique=True)
    provider_payment_id: Mapped[str | None] = mapped_column(String(40), unique=True)
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(12), default="created")
    method: Mapped[str] = mapped_column(String(20), default="")
    error: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (
        CheckConstraint("status IN ('created','authorized','captured','failed')", name="status"),
    )


class Refund(IdMixin, TimestampMixin, Base):
    __tablename__ = "refunds"

    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), index=True)
    payment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("payments.id", ondelete="RESTRICT"))
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="RESTRICT"))
    amount_paise: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(10), default="pending")
    provider_refund_id: Mapped[str | None] = mapped_column(String(40), unique=True)
    reason: Mapped[str] = mapped_column(String(300), default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str] = mapped_column(Text, default="")

    __table_args__ = (
        CheckConstraint("amount_paise > 0", name="amount"),
        CheckConstraint("status IN ('pending','processed','failed')", name="status"),
    )


class WebhookEvent(IdMixin, Base):
    __tablename__ = "webhook_events"

    provider: Mapped[str] = mapped_column(String(12))
    event_id: Mapped[str] = mapped_column(String(80))
    event_type: Mapped[str] = mapped_column(String(60))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (UniqueConstraint("provider", "event_id", name="uq_webhook_events_provider_event"),)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
