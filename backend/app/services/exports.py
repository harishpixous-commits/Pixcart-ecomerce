"""Data exports for admins and sellers, as CSV, Excel or PDF.

Every export is declared once in ``_ALL``: who may run it, which date column the range applies to, the
column headers, the query, how a row becomes cells, and which extra filters it offers (seller,
category, payment method, search text, low stock). The engine then:

* streams rows from PostgreSQL in batches (constant memory, no silent row caps),
* lets the person pick columns (every format) — PDF takes at most 14 and up to 2,000 rows,
* writes CSV as UTF-8 with a byte-order mark so Excel shows ₹ and Indian-language names correctly,
* writes Excel with real numbers, a frozen filterable header and an "About" sheet with the filters,
* neutralises spreadsheet formulas in text cells (CSV injection),
* shows dates and times in IST and money in rupees with two decimals,
* is always scoped: a seller export can only ever read that seller's rows.
"""
from __future__ import annotations

import codecs
import csv
import io
import re
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any

from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import aliased

from app.core.validators import STATES
from app.db import SessionLocal
from app.models import (
    AiRun,
    Category,
    Coupon,
    CouponRedemption,
    GiftCard,
    InventoryLevel,
    LedgerEntry,
    LoyaltyEntry,
    Order,
    OrderItem,
    Payout,
    Product,
    Referral,
    Review,
    ReturnItem,
    ReturnRequest,
    Seller,
    SubOrder,
    SupportTicket,
    User,
    Variant,
    Warehouse,
)
from app.services import docgen
from app.services.reports import IST, tcs_report_data

MAX_RANGE_DAYS = 366
BATCH = 1000
MAX_ROWS = 1_000_000  # a guard against runaway queries; far above any realistic single export

_NUMERIC = re.compile(r"^-?\d+(\.\d+)?$")


# ----------------------------------------------------------------------------- cell formatting


def money(paise: int | None) -> str:
    return f"{(paise or 0) / 100:.2f}"


def ist(dt: datetime | None) -> str:
    return dt.astimezone(IST).strftime("%Y-%m-%d %H:%M") if dt else ""


def ist_date(dt: datetime | None) -> str:
    return dt.astimezone(IST).strftime("%Y-%m-%d") if dt else ""


def pct(bps: int | None) -> str:
    return f"{(bps or 0) / 100:g}"


