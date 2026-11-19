"""What the shop assistant can look up or prepare for a customer.

Rules every tool follows:
- the customer is ``ctx.user`` (from the signed-in session), never an argument the model supplies;
- records are fetched with ``user_id == ctx.user.id`` in the query itself, so another customer's order
  number simply finds nothing;
- outputs come from ``views.py`` whitelists or public product cards;
- tools that change something only *prepare* it; the customer confirms on screen.

A tool returns ``data`` (what the model reads) and ``cards`` (what the customer sees), built from the same rows.
"""
from __future__ import annotations

import json
import re
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import and_, desc, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import Order, Product, ShopChatAction, SupportTicket, TicketMessage, User
from app.routers.catalog import product_cards
from app.services.catalog import public_product_filter
from app.services.support import CATEGORIES

from . import kb, views
from .intents import ORDER_RE, TICKET_RE


@dataclass
class Ctx:
    session: AsyncSession
    user: User | None
    chat_id: uuid.UUID
    page_path: str = "/"
    features: dict[str, bool] = field(default_factory=dict)  # Admin → Shop assistant switches
    kb_hits: list[str] = field(default_factory=list)  # article ids used in this reply


@dataclass
class Out:
    data: Any
    cards: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class Tool:
    name: str
    label: str
    description: str
    schema: dict[str, Any]
    login: bool
    feature: str
    handler: Callable[[Ctx, dict[str, Any]], Awaitable[Out]]

    def spec(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": {"type": "object", **self.schema}}


TOOLS: dict[str, Tool] = {}


def tool(name: str, label: str, description: str, properties: dict[str, Any], *, login: bool, feature: str, required: tuple[str, ...] = ()):
    def deco(fn):
        TOOLS[name] = Tool(name, label, description, {"properties": properties, "required": list(required)}, login, feature, fn)
        return fn
    return deco


FEATURE_PAGE = {"product_search": ("Search", "/search"), "orders": ("My orders", "/orders"), "cancel_orders": ("My orders", "/orders"),
                "returns_refunds": ("My orders", "/orders"), "tickets": ("Support", "/support"), "help_articles": ("Help", "/contact")}


def available(signed_in: bool, features: dict[str, bool]) -> list[Tool]:
    return [t for t in TOOLS.values() if (signed_in or not t.login) and features.get(t.feature, True)]


def sign_in_card(ctx: Ctx, reason: str) -> dict[str, Any]:
    nxt = ctx.page_path if ctx.page_path.startswith("/") and not ctx.page_path.startswith("//") else "/"
    return {"type": "signin", "text": reason, "link": f"/login?next={nxt}"}


async def execute(ctx: Ctx, name: str, args: dict[str, Any]) -> tuple[Out, bool]:
    t = TOOLS.get(name)
    if t is None:  # e.g. a model asking for an admin tool: it does not exist here
        return Out({"error": f"There is no tool called {name}."}), True
    if not ctx.features.get(t.feature, True):
        label, link = FEATURE_PAGE.get(t.feature, ("Help", "/contact"))
        return Out({"error": f"This is not available in chat. The customer can use the {label} page."},
                   [{"type": "link", "text": f"Open {label}", "link": link}]), False
    if t.login and ctx.user is None:
        return Out({"error": "sign_in_required", "message": "The customer must sign in first."},
                   [sign_in_card(ctx, "Please sign in so I can see your orders, returns and requests.")]), False
    try:
        return await t.handler(ctx, args if isinstance(args, dict) else {}), False
    except (ValueError, TypeError) as exc:
        return Out({"error": str(exc)[:300]}), True


def model_view(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, default=str)
    return text if len(text) <= 8000 else text[:8000] + "…(cut)"


def _int(v: Any, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(int(v), hi))
    except (TypeError, ValueError):
        return default


def _rupees_to_paise(v: Any) -> int | None:
    if v in (None, ""):
        return None
    try:
        return max(0, int(float(v) * 100))
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------- products (public)


def _tsquery(words: list[str], op: str) -> str | None:
    words = [re.sub(r"[^\w]", "", w) for w in words]
    words = [w for w in words if w][:8]
    return f" {op} ".join(f"{w}:*" for w in words) if words else None


async def find_products(session: AsyncSession, query: str, *, min_price: int | None = None, max_price: int | None = None,
                        sort: str = "relevance", limit: int = 6) -> list[Product]:
    base = list(public_product_filter())
    if min_price is not None:
        base.append(Product.price_from >= min_price)
    if max_price is not None:
        base.append(Product.price_from <= max_price)
    words = kb.tokens(query)
    order_by = {"price_asc": [Product.price_from.asc()], "price_desc": [Product.price_from.desc()],
                "rating": [Product.rating_avg.desc(), Product.rating_count.desc()],
                "discount": [desc((Product.mrp_from - Product.price_from) * 100 / func.nullif(Product.mrp_from, 0))]}.get(sort)
    if not words:
        stmt = select(Product).where(and_(*base)).order_by(*(order_by or [Product.sold_count.desc()]), Product.id).limit(limit)
        return list((await session.execute(stmt)).scalars())
    for op in ("&", "|"):  # every word first, then any word
        tsq = _tsquery(words, op)
        conds = [Product.title.ilike(f"%{query.strip()[:60]}%"), Product.brand.ilike(query.strip()[:60])]
        rank = literal(0.0)
        if tsq:
            q = func.to_tsquery("simple", tsq)
            conds.insert(0, Product.search_vector.op("@@")(q))
            rank = func.ts_rank(Product.search_vector, q)
        stmt = (select(Product).where(and_(*base), or_(*conds))
                .order_by(*(order_by or [Product.in_stock.desc(), desc(rank), Product.sold_count.desc()]), Product.id).limit(limit))
        rows = list((await session.execute(stmt)).scalars())
        if rows:
            return rows
    return []


def _product_data(c: dict[str, Any]) -> dict[str, Any]:
    return {"title": c["title"], "brand": c["brand"], "price": kb.inr(c["price"]), "mrp": kb.inr(c["mrp"]) if c["mrp"] > c["price"] else "",
            "discount_pct": c["discount_pct"], "rating": c["rating_avg"], "ratings": c["rating_count"], "in_stock": c["in_stock"],
            "seller": c["seller_name"], "link": f"/p/{c['slug']}"}


# The chat shows only these product fields (a whitelist: new fields on store cards do not reach the chat by accident).
CARD_FIELDS = ("id", "slug", "title", "brand", "image", "price", "mrp", "discount_pct", "rating_avg", "rating_count", "in_stock", "seller_name")


def _card_view(card: dict) -> dict:
    return {k: card[k] for k in CARD_FIELDS if k in card}


@tool("search_products", "Finding products", "Search the store's products by words, with optional price limits in rupees. "
      "Use for 'show me running shoes under 2000', 'do you have pressure cookers'. Returns at most 6 products.",
      {"query": {"type": "string", "description": "product words, e.g. 'running shoes'"},
       "min_price_rupees": {"type": "number"}, "max_price_rupees": {"type": "number"},
       "sort": {"type": "string", "enum": ["relevance", "price_asc", "price_desc", "rating", "discount"]}},
      feature="product_search", login=False, required=("query",))
async def search_products(ctx: Ctx, a: dict[str, Any]) -> Out:
    query = str(a.get("query") or "")[:100]
    rows = await find_products(ctx.session, query, min_price=_rupees_to_paise(a.get("min_price_rupees")),
                               max_price=_rupees_to_paise(a.get("max_price_rupees")), sort=str(a.get("sort") or "relevance"))
    cards = [_card_view(c) for c in await product_cards(ctx.session, rows)]
    if not cards:
        return Out({"products": [], "note": "No matching products."})
    link = f"/search?q={query.replace(' ', '+')}" if query else "/search"
    return Out({"products": [_product_data(c) for c in cards]}, [{"type": "products", "title": f"Products for “{query}”" if query else "Products",
                                                                  "items": cards, "link": link}])


@tool("product_info", "Checking the product", "Details of one product the customer names or is looking at: price, offer, stock, rating, "
      "return window, cash on delivery, highlights, seller. Pass the product link slug if known, else its name.",
      {"slug": {"type": "string"}, "name": {"type": "string"}}, feature="product_search", login=False)
async def product_info(ctx: Ctx, a: dict[str, Any]) -> Out:
    p = None
    slug = str(a.get("slug") or "").strip().strip("/").removeprefix("p/")
    if slug:
        p = (await ctx.session.execute(select(Product).where(Product.slug == slug[:200], *public_product_filter()))).scalar_one_or_none()
    if p is None and a.get("name"):
        found = await find_products(ctx.session, str(a["name"])[:100], limit=1)
        p = found[0] if found else None
    if p is None:
        return Out({"error": "No such product in the store."})
    card = _card_view((await product_cards(ctx.session, [p]))[0])
    facts = await kb.public_facts(ctx.session)
    data = _product_data(card) | {
        "highlights": [str(h) for h in (p.highlights or [])][:6],
        "returnable": p.return_window_days > 0,
        "return_window_days": p.return_window_days,
        "cash_on_delivery": facts["cod_enabled"],
        "delivery": f"{facts['shipping_fee']} per seller, free when a seller's items reach {facts['free_delivery_amount']}",
    }
    return Out(data, [{"type": "products", "title": "", "items": [card], "link": f"/p/{p.slug}"}])


# ----------------------------------------------------------------------------- help knowledge (public)


@tool("help_articles", "Looking it up", "Search the store's help articles (delivery, cash on delivery, payments, cancellation, returns, "
      "refunds, sign-in, coupons, invoices, selling, grievance). Use for any policy or how-to question.",
      {"query": {"type": "string"}}, feature="help_articles", login=False, required=("query",))
async def help_articles(ctx: Ctx, a: dict[str, Any]) -> Out:
    hits = await kb.search(ctx.session, str(a.get("query") or "")[:300], limit=3, min_score=1.5)
    ctx.kb_hits += [h.id for h in hits]
    if not hits:
        return Out({"articles": [], "note": "No help article matches. Offer to open a support request."})
    return Out({"articles": [{"title": h.title, "text": h.body[:1500], "link": h.link} for h in hits]},
               [{"type": "article", "title": hits[0].title, "text": hits[0].body, "link": hits[0].link}])


@tool("store_policies", "Checking store policies", "The store's current delivery fee, free-delivery amount, cash on delivery, delivery "
      "times and return reasons. Use for questions about charges and delivery days.", {}, feature="help_articles", login=False)
async def store_policies(ctx: Ctx, a: dict[str, Any]) -> Out:
    f = await kb.public_facts(ctx.session)
    return Out({k: f[k] for k in ("brand", "shipping_fee", "free_delivery_amount", "cod_text", "transit_same_city", "transit_same_state",
                                  "transit_national", "returns_enabled", "return_reasons", "grievance_text")})


# ----------------------------------------------------------------------------- the customer's own records


async def _own_order(ctx: Ctx, number: str | None) -> Order | None:
    """The customer's order by number (or package number); None if it is not theirs or does not exist."""
    assert ctx.user is not None
    stmt = select(Order).where(Order.user_id == ctx.user.id)
    if number:
        m = ORDER_RE.search(number)
        if not m:
            return None
        stmt = stmt.where(Order.number == m.group(1).upper())
    else:
        stmt = stmt.order_by(Order.created_at.desc()).limit(1)
    return (await ctx.session.execute(stmt)).scalars().first()


@tool("my_orders", "Checking your orders", "The signed-in customer's recent orders with status and totals.",
      {"limit": {"type": "integer", "description": "1-10, default 5"}}, feature="orders", login=True)
async def my_orders(ctx: Ctx, a: dict[str, Any]) -> Out:
    rows = list((await ctx.session.execute(select(Order).where(Order.user_id == ctx.user.id).order_by(Order.created_at.desc())
                                           .limit(_int(a.get("limit"), 5, 1, 10)))).scalars())
    cards = await views.order_cards(ctx.session, rows)
    if not cards:
        return Out({"orders": [], "note": "The customer has no orders yet."})
    return Out({"orders": [{k: c[k] for k in ("number", "placed_at", "status", "total_text", "payment", "item_count")}
                           | {"items": [i["title"] for i in c["items"]]} for c in cards]},
               [{"type": "orders", "title": "Your recent orders", "items": cards, "link": "/orders"}])


@tool("order_details", "Checking the order", "Full status of one of the customer's orders: each package's progress, courier and tracking, "
      "expected delivery, cancellation and return eligibility, refunds and returns. Without a number, the latest order.",
      {"order_number": {"type": "string", "description": "e.g. PC2611184K7QZD (or a package number PC2611184K7QZD-1)"}}, feature="orders", login=True)
async def order_details(ctx: Ctx, a: dict[str, Any]) -> Out:
    o = await _own_order(ctx, str(a.get("order_number") or "") or None)
    if o is None:
        return Out({"error": "No order with that number on this account. Ask the customer to check the number, or show their recent orders."})
    v = await views.order_view(ctx.session, o)
    return Out(v, [{"type": "order", "order": v}])


@tool("my_returns_and_refunds", "Checking returns and refunds", "The customer's return requests and refunds with their status.", {}, feature="returns_refunds", login=True)
async def my_returns_and_refunds(ctx: Ctx, a: dict[str, Any]) -> Out:
    rets = await views.return_list(ctx.session, ctx.user.id)
    orders = list((await ctx.session.execute(select(Order).where(Order.user_id == ctx.user.id, Order.refunded_total > 0)
                                             .order_by(Order.created_at.desc()).limit(5))).scalars())
    refunds = []
    for o in orders:
        v = await views.order_view(ctx.session, o)
        refunds += [{"order": o.number, **r} for r in v["refunds"]]
    data = {"returns": rets, "refunds": refunds}
    if not rets and not refunds:
        data["note"] = "No returns or refunds on this account."
    return Out(data, [{"type": "returns", "title": "Your returns and refunds", "returns": rets, "refunds": refunds}] if rets or refunds else [])


@tool("my_tickets", "Checking your requests", "The customer's support requests (tickets) and their status.", {}, feature="tickets", login=True)
async def my_tickets(ctx: Ctx, a: dict[str, Any]) -> Out:
    rows = list((await ctx.session.execute(select(SupportTicket).where(SupportTicket.user_id == ctx.user.id)
                                           .order_by(SupportTicket.updated_at.desc()).limit(8))).scalars())
    items = [views.ticket_view(t) for t in rows]
    if not items:
        return Out({"tickets": [], "note": "No support requests yet."})
    return Out({"tickets": [{k: t[k] for k in ("number", "subject", "status_label", "updated_at")} for t in items]},
               [{"type": "tickets", "title": "Your support requests", "items": items, "link": "/support"}])


@tool("ticket_details", "Checking the request", "One support request of the customer, with the team's latest reply.",
      {"ticket_number": {"type": "string", "description": "e.g. TK261118A1B2"}}, feature="tickets", login=True, required=("ticket_number",))
async def ticket_details(ctx: Ctx, a: dict[str, Any]) -> Out:
    m = TICKET_RE.search(str(a.get("ticket_number") or ""))
    t = None
    if m:
        t = (await ctx.session.execute(select(SupportTicket).where(SupportTicket.user_id == ctx.user.id, SupportTicket.number == m.group(1).upper()))).scalar_one_or_none()
    if t is None:
        return Out({"error": "No request with that number on this account."})
    msgs = list((await ctx.session.execute(select(TicketMessage).where(TicketMessage.ticket_id == t.id).order_by(TicketMessage.created_at))).scalars())
    v = views.ticket_view(t, msgs)
    return Out(v, [{"type": "tickets", "title": "", "items": [v], "link": v["link"]}])


# ----------------------------------------------------------------------------- prepared changes (customer confirms)


@tool("prepare_ticket", "Preparing a support request", "Show the customer a support request form, filled in from the chat, to send to the "
      "support team. Use when the customer asks for a person, wants to complain, or the problem cannot be solved here. Nothing is sent "
      "until the customer presses Send.",
      {"category": {"type": "string", "enum": list(CATEGORIES)}, "subject": {"type": "string", "description": "short title, 5-120 characters"},
       "message": {"type": "string", "description": "the problem in the customer's words, with the key facts"},
       "order_number": {"type": "string"}, "grievance": {"type": "boolean", "description": "a formal grievance to the Grievance Officer"}},
      feature="tickets", login=True, required=("category", "subject", "message"))
async def prepare_ticket(ctx: Ctx, a: dict[str, Any]) -> Out:
    cat = str(a.get("category") or "other")
    cat = cat if cat in CATEGORIES else "other"
    orders = list((await ctx.session.execute(select(Order).where(Order.user_id == ctx.user.id).order_by(Order.created_at.desc()).limit(10))).scalars())
    order = None
    if a.get("order_number"):
        order = await _own_order(ctx, str(a["order_number"]))
    card = {"type": "ticket_form", "category": cat, "categories": [{"code": k, "label": v} for k, v in CATEGORIES.items()],
            "subject": str(a.get("subject") or "")[:120], "message": str(a.get("message") or "")[:3000],
            "order_id": str(order.id) if order else "", "orders": [{"id": str(o.id), "number": o.number} for o in orders],
            "grievance": bool(a.get("grievance"))}
    return Out({"status": "The form is on the customer's screen. It is sent only when they press Send. Do not say it was created."}, [card])


@tool("prepare_cancellation", "Preparing the cancellation", "Prepare cancelling the customer's order (or one package of it) that has not "
      "shipped yet. The customer sees a Confirm button; nothing is cancelled until they press it.",
      {"order_number": {"type": "string", "description": "order number, or a package number to cancel only that package"},
       "reason": {"type": "string"}}, feature="cancel_orders", login=True, required=("order_number",))
async def prepare_cancellation(ctx: Ctx, a: dict[str, Any]) -> Out:
    raw = str(a.get("order_number") or "")
    o = await _own_order(ctx, raw)
    if o is None:
        return Out({"error": "No order with that number on this account."})
    v = await views.order_view(ctx.session, o)
    m = ORDER_RE.search(raw)
    pkg_no = (m.group(1) + m.group(2)).upper() if m and m.group(2) else None
    pkgs = [p for p in v["packages"] if p["can_cancel"] and (pkg_no is None or p["number"] == pkg_no)]
    if not pkgs:
        shipped = any(p["status"] in ("shipped", "delivered") for p in v["packages"])
        why = "It has already shipped; it can be returned after delivery if returnable." if shipped else "Nothing in it can be cancelled now."
        return Out({"error": f"This order cannot be cancelled. {why}", "order": v["number"]}, [{"type": "order", "order": v}])
    sub_id = pkgs[0]["id"] if pkg_no else None
    reason = (str(a.get("reason") or "").strip() or "Changed my mind")[:200]
    titles = [i["title"] for p in pkgs for i in p["items"]]
    target = f"Package {pkg_no}" if pkg_no else f"Order {o.number}"
    summary = f"Cancel {target[0].lower() + target[1:]}: {', '.join(titles)[:180]}"
    act = ShopChatAction(session_id=ctx.chat_id, user_id=ctx.user.id, kind="cancel_order",
                         params={"order_id": str(o.id), "sub_order_id": sub_id, "reason": reason, "target": target}, summary=summary[:300], created_at=utcnow())
    ctx.session.add(act)
    await ctx.session.flush()
    refund_note = "Your online payment will be refunded to the original method within 5 to 7 working days." if v["payment"] == "Paid online" else ""
    card = {"type": "confirm", "action_id": str(act.id), "title": "Cancel this?", "summary": summary, "items": titles[:6],
            "note": refund_note, "confirm_label": "Yes, cancel", "status": "pending"}
    return Out({"status": "Waiting for the customer to press Confirm. Nothing is cancelled yet.", "summary": summary}, [card])
