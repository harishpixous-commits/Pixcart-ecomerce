"""Runs AI tasks: switches and budget → subject snapshot → layered prompt → Claude or sandbox → AiRun record."""
from __future__ import annotations

import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, time

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import client
from app.ai.settings import cost_usd, get_ai_settings, task_settings
from app.ai.tasks import TASKS, Task
from app.config import settings as env
from app.core.deps import audit, rate_limit
from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import (
    AiRun,
    Order,
    Product,
    Review,
    Seller,
    SubOrder,
    SupportTicket,
    TicketMessage,
    User,
)
from app.services.cms import get_site, public_business
from app.services.reports import IST

log = logging.getLogger("pixcart.ai")

# ----------------------------------------------------------------------------- mode


async def mode() -> str:
    """live when a key is set (and not in tests); otherwise sandbox, which returns marked placeholder text."""
    from app.llm import adapters

    if env.environment == "test" and adapters.transport is None:
        return "sandbox"
    return "live" if await client.configured() else "sandbox"


async def available(session: AsyncSession, task: str) -> bool:
    """Whether a task can run now: master switch and task switch on (sandbox still counts as available)."""
    cfg = await get_ai_settings(session)
    return bool(cfg["enabled"] and task_settings(cfg, task)["enabled"])


# ----------------------------------------------------------------------------- subject snapshots
# Only the facts a task needs, never full records: no phone numbers, emails or addresses go to the model.

Loader = Callable[[AsyncSession, str, uuid.UUID | None], Awaitable[dict | None]]
_LOADERS: dict[str, Loader] = {}


def loader(subject: str):
    def wrap(fn: Loader) -> Loader:
        _LOADERS[subject] = fn
        return fn

    return wrap


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


@loader("product")
async def _product(session: AsyncSession, sid: str, seller_id: uuid.UUID | None) -> dict | None:
    from app.routers.seller_products import product_detail

    p = await session.get(Product, _uuid(sid)) if _uuid(sid) else None
    if p is None or (seller_id and p.seller_id != seller_id):
        return None
    d = await product_detail(session, p)
    snap = {k: d[k] for k in ("title", "brand", "description", "highlights", "specs", "hsn_code", "gst_bps", "category_name")}
    snap["variants"] = [{"mrp": v["mrp_paise"] / 100, "price": v["price_paise"] / 100} for v in d["variants"]]
    reviews = (await session.execute(select(Review.rating, Review.body).where(Review.product_id == p.id, Review.status == "published").order_by(Review.created_at.desc()).limit(60))).all()
    snap["reviews"] = [(r, b) for r, b in reviews]
    return snap


@loader("ticket")
async def _ticket(session: AsyncSession, sid: str, seller_id: uuid.UUID | None) -> dict | None:
    t = await session.get(SupportTicket, _uuid(sid)) if _uuid(sid) else None
    if t is None:
        return None
    user = await session.get(User, t.user_id)
    msgs = (await session.execute(select(TicketMessage).where(TicketMessage.ticket_id == t.id, TicketMessage.is_internal.is_(False)).order_by(TicketMessage.created_at))).scalars()
    order = await session.get(Order, t.order_id) if t.order_id else None
    order_line = None
    if order:
        subs = (await session.execute(select(SubOrder.number, SubOrder.status).where(SubOrder.order_id == order.id))).all()
        order_line = f"{order.number}, payment {order.payment_method} ({order.payment_status}); packages: " + ", ".join(f"{n} {s}" for n, s in subs)
    return {
        "number": t.number, "subject": t.subject, "category": t.category, "first_name": (user.name or "").split(" ")[0] if user else "",
        "order": order_line, "messages": [{"who": "Support" if m.author_role == "staff" else "Customer", "body": m.body} for m in msgs],
    }