def safe_cell(value: Any) -> Any:
    """Text that a spreadsheet would run as a formula gets a leading apostrophe; numbers pass unchanged."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return value
    v = str(value).replace("\r\n", " ").replace("\r", " ")
    if v[:1] in ("=", "+", "-", "@", "\t") and not _NUMERIC.match(v):
        return "'" + v
    return v


# ----------------------------------------------------------------------------- export declarations


FORMATS = ("csv", "xlsx", "pdf")

# Extra filters an export can offer. kind: "choice" (fixed options), "lookup" (searched list), "text", "number".
FILTERS: dict[str, dict[str, Any]] = {
    "seller": {"label": "Seller", "kind": "lookup"},
    "category": {"label": "Category", "kind": "lookup"},
    "payment_method": {"label": "Payment", "kind": "choice", "options": [{"value": "cod", "label": "Cash on delivery"}, {"value": "online", "label": "Paid online"}]},
    "q": {"label": "Search", "kind": "text", "placeholder": "Number, name, SKU…"},
    "low_stock": {"label": "Only stock at or below", "kind": "number", "placeholder": "e.g. 5"},
}


@dataclass(frozen=True)
class Context:
    seller_id: uuid.UUID | None  # set for seller exports; every seller query filters on it
    start: datetime | None
    end: datetime | None
    status: str | None
    month: str | None
    extra: dict[str, Any] = field(default_factory=dict)  # validated values of FILTERS


def _like(text: str) -> str:
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@dataclass(frozen=True)
class ExportSpec:
    name: str
    label: str
    description: str
    scope: str  # "admin" | "seller"
    permission: str  # admin permission needed (ignored for sellers)
    headers: list[str]
    query: Callable[[Context], Select] | None
    row: Callable[[Any], list[Any]] | None
    date_label: str = ""  # what the date range filters on; empty = no date range
    statuses: list[tuple[str, str]] = field(default_factory=list)
    needs_month: bool = False
    contains_personal_data: bool = False
    date_optional: bool = False  # registers (sellers, customers): all dates unless a range is given
    filters: tuple[str, ...] = ()  # keys of FILTERS this export understands
    pdf_columns: tuple[str, ...] = ()  # default columns for PDF (all headers if empty and they fit)


def _range(stmt: Select, col, ctx: Context) -> Select:
    if ctx.start is not None:
        stmt = stmt.where(col >= ctx.start)
    if ctx.end is not None:
        stmt = stmt.where(col < ctx.end)
    return stmt


SUB_STATUSES = [("placed", "Placed"), ("confirmed", "Confirmed"), ("packed", "Packed"), ("shipped", "Shipped"), ("delivered", "Delivered"), ("cancelled", "Cancelled")]
RETURN_STATUSES = [("requested", "Requested"), ("approved", "Approved"), ("picked_up", "Picked up"), ("received", "Received"), ("refunded", "Refunded"), ("rejected", "Rejected"), ("cancelled", "Cancelled")]
PAYOUT_STATUSES = [("pending", "Pending"), ("processing", "Processing"), ("paid", "Paid"), ("failed", "Failed"), ("cancelled", "Cancelled")]


# --- packages (sub-orders)

def _packages_q(ctx: Context) -> Select:
    stmt = (
        select(SubOrder, Order, Seller.display_name, Seller.gstin)
        .join(Order, Order.id == SubOrder.order_id)
        .join(Seller, Seller.id == SubOrder.seller_id)
        .where(SubOrder.status != "pending_payment")
    )
    if ctx.seller_id:
        stmt = stmt.where(SubOrder.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(SubOrder.status == ctx.status)
    stmt = _order_extras(stmt, ctx)
    return _range(stmt, SubOrder.created_at, ctx).order_by(SubOrder.created_at, SubOrder.id)


def _order_extras(stmt: Select, ctx: Context) -> Select:
    x = ctx.extra
    if x.get("seller"):
        stmt = stmt.where(SubOrder.seller_id == x["seller"])
    if x.get("payment_method"):
        stmt = stmt.where(Order.payment_method == x["payment_method"])
    if x.get("q"):
        stmt = stmt.where(or_(SubOrder.number.ilike(_like(x["q"])), Order.number.ilike(_like(x["q"]))))
    return stmt


PACKAGE_HEADERS = [
    "Package", "Order", "Placed (IST)", "Seller", "Seller GSTIN", "Status", "Payment method", "Payment status", "Ship-to state",
    "Items value", "Delivery fee", "COD fee", "Seller discount", "Platform discount", "Package total", "Taxable value",
    "Commission", "GST on commission", "TCS", "TDS", "Seller payout", "Refunded/returned value", "Coupon",
    "Invoice number", "Invoice date", "Courier", "AWB", "Shipped (IST)", "Delivered (IST)", "Cancel reason",
]


def _package_row(r) -> list[Any]:
    s, o, seller_name, gstin = r
    return [
        s.number, o.number, ist(s.created_at), seller_name, gstin or "", s.status, o.payment_method, o.payment_status,
        STATES.get(o.ship_to.get("state_code", ""), o.ship_to.get("state", "")),
        money(s.items_total), money(s.shipping_fee), money(s.cod_fee), money(s.seller_discount), money(s.platform_discount),
        money(s.total), money(s.taxable_total), money(s.commission_paise), money(s.commission_gst_paise), money(s.tcs_paise),
        money(s.tds_paise), money(s.seller_payout_paise), money(s.returned_total), o.coupon_code,
        s.invoice_number, ist_date(s.invoice_date), s.courier_name, s.tracking_number, ist(s.shipped_at), ist(s.delivered_at), s.cancel_reason,
    ]


# --- GST line items (for GSTR-1 and accounting)

def _items_q(ctx: Context) -> Select:
    stmt = (
        select(OrderItem, SubOrder, Order, Seller.gstin, Seller.legal_name)
        .join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
        .join(Order, Order.id == SubOrder.order_id)
        .join(Seller, Seller.id == SubOrder.seller_id)
        .where(SubOrder.status != "pending_payment")
    )
    if ctx.seller_id:
        stmt = stmt.where(SubOrder.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(SubOrder.status == ctx.status)
    if ctx.extra.get("q"):
        q = _like(ctx.extra["q"])
        stmt = stmt.where(or_(SubOrder.number.ilike(q), OrderItem.sku.ilike(q), OrderItem.title.ilike(q)))
        ctx = Context(ctx.seller_id, ctx.start, ctx.end, ctx.status, ctx.month, {k: v for k, v in ctx.extra.items() if k != "q"})
    stmt = _order_extras(stmt, ctx)
    return _range(stmt, SubOrder.created_at, ctx).order_by(SubOrder.created_at, SubOrder.id, OrderItem.id)


ITEM_HEADERS = [
    "Package", "Placed (IST)", "Status", "Invoice number", "Invoice date", "Seller", "Seller GSTIN", "Place of supply",
    "Inter-state", "SKU", "Product", "Option", "HSN", "Qty", "Unit price", "Line total", "Seller discount", "Platform discount",
    "Taxable value", "GST rate %", "CGST", "SGST", "IGST", "Returned qty",
]


def _item_row(r) -> list[Any]:
    it, s, o, gstin, legal = r
    code = o.ship_to.get("state_code", "")
    return [
        s.number, ist(s.created_at), s.status, s.invoice_number, ist_date(s.invoice_date), legal, gstin or "",
        f"{code}-{STATES.get(code, '')}" if code else "", s.is_interstate, it.sku, it.title, it.variant_label, it.hsn_code, it.qty,
        money(it.unit_price), money(it.line_total), money(it.seller_discount), money(it.platform_discount), money(it.taxable_value),
        pct(it.gst_bps), money(it.cgst), money(it.sgst), money(it.igst), it.returned_qty,
    ]


# --- returns

def _returns_q(ctx: Context) -> Select:
    items = select(ReturnItem.return_id, func.sum(ReturnItem.qty).label("units")).group_by(ReturnItem.return_id).subquery()
    stmt = (
        select(ReturnRequest, SubOrder.number, Seller.display_name, items.c.units)
        .join(SubOrder, SubOrder.id == ReturnRequest.sub_order_id)
        .join(Seller, Seller.id == ReturnRequest.seller_id)
        .outerjoin(items, items.c.return_id == ReturnRequest.id)
    )
    if ctx.seller_id:
        stmt = stmt.where(ReturnRequest.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(ReturnRequest.status == ctx.status)
    if ctx.extra.get("seller"):
        stmt = stmt.where(ReturnRequest.seller_id == ctx.extra["seller"])
    if ctx.extra.get("q"):
        stmt = stmt.where(or_(ReturnRequest.number.ilike(_like(ctx.extra["q"])), SubOrder.number.ilike(_like(ctx.extra["q"]))))
    return _range(stmt, ReturnRequest.created_at, ctx).order_by(ReturnRequest.created_at, ReturnRequest.id)


RETURN_HEADERS = ["Return", "Package", "Seller", "Requested (IST)", "Status", "Reason", "Units", "Refund amount", "Credit note", "Received (IST)", "Refunded (IST)", "Seller note"]


def _return_row(r) -> list[Any]:
    ret, sub_no, seller, units = r
    return [ret.number, sub_no, seller, ist(ret.created_at), ret.status, ret.reason, int(units or 0), money(ret.refund_amount),
            ret.credit_note_number, ist(ret.received_at), ist(ret.refunded_at), ret.seller_note]


# --- payouts and ledger

def _payouts_q(ctx: Context) -> Select:
    stmt = select(Payout, Seller.display_name, Seller.legal_name).join(Seller, Seller.id == Payout.seller_id)
    if ctx.seller_id:
        stmt = stmt.where(Payout.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(Payout.status == ctx.status)
    if ctx.extra.get("seller"):
        stmt = stmt.where(Payout.seller_id == ctx.extra["seller"])
    if ctx.extra.get("q"):
        stmt = stmt.where(or_(Payout.number.ilike(_like(ctx.extra["q"])), Payout.utr.ilike(_like(ctx.extra["q"]))))
    return _range(stmt, Payout.created_at, ctx).order_by(Payout.created_at, Payout.id)


PAYOUT_HEADERS = ["Payout", "Seller", "Legal name", "Created (IST)", "Amount", "Status", "Method", "UTR", "Paid (IST)", "Account (last 4)", "IFSC", "Failure reason"]


def _payout_row(r) -> list[Any]:
    p, name, legal = r
    bank = p.bank_snapshot or {}
    return [p.number, name, legal, ist(p.created_at), money(p.amount), p.status, p.mode, p.utr, ist(p.paid_at), bank.get("account_last4", ""), bank.get("ifsc", ""), p.failure_reason]


def _ledger_q(ctx: Context) -> Select:
    po = aliased(Payout)
    stmt = (
        select(LedgerEntry, Seller.display_name, SubOrder.number, po.number)
        .join(Seller, Seller.id == LedgerEntry.seller_id)
        .outerjoin(SubOrder, SubOrder.id == LedgerEntry.sub_order_id)
        .outerjoin(po, po.id == LedgerEntry.payout_id)
    )
    if ctx.seller_id:
        stmt = stmt.where(LedgerEntry.seller_id == ctx.seller_id)
    if ctx.extra.get("seller"):
        stmt = stmt.where(LedgerEntry.seller_id == ctx.extra["seller"])
    return _range(stmt, LedgerEntry.created_at, ctx).order_by(LedgerEntry.created_at, LedgerEntry.id)


LEDGER_HEADERS = ["Date (IST)", "Seller", "Type", "Package", "Description", "Amount", "Available from", "Payout"]


def _ledger_row(r) -> list[Any]:
    e, seller, sub_no, po_no = r
    return [ist(e.created_at), seller, e.kind, sub_no or "", e.description, money(e.amount), ist_date(e.available_at), po_no or ""]


# --- stock (columns 1-3 match the stock import format, so an edited export can be imported back)

def _stock_q(ctx: Context) -> Select:
    stmt = (
        select(Variant.sku, Warehouse.code, InventoryLevel.quantity, Product.title, Variant.options, Seller.display_name, Warehouse.name, Variant.is_active)
        .join(Product, Product.id == Variant.product_id)
        .join(InventoryLevel, InventoryLevel.variant_id == Variant.id)
        .join(Warehouse, Warehouse.id == InventoryLevel.warehouse_id)
        .join(Seller, Seller.id == Variant.seller_id)
        .where(Product.status != "archived")
    )
    if ctx.seller_id:
        stmt = stmt.where(Variant.seller_id == ctx.seller_id)
    x = ctx.extra
    if x.get("seller"):
        stmt = stmt.where(Variant.seller_id == x["seller"])
    if x.get("category"):
        stmt = stmt.where(Product.category_id == x["category"])
    if x.get("q"):
        stmt = stmt.where(or_(Variant.sku.ilike(_like(x["q"])), Product.title.ilike(_like(x["q"]))))
    if x.get("low_stock") is not None:
        stmt = stmt.where(InventoryLevel.quantity <= x["low_stock"])
    return stmt.order_by(Seller.display_name, Product.title, Variant.sku, Warehouse.code)


STOCK_HEADERS = ["sku", "warehouse_code", "quantity", "title", "option", "seller", "warehouse", "active"]


def _stock_row(r) -> list[Any]:
    sku, code, qty, title, options, seller, wh, active = r
    return [sku, code, qty, title, ", ".join(f"{k}: {v}" for k, v in (options or {}).items()), seller, wh, active]


# --- catalogue, sellers, customers, tickets (admin only)

def _products_q(ctx: Context) -> Select:
    stmt = (
        select(Product, Variant, Seller.display_name, Category.name)
        .join(Variant, Variant.product_id == Product.id)
        .join(Seller, Seller.id == Product.seller_id)
        .join(Category, Category.id == Product.category_id)
    )
    if ctx.seller_id:
        stmt = stmt.where(Product.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(Product.status == ctx.status)
    x = ctx.extra
    if x.get("seller"):
        stmt = stmt.where(Product.seller_id == x["seller"])
    if x.get("category"):
        stmt = stmt.where(Product.category_id == x["category"])
    if x.get("q"):
        stmt = stmt.where(or_(Variant.sku.ilike(_like(x["q"])), Product.title.ilike(_like(x["q"])), Product.brand.ilike(_like(x["q"]))))
    if x.get("low_stock") is not None:
        stmt = stmt.where(Variant.stock <= x["low_stock"])
    return stmt.order_by(Seller.display_name, Product.title, Variant.sku)


PRODUCT_HEADERS = ["SKU", "Product", "Option", "Seller", "Category", "Brand", "Status", "MRP", "Price", "Stock", "HSN", "GST rate %", "Return window (days)", "Rating", "Reviews", "Sold", "Created (IST)"]


def _product_row(r) -> list[Any]:
    p, v, seller, cat = r
    return [v.sku, p.title, ", ".join(f"{k}: {x}" for k, x in (v.options or {}).items()), seller, cat, p.brand, p.status,
            money(v.mrp_paise), money(v.price_paise), v.stock, p.hsn_code, pct(p.gst_bps), p.return_window_days,
            f"{float(p.rating_avg or 0):.1f}", p.rating_count, p.sold_count, ist(p.created_at)]


def _sellers_q(ctx: Context) -> Select:
    live = select(Product.seller_id, func.count().label("n")).where(Product.status == "approved").group_by(Product.seller_id).subquery()
    stmt = select(Seller, live.c.n).outerjoin(live, live.c.seller_id == Seller.id)
    if ctx.status:
        stmt = stmt.where(Seller.status == ctx.status)
    if ctx.extra.get("q"):
        q = _like(ctx.extra["q"])
        stmt = stmt.where(or_(Seller.display_name.ilike(q), Seller.legal_name.ilike(q), Seller.gstin.ilike(q), Seller.pickup_city.ilike(q)))
    return _range(stmt, Seller.created_at, ctx).order_by(Seller.created_at)


SELLER_HEADERS = ["Store", "Legal name", "Business type", "GSTIN", "Status", "City", "State", "PIN", "Email", "Phone", "Commission override %", "Live listings", "Rating", "Reviews", "Holiday mode", "Joined (IST)", "Approved (IST)"]


def _seller_row(r) -> list[Any]:
    s, live = r
    return [s.display_name, s.legal_name, s.business_type, s.gstin or "", s.status, s.pickup_city, STATES.get(s.pickup_state_code, ""), s.pickup_pincode,
            s.contact_email, s.contact_phone, pct(s.commission_bps_override) if s.commission_bps_override is not None else "", int(live or 0),
            f"{float(s.rating_avg or 0):.1f}", s.rating_count, s.holiday_mode, ist(s.created_at), ist(s.approved_at)]


def _customers_q(ctx: Context) -> Select:
    orders = (
        select(Order.user_id, func.count().label("n"), func.coalesce(func.sum(Order.grand_total - Order.refunded_total), 0).label("spent"), func.max(Order.placed_at).label("last"))
        .where(Order.status == "placed").group_by(Order.user_id).subquery()
    )
    stmt = (
        select(User, orders.c.n, orders.c.spent, orders.c.last)
        .outerjoin(orders, orders.c.user_id == User.id)
        .where(User.is_admin.is_(False), User.deleted_at.is_(None))
    )
    if ctx.extra.get("q"):
        q = _like(ctx.extra["q"])
        stmt = stmt.where(or_(User.name.ilike(q), User.phone.ilike(q), User.email.ilike(q)))
    return _range(stmt, User.created_at, ctx).order_by(User.created_at)


CUSTOMER_HEADERS = ["Name", "Mobile", "Email", "Joined (IST)", "Orders", "Net spend", "Last order (IST)", "Marketing consent", "Active"]


def _customer_row(r) -> list[Any]:
    u, n, spent, last = r
    return [u.name, u.phone or "", u.email or "", ist(u.created_at), int(n or 0), money(spent), ist(last), u.marketing_opt_in, u.is_active]


def _tickets_q(ctx: Context) -> Select:
    stmt = select(SupportTicket, Order.number).outerjoin(Order, Order.id == SupportTicket.order_id)
    if ctx.status:
        stmt = stmt.where(SupportTicket.status == ctx.status)
    if ctx.extra.get("q"):
        q = _like(ctx.extra["q"])
        stmt = stmt.where(or_(SupportTicket.number.ilike(q), SupportTicket.subject.ilike(q), Order.number.ilike(q)))
    return _range(stmt, SupportTicket.created_at, ctx).order_by(SupportTicket.created_at)


TICKET_HEADERS = ["Ticket", "Opened (IST)", "Category", "Subject", "Order", "Status", "Priority", "Grievance", "Reply due (IST)", "Replied (IST)", "Reply on time", "Resolve due (IST)", "Resolved (IST)", "Resolved on time"]


def _ticket_row(r) -> list[Any]:
    t, order_no = r
    replied_ok = t.acknowledged_at is not None and t.acknowledged_at <= t.ack_due_at
    resolved_ok = t.resolved_at is not None and t.resolved_at <= t.resolve_due_at
    return [t.number, ist(t.created_at), t.category, t.subject, order_no or "", t.status, t.priority, t.is_grievance, ist(t.ack_due_at),
            ist(t.acknowledged_at), replied_ok if t.acknowledged_at else "", ist(t.resolve_due_at), ist(t.resolved_at), resolved_ok if t.resolved_at else ""]


def _ai_q(ctx: Context) -> Select:
    stmt = select(AiRun, User.name).outerjoin(User, User.id == AiRun.created_by)
    if ctx.seller_id:
        stmt = stmt.where(AiRun.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(AiRun.status == ctx.status)
    return _range(stmt, AiRun.created_at, ctx).order_by(AiRun.created_at, AiRun.id)


AI_HEADERS = ["Time (IST)", "Task", "By", "Status", "Mode", "Model", "Input tokens", "Output tokens", "Cache write tokens", "Cache read tokens", "Latency ms", "Subject", "Error"]


def _ai_row(r) -> list[Any]:
    run, name = r
    return [ist(run.created_at), run.task, name or "System", run.status, run.mode, run.model, run.input_tokens, run.output_tokens,
            run.cache_creation_tokens, run.cache_read_tokens, run.latency_ms, f"{run.subject_type}:{run.subject_id}" if run.subject_type else "", run.error]


TCS_HEADERS = ["GSTIN of supplier", "Legal name", "Packages", "Returned value", "Net taxable value", "IGST TCS", "CGST TCS", "SGST TCS"]


_ORD = ("seller", "payment_method", "q")
_ORD_PDF = ("Package", "Order", "Placed (IST)", "Seller", "Status", "Payment method", "Package total", "Commission", "TCS", "Seller payout", "AWB")
_ITEM_PDF = ("Package", "Invoice number", "Seller GSTIN", "Place of supply", "SKU", "HSN", "Qty", "Taxable value", "GST rate %", "CGST", "SGST", "IGST")
_PROD_STATUSES = [("approved", "Live"), ("pending", "In review"), ("rejected", "Rejected"), ("draft", "Draft"), ("archived", "Archived")]
_PROD_PDF = ("SKU", "Product", "Option", "Seller", "Category", "Status", "MRP", "Price", "Stock", "Sold")

def _gift_cards_q(ctx: Context) -> Select:
    stmt = select(GiftCard)
    if ctx.status:
        stmt = stmt.where(GiftCard.status == ctx.status)
    return _range(stmt, GiftCard.created_at, ctx).order_by(GiftCard.created_at, GiftCard.id)


GIFT_CARD_HEADERS = ["Card (last 4)", "Issued (IST)", "Expires (IST)", "Status", "Value", "Balance", "Used", "Note"]


def _gift_card_row(r) -> list[Any]:
    c = r[0]
    return [c.code[-4:], ist(c.created_at), ist(c.expires_at), c.status, money(c.initial_paise), money(c.balance_paise), money(c.initial_paise - c.balance_paise), c.note]


def _referrals_q(ctx: Context) -> Select:
    ref, fr = aliased(User), aliased(User)
    stmt = select(Referral, ref.name, fr.name).join(ref, ref.id == Referral.referrer_id).join(fr, fr.id == Referral.referee_id)
    if ctx.status:
        stmt = stmt.where(Referral.status == ctx.status)
    return _range(stmt, Referral.created_at, ctx).order_by(Referral.created_at, Referral.id)


REFERRAL_HEADERS = ["Referrer", "Friend", "Joined (IST)", "Status", "Reward", "Rewarded (IST)"]


def _referral_row(r) -> list[Any]:
    f, referrer, friend = r
    return [referrer or "", friend or "", ist(f.created_at), f.status, money(f.reward_paise), ist(f.rewarded_at)]


def _loyalty_q(ctx: Context) -> Select:
    stmt = select(LoyaltyEntry, User.name, User.phone).join(User, User.id == LoyaltyEntry.user_id)
    if ctx.status:
        stmt = stmt.where(LoyaltyEntry.kind == ctx.status)
    return _range(stmt, LoyaltyEntry.created_at, ctx).order_by(LoyaltyEntry.created_at, LoyaltyEntry.id)


LOYALTY_HEADERS = ["Date (IST)", "Customer", "Phone", "Type", "Points", "Note"]


def _loyalty_row(r) -> list[Any]:
    e, name, phone = r
    return [ist(e.created_at), name or "", phone or "", e.kind, e.points, e.note]


def _coupon_use_q(ctx: Context) -> Select:
    stmt = (select(CouponRedemption, Coupon.code, User.name, Order.number)
            .join(Coupon, Coupon.id == CouponRedemption.coupon_id).join(User, User.id == CouponRedemption.user_id).join(Order, Order.id == CouponRedemption.order_id))
    if ctx.status:
        stmt = stmt.where(CouponRedemption.released == (ctx.status == "released"))
    return _range(stmt, CouponRedemption.created_at, ctx).order_by(CouponRedemption.created_at, CouponRedemption.id)


COUPON_USE_HEADERS = ["Date (IST)", "Coupon", "Customer", "Order", "Discount", "Released"]


def _coupon_use_row(r) -> list[Any]:
    c, code, name, number = r
    return [ist(c.created_at), code, name or "", number, money(c.discount_paise), c.released]


def _reviews_q(ctx: Context) -> Select:
    stmt = select(Review, Product.title, Seller.display_name).join(Product, Product.id == Review.product_id).join(Seller, Seller.id == Product.seller_id)
    if ctx.seller_id:
        stmt = stmt.where(Product.seller_id == ctx.seller_id)
    if ctx.status:
        stmt = stmt.where(Review.status == ctx.status)
    if ctx.extra.get("seller"):
        stmt = stmt.where(Product.seller_id == ctx.extra["seller"])
    if ctx.extra.get("q"):
        q = _like(ctx.extra["q"])
        stmt = stmt.where(or_(Product.title.ilike(q), Review.title.ilike(q), Review.body.ilike(q)))
    return _range(stmt, Review.created_at, ctx).order_by(Review.created_at, Review.id)


REVIEW_HEADERS = ["Date (IST)", "Product", "Seller", "Rating", "Title", "Review", "Verified purchase", "Status", "Seller reply", "Helpful votes", "Open reports"]


def _review_row(r) -> list[Any]:
    v, product, seller = r
    return [ist(v.created_at), product, seller, v.rating, v.title, v.body, v.verified, v.status, v.seller_reply, v.helpful_count, v.report_count]


_REVIEW_STATUSES = [("published", "Published"), ("pending", "Waiting for review"), ("hidden", "Hidden")]

_ALL: list[ExportSpec] = [
        # ---------------- admin
        ExportSpec("orders", "Orders (one row per package)", "Every package with payment, tax, commission, TCS/TDS, payout and shipping details.", "admin", "orders",
                   PACKAGE_HEADERS, _packages_q, _package_row, "date the order was placed", SUB_STATUSES, filters=_ORD, pdf_columns=_ORD_PDF),
        ExportSpec("order-items", "GST line items", "One row per item: HSN, taxable value, CGST/SGST/IGST and place of supply. Use for GST reconciliation.", "admin", "reports",
                   ITEM_HEADERS, _items_q, _item_row, "date the order was placed", SUB_STATUSES, filters=_ORD, pdf_columns=_ITEM_PDF),
        ExportSpec("returns", "Returns", "Every return with reason, refund amount and credit note.", "admin", "orders",
                   RETURN_HEADERS, _returns_q, _return_row, "date the return was requested", RETURN_STATUSES, filters=("seller", "q")),
        ExportSpec("payouts", "Seller payouts", "Payouts with amount, status and UTR. Full account numbers are only in the bank file.", "admin", "payouts",
                   PAYOUT_HEADERS, _payouts_q, _payout_row, "date the payout was created", PAYOUT_STATUSES, filters=("seller", "q")),
        ExportSpec("ledger", "Seller ledger (all sellers)", "Every sale, deduction, return and payout entry.", "admin", "payouts",
                   LEDGER_HEADERS, _ledger_q, _ledger_row, "date of the entry", filters=("seller",)),
        ExportSpec("tcs", "GST TCS (GSTR-8)", "Supplier-wise net taxable value and TCS for one month, less returns received that month.", "admin", "reports",
                   TCS_HEADERS, None, None, needs_month=True),
        ExportSpec("products", "Catalogue", "Every product option with seller, category, prices, stock and tax.", "admin", "catalog",
                   PRODUCT_HEADERS, _products_q, _product_row, "", _PROD_STATUSES, filters=("seller", "category", "q", "low_stock"), pdf_columns=_PROD_PDF),
        ExportSpec("stock", "Stock by warehouse", "Units per product option and warehouse, for all sellers.", "admin", "catalog",
                   STOCK_HEADERS, _stock_q, _stock_row, filters=("seller", "category", "q", "low_stock")),
        ExportSpec("sellers", "Sellers", "Seller businesses with verification status and contact details (no PAN or bank numbers).", "admin", "sellers",
                   SELLER_HEADERS, _sellers_q, _seller_row, "date the seller joined", [("approved", "Approved"), ("submitted", "Waiting for review"), ("rejected", "Needs changes"), ("suspended", "Suspended"), ("draft", "Not submitted")],
                   contains_personal_data=True, date_optional=True, filters=("q",),
                   pdf_columns=("Store", "Legal name", "GSTIN", "Status", "City", "State", "Phone", "Live listings", "Rating", "Joined (IST)")),
        ExportSpec("customers", "Customers", "Customer accounts with order count and spend. Contains personal data: share only as the privacy notice allows.", "admin", "customers",
                   CUSTOMER_HEADERS, _customers_q, _customer_row, "date the account was created", contains_personal_data=True, date_optional=True, filters=("q",)),
        ExportSpec("tickets", "Support tickets", "Tickets with categories and whether the 48-hour reply and 30-day resolution limits were met.", "admin", "support",
                   TICKET_HEADERS, _tickets_q, _ticket_row, "date the ticket was opened", [("open", "Open"), ("awaiting_customer", "Waiting for customer"), ("resolved", "Resolved"), ("closed", "Closed")],
                   filters=("q",), pdf_columns=("Ticket", "Opened (IST)", "Category", "Subject", "Order", "Status", "Priority", "Reply on time", "Resolved (IST)")),
        ExportSpec("ai-runs", "AI usage", "Every AI draft and assistant answer with tokens, latency and what happened to it, for cost review and audits.", "admin", "settings",
                   AI_HEADERS, _ai_q, _ai_row, "date of the AI run", [("draft", "Draft"), ("applied", "Used"), ("sent", "Sent"), ("discarded", "Discarded"), ("failed", "Failed")],
                   pdf_columns=("Time (IST)", "Task", "By", "Status", "Mode", "Model", "Input tokens", "Output tokens", "Latency ms")),
        ExportSpec("gift-cards", "Gift cards", "Every gift card with value, balance and expiry. Only the last 4 characters of the code are shown.", "admin", "marketing",
                   GIFT_CARD_HEADERS, _gift_cards_q, _gift_card_row, "date the card was issued", [("active", "Active"), ("void", "Void")], date_optional=True),
        ExportSpec("referrals", "Referrals", "Friends who joined with a referral code, with the reward status. Contains personal data: share only as the privacy notice allows.", "admin", "marketing",
                   REFERRAL_HEADERS, _referrals_q, _referral_row, "date the friend joined", [("joined", "Joined"), ("rewarded", "Rewarded"), ("capped", "Over the cap")],
                   contains_personal_data=True, date_optional=True),
        ExportSpec("loyalty", "Loyalty points", "Every points entry: earned, redeemed, expired, adjusted and taken back. Contains personal data: share only as the privacy notice allows.", "admin", "marketing",
                   LOYALTY_HEADERS, _loyalty_q, _loyalty_row, "date of the entry", [("earn", "Earned"), ("redeem", "Redeemed"), ("expire", "Expired"), ("adjust", "Adjusted"), ("reverse", "Taken back")],
                   contains_personal_data=True),
        ExportSpec("coupon-use", "Coupon use", "Every order that used a coupon, with the discount given and whether it was released by a cancellation.", "admin", "marketing",
                   COUPON_USE_HEADERS, _coupon_use_q, _coupon_use_row, "date the coupon was used", [("used", "In use"), ("released", "Released")],
                   contains_personal_data=True),
        ExportSpec("reviews", "Reviews", "Every review with rating, text, seller reply and open reports. No customer names.", "admin", "catalog",
                   REVIEW_HEADERS, _reviews_q, _review_row, "date of the review", _REVIEW_STATUSES, date_optional=True, filters=("seller", "q")),
        # ---------------- seller (always limited to the signed-in seller)
        ExportSpec("orders", "Orders", "Your packages with totals, deductions, payout and shipping details.", "seller", "",
                   PACKAGE_HEADERS, _packages_q, _package_row, "date the order was placed", SUB_STATUSES, filters=("payment_method", "q"), pdf_columns=_ORD_PDF),
        ExportSpec("order-items", "GST line items", "One row per item with HSN, taxable value and CGST/SGST/IGST, for your GSTR-1.", "seller", "",
                   ITEM_HEADERS, _items_q, _item_row, "date the order was placed", SUB_STATUSES, filters=("payment_method", "q"), pdf_columns=_ITEM_PDF),
        ExportSpec("returns", "Returns", "Your returns with reasons, refunds and credit notes.", "seller", "",
                   RETURN_HEADERS, _returns_q, _return_row, "date the return was requested", RETURN_STATUSES, filters=("q",)),
        ExportSpec("ledger", "Statement", "Every sale, deduction, return and payout on your account.", "seller", "",
                   LEDGER_HEADERS, _ledger_q, _ledger_row, "date of the entry"),
        ExportSpec("payouts", "Payouts", "Payouts to your bank with UTR numbers.", "seller", "",
                   PAYOUT_HEADERS, _payouts_q, _payout_row, "date the payout was created", PAYOUT_STATUSES, filters=("q",)),
        ExportSpec("stock", "Stock", "Units per product option and warehouse. Edit the quantity column and import it back on the Inventory page.", "seller", "",
                   STOCK_HEADERS, _stock_q, _stock_row, filters=("category", "q", "low_stock")),
        ExportSpec("products", "Products", "Your product options with prices, stock and tax details.", "seller", "",
                   PRODUCT_HEADERS, _products_q, _product_row, "", _PROD_STATUSES, filters=("category", "q", "low_stock"), pdf_columns=_PROD_PDF),
        ExportSpec("reviews", "Reviews", "Reviews of your products with rating, text and your reply. No customer names.", "seller", "",
                   REVIEW_HEADERS, _reviews_q, _review_row, "date of the review", _REVIEW_STATUSES, date_optional=True, filters=("q",)),
]

# The two scopes share export names, so they are looked up separately.
ADMIN_EXPORTS: dict[str, ExportSpec] = {s.name: s for s in _ALL if s.scope == "admin"}
SELLER_EXPORTS: dict[str, ExportSpec] = {s.name: s for s in _ALL if s.scope == "seller"}


def default_pdf_columns(spec: ExportSpec) -> list[str]:
    return list(spec.pdf_columns) if spec.pdf_columns else spec.headers[:docgen.PDF_MAX_COLUMNS]


def describe(spec: ExportSpec) -> dict:
    return {
        "name": spec.name, "label": spec.label, "description": spec.description, "columns": spec.headers,
        "date_filter": spec.date_label, "statuses": [{"value": v, "label": label} for v, label in spec.statuses],
        "needs_month": spec.needs_month, "personal_data": spec.contains_personal_data, "date_optional": spec.date_optional,
        "filters": [{"key": k, **FILTERS[k]} for k in spec.filters], "formats": list(FORMATS),
        "pdf_columns": default_pdf_columns(spec), "pdf_max_columns": docgen.PDF_MAX_COLUMNS, "pdf_max_rows": docgen.PDF_MAX_ROWS,
    }


# ----------------------------------------------------------------------------- request parsing


def parse_context(
    spec: ExportSpec, *, seller_id: uuid.UUID | None, date_from: date | None, date_to: date | None, status: str | None, month: str | None,
    extra: dict[str, Any] | None = None,
) -> Context:
    """Validates filters. Dates are whole IST days, both inclusive."""
    if status and status not in {v for v, _ in spec.statuses}:
        raise ValueError("That status cannot be used for this export")
    clean: dict[str, Any] = {}
    for key, raw in (extra or {}).items():
        if raw in (None, ""):
            continue
        if key not in spec.filters:
            raise ValueError(f"This export cannot be filtered by {FILTERS.get(key, {}).get('label', key).lower()}")
        if key in ("seller", "category"):
            try:
                clean[key] = uuid.UUID(str(raw))
            except ValueError:
                raise ValueError(f"Choose a {FILTERS[key]['label'].lower()} from the list") from None
        elif key == "payment_method":
            if raw not in ("cod", "online"):
                raise ValueError("Payment must be cod or online")
            clean[key] = raw
        elif key == "q":
            text = " ".join(str(raw).split())[:80]
            if text:
                clean[key] = text
        elif key == "low_stock":
            try:
                n = int(raw)
            except (TypeError, ValueError):
                raise ValueError("Low stock must be a whole number") from None
            if not 0 <= n <= 100_000:
                raise ValueError("Low stock must be between 0 and 100000")
            clean[key] = n
    if spec.needs_month:
        if not month or not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month):
            raise ValueError("Choose a month")
        return Context(seller_id, None, None, None, month, clean)
    start = end = None
    if spec.date_label and not (spec.date_optional and date_from is None and date_to is None):
        today = datetime.now(IST).date()
        date_to = date_to or today
        date_from = date_from or (date_to - timedelta(days=30))
        if date_from > date_to:
            raise ValueError("The start date is after the end date")
        if (date_to - date_from).days >= MAX_RANGE_DAYS:
            raise ValueError(f"Export at most {MAX_RANGE_DAYS} days at a time")
        start = datetime.combine(date_from, time.min, IST)
        end = datetime.combine(date_to + timedelta(days=1), time.min, IST)
    return Context(seller_id, start, end, status or None, None, clean)


def pick_columns(spec: ExportSpec, wanted: list[str] | None, fmt: str) -> list[int]:
    """Indexes of the chosen columns, in the export's own order. PDF defaults to its key columns."""
    if not wanted:
        wanted = default_pdf_columns(spec) if fmt == "pdf" else list(spec.headers)
    unknown = [c for c in wanted if c not in spec.headers]
    if unknown:
        raise ValueError(f"Unknown column: {unknown[0]}")
    idx = [i for i, h in enumerate(spec.headers) if h in set(wanted)]
    if not idx:
        raise ValueError("Choose at least one column")
    if fmt == "pdf" and len(idx) > docgen.PDF_MAX_COLUMNS:
        raise ValueError(f"A PDF fits at most {docgen.PDF_MAX_COLUMNS} columns. Choose fewer, or download Excel for all of them.")
    return idx


