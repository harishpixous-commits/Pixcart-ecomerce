"""Phase 2/3 tables: warehouses and stock ledger, wishlist, reviews, returns, coupons, seller ledger and
payouts, invoices, notifications, support tickets, CMS and analytics."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, IdMixin, TimestampMixin

# ----------------------------------------------------------------------------- warehouses & inventory


class Warehouse(IdMixin, TimestampMixin, Base):
    __tablename__ = "warehouses"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(80))
    line1: Mapped[str] = mapped_column(String(200))
    line2: Mapped[str] = mapped_column(String(200), default="")
    city: Mapped[str] = mapped_column(String(80))
    state_code: Mapped[str] = mapped_column(String(2))
    pincode: Mapped[str] = mapped_column(String(6))
    contact_name: Mapped[str] = mapped_column(String(120), default="")
    contact_phone: Mapped[str] = mapped_column(String(15), default="")
    gstin: Mapped[str] = mapped_column(String(15), default="")  # needed when the state differs from the seller's GSTIN
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    shiprocket_pickup_name: Mapped[str] = mapped_column(String(40), default="")
    # map position for the delivery fleet (set by the seller, or learnt the first time a partner reaches the store)
    lat: Mapped[float | None] = mapped_column(Numeric(9, 6))
    lng: Mapped[float | None] = mapped_column(Numeric(9, 6))

    __table_args__ = (UniqueConstraint("seller_id", "code", name="uq_warehouses_seller_code"),)


class InventoryLevel(Base):
    __tablename__ = "inventory_levels"

    variant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("variants.id", ondelete="CASCADE"), primary_key=True)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id", ondelete="CASCADE"), primary_key=True)
    quantity: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("quantity >= 0", name="qty_non_negative"),)


class StockMovement(IdMixin, Base):
    __tablename__ = "stock_movements"

    variant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("variants.id", ondelete="CASCADE"), index=True)
    warehouse_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("warehouses.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))  # set | adjust | sale | release | return | transfer
    delta: Mapped[int] = mapped_column(Integer)
    balance_after: Mapped[int] = mapped_column(Integer)
    reference: Mapped[str] = mapped_column(String(80), default="")
    note: Mapped[str] = mapped_column(String(300), default="")
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


# ----------------------------------------------------------------------------- customer engagement


class WishlistItem(Base):
    __tablename__ = "wishlist_items"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    price_at_add: Mapped[int | None] = mapped_column(BigInteger)  # for "price dropped" alerts
    alerted_price: Mapped[int | None] = mapped_column(BigInteger)  # the price we last told the shopper about


class Review(IdMixin, TimestampMixin, Base):
    """A customer's rating and review. ``status``: published (counted and shown), pending (waiting for staff:
    held for moderation or hidden after reports) or hidden (removed by staff). Photos and videos have their
    own ``media_status`` so staff can hold or remove them without touching the text."""

    __tablename__ = "reviews"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    # The delivered package that makes this a verified purchase; empty when the marketplace lets any
    # signed-in customer review (those reviews carry no "Verified purchase" badge).
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"))
    verified: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    rating: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(120), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="published")
    media: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")  # [{kind, url, poster_url}]
    media_status: Mapped[str] = mapped_column(String(10), default="published", server_default="published")
    seller_reply: Mapped[str] = mapped_column(Text, default="")
    helpful_count: Mapped[int] = mapped_column(Integer, default=0)
    report_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # open reports

    __table_args__ = (
        UniqueConstraint("product_id", "user_id", name="uq_reviews_product_user"),
        CheckConstraint("rating BETWEEN 1 AND 5", name="rating"),
        CheckConstraint("status IN ('published','pending','hidden')", name="status"),
        CheckConstraint("media_status IN ('published','pending','hidden')", name="media_status"),
        Index("ix_reviews_product_status", "product_id", "status"),  # created by migration 0008
    )


class ReviewVote(Base):
    """One "helpful" vote per signed-in customer per review (a second click takes it back)."""

    __tablename__ = "review_votes"

    review_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("reviews.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ReviewReport(IdMixin, Base):
    """A customer (or the product's seller) flags a review to staff."""

    __tablename__ = "review_reports"

    review_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("reviews.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    reason: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)  # open | upheld | dismissed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (UniqueConstraint("review_id", "user_id", name="uq_review_reports_review_user"),)


class ProductReport(IdMixin, TimestampMixin, Base):
    """'Report an issue with this product': wrong information, counterfeit, unsafe, prohibited, a lower price
    elsewhere. Staff resolve it (and can take the listing down); the seller sees the report without the
    customer's identity and can answer."""

    __tablename__ = "product_reports"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), index=True)
    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    reason: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String(400), default="")  # where a lower price was seen
    status: Mapped[str] = mapped_column(String(10), default="open", index=True)  # open | resolved | dismissed
    admin_note: Mapped[str] = mapped_column(Text, default="")
    seller_note: Mapped[str] = mapped_column(Text, default="")
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (CheckConstraint("status IN ('open','resolved','dismissed')", name="status"),)


