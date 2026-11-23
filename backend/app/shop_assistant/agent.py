"""The shop assistant's pipeline: one customer message → events streamed to the browser.

    start → [tool | card | text]* → done   (or error)

1. Save the message; read the intent with multilingual rules (``intents.detect``).
2. Live mode (an AI model is connected on the ``shop_assistant`` route, the assistant is set to use it and its own
   monthly budget is not used up): the model answers with the customer tools, streaming text; cards stream as tools run.
3. Guided mode (no model, budget used up, or the model fails before answering): the same tools, chosen by the
   intent, with sentences from ``replies.py``. The customer always gets an answer.
4. Save the reply and, in live mode, the token use (``ai_runs`` task ``shop_assistant``, no chat text stored there).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import exists, func, select

from app.config import settings as env
from app.core.errors import ApiError
from app.db import SessionLocal, utcnow
from app.llm import adapters
from app.llm import config as llm_config
from app.llm import router as llm_router
from app.models import AiRun, Order, ShopChatMessage, ShopChatSession, SubOrder, User
from app.services.orders import customer_cancellable

from . import intents, kb, prompts, replies, tools, views
from . import settings as shop_settings

ROUTE = "shop_assistant"
IST = timezone(timedelta(hours=5, minutes=30))
AI_FAILURES = {"ai_unavailable", "ai_not_configured", "ai_interrupted"}
INTENT_FEATURE = {"track": "orders", "cancel": "cancel_orders", "return": "returns_refunds", "damaged": "returns_refunds",
                  "refund": "returns_refunds", "tickets": "tickets", "ticket_status": "tickets", "human": "tickets", "grievance": "tickets",
                  "search": "product_search"}
LOGIN_INTENTS = {"track", "cancel", "return", "damaged", "tickets", "ticket_status", "human", "grievance"}
GUEST_ARTICLE = {"track": "track order", "cancel": "cancel order", "return": "return product", "damaged": "damaged wrong item",
                 "refund": "refund", "tickets": "contact support", "ticket_status": "contact support", "human": "contact support",
                 "grievance": "grievance", "payment": "payment failed money deducted"}
log = logging.getLogger("pixcart.shop_assistant")


def _date(iso: str | None) -> str:
    if not iso:
        return ""
    d = datetime.fromisoformat(iso).astimezone(IST)
    return f"{d.day} {d:%b}"


async def choose_mode(session, cfg: dict[str, Any]) -> tuple[str, list]:
    if cfg["ai"] != "auto":
        return "guided", []
    chain = await llm_config.targets(session, ROUTE)
    if not chain or (adapters.transport is None and env.environment == "test"):
        return "guided", []  # tests never call a real provider
    if cfg["monthly_token_budget"]:
        start = datetime.now(IST).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        used = (await session.execute(select(func.coalesce(func.sum(AiRun.input_tokens + AiRun.output_tokens), 0))
                                      .where(AiRun.task == ROUTE, AiRun.created_at >= start))).scalar_one()
        if used >= cfg["monthly_token_budget"]:
            return "guided", []
    return "live", chain


# ----------------------------------------------------------------------------- guided mode


STATUS_PHRASE = {"Order placed": "placed and waiting for the seller to confirm it", "Confirmed by the seller": "confirmed by the seller",
                 "Packed": "packed and ready to ship", "Shipped": "on the way", "Partly delivered": "partly delivered",
                 "Delivered": "delivered", "Cancelled": "cancelled", "Waiting for payment": "waiting for payment"}


def order_sentence(v: dict[str, Any], lang: str) -> str:
    parts = [replies.t("order_status", lang, number=v["number"], status=STATUS_PHRASE.get(v["status"], v["status"].lower()))]
    for p in v["packages"]:
        if p["status"] == "shipped":
            tr = f", tracking {p['tracking_number']}" if p["tracking_number"] else ""
            parts.append(replies.t("pkg_shipped", lang, number=p["number"], courier=p["courier"] or "the courier", tracking=tr))
    nxt = [p["expected_delivery_at"] for p in v["packages"] if p["status"] not in ("delivered", "cancelled") and p["expected_delivery_at"]]
    if nxt:
        parts.append(replies.t("pkg_expected", lang, date=_date(min(nxt))))
    return " ".join(parts)


async def _orders_with(ctx: tools.Ctx, statuses: tuple[str, ...], limit: int = 5) -> list[Order]:
    has = exists().where(SubOrder.order_id == Order.id, SubOrder.status.in_(statuses))
    return list((await ctx.session.execute(select(Order).where(Order.user_id == ctx.user.id, has).order_by(Order.created_at.desc()).limit(limit))).scalars())


async def _transcript(session, chat_id: uuid.UUID, current: str) -> str:
    rows = list((await session.execute(select(ShopChatMessage.text).where(ShopChatMessage.session_id == chat_id, ShopChatMessage.role == "user")
                                       .order_by(ShopChatMessage.created_at.desc()).limit(6))).scalars())
    lines = [r.strip() for r in reversed(rows) if r.strip()]
    if not lines or lines[-1] != current.strip():
        lines.append(current.strip())
    return "\n".join(f"- {line[:500]}" for line in lines[-6:])


async def guided(ctx: tools.Ctx, it: intents.Intent, text: str, cfg: dict[str, Any], facts: dict[str, Any], last_intent: str) -> tuple[str, list[dict[str, Any]]]:
    lang, signed = it.lang, ctx.user is not None
    cards: list[dict[str, Any]] = []
    parts: list[str] = []
    chips = cfg["quick_replies"] if lang == "en" else replies.CHIPS[lang]

    async def call(name: str, args: dict[str, Any]) -> Any:
        out, _ = await tools.execute(ctx, name, args)
        cards.extend(out.cards)
        return out.data

    async def article(query: str, *, as_text: bool) -> bool:
        if not ctx.features.get("help_articles", True):
            return False
        data = await call("help_articles", {"query": query})
        arts = data.get("articles") or []
        if arts and as_text:
            parts.append(arts[0]["text"][:700])
            if cards and cards[-1].get("type") == "article":
                cards[-1] = {**cards[-1], "text": ""}  # the sentence above already says it; the card keeps the link
        return bool(arts)

    name = it.name
    feature = INTENT_FEATURE.get(name)
    if feature and not ctx.features.get(feature, True):
        label, link = tools.FEATURE_PAGE[feature]
        parts.append(replies.t("feature_off", lang, page=label))
        cards.append({"type": "link", "text": f"Open {label}", "link": link})
        return " ".join(parts), cards
    if name == "greet":
        parts.append(cfg["greeting"])
        cards.append(replies.chips(chips))
    elif name == "thanks":
        parts.append(replies.t("thanks", lang))
        cards.append(replies.chips(chips))
    elif name == "bye":
        parts.append(replies.t("bye", lang, brand=facts["brand"]))
    elif name in LOGIN_INTENTS and not signed:
        if name in ("human", "grievance"):
            parts.append(replies.t("guest_ticket", lang, grievance=facts["grievance_text"] if name == "grievance" else ""))
        else:
            await article(GUEST_ARTICLE.get(name, text), as_text=True)
            parts.append(replies.t("sign_in", lang))
        cards.append(tools.sign_in_card(ctx, replies.t("sign_in", lang)))
    elif name == "track":
        if it.order_number:
            data = await call("order_details", {"order_number": it.package_number or it.order_number})
            if data.get("error"):
                parts.append(replies.t("order_not_found", lang, number=it.order_number))
                await call("my_orders", {})
            else:
                parts.append(order_sentence(data, lang))
        else:
            open_orders = await _orders_with(ctx, ("pending_payment", "placed", "confirmed", "packed", "shipped"))
            if len(open_orders) == 1:
                parts.append(order_sentence(await call("order_details", {"order_number": open_orders[0].number}), lang))
            else:
                data = await call("my_orders", {})
                parts.append(replies.t("orders_list" if data.get("orders") else "no_orders", lang))
    elif name == "cancel":
        if it.order_number:
            data = await call("prepare_cancellation", {"order_number": it.package_number or it.order_number})
            parts.append(data["error"] if data.get("error") else replies.t("cancel_ready", lang))
        else:
            orders = await _orders_with(ctx, (*(await customer_cancellable(ctx.session)), "pending_payment"))
            if len(orders) == 1:
                data = await call("prepare_cancellation", {"order_number": orders[0].number})
                parts.append(data["error"] if data.get("error") else replies.t("cancel_ready", lang))
            elif orders:
                cards.append({"type": "orders", "title": "", "items": await views.order_cards(ctx.session, orders), "link": "/orders"})
                parts.append(replies.t("cancel_pick", lang))
            else:
                parts.append(replies.t("cancel_none", lang))
    elif name in ("return", "damaged"):
        if name == "damaged":
            parts.append(replies.t("damaged_sorry", lang))
        found = None
        if it.order_number:
            o = await tools._own_order(ctx, it.order_number)
            found = await views.order_view(ctx.session, o) if o else None
        else:
            for o in await _orders_with(ctx, ("delivered",)):
                v = await views.order_view(ctx.session, o)
                if any(p["can_return"] for p in v["packages"]):
                    found = v
                    break
        pkg = next((p for p in (found or {}).get("packages", []) if p["can_return"]), None)
        if found and pkg:
            cards.append({"type": "order", "order": found})
            parts.append(replies.t("return_ready", lang, number=found["number"], date=_date(pkg["return_by"])))
        else:
            if found:
                cards.append({"type": "order", "order": found})
            parts.append(replies.t("return_none", lang))
            await article("damaged wrong item" if name == "damaged" else "return product", as_text=False)
            parts.append(replies.t("handoff", lang))
            cards.append(replies.chips(["Talk to support"] if lang == "en" else [replies.CHIPS[lang][4]]))
    elif name == "refund":
        if signed:
            data = await call("my_returns_and_refunds", {})
            parts.append(replies.t("refunds" if data.get("returns") or data.get("refunds") else "no_refunds", lang))
            await article("refund", as_text=False)
        else:
            await article("refund", as_text=True)
            cards.append(tools.sign_in_card(ctx, replies.t("sign_in", lang)))
    elif name == "payment":
        await article("payment failed money deducted", as_text=True)
        if signed:
            pending = await _orders_with(ctx, ("pending_payment",), limit=1)
            if pending:
                await call("order_details", {"order_number": pending[0].number})
        cards.append(replies.chips(["Talk to support"] if lang == "en" else [replies.CHIPS[lang][4]]))
    elif name == "tickets":
        data = await call("my_tickets", {})
        parts.append(replies.t("tickets" if data.get("tickets") else "no_tickets", lang))
    elif name == "ticket_status":
        data = await call("ticket_details", {"ticket_number": it.ticket_number})
        if data.get("error"):
            parts.append(data["error"])
            await call("my_tickets", {})
        else:
            reply = data.get("last_team_reply")
            parts.append(f"{data['number']}: {data['status_label']}." + (f" Latest reply from our team: “{reply['text'][:300]}”" if reply else ""))
    elif name in ("human", "grievance"):
        also = set(it.also)
        transcript = await _transcript(ctx.session, ctx.chat_id, text)
        # The order the customer was talking about: in this message, else the latest one mentioned in the chat.
        mentioned = it.order_number or next((m.group(1).upper() for m in reversed(list(intents.ORDER_RE.finditer(transcript)))), None)
        cat = ("payment" if also & {"payment", "refund"} else "return" if also & {"return", "damaged"} else "delivery" if "track" in also
               else "order" if ("cancel" in also or mentioned) else "other")
        topic = {"payment": "Payment or refund", "return": "Damaged item" if "damaged" in also else "Return or replacement",
                 "delivery": "Delivery problem", "order": "Problem with my order", "other": "Help needed"}[cat]
        subject = "Grievance" if name == "grievance" else f"{topic} ({mentioned})" if mentioned else topic
        await call("prepare_ticket", {"category": cat, "subject": subject, "message": transcript, "order_number": mentioned or "",
                                      "grievance": name == "grievance"})
        parts.append(replies.t("ticket_form", lang))
    elif name == "search":
        if not it.query and it.max_price is None and it.min_price is None:
            parts.append(replies.t("ask_product", lang))
        else:
            data = await call("search_products", {"query": it.query, "max_price_rupees": it.max_price / 100 if it.max_price else None,
                                                  "min_price_rupees": it.min_price / 100 if it.min_price else None})
            price = f" under {kb.inr(it.max_price)}" if it.max_price else ""
            parts.append(replies.t("products", lang, price=price) if data.get("products") else replies.t("no_products", lang, query=it.query or text[:40]))
    else:  # a question: help articles first, then products, then a way out
        if not await article(text, as_text=True):
            found = False
            if it.query:
                data = await call("search_products", {"query": it.query})
                found = bool(data.get("products"))
                if found:
                    parts.append(replies.t("products", lang, price=""))
            if not found:
                parts.append(replies.t("fallback", lang))
                if last_intent == "unknown":
                    parts.append(replies.t("handoff", lang))
                cards.append(replies.chips(chips))
    return " ".join(p.strip() for p in parts if p.strip()), cards


# ----------------------------------------------------------------------------- live mode helpers


def _clean(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Alternating roles and no dangling tool calls, so every provider accepts the history."""
    out: list[dict[str, Any]] = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            a = out[-1]["content"] if isinstance(out[-1]["content"], list) else [{"type": "text", "text": out[-1]["content"]}]
            b = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
            out[-1] = {"role": m["role"], "content": a + b}
        else:
            out.append(dict(m))
    if out and out[-1]["role"] == "assistant" and isinstance(out[-1]["content"], list) and any(b.get("type") == "tool_use" for b in out[-1]["content"]):
        out[-1] = {"role": "assistant", "content": [b for b in out[-1]["content"] if b.get("type") == "text"] or [{"type": "text", "text": "(stopped)"}]}
    return out