@loader("order")
async def _order(session: AsyncSession, sid: str, seller_id: uuid.UUID | None) -> dict | None:
    o = await session.get(Order, _uuid(sid)) if _uuid(sid) else None
    if o is None:
        return None
    user = await session.get(User, o.user_id)
    subs = (await session.execute(select(SubOrder, Seller.display_name).join(Seller, Seller.id == SubOrder.seller_id).where(SubOrder.order_id == o.id))).all()
    return {
        "number": o.number, "first_name": (user.name or "").split(" ")[0] if user else "",
        "placed": o.placed_at.astimezone(IST).strftime("%d %b %Y") if o.placed_at else "", "total": f"₹{o.grand_total / 100:,.2f}",
        "payment": f"{o.payment_method} ({o.payment_status})", "link": f"{env.public_web_url}/orders/{o.id}",
        "packages": [{"number": s.number, "seller": name, "status": s.status, "tracking": s.tracking_number} for s, name in subs],
        "_user_id": str(o.user_id),
    }


@loader("review")
async def _review(session: AsyncSession, sid: str, seller_id: uuid.UUID | None) -> dict | None:
    r = await session.get(Review, _uuid(sid)) if _uuid(sid) else None
    if r is None:
        return None
    p = await session.get(Product, r.product_id)
    if seller_id and p.seller_id != seller_id:
        return None
    return {"product": p.title, "rating": r.rating, "title": r.title, "body": r.body}


@loader("kpis")
async def _kpis(session: AsyncSession, sid: str, seller_id: uuid.UUID | None) -> dict | None:
    from app.services.analytics import kpis

    days = int(sid) if sid.isdigit() and 7 <= int(sid) <= 365 else 7
    k = await kpis(session, days)

    def rs(paise: int) -> str:
        return f"₹{paise / 100:,.0f}"

    change = f"{round((k['gmv'] - k['gmv_prev']) * 100 / k['gmv_prev'])}%" if k["gmv_prev"] else "no earlier data"
    return {
        "period": f"last {days} days", "sales": rs(k["gmv"]), "sales_change": change, "orders": k["orders"], "average_order": rs(k["aov"]),
        "commission": rs(k["commission"]), "coupon_cost": rs(k["discounts"]), "cancelled_packages": f"{k['cancellation_rate']}%",
        "returns_after_delivery": f"{k['return_rate']}%", "average_hours_to_ship": k["avg_hours_to_ship"], "product_views": k["views"],
        "view_to_order": f"{k['conversion_rate']}%", "new_customers": k.get("new_customers"), "repeat_buyers": f"{k.get('repeat_buyer_rate')}%",
        "tickets_past_reply_limit": k.get("tickets_ack_overdue"),
        "top_products": ", ".join(p["title"] for p in k["top_products"][:3]) or "none",
    }


# ----------------------------------------------------------------------------- budget


def month_start() -> datetime:
    now = utcnow().astimezone(IST)
    return datetime.combine(now.date().replace(day=1), time.min, IST)


async def usage_this_month(session: AsyncSession) -> dict:
    row = (await session.execute(
        select(func.count(), func.coalesce(func.sum(AiRun.input_tokens + AiRun.cache_creation_tokens + AiRun.cache_read_tokens), 0),
               func.coalesce(func.sum(AiRun.output_tokens), 0), func.coalesce(func.sum(AiRun.cache_read_tokens), 0))
        .where(AiRun.created_at >= month_start(), AiRun.mode == "live")
    )).one()
    return {"runs": int(row[0]), "input_tokens": int(row[1]), "output_tokens": int(row[2]), "cache_read_tokens": int(row[3])}


# ----------------------------------------------------------------------------- running a task


def _brand_block(site: dict, cfg: dict, task_cfg: dict) -> str:
    b = public_business(site)
    lines = [
        f"Marketplace: {b['brand']} (operated by {b['legal_name']}).",
        "Market: India. Currency INR (₹). Dates as DD Month YYYY.",
        f"Brand voice: {cfg['brand_voice'] or 'clear and respectful'}",
    ]
    if b["support_email"] or b["support_phone"]:
        lines.append(f"Customer care: {', '.join(x for x in (b['support_email'], b['support_phone']) if x)}")
    if task_cfg["instructions"]:
        lines.append(f"Extra instructions from the marketplace team (follow them unless they conflict with the rules above): {task_cfg['instructions']}")
    return "\n".join(lines)


