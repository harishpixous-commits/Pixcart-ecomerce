"""The assistant's agent loop.

One question → events streamed to the browser:

    start → decision → [status | tool | card | text]* → done   (or error)

Steps:
1. Save the person's message; load memory notes, attached files and recent history (older turns condensed).
2. Decision layer: areas, period, tools to offer and an optional prefetch (run before the model is called).
3. Model turns on the route's fallback chain (any provider), streaming text. Tool calls run with the person's
   permissions; their cards stream to the screen immediately. Repeats up to ``max_steps`` times.
4. Save the reply (text + cards + model content for follow-up questions) and record tokens in the AI usage log.

Without a connected model the sandbox engine answers common questions with the same real tools.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import select

from app.ai.service import usage_this_month
from app.ai.settings import get_ai_settings
from app.config import settings as env
from app.core.errors import ApiError
from app.core.permissions import load_roles, permissions_for, role_code, role_name
from app.db import SessionLocal, utcnow
from app.llm import adapters
from app.llm import config as llm_config
from app.llm import router as llm_router
from app.models import AiRun, AssistantConversation, AssistantMessage, AssistantUpload, User
from app.services.cms import get_site

from . import decision as decision_mod
from . import prompts, sandbox, tools
from . import settings as asst_settings

log = logging.getLogger("pixcart.assistant")


def _model_text(text: str, files: list[dict[str, Any]]) -> str:
    if files:
        text += "\n\n[Attached: " + "; ".join(f"{f['filename']} (file_id {f['id']})" for f in files) + "]"
    return text


async def _history(session, conv_id: uuid.UUID, keep: int, exclude: uuid.UUID) -> tuple[list[dict[str, Any]], str]:
    """Recent messages word for word (as the model saw them) and a condensed note of older ones."""
    rows = list((await session.execute(
        select(AssistantMessage).where(AssistantMessage.conversation_id == conv_id, AssistantMessage.id != exclude).order_by(AssistantMessage.created_at)
    )).scalars())
    recent, older = rows[-keep:], rows[:-keep] if len(rows) > keep else []
    while recent and recent[0].role != "user":  # the model's history must start with the person
        older.append(recent.pop(0))
    msgs: list[dict[str, Any]] = []
    for m in recent:
        content = m.model_content or ([{"role": m.role, "content": m.text or "(no text)"}])
        msgs.extend(content)
    earlier = "\n".join(f"{'Person' if m.role == 'user' else 'You'}: {' '.join((m.text or '').split())[:240]}" for m in older[-20:])
    return _clean(msgs), earlier


def _clean(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keeps the conversation valid for every provider: alternating roles, every tool call answered."""
    out: list[dict[str, Any]] = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            prev = out[-1]
            a = prev["content"] if isinstance(prev["content"], list) else [{"type": "text", "text": prev["content"]}]
            b = m["content"] if isinstance(m["content"], list) else [{"type": "text", "text": m["content"]}]
            out[-1] = {"role": m["role"], "content": a + b}
        else:
            out.append(dict(m))
    # Drop a trailing assistant tool call without its result (an interrupted turn).
    if out and out[-1]["role"] == "assistant" and isinstance(out[-1]["content"], list) and any(b.get("type") == "tool_use" for b in out[-1]["content"]):
        out[-1] = {"role": "assistant", "content": [b for b in out[-1]["content"] if b.get("type") == "text"] or [{"type": "text", "text": "(stopped)"}]}
    return out