async def _history(session, chat_id: uuid.UUID, keep: int, exclude: uuid.UUID) -> tuple[list[dict[str, Any]], str]:
    rows = list((await session.execute(select(ShopChatMessage).where(ShopChatMessage.session_id == chat_id, ShopChatMessage.id != exclude)
                                       .order_by(ShopChatMessage.created_at))).scalars())
    recent, older = rows[-keep:], rows[:-keep] if len(rows) > keep else []
    while recent and recent[0].role != "user":
        older.append(recent.pop(0))
    msgs: list[dict[str, Any]] = []
    for m in recent:
        msgs.extend(m.model_content or [{"role": m.role, "content": m.text or "(no text)"}])
    earlier = "\n".join(f"{'Customer' if m.role == 'user' else 'You'}: {' '.join((m.text or '').split())[:200]}" for m in older[-12:])
    return _clean(msgs), earlier


def _prefetch(it: intents.Intent, signed: bool) -> list[tuple[str, dict[str, Any]]]:
    if not signed:
        return []
    if it.name in ("track", "cancel", "return", "damaged") and it.order_number:
        return [("order_details", {"order_number": it.package_number or it.order_number})]
    if it.name == "track":
        return [("my_orders", {})]
    if it.name == "ticket_status" and it.ticket_number:
        return [("ticket_details", {"ticket_number": it.ticket_number})]
    if it.name in ("tickets", "refund"):
        return [("my_tickets", {})] if it.name == "tickets" else [("my_returns_and_refunds", {})]
    return []