class ReturnRequest(IdMixin, TimestampMixin, Base):
    __tablename__ = "return_requests"

    number: Mapped[str] = mapped_column(String(24), unique=True)
    sub_order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="CASCADE"), index=True)
    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="requested", index=True)
    reason: Mapped[str] = mapped_column(String(60))
    comment: Mapped[str] = mapped_column(Text, default="")
    refund_amount: Mapped[int] = mapped_column(BigInteger, default=0)
    refund_upi: Mapped[str] = mapped_column(String(60), default="")  # COD orders: where to send the money
    seller_note: Mapped[str] = mapped_column(Text, default="")
    pickup_courier: Mapped[str] = mapped_column(String(60), default="")
    pickup_tracking: Mapped[str] = mapped_column(String(60), default="")
    credit_note_number: Mapped[str] = mapped_column(String(20), default="")
    photos: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")  # urls of the customer's photos
    # own delivery fleet collecting the item: when it was asked for, staff alerted, and the code the customer gives
    fleet_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fleet_alerted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pickup_otp: Mapped[str] = mapped_column(String(6), default="", server_default="")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "status IN ('requested','approved','picked_up','received','refunded','rejected','cancelled')", name="status"
        ),
    )


class ReturnItem(IdMixin, Base):
    __tablename__ = "return_items"

    return_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("return_requests.id", ondelete="CASCADE"), index=True)
    order_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("order_items.id", ondelete="CASCADE"))
    qty: Mapped[int] = mapped_column(Integer)
    amount: Mapped[int] = mapped_column(BigInteger)  # what the customer paid for these units
    # set when the seller receives it: back in sellable stock, or damaged (kept out of stock)
    condition: Mapped[str] = mapped_column(String(10), default="", server_default="")

    __table_args__ = (
        CheckConstraint("qty > 0", name="qty"),
        CheckConstraint("condition IN ('','sellable','damaged')", name="condition"),
        UniqueConstraint("return_id", "order_item_id", name="uq_return_items_return_order_item"),
    )


class Coupon(IdMixin, TimestampMixin, Base):
    __tablename__ = "coupons"

    code: Mapped[str] = mapped_column(String(30), unique=True)
    description: Mapped[str] = mapped_column(String(200), default="")
    kind: Mapped[str] = mapped_column(String(8))  # percent | flat
    value: Mapped[int] = mapped_column(Integer)  # bps for percent, paise for flat
    max_discount_paise: Mapped[int | None] = mapped_column(BigInteger)
    min_order_paise: Mapped[int] = mapped_column(BigInteger, default=0)
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    usage_limit: Mapped[int | None] = mapped_column(Integer)
    per_user_limit: Mapped[int] = mapped_column(Integer, default=1)
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    funded_by: Mapped[str] = mapped_column(String(8), default="platform")  # platform | seller
    seller_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"))
    category_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"))
    first_order_only: Mapped[bool] = mapped_column(Boolean, default=False)
    only_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))  # a code made for one person (loyalty, gift card)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    show_on_checkout: Mapped[bool] = mapped_column(Boolean, default=True)
    buy_qty: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # "bxgy" coupons: units the customer buys ...
    get_qty: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # ... then this many units get `value` percent off
    product_ids: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")  # platform coupons: only these products count (empty = all)
    is_automatic: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # applied at checkout with no code (Admin → Growth → Automatic discounts)

    __table_args__ = (
        CheckConstraint("kind IN ('percent','flat','bxgy')", name="kind"),
        CheckConstraint("value > 0", name="value"),
        CheckConstraint("funded_by IN ('platform','seller')", name="funded_by"),
        CheckConstraint("funded_by = 'platform' OR seller_id IS NOT NULL", name="seller_funded_has_seller"),
    )