def period_label(ctx: Context) -> str:
    if ctx.month:
        return ctx.month
    if ctx.start and ctx.end:
        return f"{ctx.start.date().isoformat()}-to-{(ctx.end - timedelta(days=1)).date().isoformat()}"
    return datetime.now(IST).strftime("%Y-%m-%d")


def filename(brand: str, spec: ExportSpec, ctx: Context, fmt: str = "csv") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", brand.lower()).strip("-") or "export"
    return f"{slug}-{spec.name}-{period_label(ctx)}.{fmt}"


def filter_summary(spec: ExportSpec, ctx: Context, names: dict[str, str] | None = None) -> list[tuple[str, str]]:
    """Human-readable filters for the Excel "About" sheet and the PDF subtitle."""
    out: list[tuple[str, str]] = []
    if ctx.month:
        out.append(("Month", ctx.month))
    elif ctx.start and ctx.end:
        out.append((f"Dates ({spec.date_label})", f"{ctx.start.date():%d %b %Y} to {(ctx.end - timedelta(days=1)).date():%d %b %Y}"))
    elif spec.date_label:
        out.append(("Dates", "All"))
    if ctx.status:
        out.append(("Status", dict(spec.statuses).get(ctx.status, ctx.status)))
    for k, v in ctx.extra.items():
        label = FILTERS[k]["label"]
        if k == "payment_method":
            v = "Cash on delivery" if v == "cod" else "Paid online"
        out.append((label, (names or {}).get(k) or str(v)))
    return out