# ----------------------------------------------------------------------------- the pipeline


async def run(chat_id: uuid.UUID, user_id: uuid.UUID | None, text: str, *, voice: bool, page: dict[str, Any] | None) -> AsyncIterator[dict[str, Any]]:
    """Async generator of events; opens its own database session so it can outlive the request handler."""
    async with SessionLocal() as session:
        chat = await session.get(ShopChatSession, chat_id)
        user = await session.get(User, user_id) if user_id else None
        if chat is None or (chat.user_id is not None and (user is None or chat.user_id != user.id)):
            yield {"type": "error", "message": "Chat not found"}
            return
        cfg = await shop_settings.get(session)
        facts = await kb.public_facts(session)
        it = intents.detect(text)
        last_intent = (await session.execute(select(ShopChatMessage.intent).where(ShopChatMessage.session_id == chat.id, ShopChatMessage.role == "assistant")
                                             .order_by(ShopChatMessage.created_at.desc()).limit(1))).scalar_one_or_none() or ""
        now = utcnow()
        user_msg = ShopChatMessage(session_id=chat.id, role="user", text=text, blocks=[], model_content=[{"role": "user", "content": text}],
                                   intent=it.name, voice=voice, created_at=now)
        session.add(user_msg)
        if chat.title in ("", "New chat"):
            chat.title = " ".join(text.split())[:60] or "New chat"
        if it.lang != "en" or not chat.language:
            chat.language = it.lang
        chat.updated_at = now
        if page:
            chat.page = {"path": str(page.get("path") or "")[:200], "title": str(page.get("title") or "")[:120]}
        await session.commit()

        reply = ShopChatMessage(id=uuid.uuid4(), session_id=chat.id, role="assistant", text="", blocks=[], model_content=[], intent=it.name,
                                voice=voice, created_at=utcnow())
        mode, chain = await choose_mode(session, cfg)
        yield {"type": "start", "message_id": str(reply.id), "session_id": str(chat.id), "mode": mode, "intent": it.name, "lang": it.lang}

        ctx = tools.Ctx(session=session, user=user, chat_id=chat.id, page_path=str((page or {}).get("path") or "/"), features=dict(cfg["features"]))
        blocks: list[dict[str, Any]] = []
        turn_msgs: list[dict[str, Any]] = []
        usage = {"in": 0, "out": 0, "cache_w": 0, "cache_r": 0}
        used_model, status, started = "", "done", time.monotonic()
        streamed_text = False

        async def run_guided() -> AsyncIterator[dict[str, Any]]:
            answer, cards = await guided(ctx, it, text, cfg, facts, last_intent)
            for c in cards:
                blocks.append(c)
                yield {"type": "card", "card": c}
            if answer:
                blocks.insert(0, {"type": "text", "text": answer})
                yield {"type": "text", "delta": answer}
            reply.text = answer
            turn_msgs[:] = [{"role": "assistant", "content": [{"type": "text", "text": answer or "(shown cards)"}]}]

        try:
            if mode == "guided":
                async for ev in run_guided():
                    yield ev
            else:
                try:
                    history, earlier = await _history(session, chat.id, cfg["history_messages"], exclude=user_msg.id)
                    system = [
                        {"type": "text", "text": prompts.RULES, "cache": True},
                        {"type": "text", "text": prompts.knowledge(facts["brand"], cfg["instructions"], facts), "cache": True},
                        {"type": "text", "text": prompts.context(signed_in=user is not None, name=(user.name if user else "") or "", page=page, voice=voice,
                                                                 earlier=earlier, hint={"intent": it.name, "order": it.order_number} if it.name != "unknown" else None)},
                    ]
                    specs = [t.spec() for t in tools.available(user is not None, ctx.features)]
                    messages = history + [{"role": "user", "content": text}]
                    calls, results = [], []
                    for i, (name, args) in enumerate(p for p in _prefetch(it, user is not None) if ctx.features.get(tools.TOOLS[p[0]].feature, True)):
                        yield {"type": "tool", "name": name, "label": tools.TOOLS[name].label}
                        out, err = await tools.execute(ctx, name, args)
                        tid = f"prefetch_{reply.id.hex[:8]}_{i}"
                        calls.append({"type": "tool_use", "id": tid, "name": name, "input": args})
                        results.append({"type": "tool_result", "tool_use_id": tid, "content": tools.model_view(out.data), "is_error": err})
                        for c in out.cards:
                            blocks.append(c)
                            yield {"type": "card", "card": c}
                    if calls:
                        pre = [{"role": "assistant", "content": calls}, {"role": "user", "content": results}]
                        messages += pre
                        turn_msgs += pre
                    text_parts: list[str] = []
                    for _step in range(cfg["max_steps"]):
                        turn = None
                        step_text: list[str] = []
                        async for kind, val in llm_router.stream(session, ROUTE, system=system, messages=messages, tools=specs,
                                                                 max_tokens=cfg["max_output_tokens"], chain=chain):
                            if kind == "text":
                                step_text.append(val)
                                streamed_text = True
                                yield {"type": "text", "delta": val}
                            elif kind == "tool":
                                t = tools.TOOLS.get(val.get("name") or "")
                                yield {"type": "tool", "name": val.get("name"), "label": t.label if t else "Working"}
                            elif kind == "turn":
                                turn = val
                            elif kind == "used":
                                used_model = f"{val.model} via {val.connection_name}"
                        assert turn is not None
                        usage["in"] += turn.input_tokens
                        usage["out"] += turn.output_tokens
                        usage["cache_w"] += turn.cache_creation_tokens
                        usage["cache_r"] += turn.cache_read_tokens
                        if step_text:
                            blocks.append({"type": "text", "text": "".join(step_text)})
                            text_parts.append("".join(step_text))
                        messages.append({"role": "assistant", "content": turn.content})
                        turn_msgs.append({"role": "assistant", "content": turn.content})
                        tcalls = [b for b in turn.content if b.get("type") == "tool_use"]
                        if not tcalls:
                            break
                        tresults = []
                        for b in tcalls:
                            out, err = await tools.execute(ctx, b["name"], b.get("input") or {})
                            tresults.append({"type": "tool_result", "tool_use_id": b["id"], "content": tools.model_view(out.data), "is_error": err})
                            for c in out.cards:
                                blocks.append(c)
                                yield {"type": "card", "card": c}
                        messages.append({"role": "user", "content": tresults})
                        turn_msgs.append({"role": "user", "content": tresults})
                    reply.text = "\n\n".join(p.strip() for p in text_parts if p.strip())
                except ApiError as exc:
                    if exc.code not in AI_FAILURES or streamed_text:
                        raise
                    log.warning("shop assistant model unavailable (%s); answering in guided mode", exc.code)
                    mode = "guided"
                    blocks.clear()
                    turn_msgs.clear()
                    async for ev in run_guided():
                        yield ev
        except ApiError as exc:
            status = "error"
            blocks.append({"type": "error", "text": exc.message})
            yield {"type": "error", "message": exc.message, "code": exc.code}
        except (asyncio.CancelledError, GeneratorExit):
            status = "stopped"
            raise
        except Exception:  # noqa: BLE001 — never leave the customer hanging; details go to the log
            log.exception("shop assistant turn failed")
            status = "error"
            msg = "Sorry, something went wrong while answering. Please try again."
            blocks.append({"type": "error", "text": msg})
            yield {"type": "error", "message": msg}
        finally:
            reply.blocks, reply.status, reply.mode = _compact(blocks), status, mode
            content = _clean([{"role": "user", "content": "x"}] + turn_msgs)[1:] if turn_msgs else []
            if not content or content[0]["role"] != "assistant":
                content = [{"role": "assistant", "content": [{"type": "text", "text": reply.text or "(no answer)"}]}] + content
            reply.model_content = content
            reply.input_tokens, reply.output_tokens = usage["in"], usage["out"]
            await asyncio.shield(_save(session, reply, chat, user, usage, used_model, mode, started, status, ctx.kb_hits))
        if status == "done":
            yield {"type": "done", "message": message_out(reply), "mode": mode}