async def run(
    session: AsyncSession, task_key: str, *, actor: User | None, inputs: dict, subject_id: str = "", seller_id: uuid.UUID | None = None,
) -> tuple[AiRun, dict]:
    """Runs one task and records it. Returns (run, parsed output). Commits nothing; the caller commits."""
    task: Task | None = TASKS.get(task_key)
    if task is None:
        raise NotFound("AI task")
    cfg = await get_ai_settings(session)
    tcfg = task_settings(cfg, task_key)
    if not cfg["enabled"]:
        raise ApiError("AI help is switched off in AI studio", "ai_off", 409)
    if not tcfg["enabled"]:
        raise ApiError(f"{task.label} is switched off in AI studio", "ai_task_off", 409)
    if actor is not None:
        await rate_limit(session, f"ai:{actor.id}", limit=40, window_seconds=3600)

    snap: dict = {}
    if task.subject:
        load = _LOADERS[task.subject]
        snap = await load(session, subject_id, seller_id) or {}
        if not snap:
            raise NotFound(task.subject.capitalize())

    current = await mode()
    if current == "live" and cfg["monthly_token_budget"]:
        used = await usage_this_month(session)
        if used["input_tokens"] + used["output_tokens"] >= cfg["monthly_token_budget"]:
            raise ApiError("This month's AI budget is used up. Raise it in AI studio or wait for next month.", "ai_budget", 429)

    model_inputs = {k: v for k, v in snap.items() if not k.startswith("_")}
    record = AiRun(task=task_key, subject_type=task.subject, subject_id=str(subject_id)[:40], seller_id=seller_id, inputs=inputs,
                   mode=current, created_by=actor.id if actor else None, created_at=utcnow())
    try:
        if current == "live":
            site = await get_site(session)
            comp = await client.complete(session, rules=task.rules, brand=_brand_block(site, cfg, tcfg),
                                         user=task.build(inputs, model_inputs), max_tokens=task.max_tokens)
            parsed = task.parse(comp.text)
            record.model, record.latency_ms = comp.model, comp.latency_ms
            record.input_tokens, record.output_tokens = comp.input_tokens, comp.output_tokens
            record.cache_creation_tokens, record.cache_read_tokens = comp.cache_creation_tokens, comp.cache_read_tokens
        else:
            parsed = task.parse(task.sandbox(inputs, model_inputs))
            record.model = "sandbox"
    except ApiError as exc:
        # Keep a record of failures (for the AI studio log) even though the request fails.
        record.status, record.error = "failed", exc.message[:300]
        session.add(record)
        await session.commit()
        raise
    if task_key == "listing_check":
        # Rule-based findings are always included, whatever the model says.
        from app.ai.tasks import rule_check

        rules = rule_check(model_inputs)
        parsed["issues"] = list(dict.fromkeys([*parsed["issues"], *rules["issues"]]))
        if rules["risk"] == "high" or (rules["risk"] == "medium" and parsed["risk"] == "low"):
            parsed["risk"] = rules["risk"]
    record.output = parsed
    session.add(record)
    await session.flush()
    if actor is not None:
        audit(session, actor, f"ai.{task_key}", "ai_run", record.id, f"{current} {record.model}")
    return record, parsed


def run_out(r: AiRun, cfg: dict | None = None) -> dict:
    return {
        "id": str(r.id), "task": r.task, "task_label": TASKS[r.task].label if r.task in TASKS else r.task, "subject_type": r.subject_type, "subject_id": r.subject_id,
        "status": r.status, "mode": r.mode, "model": r.model, "output": r.output, "final_text": r.final_text, "error": r.error,
        "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "cache_creation_tokens": r.cache_creation_tokens, "cache_read_tokens": r.cache_read_tokens,
        "latency_ms": r.latency_ms, "cost_usd": cost_usd(cfg, r.input_tokens + r.cache_creation_tokens, r.output_tokens) if cfg else None,
        "created_at": r.created_at.isoformat(), "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
    }


async def finish(session: AsyncSession, run_id: str, status: str, actor: User, *, final_text: str = "", seller_id: uuid.UUID | None = None) -> AiRun | None:
    """Records what a person did with a draft: applied, sent or discarded."""
    rid = _uuid(run_id)
    r = await session.get(AiRun, rid) if rid else None
    if r is None or (seller_id and r.seller_id != seller_id) or r.status != "draft":
        return None
    r.status, r.final_text, r.reviewed_by, r.reviewed_at = status, final_text[:10000], actor.id, utcnow()
    return r