class CouponRedemption(IdMixin, Base):
    __tablename__ = "coupon_redemptions"

    coupon_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("coupons.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), unique=True)
    discount_paise: Mapped[int] = mapped_column(BigInteger)
    released: Mapped[bool] = mapped_column(Boolean, default=False)  # order fully cancelled
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ----------------------------------------------------------------------------- money


class LedgerEntry(IdMixin, Base):
    """Seller balance. Positive = owed to the seller. Payouts settle entries whose available_at has passed."""

    __tablename__ = "seller_ledger"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), index=True)
    sub_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sub_orders.id", ondelete="SET NULL"))
    return_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("return_requests.id", ondelete="SET NULL"))
    kind: Mapped[str] = mapped_column(String(30))
    amount: Mapped[int] = mapped_column(BigInteger)
    description: Mapped[str] = mapped_column(String(200), default="")
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    payout_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("payouts.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "kind IN ('sale','commission','commission_gst','tcs','tds','return','commission_reversal','commission_gst_reversal','tcs_reversal','tds_reversal','adjustment','payout_reversal','ad_spend','cod_collected')",
            name="kind",
        ),
    )


class Payout(IdMixin, TimestampMixin, Base):
    __tablename__ = "payouts"

    number: Mapped[str] = mapped_column(String(24), unique=True)
    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="RESTRICT"), index=True)
    amount: Mapped[int] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)
    mode: Mapped[str] = mapped_column(String(10), default="manual")  # manual | razorpayx
    utr: Mapped[str] = mapped_column(String(40), default="")
    provider_payout_id: Mapped[str] = mapped_column(String(40), default="")
    failure_reason: Mapped[str] = mapped_column(String(300), default="")
    bank_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)  # holder, last4, ifsc at payout time
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("amount > 0", name="amount"),
        CheckConstraint("status IN ('pending','processing','paid','failed','cancelled')", name="status"),
    )


class DocumentCounter(Base):
    """Gap-free invoice / credit-note numbering per seller per financial year (GST rule 46)."""

    __tablename__ = "document_counters"

    seller_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="CASCADE"), primary_key=True)
    doc_type: Mapped[str] = mapped_column(String(4), primary_key=True)  # INV | CN
    fiscal_year: Mapped[str] = mapped_column(String(5), primary_key=True)  # e.g. 26-27
    last_number: Mapped[int] = mapped_column(Integer, default=0)


# ----------------------------------------------------------------------------- communication


class NotificationTemplate(IdMixin, TimestampMixin, Base):
    __tablename__ = "notification_templates"

    event: Mapped[str] = mapped_column(String(40))
    channel: Mapped[str] = mapped_column(String(10))  # inapp | email | sms | whatsapp
    subject: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    provider_template: Mapped[str] = mapped_column(String(80), default="")  # MSG91 flow id / WhatsApp template name
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (UniqueConstraint("event", "channel", name="uq_notification_templates_event_channel"),)


class Notification(IdMixin, Base):
    __tablename__ = "notifications"

    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event: Mapped[str] = mapped_column(String(40))
    channel: Mapped[str] = mapped_column(String(10))
    recipient: Mapped[str] = mapped_column(String(254), default="")
    subject: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(300), default="")
    variables: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('pending','sent','failed','skipped')", name="status"),)