async def run(user_id: uuid.UUID, conv_id: uuid.UUID, text: str, upload_ids: list[str], page: dict[str, Any] | None, voice: bool) -> AsyncIterator[dict[str, Any]]:
    """Async generator of events. Opens its own database session so it can outlive the request handler."""
    async with SessionLocal() as session:
        user = await session.get(User, user_id)
        conv = await session.get(AssistantConversation, conv_id)
        if user is None or conv is None or conv.user_id != user.id:
            yield {"type": "error", "message": "Conversation not found"}
            return
        cfg = await asst_settings.get(session, reveal=True)
        await load_roles(session)
        perms = set(permissions_for(user))
        allowed = tools.available(perms)
        names = {t.name for t in allowed}
        now = utcnow()
        files_rows = []
        for fid in upload_ids[:5]:
            try:
                up = await session.get(AssistantUpload, uuid.UUID(fid))
            except ValueError:
                up = None
            if up and up.user_id == user.id:
                files_rows.append(up)
        files = [{"id": str(f.id), "filename": f.filename, "rows": f.row_count, "columns": len(f.columns)} for f in files_rows]
        user_msg = AssistantMessage(conversation_id=conv.id, role="user", text=text, blocks=[{"type": "files", "items": files}] if files else [],
                                    model_content=[{"role": "user", "content": _model_text(text, files)}], upload_ids=[f["id"] for f in files], created_at=now)
        session.add(user_msg)
        if conv.title in ("", "New chat"):
            conv.title = (" ".join(text.split())[:60] or "New chat")
        conv.updated_at = now
        if page:
            conv.context = page
        await session.commit()
        reply = AssistantMessage(id=uuid.uuid4(), conversation_id=conv.id, role="assistant", text="", blocks=[], model_content=[], created_at=utcnow())

        route = "assistant"
        chain = await llm_config.targets(session, route)
        mode = "live" if chain else "sandbox"
        if mode == "live" and adapters.transport is None and env.environment == "test":
            mode = "sandbox"  # tests never call a real provider
        dec = await decision_mod.decide(text, cfg["decision"], available=names, has_upload=bool(files))
        if voice and dec.voice_fast and mode == "live":
            fast = (await llm_config._raw(session)).get("routes", {}).get("assistant_fast")
            if fast:  # only when the admin set a fast route; otherwise the assistant route stays
                chain = await llm_config.targets(session, "assistant_fast")
        yield {"type": "start", "user_message_id": str(user_msg.id), "message_id": str(reply.id), "conversation_id": str(conv.id), "title": conv.title, "mode": mode}
        yield {"type": "decision", **dec.as_dict()}

        ctx = tools.ToolContext(session=session, user=user, permissions=perms, conversation_id=conv.id, share_contacts=bool(cfg["share_contact_details"]),
                                upload_ids=[f["id"] for f in files])
        blocks: list[dict[str, Any]] = []
        turn_msgs: list[dict[str, Any]] = []
        usage = {"in": 0, "out": 0, "cache_w": 0, "cache_r": 0}
        used_model, status, started = "", "done", time.monotonic()

        async def run_tool(name: str, args: dict[str, Any]) -> tuple[tools.ToolOutput, bool]:
            out, err = await tools.execute(ctx, name, args)
            return out, err

        try:
            if mode == "sandbox":
                d, calls = sandbox.choose(text, names, bool(files))
                results = []
                for name, args in calls:
                    yield {"type": "tool", "name": name, "label": tools.TOOLS[name].label}
                    out, _ = await run_tool(name, args)
                    results.append((name, out.data))
                    for c in out.cards:
                        blocks.append(c)
                        yield {"type": "card", "card": c}
                answer = sandbox.reply(d, results)
                yield {"type": "text", "delta": answer}
                blocks.append({"type": "text", "text": answer})
                reply.text = answer
                turn_msgs = [{"role": "assistant", "content": [{"type": "text", "text": answer}]}]
                used_model = "sandbox"
            else:
                ai_cfg = await get_ai_settings(session)
                if not ai_cfg["enabled"] or not cfg["enabled"]:
                    raise ApiError("The AI assistant is switched off in Admin → AI assistant", "assistant_off", 409)
                if ai_cfg["monthly_token_budget"]:
                    u = await usage_this_month(session)
                    if u["input_tokens"] + u["output_tokens"] >= ai_cfg["monthly_token_budget"]:
                        raise ApiError("This month's AI budget is used up. Raise it in AI studio.", "ai_budget", 429)
                history, earlier = await _history(session, conv.id, cfg["history_messages"], exclude=user_msg.id)
                site = await get_site(session)
                memories = await asst_settings.memories(session, user.id)
                system = [
                    {"type": "text", "text": prompts.RULES, "cache": True},
                    {"type": "text", "text": prompts.knowledge(site["brand_name"], cfg["instructions"]), "cache": True},
                    {"type": "text", "text": prompts.context(user_name=user.name or "", role_name=role_name(role_code(user)), permissions=sorted(perms), page=page,
                                                             memories=memories, voice=voice, decision=dec.as_dict() if dec.source != "off" else None, files=files, earlier=earlier)},
                ]
                offered = [t for t in allowed if dec.tools is None or t.name in dec.tools]
                specs = [t.spec() for t in offered]
                messages = history + [{"role": "user", "content": _model_text(text, files)}]
                # Prefetch: the obvious first lookup runs now and is handed to the model as if it had asked for it.
                if dec.prefetch:
                    calls, results = [], []
                    for i, (name, args) in enumerate(dec.prefetch):
                        if name not in {t.name for t in offered}:
                            continue
                        yield {"type": "tool", "name": name, "label": tools.TOOLS[name].label}
                        out, err = await run_tool(name, args)
                        tid = f"prefetch_{reply.id.hex[:8]}_{i}"
                        calls.append({"type": "tool_use", "id": tid, "name": name, "input": args})
                        results.append({"type": "tool_result", "tool_use_id": tid, "content": tools.model_view(out.data, ctx.share_contacts), "is_error": err})
                        for c in out.cards:
                            blocks.append(c)
                            yield {"type": "card", "card": c}
                    if calls:
                        pre = [{"role": "assistant", "content": calls}, {"role": "user", "content": results}]
                        messages += pre
                        turn_msgs += pre
                text_parts: list[str] = []
                for step in range(cfg["max_steps"]):
                    turn = None
                    step_text: list[str] = []
                    async for kind, val in llm_router.stream(session, route, system=system, messages=messages, tools=specs,
                                                             max_tokens=cfg["max_output_tokens"], chain=chain):
                        if kind == "text":
                            step_text.append(val)
                            yield {"type": "text", "delta": val}
                        elif kind == "tool":
                            t = tools.TOOLS.get(val.get("name") or "")
                            yield {"type": "tool", "name": val.get("name"), "label": t.label if t else "Working"}
                        elif kind == "turn":
                            turn = val
                        elif kind == "used":
                            used_model = f"{val.model} via {val.connection_name}" + (f" (fallback {val.fallbacks})" if val.fallbacks else "")
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
                    calls = [b for b in turn.content if b.get("type") == "tool_use"]
                    if not calls:
                        break
                    results = []
                    for b in calls:
                        out, err = await run_tool(b["name"], b.get("input") or {})
                        results.append({"type": "tool_result", "tool_use_id": b["id"], "content": tools.model_view(out.data, ctx.share_contacts), "is_error": err})
                        for c in out.cards:
                            blocks.append(c)
                            yield {"type": "card", "card": c}
                    messages.append({"role": "user", "content": results})
                    turn_msgs.append({"role": "user", "content": results})
                    if step == cfg["max_steps"] - 1:
                        note = "\n\n(I reached the step limit for one question. Ask me to continue.)"
                        text_parts.append(note)
                        blocks.append({"type": "text", "text": note})
                        yield {"type": "text", "delta": note}
                        turn_msgs.append({"role": "assistant", "content": [{"type": "text", "text": note.strip()}]})
                reply.text = "\n\n".join(p.strip() for p in text_parts if p.strip())
        except ApiError as exc:
            status = "error"
            reply.text = (reply.text + "\n\n" if reply.text else "") + exc.message
            blocks.append({"type": "error", "text": exc.message})
            yield {"type": "error", "message": exc.message, "code": exc.code}
        except (asyncio.CancelledError, GeneratorExit):
            status = "stopped"
            raise
        except Exception:  # noqa: BLE001 — never leave the chat hanging; details go to the log
            log.exception("assistant turn failed")
            status = "error"
            msg = "Something went wrong while answering. Please try again."
            blocks.append({"type": "error", "text": msg})
            yield {"type": "error", "message": msg}
        finally:
            reply.blocks, reply.status, reply.mode = _compact(blocks), status, mode
            reply.model_content = _clean([{"role": "user", "content": "x"}] + turn_msgs)[1:] if turn_msgs else [{"role": "assistant", "content": [{"type": "text", "text": reply.text or "(no answer)"}]}]
            if not reply.model_content or reply.model_content[0]["role"] != "assistant":
                reply.model_content = [{"role": "assistant", "content": [{"type": "text", "text": reply.text or "(no answer)"}]}] + reply.model_content
            reply.input_tokens, reply.output_tokens = usage["in"], usage["out"]
            await asyncio.shield(_save(session, reply, conv, user, usage, used_model, mode, started, status, text))
        if status == "done":
            yield {"type": "done", "message": message_out(reply), "model": used_model, "usage": {"input_tokens": usage["in"], "output_tokens": usage["out"]}}