def _compact(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for b in blocks:
        if b.get("type") == "text" and out and out[-1].get("type") == "text":
            out[-1] = {"type": "text", "text": out[-1]["text"] + b["text"]}
        else:
            out.append(b)
    return out


async def _save(session, reply: ShopChatMessage, chat: ShopChatSession, user: User | None, usage: dict[str, int], model: str, mode: str,
                started: float, status: str, kb_hits: list[str]) -> None:
    try:
        session.add(reply)
        chat.message_count = (chat.message_count or 0) + 2
        chat.updated_at = utcnow()
        await kb.count_use(session, kb_hits)
        if mode == "live":
            # Token accounting only: the customer's words stay in the chat tables.
            session.add(AiRun(task=ROUTE, subject_type="shop_chat", subject_id=str(chat.id), inputs={}, output={"blocks": len(reply.blocks)},
                              final_text="", status="applied" if status == "done" else "failed", mode="live", model=model[:80],
                              input_tokens=usage["in"], output_tokens=usage["out"], cache_creation_tokens=usage["cache_w"],
                              cache_read_tokens=usage["cache_r"], latency_ms=int((time.monotonic() - started) * 1000),
                              error="" if status == "done" else status, created_by=user.id if user else None, created_at=utcnow()))
        await session.commit()
    except Exception:  # noqa: BLE001
        log.exception("could not save shop assistant reply")


def message_out(m: ShopChatMessage) -> dict[str, Any]:
    return {"id": str(m.id), "role": m.role, "text": m.text, "blocks": m.blocks, "status": m.status, "mode": m.mode,
            "created_at": m.created_at.isoformat() if m.created_at else None}


def sse(event: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n".encode()