class SupportTicket(IdMixin, TimestampMixin, Base):
    __tablename__ = "support_tickets"

    number: Mapped[str] = mapped_column(String(20), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("orders.id", ondelete="SET NULL"))
    category: Mapped[str] = mapped_column(String(30))
    subject: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    priority: Mapped[str] = mapped_column(String(8), default="normal")
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    is_grievance: Mapped[bool] = mapped_column(Boolean, default=False)
    ack_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    resolve_due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    csat_rating: Mapped[int | None] = mapped_column(Integer)
    csat_comment: Mapped[str] = mapped_column(String(500), default="", server_default="")
    csat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5", name="csat"),
        CheckConstraint("status IN ('open','awaiting_customer','resolved','closed')", name="status"),
        CheckConstraint("priority IN ('low','normal','high','urgent')", name="priority"),
    )


class TicketMessage(IdMixin, Base):
    __tablename__ = "ticket_messages"

    ticket_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("support_tickets.id", ondelete="CASCADE"), index=True)
    author_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    author_role: Mapped[str] = mapped_column(String(10))  # customer | staff
    body: Mapped[str] = mapped_column(Text)
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False)  # staff-only note
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ----------------------------------------------------------------------------- CMS


class HomeSection(IdMixin, TimestampMixin, Base):
    __tablename__ = "home_sections"

    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(120), default="")
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    device: Mapped[str] = mapped_column(String(8), default="all")  # all | mobile | desktop
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "kind IN ('hero','categories','products','banner','banner_grid','text','usp','recent','cards','deals','sponsored','countdown','signin','inspired','buy_again','media')", name="kind"
        ),
        CheckConstraint("device IN ('all','mobile','desktop')", name="device"),
    )


class CmsPage(IdMixin, TimestampMixin, Base):
    __tablename__ = "cms_pages"

    slug: Mapped[str] = mapped_column(String(80), unique=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str] = mapped_column(Text, default="")  # Markdown
    meta_description: Mapped[str] = mapped_column(String(300), default="")
    is_published: Mapped[bool] = mapped_column(Boolean, default=True)


class MediaAsset(IdMixin, Base):
    __tablename__ = "media_assets"

    url: Mapped[str] = mapped_column(String(400))
    label: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ----------------------------------------------------------------------------- analytics


class ProductDailyStat(Base):
    __tablename__ = "product_daily_stats"

    product_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    add_to_cart: Mapped[int] = mapped_column(Integer, default=0)
    orders: Mapped[int] = mapped_column(Integer, default=0)
    units: Mapped[int] = mapped_column(Integer, default=0)
    revenue: Mapped[int] = mapped_column(BigInteger, default=0)

    __table_args__ = (Index("ix_product_daily_stats_day", "day"),)


class IntegrationToken(Base):
    """Short-lived provider tokens (e.g. Shiprocket's 10-day JWT), shared by all app instances."""

    __tablename__ = "integration_tokens"

    provider: Mapped[str] = mapped_column(String(20), primary_key=True)
    token: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ----------------------------------------------------------------------------- AI pipeline


class AiRun(IdMixin, Base):
    """One AI generation: what was asked, what came back, what it cost, and what a person did with it.

    Lifecycle: draft → applied (used as is or edited) | sent (a message that went out) | discarded.
    Nothing an AI writes reaches customers or the catalogue without a person accepting it.
    """

    __tablename__ = "ai_runs"

    task: Mapped[str] = mapped_column(String(40), index=True)
    subject_type: Mapped[str] = mapped_column(String(20), default="")
    subject_id: Mapped[str] = mapped_column(String(40), default="")
    seller_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sellers.id", ondelete="SET NULL"), index=True)
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    output: Mapped[dict] = mapped_column(JSONB, default=dict)
    final_text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(12), default="draft", index=True)
    mode: Mapped[str] = mapped_column(String(10), default="live")  # live | sandbox
    model: Mapped[str] = mapped_column(String(80), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_creation_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(String(300), default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("status IN ('draft','applied','sent','discarded','failed')", name="status"),
        Index("ix_ai_runs_task_created", "task", "created_at"),
    )


# ----------------------------------------------------------------------------- staff roles


class AdminRole(Base):
    """A staff role: a named set of permissions (see app.core.permissions.CATALOG).

    The owner role is locked to every permission so the marketplace can never lose its last full admin.
    """

    __tablename__ = "admin_roles"

    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(300), default="")
    permissions: Mapped[list] = mapped_column(JSONB, default=list)
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ----------------------------------------------------------------------------- admin AI assistant