# ----------------------------------------------------------------------------- rows and writers


async def iter_rows(spec: ExportSpec, ctx: Context, session) -> AsyncIterator[list[Any]]:
    if spec.needs_month:
        data = await tcs_report_data(session, ctx.month or "")
        for i in data["items"]:
            yield [i["gstin"], i["legal_name"], i["sub_orders"], money(i.get("returned_value", 0)), money(i["net_taxable_value"]),
                   money(i["igst_tcs"]), money(i["cgst_tcs"]), money(i["sgst_tcs"])]
        return
    assert spec.query is not None and spec.row is not None
    result = await session.stream(spec.query(ctx).execution_options(yield_per=BATCH))
    count = 0
    async for row in result:
        yield spec.row(row)
        count += 1
        if count >= MAX_ROWS:
            yield [f"Stopped at {MAX_ROWS:,} rows; export a shorter date range for the rest."]
            break


def _encode_rows(rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerows([[safe_cell(c) for c in r] for r in rows])
    return buf.getvalue().encode("utf-8")


def _pick(row: list[Any], cols: list[int] | None) -> list[Any]:
    return row if cols is None or len(row) == 1 and len(cols) > 1 else [row[i] if i < len(row) else "" for i in cols]


async def stream_csv(spec: ExportSpec, ctx: Context, cols: list[int] | None = None) -> AsyncIterator[bytes]:
    """Yields the file in chunks. Opens its own read-only session so the stream outlives the request handler."""
    headers = spec.headers if cols is None else [spec.headers[i] for i in cols]
    yield codecs.BOM_UTF8 + _encode_rows([headers])
    async with SessionLocal() as session:
        batch: list[list[Any]] = []
        async for row in iter_rows(spec, ctx, session):
            batch.append(_pick(row, cols))
            if len(batch) >= BATCH:
                yield _encode_rows(batch)
                batch = []
        if batch:
            yield _encode_rows(batch)


async def build_xlsx(spec: ExportSpec, ctx: Context, cols: list[int], about: list[tuple[str, str]], title: str):
    """Writes the workbook to a temporary file (spills to disk past 8 MB) and returns it, rewound."""
    writer = docgen.XlsxWriter(spec.label, [spec.headers[i] for i in cols])
    async with SessionLocal() as session:
        async for row in iter_rows(spec, ctx, session):
            writer.append(_pick(row, cols))
    writer.add_about(title, about + [("Rows", f"{writer.rows:,}")])
    return writer.finish()


async def build_pdf(spec: ExportSpec, ctx: Context, cols: list[int], about: list[tuple[str, str]], title: str, brand: str) -> bytes:
    rows: list[list[Any]] = []
    total = 0
    async with SessionLocal() as session:
        async for row in iter_rows(spec, ctx, session):
            total += 1
            if len(rows) < docgen.PDF_MAX_ROWS:
                rows.append(_pick(row, cols))
    subtitle = " · ".join(f"{k}: {v}" for k, v in about)
    doc = docgen.PdfDoc(title, subtitle).table([spec.headers[i] for i in cols], rows, total_rows=total)
    if total == 0:
        doc.note("No rows match these filters.")
    return docgen.pdf_bytes(doc, brand=brand)
