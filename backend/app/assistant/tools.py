"""The assistant's tools: what it can look up, export, analyse and propose.

Each tool declares the permission it needs; a person only gets the tools their role allows, and the
check is repeated when a tool runs. A tool returns:

- ``data``: exact figures for the model (contact details masked unless the admin allows sharing),
- ``cards``: what the screen shows — metrics, tables, charts, files, links, action confirmations.

Cards are built from the same data, so the numbers a person sees never depend on the model's wording.
"""
from __future__ import annotations

import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AssistantUpload, User

from . import actions as actions_mod
from . import periods, queries, uploads
from . import settings as asst_settings
from .queries import inr, num

PERIOD_SCHEMA = {
    "period": {"type": "string", "enum": list(periods.PRESETS), "description": "Time range in India time. Use custom with date_from/date_to for other dates."},
    "date_from": {"type": "string", "description": "YYYY-MM-DD, only with period=custom"},
    "date_to": {"type": "string", "description": "YYYY-MM-DD, only with period=custom"},
}


@dataclass
class ToolContext:
    session: AsyncSession
    user: User
    permissions: set[str]
    conversation_id: uuid.UUID
    share_contacts: bool
    upload_ids: list[str] = field(default_factory=list)


@dataclass
class ToolOutput:
    data: Any
    cards: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class Tool:
    name: str
    label: str  # shown while it runs ("Checking sales…")
    description: str
    schema: dict[str, Any]
    any_of: tuple[str, ...]  # the person needs at least one of these permissions
    group: str  # decision-layer domain
    handler: Callable[[ToolContext, dict[str, Any]], Awaitable[ToolOutput]]

    def spec(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": {"type": "object", **self.schema}}


TOOLS: dict[str, Tool] = {}


def tool(name: str, label: str, description: str, properties: dict[str, Any], *, any_of: tuple[str, ...], group: str, required: tuple[str, ...] = ()):
    def deco(fn):
        TOOLS[name] = Tool(name, label, description, {"properties": properties, "required": list(required)}, any_of, group, fn)
        return fn
    return deco


def available(perms: set[str]) -> list[Tool]:
    return [t for t in TOOLS.values() if set(t.any_of) & perms]


# ----------------------------------------------------------------------------- helpers


def _period(a: dict[str, Any], default: str = "today") -> periods.Period:
    return periods.resolve(a.get("period") or (None if a.get("date_from") or a.get("date_to") else default), a.get("date_from"), a.get("date_to"))


def _limit(a: dict[str, Any], default: int = 25, hi: int = 200) -> int:
    try:
        return max(1, min(int(a.get("limit") or default), hi))
    except (TypeError, ValueError):
        return default


def mask(value: Any) -> Any:
    """Hides phone numbers, emails and street addresses from the model (screen cards keep them)."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            lk = k.lower()
            if isinstance(v, str) and v and ("phone" in lk or lk in ("contact", "mobile")):
                digits = re.sub(r"\D", "", v)
                out[k] = f"{digits[:2]}••••••{digits[-2:]}" if len(digits) >= 6 else "••••"
            elif isinstance(v, str) and v and "email" in lk:
                name, _, dom = v.partition("@")
                out[k] = f"{name[:1]}•••@{dom}" if dom else "•••"
            elif lk in ("address", "line1", "line2", "landmark") and isinstance(v, str):
                out[k] = "(hidden)"
            else:
                out[k] = mask(v)
        return out
    if isinstance(value, list):
        return [mask(v) for v in value]
    return value


def metrics(title: str, items: list[tuple[str, str, str | None]], note: str = "") -> dict[str, Any]:
    return {"type": "metrics", "title": title, "note": note, "items": [{"label": label, "value": v, "hint": h or ""} for label, v, h in items]}


def table(title: str, columns: list[str], rows: list[list[Any]], *, total: int | None = None, note: str = "", link: str = "") -> dict[str, Any]:
    return {"type": "table", "title": title, "columns": columns, "rows": [[("" if c is None else c) for c in r] for r in rows],
            "total_rows": total if total is not None else len(rows), "note": note, "link": link}


def chart(title: str, kind: str, labels: list[str], series: list[tuple[str, list[float]]], unit: str = "") -> dict[str, Any]:
    return {"type": "chart", "title": title, "kind": kind, "labels": labels, "unit": unit, "series": [{"name": n, "values": v} for n, v in series]}


def _delta(cur: int, prev: int) -> str | None:
    if not prev:
        return None  # nothing to compare with
    change = (cur - prev) * 100 / abs(prev)
    return f"{'+' if change >= 0 else ''}{change:.1f}% vs previous"


# ----------------------------------------------------------------------------- business numbers


@tool("business_overview", "Checking the numbers", "Sales, orders, average order value, cancellations, returns, commission, COD vs online and new customers "
      "for a period. Use for 'how much did we sell', 'today's orders', 'this month's revenue'. Optional filters narrow it to one seller, category, payment method or state.",
      {**PERIOD_SCHEMA, "compare": {"type": "boolean", "description": "Also return the previous period of the same length"},
       "seller": {"type": "string", "description": "store name, GSTIN or id"}, "category": {"type": "string"},
       "payment_method": {"type": "string", "enum": ["cod", "online"]}, "state_code": {"type": "string", "description": "2-digit GST state code, e.g. 33 for Tamil Nadu"}},
      any_of=("dashboard",), group="sales")
async def business_overview(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a)
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    cat = await queries.resolve_category(ctx.session, a.get("category")) if a.get("category") else None
    if a.get("seller") and not seller:
        return ToolOutput({"error": f"No single seller matches '{a['seller']}'. Use find_sellers first."})
    if a.get("category") and not cat:
        return ToolOutput({"error": f"No single category matches '{a['category']}'."})
    kw = {"seller_id": seller.id if seller else None, "category_id": cat.id if cat else None, "payment_method": a.get("payment_method"), "state_code": a.get("state_code")}
    cur = await queries.sales_summary(ctx.session, p, **kw)
    prev = await queries.sales_summary(ctx.session, p.previous(), **kw) if a.get("compare", True) else None
    scope = " · ".join(x for x in (seller.display_name if seller else "", cat.name if cat else "",
                                   {"cod": "Cash on delivery", "online": "Paid online"}.get(a.get("payment_method") or "", "")) if x)

    def d(k: str) -> str | None:
        return _delta(cur[k], prev[k]) if prev else None

    items = [("Sales", inr(cur["sales"]), d("sales")), ("Orders", num(cur["orders"]), d("orders")), ("Average order", inr(cur["average_order_value"]), d("average_order_value")),
             ("Units sold", num(cur["units"]), d("units")), ("Net after returns", inr(cur["net_sales"]), None), ("Commission earned", inr(cur["commission"]), d("commission")),
             ("Cancelled packages", f"{num(cur['cancelled_packages'])} ({cur['cancellation_rate_pct']}%)", None), ("COD / online orders", f"{cur['cod_orders']} / {cur['online_orders']}", None)]
    if "new_customers" in cur:
        items.append(("New customers", num(cur["new_customers"]), d("new_customers")))
    data = {"current": cur, "previous": prev, "definitions": {"sales": "package totals excluding cancelled ones and unpaid online orders",
                                                             "orders": "orders with at least one package placed", "amounts": "integer paise; divide by 100 for rupees"}}
    return ToolOutput(data, [metrics(f"{p.label}{' · ' + scope if scope else ''}", items, note="IST calendar days. Compared with the previous period of the same length." if prev else "")])


@tool("sales_breakdown", "Breaking down sales", "Sales and orders grouped by day, week, month, hour of day, seller, category, product, state, payment method or package status. "
      "Use for trends, charts, comparisons and top-N lists.",
      {**PERIOD_SCHEMA, "by": {"type": "string", "enum": list(queries.BREAKDOWNS)}, "seller": {"type": "string"}, "category": {"type": "string"},
       "payment_method": {"type": "string", "enum": ["cod", "online"]}, "limit": {"type": "integer", "description": "top N for seller/category/product/state (default 10)"}},
      any_of=("dashboard",), group="sales", required=("by",))
async def sales_breakdown(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a, "last_7_days")
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    cat = await queries.resolve_category(ctx.session, a.get("category")) if a.get("category") else None
    out = await queries.sales_breakdown(ctx.session, p, a.get("by", "day"), seller_id=seller.id if seller else None, category_id=cat.id if cat else None,
                                        payment_method=a.get("payment_method"), limit=_limit(a, 10, 100))
    by = out["by"]
    labels = [i["label"] for i in out["items"]]
    has_units = by in ("category", "product")
    second = "units" if has_units else "orders"
    rows = [[i["label"], inr(i["sales"]), num(i.get(second, 0))] for i in out["items"]]
    kind = "line" if by in ("day", "week", "month", "hour") and len(labels) > 2 else "bar"
    cards = [chart(f"Sales by {by.replace('_', ' ')} · {p.label}", kind, labels, [("Sales (₹)", [round(i["sales"] / 100, 2) for i in out["items"]])], unit="₹"),
             table(f"Sales by {by.replace('_', ' ')}", [by.replace("_", " ").capitalize(), "Sales", second.capitalize()], rows)]
    return ToolOutput(out, cards)


@tool("work_queue", "Checking what needs attention", "Counts of everything waiting for staff: sellers and listings to review, late packages, returns, failed refunds, "
      "overdue tickets, reviews to moderate, failed payouts, out-of-stock options.", {}, any_of=("dashboard",), group="overview")
async def work_queue(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    q = await queries.pending_work(ctx.session)
    labels = {"sellers_to_review": ("Sellers to review", "/admin/sellers?status=submitted"), "listings_to_review": ("Listings to review", "/admin/products"),
              "packages_late_to_ship_48h": ("Packages not shipped in 48 h", "/admin/orders"), "returns_waiting": ("Returns waiting", "/admin/returns"),
              "refunds_failed": ("Failed refunds", "/admin/refunds"), "tickets_reply_overdue": ("Tickets past reply time", "/admin/support"),
              "tickets_open": ("Open tickets", "/admin/support"), "reviews_to_moderate": ("Reviews to moderate", "/admin/reviews"),
              "payouts_failed": ("Failed payouts", "/admin/payouts"), "out_of_stock_options": ("Options out of stock", "/admin/products")}
    items = [(labels[k][0], num(v), None) for k, v in q.items()]
    links = [{"label": labels[k][0], "href": labels[k][1]} for k, v in q.items() if v and _page_allowed(labels[k][1], ctx.permissions)]
    return ToolOutput(q, [metrics("Waiting for you", items), {"type": "links", "title": "Open", "items": links}] if links else [metrics("Waiting for you", items)])


# ----------------------------------------------------------------------------- orders and customers


@tool("find_orders", "Finding orders", "Lists packages (one seller's part of an order) with filters: status, search text (order or package number, customer name or phone, AWB), "
      "seller, payment method, period, or packages not shipped after N hours.",
      {**PERIOD_SCHEMA, "status": {"type": "string", "enum": list(queries.PACKAGE_STATUSES)}, "q": {"type": "string"}, "seller": {"type": "string"},
       "payment_method": {"type": "string", "enum": ["cod", "online"]}, "late_to_ship_hours": {"type": "integer"}, "limit": {"type": "integer"},
       "all_time": {"type": "boolean", "description": "ignore the period"}},
      any_of=("orders",), group="orders")
async def find_orders(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = None if a.get("all_time") or (a.get("q") and not a.get("period")) or a.get("late_to_ship_hours") else _period(a, "last_30_days")
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    out = await queries.find_packages(ctx.session, period=p, status=a.get("status"), q=a.get("q"), seller_id=seller.id if seller else None,
                                      payment_method=a.get("payment_method"), late_to_ship_hours=a.get("late_to_ship_hours"), limit=_limit(a))
    rows = [[i["package"], i["order"], i["placed"], i["status"], i["seller"], i["customer"], i["payment"], inr(i["total"]), i["city"]] for i in out["items"]]
    title = f"Packages{' · ' + p.label if p else ''}{' · ' + a['status'] if a.get('status') else ''}"
    note = f"Showing {len(rows)} of {out['total']} (total value {inr(out['total_value'])})." if out["total"] > len(rows) else f"Total value {inr(out['total_value'])}."
    return ToolOutput(out, [table(title, ["Package", "Order", "Placed", "Status", "Seller", "Customer", "Payment", "Total", "City"], rows, total=out["total"], note=note, link="/admin/orders")])


@tool("order_details", "Opening the order", "Everything about one order: items, packages, payment, refunds, returns and timeline. Give an order number, package number or AWB.",
      {"reference": {"type": "string"}}, any_of=("orders",), group="orders", required=("reference",))
async def order_details(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    d = await queries.order_detail(ctx.session, str(a.get("reference", "")))
    if d is None:
        return ToolOutput({"error": "No order, package or AWB with that number."})
    cards = [
        metrics(f"Order {d['number']}", [("Status", d["status"], None), ("Placed", d["placed"], None), ("Payment", f"{d['payment_method'].upper()} · {d['payment_status']}", None),
                                         ("Total", inr(d["grand_total"]), None), ("Refunded", inr(d["refunded_total"]), None), ("Customer", d["customer"]["name"] or d["customer"]["phone"], None)]),
        table("Items", ["SKU", "Item", "Option", "Qty", "Unit price", "Line total", "Returned"],
              [[i["sku"], i["title"], i["option"], i["qty"], inr(i["unit_price"]), inr(i["line_total"]), i["returned_qty"]] for i in d["items"]]),
        table("Packages", ["Package", "Seller", "Status", "Total", "Courier", "AWB", "Delivered"],
              [[p["package"], p["seller"], p["status"], inr(p["total"]), p["courier"], p["awb"], p["delivered"]] for p in d["packages"]],
              link=f"/admin/orders/{d['order_id']}"),
    ]
    if d["timeline"]:
        cards.append(table("Timeline", ["When", "Change", "By", "Note"], [[t["at"], t["change"], t["by"], t["note"]] for t in d["timeline"]]))
    return ToolOutput(d, cards)


@tool("find_customers", "Finding customers", "Search customers by name, phone or email, or list top spenders for a period.",
      {**PERIOD_SCHEMA, "q": {"type": "string"}, "sort": {"type": "string", "enum": ["recent", "top_spenders"]}, "limit": {"type": "integer"}},
      any_of=("customers",), group="customers")
async def find_customers(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a) if a.get("period") or a.get("date_from") else None
    out = await queries.find_customers(ctx.session, q=a.get("q"), period=p, sort=a.get("sort", "recent"), limit=_limit(a))
    rows = [[c["name"], c["phone"], c["email"], c["joined"], c["orders"], inr(c["spent"]), c["last_order"], "yes" if c["active"] else "blocked"] for c in out["items"]]
    return ToolOutput(out, [table(f"Customers{' · ' + p.label if p else ''}", ["Name", "Mobile", "Email", "Joined", "Orders", "Spent", "Last order", "Active"], rows,
                                  total=out["total"], link="/admin/customers")])


@tool("customer_profile", "Opening the customer", "One customer's profile: orders, spend, returns, cancellations, tickets and recent orders. Give a mobile number, email, id or exact name.",
      {"reference": {"type": "string"}}, any_of=("customers",), group="customers", required=("reference",))
async def customer_profile(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    d = await queries.customer_detail(ctx.session, str(a.get("reference", "")))
    if d is None:
        return ToolOutput({"error": "No single customer matches. Try the mobile number or email."})
    cards = [metrics(d["name"] or d["phone"], [("Mobile", d["phone"], None), ("Email", d["email"] or "—", None), ("Joined", d["joined"], None),
                                              ("Orders", num(d["orders"]), None), ("Net spend", inr(d["net_spend"]), None), ("Average order", inr(d["average_order_value"]), None),
                                              ("Returns", num(d["returns"]), None), ("Cancelled packages", num(d["cancelled_packages"]), None),
                                              ("Account", "active" if d["active"] else "blocked", None)]),
             table("Recent orders", ["Order", "Placed", "Status", "Payment", "Total"], [[o["number"], o["placed"], o["status"], o["payment"], inr(o["total"])] for o in d["recent_orders"]])]
    if d["tickets"]:
        cards.append(table("Support tickets", ["Ticket", "Subject", "Status"], [[t["number"], t["subject"], t["status"]] for t in d["tickets"]]))
    return ToolOutput(d, cards)


# ----------------------------------------------------------------------------- catalogue and sellers


@tool("find_products", "Searching the catalogue", "Search listings by title, brand or SKU, filter by status, seller, category or stock, sort by best selling, rating, price or stock.",
      {"q": {"type": "string"}, "status": {"type": "string", "enum": ["approved", "pending", "rejected", "draft", "archived"]}, "seller": {"type": "string"},
       "category": {"type": "string"}, "max_stock": {"type": "integer"}, "sort": {"type": "string", "enum": ["recent", "best_selling", "rating", "price_high", "price_low", "stock_low"]},
       "limit": {"type": "integer"}}, any_of=("catalog",), group="catalog")
async def find_products(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    cat = await queries.resolve_category(ctx.session, a.get("category")) if a.get("category") else None
    out = await queries.find_products(ctx.session, q=a.get("q"), status=a.get("status"), seller_id=seller.id if seller else None, category_id=cat.id if cat else None,
                                      max_stock=a.get("max_stock"), sort=a.get("sort", "recent"), limit=_limit(a))
    rows = [[p["title"], p["sku"], p["seller"], p["category"], p["status"], inr(p["price"]), inr(p["mrp"]), p["stock"], p["sold"], f"{p['rating']:.1f} ({p['reviews']})"] for p in out["items"]]
    return ToolOutput(out, [table("Listings", ["Product", "SKU", "Seller", "Category", "Status", "Price", "MRP", "Stock", "Sold", "Rating"], rows, total=out["total"], link="/admin/products")])


@tool("stock_alerts", "Checking stock", "Live product options with stock at or below a threshold (default 5), lowest first.",
      {"threshold": {"type": "integer"}, "seller": {"type": "string"}, "limit": {"type": "integer"}}, any_of=("catalog", "sellers"), group="catalog")
async def stock_alerts(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    out = await queries.stock_alerts(ctx.session, threshold=int(a.get("threshold") if a.get("threshold") is not None else 5), seller_id=seller.id if seller else None, limit=_limit(a, 50))
    rows = [[i["sku"], i["product"], i["option"], i["seller"], i["stock"], i["sold"]] for i in out["items"]]
    return ToolOutput(out, [table(f"Stock at or below {out['threshold']}", ["SKU", "Product", "Option", "Seller", "Stock", "Sold so far"], rows, total=out["total"],
                                  note=f"{out['out_of_stock']} out of stock in this list.")])


@tool("find_sellers", "Finding sellers", "Search sellers by name, GSTIN or city, filter by status, ranked by sales in a period.",
      {**PERIOD_SCHEMA, "q": {"type": "string"}, "status": {"type": "string", "enum": ["approved", "submitted", "rejected", "suspended", "draft"]}, "limit": {"type": "integer"}},
      any_of=("sellers",), group="sellers")
async def find_sellers(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a, "last_30_days")
    out = await queries.find_sellers(ctx.session, q=a.get("q"), status=a.get("status"), period=p, limit=_limit(a))
    rows = [[s["store"], s["status"], s["city"], s["gstin"], inr(s["sales"]), s["packages"], s["live_listings"], f"{s['rating']:.1f}"] for s in out["items"]]
    return ToolOutput(out, [table(f"Sellers · sales {p.label}", ["Store", "Status", "City", "GSTIN", "Sales", "Packages", "Live listings", "Rating"], rows, total=out["total"], link="/admin/sellers")])


@tool("seller_profile", "Opening the seller", "One seller's status, sales for a period, payouts due, listings, late packages and health score with reasons.",
      {**PERIOD_SCHEMA, "seller": {"type": "string", "description": "store name, GSTIN or id"}}, any_of=("sellers",), group="sellers", required=("seller",))
async def seller_profile(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    s = await queries.resolve_seller(ctx.session, a.get("seller"))
    if s is None:
        return ToolOutput({"error": "No single seller matches. Use find_sellers."})
    p = _period(a, "last_30_days")
    d = await queries.seller_detail(ctx.session, s, p)
    sm = d["sales"]
    cards = [metrics(f"{d['store']} · {p.label}", [("Status", d["status"], None), ("Sales", inr(sm["sales"]), None), ("Orders", num(sm["orders"]), None),
                                                  ("Payout due now", inr(d["payout_due_now"]), None), ("On hold (return window)", inr(d["payout_on_hold"]), None),
                                                  ("Late to ship", num(d["packages_late_to_ship"]), None), ("Rating", f"{d['rating']:.1f} ({d['rating_count']})", None),
                                                  ("Health", f"{d['health']['level']} · {d['health']['score']}", d["health"]["headline"])]),
             table("Why", ["Weight", "Reason"], [[f["weight"], f["text"]] for f in d["health"]["factors"]], link=f"/admin/sellers/{d['id']}")]
    return ToolOutput(d, cards)


# ----------------------------------------------------------------------------- returns, refunds, support, payouts, coupons, tax


@tool("returns_report", "Checking returns", "Returns with counts by status and reason; filter by period, status or seller.",
      {**PERIOD_SCHEMA, "status": {"type": "string", "enum": ["requested", "approved", "picked_up", "received", "refunded", "rejected", "cancelled"]}, "seller": {"type": "string"},
       "limit": {"type": "integer"}}, any_of=("orders", "refunds"), group="returns")
async def returns_report(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a, "last_30_days")
    seller = await queries.resolve_seller(ctx.session, a.get("seller")) if a.get("seller") else None
    out = await queries.find_returns(ctx.session, period=p, status=a.get("status"), seller_id=seller.id if seller else None, limit=_limit(a))
    cards = [metrics(f"Returns · {p.label}", [(k.replace("_", " ").capitalize(), num(v), None) for k, v in out["by_status"].items()] or [("Returns", "0", None)]),
             table("Returns", ["Return", "Package", "Seller", "Requested", "Status", "Reason", "Refund"],
                   [[r["number"], r["package"], r["seller"], r["requested"], r["status"], r["reason"], inr(r["refund_amount"])] for r in out["items"]], total=out["total"], link="/admin/returns")]
    if out["by_reason"]:
        cards.append(chart("Return reasons", "bar", list(out["by_reason"]), [("Returns", list(out["by_reason"].values()))]))
    return ToolOutput(out, cards)


@tool("refunds_report", "Checking refunds", "Refunds by status (pending, processed, failed) with amounts and errors.",
      {**PERIOD_SCHEMA, "status": {"type": "string", "enum": ["pending", "processed", "failed"]}, "limit": {"type": "integer"}}, any_of=("refunds", "orders"), group="returns")
async def refunds_report(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    p = _period(a) if a.get("period") or a.get("date_from") else None
    out = await queries.find_refunds(ctx.session, status=a.get("status"), period=p, limit=_limit(a))
    return ToolOutput(out, [table(f"Refunds{' · ' + a['status'] if a.get('status') else ''}", ["Refund id", "Order", "Amount", "Status", "Reason", "Attempts", "Last error", "Created"],
                                  [[r["id"], r["order"], inr(r["amount"]), r["status"], r["reason"], r["attempts"], r["last_error"], r["created"]] for r in out["items"]],
                                  note=f"Total {inr(out['total_value'])}", link="/admin/refunds")])


@tool("support_tickets", "Checking the support desk", "Support tickets by status, overdue ones (past the 48-hour reply or 30-day resolution limit) or matching text.",
      {"status": {"type": "string", "enum": ["open", "awaiting_customer", "resolved", "closed"]}, "overdue_only": {"type": "boolean"}, "q": {"type": "string"}, "limit": {"type": "integer"}},
      any_of=("support",), group="support")
async def support_tickets(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    out = await queries.find_tickets(ctx.session, status=a.get("status"), overdue_only=bool(a.get("overdue_only")), q=a.get("q"), limit=_limit(a))
    return ToolOutput(out, [table("Support tickets", ["Ticket", "Subject", "Category", "Status", "Priority", "Opened", "Reply due", "Replied"],
                                  [[t["number"], t["subject"], t["category"], t["status"], t["priority"], t["opened"], t["reply_due"], t["replied"] or "—"] for t in out["items"]],
                                  total=out["total"], link="/admin/support")])


@tool("payouts_report", "Checking payouts", "Money due to sellers now, money on hold in the return window, and recent payouts by status.",
      {"status": {"type": "string", "enum": ["pending", "processing", "paid", "failed", "cancelled"]}, "limit": {"type": "integer"}}, any_of=("payouts",), group="payouts")
async def payouts_report(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    out = await queries.payouts_overview(ctx.session, status=a.get("status"), limit=_limit(a))
    return ToolOutput(out, [metrics("Seller payouts", [("Due now", inr(out["due_now_total"]), f"{len(out['due_now'])} sellers"), ("On hold", inr(out["on_hold_total"]), "inside return windows")]
                                    + [(k.capitalize(), num(v), None) for k, v in out["by_status"].items()]),
                            table("Recent payouts", ["Payout", "Seller", "Amount", "Status", "Method", "UTR", "Created", "Paid"],
                                  [[p["number"], p["seller"], inr(p["amount"]), p["status"], p["mode"], p["utr"], p["created"], p["paid"]] for p in out["items"]], link="/admin/payouts")])


@tool("coupons", "Checking coupons", "Coupons with value, limits, usage and status.", {"active_only": {"type": "boolean"}}, any_of=("marketing",), group="marketing")
async def coupons(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    out = await queries.coupons_overview(ctx.session, active_only=bool(a.get("active_only")))
    return ToolOutput(out, [table("Coupons", ["Code", "Discount", "Min order", "Cap", "Used", "Limit", "Ends", "Active", "Paid by"],
                                  [[c["code"], f"{c['value']}%" if c["kind"] == "percent" else inr(c["value"]), inr(c["min_order"]), inr(c["max_discount"]) if c["max_discount"] else "—",
                                    c["used"], c["usage_limit"] or "∞", c["ends"] or "—", "yes" if c["active"] else "no", c["funded_by"]] for c in out["items"]], link="/admin/coupons")])


@tool("gst_tcs_report", "Preparing the TCS report", "GST TCS (GSTR-8) for one month: supplier-wise net taxable value and TCS after returns.",
      {"month": {"type": "string", "description": "YYYY-MM"}}, any_of=("reports",), group="reports", required=("month",))
async def gst_tcs_report(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    from app.services.reports import tcs_report_data

    month = str(a.get("month", ""))
    if not re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month):
        return ToolOutput({"error": "month must look like 2026-10"})
    data = await tcs_report_data(ctx.session, month)
    rows = [[i["gstin"], i["legal_name"], i["sub_orders"], inr(i.get("returned_value", 0)), inr(i["net_taxable_value"]), inr(i["igst_tcs"]), inr(i["cgst_tcs"]), inr(i["sgst_tcs"])] for i in data["items"]]
    return ToolOutput(data, [table(f"GST TCS {month}", ["GSTIN", "Legal name", "Packages", "Returned", "Net taxable", "IGST TCS", "CGST TCS", "SGST TCS"], rows, link="/admin/reports")])


@tool("marketplace_settings", "Reading settings", "Current marketplace settings (fees, COD, tax rates, features, payouts), which integrations are connected (never their keys) "
      "and the go-live checklist.", {}, any_of=("settings", "integrations"), group="settings")
async def marketplace_settings(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    from app.integrations import store as istore
    from app.services.platform_settings import get_settings

    cfg = await get_settings(ctx.session)
    integ = [{"name": i["name"], "on": i["ready"], "mode": i["mode"]} for i in await istore.status(ctx.session)] if "integrations" in ctx.permissions else []
    show = [(k.replace("_", " "), inr(v) if k.endswith("_paise") else (f"{v / 100:g}%" if k.endswith("_bps") else ("on" if v is True else "off" if v is False else str(v)))) for k, v in cfg.items()]
    cards = [table("Marketplace settings", ["Setting", "Value"], [list(x) for x in show], link="/admin/settings")]
    if integ:
        cards.append(table("Integrations", ["Integration", "Connected", "Mode"], [[i["name"], "yes" if i["on"] else "no", i["mode"]] for i in integ], link="/admin/integrations"))
    return ToolOutput({"settings": cfg, "integrations": integ, "setting_keys_note": "*_paise are paise, *_bps are basis points (100 = 1%)"}, cards)


# ----------------------------------------------------------------------------- exports


@tool("prepare_export", "Preparing the download", "Makes a download button for a data export in CSV, Excel (xlsx) or PDF with filters. "
      "Exports: orders, order-items, returns, payouts, ledger, tcs, products, stock, sellers, customers, tickets, ai-runs.",
      {**PERIOD_SCHEMA, "name": {"type": "string"}, "format": {"type": "string", "enum": ["csv", "xlsx", "pdf"]}, "status": {"type": "string"},
       "month": {"type": "string", "description": "YYYY-MM for tcs"}, "q": {"type": "string"}, "payment_method": {"type": "string", "enum": ["cod", "online"]},
       "seller": {"type": "string"}, "low_stock": {"type": "integer"}, "columns": {"type": "array", "items": {"type": "string"}}},
      any_of=("orders", "reports", "payouts", "catalog", "sellers", "customers", "support", "settings"), group="exports", required=("name",))
async def prepare_export(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    from app.services import exports

    spec = exports.ADMIN_EXPORTS.get(str(a.get("name")))
    if spec is None:
        return ToolOutput({"error": f"Unknown export. Choose from: {', '.join(exports.ADMIN_EXPORTS)}"})
    if spec.permission not in ctx.permissions:
        return ToolOutput({"error": f"Your role cannot download {spec.label}."})
    fmt = a.get("format") or "xlsx"
    q: list[tuple[str, str]] = []
    if spec.needs_month:
        q.append(("month", str(a.get("month") or "")))
    elif spec.date_label:
        p = _period(a, "last_30_days")
        q += [("from", p.first_day.isoformat()), ("to", p.last_day.isoformat())]
    for k in ("status", "q", "payment_method", "low_stock"):
        if a.get(k) not in (None, "") and (k == "status" or k in spec.filters):
            q.append((k, str(a[k])))
    if a.get("seller") and "seller" in spec.filters:
        s = await queries.resolve_seller(ctx.session, a["seller"])
        if s:
            q.append(("seller", str(s.id)))
    for c in a.get("columns") or []:
        if c in spec.headers:
            q.append(("columns", c))
    extra = {k: v for k, v in q if k not in ("from", "to", "month", "columns")}
    try:
        ctx_obj = exports.parse_context(spec, seller_id=None, date_from=None if not dict(q).get("from") else periods.date.fromisoformat(dict(q)["from"]),
                                        date_to=None if not dict(q).get("to") else periods.date.fromisoformat(dict(q)["to"]),
                                        status=extra.pop("status", None), month=dict(q).get("month"), extra=extra)
        exports.pick_columns(spec, [v for k, v in q if k == "columns"], fmt)
    except ValueError as exc:
        return ToolOutput({"error": str(exc)})
    path = f"/api/admin/exports/{spec.name}.{fmt}?{urlencode(q)}"
    summary = " · ".join(f"{k}: {v}" for k, v in exports.filter_summary(spec, ctx_obj))
    card = {"type": "file", "title": spec.label, "format": fmt, "path": path, "filename": f"{spec.name}.{fmt}", "detail": summary}
    return ToolOutput({"ready": True, "export": spec.label, "format": fmt, "filters": summary}, [card])


# ----------------------------------------------------------------------------- files


async def _upload(ctx: ToolContext, a: dict[str, Any]) -> AssistantUpload | None:
    ref = a.get("file_id") or (ctx.upload_ids[-1] if ctx.upload_ids else None)
    try:
        up = await ctx.session.get(AssistantUpload, uuid.UUID(str(ref))) if ref else None
    except ValueError:
        up = None
    return up if up and up.user_id == ctx.user.id else None


@tool("file_overview", "Reading your file", "Columns, types, totals and first rows of a file the person uploaded (defaults to the latest one).",
      {"file_id": {"type": "string"}}, any_of=("assistant_files",), group="files")
async def file_overview(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    up = await _upload(ctx, a)
    if up is None:
        return ToolOutput({"error": "No uploaded file found. Ask the person to attach one."})
    prof = uploads.profile(up)
    if prof["kind"] == "text":
        return ToolOutput(prof)
    cols = [[c["name"], c["type"], c["filled"], c["distinct"], c.get("sum", ""), c.get("min", ""), c.get("max", "")] for c in prof["columns"]]
    return ToolOutput(prof, [table(f"{up.filename} · {up.row_count:,} rows", ["Column", "Type", "Filled", "Distinct", "Sum", "Min", "Max"], cols,
                                   note="Only the first 50,000 rows were read." if up.truncated else "")])


@tool("file_query", "Calculating from your file", "Exact counts, sums, averages, min or max over the uploaded file, optionally filtered and grouped.",
      {"file_id": {"type": "string"}, "filters": {"type": "array", "items": {"type": "object", "properties": {"column": {"type": "string"}, "op": {"type": "string", "enum": list(uploads.OPS)},
                                                                                                            "value": {"type": "string"}}}},
       "group_by": {"type": "string"}, "metric": {"type": "string", "enum": list(uploads.METRICS)}, "value_column": {"type": "string"}, "sort": {"type": "string", "enum": ["desc", "asc"]},
       "limit": {"type": "integer"}}, any_of=("assistant_files",), group="files")
async def file_query(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    up = await _upload(ctx, a)
    if up is None:
        return ToolOutput({"error": "No uploaded file found."})
    try:
        out = uploads.query(up, filters=a.get("filters"), group_by=a.get("group_by"), metric=a.get("metric", "count"), value_column=a.get("value_column"),
                            sort=a.get("sort", "desc"), limit=_limit(a, 50, 500))
    except ValueError as exc:
        return ToolOutput({"error": str(exc)})
    label = f"{out['metric']}{' of ' + out['value_column'] if out.get('value_column') else ''}"
    if "items" in out:
        cards = [table(f"{up.filename}: {label} by {a.get('group_by')}", [str(a.get("group_by")), label, "Rows"], [[i["group"], i["value"], i["rows"]] for i in out["items"]],
                       note=f"{out['matched_rows']:,} rows matched."),
                 chart(f"{label} by {a.get('group_by')}", "bar", [i["group"] for i in out["items"][:20]], [(label, [float(i["value"]) for i in out["items"][:20]])])]
    else:
        cards = [metrics(up.filename, [(label.capitalize(), out["value"], None), ("Rows matched", f"{out['matched_rows']:,}", None)])]
    return ToolOutput(out, cards)


@tool("file_compare", "Comparing your file with live data", "Matches each row of the uploaded file to live orders, packages, products (SKU), payouts, customers or sellers and lists "
      "missing records and differences (amounts in rupees, stock, status). Columns are detected from the headers unless given.",
      {"file_id": {"type": "string"}, "entity": {"type": "string", "enum": list(uploads.ENTITIES)}, "key_column": {"type": "string"},
       "columns": {"type": "object", "description": "live field -> file column, e.g. {\"total\": \"Amount\"}", "additionalProperties": {"type": "string"}}},
      any_of=("assistant_files",), group="files", required=("entity",))
async def file_compare(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    up = await _upload(ctx, a)
    if up is None:
        return ToolOutput({"error": "No uploaded file found."})
    need = {"orders": "orders", "packages": "orders", "products": "catalog", "payouts": "payouts", "customers": "customers", "sellers": "sellers"}.get(str(a.get("entity")), "")
    if need and need not in ctx.permissions:
        return ToolOutput({"error": f"Your role cannot read live {a.get('entity')}."})
    try:
        out = await uploads.compare(ctx.session, up, entity=str(a.get("entity")), key_column=a.get("key_column"), columns=a.get("columns"))
    except ValueError as exc:
        return ToolOutput({"error": str(exc)})
    cards = [metrics(f"{up.filename} vs live {out['entity']}", [("Rows with a key", num(out["rows_with_key"]), None), ("Matched", num(out["matched"]), None),
                                                                ("Identical", num(out["rows_identical"]), None), ("Different", num(out["rows_with_differences"]), None),
                                                                ("Not found live", num(out["not_found_in_live"]), None)]
                     + [(f"{f} total (file / live)", f"{v['file']} / {v['live']}", f"difference {v['difference']}") for f, v in out["totals"].items()],
                     note=f"Matched on column “{out['key_column']}”. Compared: {', '.join(f'{k} ← {v}' for k, v in out['compared_columns'].items()) or 'presence only'}.")]
    if out["differences"]:
        cards.append(table("Differences", ["Key", "Field", "In file", "Live"], [[d["key"], x["field"], x["file"], x["live"]] for d in out["differences"] for x in d["differences"]]))
    if out["not_found"]:
        cards.append(table("Not found in live data", ["Key"], [[k] for k in out["not_found"]]))
    return ToolOutput(out, cards)


# ----------------------------------------------------------------------------- actions, navigation, memory


@tool("propose_action", "Preparing the change", "Prepares a change for the person to confirm with a button. Nothing changes until they press Confirm. "
      f"kinds: {', '.join(actions_mod.ACTIONS)}. Look records up first so the params are exact.",
      {"kind": {"type": "string", "enum": list(actions_mod.ACTIONS)}, "params": {"type": "object", "description": "see each kind; e.g. {\"package\": \"PC123-1\", \"reason\": \"...\"}"}},
      any_of=("assistant_actions",), group="actions", required=("kind", "params"))
async def propose_action(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    try:
        act = await actions_mod.prepare(ctx.session, ctx.user, ctx.conversation_id, str(a.get("kind")), dict(a.get("params") or {}))
    except actions_mod.ActionError as exc:
        return ToolOutput({"error": str(exc), "params_needed": actions_mod.ACTIONS.get(str(a.get("kind"))).params if a.get("kind") in actions_mod.ACTIONS else None})
    card = {"type": "action", "action_id": str(act.id), "kind": act.kind, "summary": act.summary, "details": act.result.get("details", []), "status": "pending"}
    return ToolOutput({"prepared": True, "summary": act.summary, "note": "Waiting for the person to press Confirm. Do not say it is done."}, [card])


PAGES: dict[str, tuple[str, str, str]] = {
    "overview": ("Overview", "/admin", "dashboard"), "orders": ("Orders", "/admin/orders", "orders"), "returns": ("Returns", "/admin/returns", "orders"),
    "refunds": ("Refunds", "/admin/refunds", "refunds"), "sellers": ("Sellers", "/admin/sellers", "sellers"), "products": ("Listings", "/admin/products", "catalog"),
    "categories": ("Categories", "/admin/categories", "catalog"), "reviews": ("Reviews", "/admin/reviews", "catalog"), "customers": ("Customers", "/admin/customers", "customers"),
    "support": ("Support desk", "/admin/support", "support"), "payouts": ("Payouts", "/admin/payouts", "payouts"), "coupons": ("Coupons", "/admin/coupons", "marketing"),
    "storefront": ("Storefront", "/admin/storefront", "marketing"), "notifications": ("Messages", "/admin/notifications", "marketing"),
    "reports": ("Reports", "/admin/reports", "reports"), "exports": ("Exports", "/admin/exports", "reports"), "settings": ("Settings", "/admin/settings", "settings"),
    "ai_studio": ("AI studio", "/admin/ai", "settings"), "assistant_settings": ("Assistant settings", "/admin/assistant", "settings"),
    "ai_providers": ("AI providers", "/admin/ai-providers", "ai_providers"), "integrations": ("Integrations", "/admin/integrations", "integrations"),
    "go_live": ("Go-live checklist", "/admin/go-live", "dashboard"), "staff": ("Staff and roles", "/admin/staff", "staff"), "audit": ("Audit log", "/admin/audit", "audit"),
}


def _page_allowed(href: str, perms: set[str]) -> bool:
    path = href.split("?")[0]
    for _, h, p in PAGES.values():
        if h == path:
            return p in perms
    return True


@tool("open_page", "Finding the page", "Gives a link to an admin page. Pages: " + ", ".join(PAGES), {"page": {"type": "string", "enum": list(PAGES)}},
      any_of=("dashboard",), group="help", required=("page",))
async def open_page(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    page = PAGES.get(str(a.get("page")))
    if page is None or page[2] not in ctx.permissions:
        return ToolOutput({"error": "That page is not available for your role."})
    return ToolOutput({"link": page[1]}, [{"type": "links", "title": "Open", "items": [{"label": page[0], "href": page[1]}]}])


@tool("remember", "Saving to memory", "Saves a short note the person asked you to remember for future chats (preferences, standing instructions). "
      "Use forget with the note's number to remove one.", {"note": {"type": "string"}, "forget": {"type": "integer", "description": "1-based number of a saved note to delete"}},
      any_of=("assistant",), group="help")
async def remember(ctx: ToolContext, a: dict[str, Any]) -> ToolOutput:
    notes = await asst_settings.memories(ctx.session, ctx.user.id)
    if a.get("forget"):
        i = int(a["forget"]) - 1
        if 0 <= i < len(notes):
            notes.pop(i)
    if a.get("note"):
        notes.append(str(a["note"]))
    notes = await asst_settings.set_memories(ctx.session, ctx.user.id, notes)
    return ToolOutput({"saved_notes": notes})


# ----------------------------------------------------------------------------- execution


def model_view(data: Any, share_contacts: bool, limit: int = 14000) -> str:
    text = json.dumps(data if share_contacts else mask(data), ensure_ascii=False, default=str)
    if len(text) > limit:
        text = text[:limit] + '…" (truncated: the screen shows the full table; summarise what is here)'
    return text


async def execute(ctx: ToolContext, name: str, args: dict[str, Any]) -> tuple[ToolOutput, bool]:
    """Runs a tool after re-checking the permission. Returns (output, is_error)."""
    t = TOOLS.get(name)
    if t is None:
        return ToolOutput({"error": f"Unknown tool {name}"}), True
    if not set(t.any_of) & ctx.permissions:
        return ToolOutput({"error": "Your role does not allow this."}), True
    try:
        out = await t.handler(ctx, args if isinstance(args, dict) else {})
    except ValueError as exc:
        return ToolOutput({"error": str(exc)}), True
    return out, isinstance(out.data, dict) and "error" in out.data