class AssistantConversation(IdMixin, Base):
    """One chat with the admin AI assistant. Private to the staff member who started it."""

    __tablename__ = "assistant_conversations"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(120), default="New chat")
    context: Mapped[dict] = mapped_column(JSONB, default=dict)  # page the chat was opened from
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class AssistantMessage(IdMixin, Base):
    """A turn in a conversation.

    ``model_content`` is what the model saw or said (text, tool calls, tool results) so the chat
    can continue; ``blocks`` is what the screen shows: text and data cards built from tool results.
    """

    __tablename__ = "assistant_messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assistant_conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(10))  # user | assistant
    text: Mapped[str] = mapped_column(Text, default="")
    blocks: Mapped[list] = mapped_column(JSONB, default=list)
    model_content: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(10), default="done")  # done | error | stopped
    mode: Mapped[str] = mapped_column(String(10), default="")  # live | sandbox
    upload_ids: Mapped[list] = mapped_column(JSONB, default=list)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)

    __table_args__ = (CheckConstraint("role IN ('user','assistant')", name="role"),)


class AssistantUpload(IdMixin, Base):
    """A spreadsheet or text file given to the assistant. Parsed once; deleted after 7 days."""

    __tablename__ = "assistant_uploads"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(100), default="")
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    columns: Mapped[list] = mapped_column(JSONB, default=list)
    rows: Mapped[list] = mapped_column(JSONB, default=list)  # list of lists, capped
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    text: Mapped[str] = mapped_column(Text, default="")  # plain-text files
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class AssistantAction(IdMixin, Base):
    """A change the assistant proposed. It runs only when the staff member presses Confirm."""

    __tablename__ = "assistant_actions"

    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assistant_conversations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(40))
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(12), default="pending")
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (CheckConstraint("status IN ('pending','running','done','cancelled','failed','expired')", name="status"),)


class AgentProposal(IdMixin, Base):
    """Something an AI agent noticed and wants to do. It runs only when staff press Approve (Admin -> AI agents)."""

    __tablename__ = "agent_proposals"

    agent: Mapped[str] = mapped_column(String(30), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    dedupe_key: Mapped[str] = mapped_column(String(120), unique=True)  # one proposal per subject and kind, ever: a rejected idea is not re-proposed
    summary: Mapped[str] = mapped_column(String(500))
    details: Mapped[list] = mapped_column(JSONB, default=list)  # [[label, value], ...] shown on the card
    params: Mapped[dict] = mapped_column(JSONB, default=dict)
    permission: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(10), default="pending", index=True)
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))

    __table_args__ = (CheckConstraint("status IN ('pending','running','done','rejected','expired','failed')", name="status"),)


class ProductCollection(IdMixin, TimestampMixin, Base):
    """A page of chosen products ("Diwali gifts"). Either a hand-picked list, or products matching rules (category, brand, price)."""

    __tablename__ = "product_collections"

    slug: Mapped[str] = mapped_column(String(80), unique=True)
    title: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    image_url: Mapped[str] = mapped_column(String(500), default="", server_default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    product_ids: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")  # hand-picked, in this order; wins over the rules
    category_slug: Mapped[str] = mapped_column(String(120), default="", server_default="")
    brand: Mapped[str] = mapped_column(String(80), default="", server_default="")
    min_price_paise: Mapped[int | None] = mapped_column(BigInteger)
    max_price_paise: Mapped[int | None] = mapped_column(BigInteger)