def _compact(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merges neighbouring text blocks so the saved message reads as it streamed."""
    out: list[dict[str, Any]] = []
    for b in blocks:
        if b.get("type") == "text" and out and out[-1].get("type") == "text":
            out[-1] = {"type": "text", "text": out[-1]["text"] + b["text"]}
        else:
            out.append(b)
    return out


async def _save(session, reply: AssistantMessage, conv: AssistantConversation, user: User, usage: dict[str, int], model: str, mode: str,
                started: float, status: str, question: str) -> None:
    try:
        session.add(reply)
        conv.updated_at = utcnow()
        if mode == "live":
            session.add(AiRun(task="assistant", subject_type="conversation", subject_id=str(conv.id), inputs={"question": question[:500]},
                              output={"blocks": len(reply.blocks)}, final_text=reply.text[:4000], status="applied" if status == "done" else "failed",
                              mode=mode, model=model[:80], input_tokens=usage["in"], output_tokens=usage["out"], cache_creation_tokens=usage["cache_w"],
                              cache_read_tokens=usage["cache_r"], latency_ms=int((time.monotonic() - started) * 1000), error="" if status == "done" else status,
                              created_by=user.id, created_at=utcnow()))
        await session.commit()
    except Exception:  # noqa: BLE001
        log.exception("could not save assistant reply")


def message_out(m: AssistantMessage) -> dict[str, Any]:
    return {"id": str(m.id), "role": m.role, "text": m.text, "blocks": m.blocks, "status": m.status, "mode": m.mode,
            "created_at": m.created_at.isoformat() if m.created_at else None}


def sse(event: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n".encode()
