"""Admin AI assistant API: chats (streamed), file uploads, confirm-before-run actions, downloads,
memory, settings, and the AI providers (LLM connections and fallback routes).

Who can do what is decided by role permissions: ``assistant`` (chat), ``assistant_files``,
``assistant_actions``, ``assistant_voice``; ``settings`` for assistant settings; ``ai_providers`` for keys,
including the Laya decision server's address and token (changing those also asks for the password again).
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from app.assistant import actions as actions_mod
from app.assistant import agent, decision, downloads, tools, uploads
from app.assistant import settings as asst_settings
from app.core.deps import SessionDep, audit, rate_limit
from app.core.errors import ApiError, Forbidden, NotFound
from app.core.permissions import Perm, permissions_for
from app.core.step_up import confirm_identity
from app.db import utcnow
from app.llm import config as llm_config
from app.llm import router as llm_router
from app.models import AssistantAction, AssistantConversation, AssistantMessage, AssistantUpload
from app.services.cms import get_site

router = APIRouter(prefix="/api/admin", tags=["assistant"])


# ----------------------------------------------------------------------------- status and settings


@router.get("/assistant/status")
async def status(user: Perm("assistant"), session: SessionDep) -> dict:
    cfg = await asst_settings.get(session)
    perms = permissions_for(user)
    chain = await llm_config.targets(session, "assistant")
    return {
        "enabled": cfg["enabled"], "name": cfg["name"], "suggestions": cfg["suggestions"],
        "mode": "live" if chain else "sandbox",
        "model": f"{chain[0].model} via {chain[0].connection.name}" if chain else "",
        "fallbacks": max(0, len(chain) - 1),
        "decision": cfg["decision"]["provider"],
        "voice": cfg["voice"] | {"languages": [{"code": c, "label": asst_settings.LANGS[c]} for c in cfg["voice"]["languages"]]},
        "can": {"chat": True, "actions": "assistant_actions" in perms, "files": "assistant_files" in perms, "voice": "assistant_voice" in perms and cfg["voice"]["enabled"],
                "settings": "settings" in perms, "providers": "ai_providers" in perms},
        "tools": [t.name for t in tools.available(perms)],
        "upload": {"max_mb": uploads.MAX_BYTES // (1024 * 1024), "types": list(uploads.EXTENSIONS)},
    }


@router.get("/assistant/settings")
async def get_settings(admin: Perm("settings"), session: SessionDep) -> dict:
    return {"settings": await asst_settings.get(session), "languages": asst_settings.LANGS, "tools": [
        {"name": t.name, "label": t.label, "description": t.description.split(". ")[0], "permissions": list(t.any_of)} for t in tools.TOOLS.values()],
        "actions": [{"kind": a.kind, "label": a.label, "permission": a.permission} for a in actions_mod.ACTIONS.values()]}


@router.put("/assistant/settings")
async def put_settings(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    password, code = str(body.pop("password", "") or ""), str(body.pop("totp", "") or "")
    before = (await asst_settings.stored(session))["decision"]
    try:
        cfg = asst_settings.validate(body, before)
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_assistant_settings") from exc
    laya = asst_settings.laya_changed(before, cfg["decision"])
    if laya:
        # Every staff question (and the token) goes to the Laya server: the same bar as connecting an AI provider.
        if "ai_providers" not in permissions_for(admin):
            raise Forbidden("Changing the Laya server or its token needs the AI providers permission")
        await confirm_identity(session, admin, password, code, purpose="assistant-laya")
    cfg = await asst_settings.save(session, cfg)
    audit(session, admin, "assistant.settings", "settings", "assistant",
          f"decision={cfg['decision']['provider']} voice={cfg['voice']['enabled']}" + (" laya_server=changed" if laya else ""))
    await session.commit()
    return await get_settings(admin, session)


class DecisionTest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@router.post("/assistant/decision-test")
async def decision_test(body: DecisionTest, admin: Perm("settings"), session: SessionDep) -> dict:
    cfg = await asst_settings.get(session, reveal=True)
    d = await decision.decide(body.text, cfg["decision"], available=set(tools.TOOLS), has_upload=False)
    return d.as_dict()


# ----------------------------------------------------------------------------- conversations


def _conv_out(c: AssistantConversation, count: int | None = None) -> dict:
    return {"id": str(c.id), "title": c.title, "updated_at": c.updated_at.isoformat(), "created_at": c.created_at.isoformat(), "archived": c.is_archived,
            "context": c.context or {}, **({"messages": count} if count is not None else {})}


async def _own(session, user, conv_id: uuid.UUID) -> AssistantConversation:
    c = await session.get(AssistantConversation, conv_id)
    if c is None or c.user_id != user.id:
        raise NotFound("Conversation")
    return c


@router.get("/assistant/conversations")
async def list_conversations(user: Perm("assistant"), session: SessionDep, archived: bool = False, q: str = "") -> dict:
    stmt = select(AssistantConversation).where(AssistantConversation.user_id == user.id, AssistantConversation.is_archived.is_(archived))
    if q.strip():
        stmt = stmt.where(AssistantConversation.title.ilike(f"%{q.strip()[:60]}%"))
    rows = (await session.execute(stmt.order_by(AssistantConversation.updated_at.desc()).limit(100))).scalars()
    return {"items": [_conv_out(c) for c in rows]}


class ConvIn(BaseModel):
    title: str = Field(default="New chat", max_length=120)
    context: dict[str, Any] = Field(default_factory=dict)


@router.post("/assistant/conversations", status_code=201)
async def create_conversation(body: ConvIn, user: Perm("assistant"), session: SessionDep) -> dict:
    now = utcnow()
    ctx = {k: str(v)[:300] for k, v in (body.context or {}).items() if k in ("path", "title", "filters")}
    c = AssistantConversation(user_id=user.id, title=body.title.strip() or "New chat", context=ctx, created_at=now, updated_at=now)
    session.add(c)
    await session.commit()
    return _conv_out(c, 0)


class ConvPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    archived: bool | None = None


@router.patch("/assistant/conversations/{conv_id}")
async def patch_conversation(conv_id: uuid.UUID, body: ConvPatch, user: Perm("assistant"), session: SessionDep) -> dict:
    c = await _own(session, user, conv_id)
    if body.title is not None:
        c.title = body.title.strip()
    if body.archived is not None:
        c.is_archived = body.archived
    await session.commit()
    return _conv_out(c)


@router.delete("/assistant/conversations/{conv_id}")
async def delete_conversation(conv_id: uuid.UUID, user: Perm("assistant"), session: SessionDep) -> dict:
    c = await _own(session, user, conv_id)
    await session.delete(c)
    await session.commit()
    return {"ok": True}


@router.get("/assistant/conversations/{conv_id}")
async def get_conversation(conv_id: uuid.UUID, user: Perm("assistant"), session: SessionDep) -> dict:
    c = await _own(session, user, conv_id)
    msgs = (await session.execute(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id).order_by(AssistantMessage.created_at))).scalars()
    acts = {str(a.id): a.status for a in (await session.execute(select(AssistantAction).where(AssistantAction.conversation_id == c.id))).scalars()}
    out = []
    for m in msgs:
        d = agent.message_out(m)
        d["blocks"] = [{**b, "status": acts.get(b.get("action_id"), b.get("status"))} if b.get("type") == "action" else b for b in d["blocks"]]
        out.append(d)
    return {**_conv_out(c), "messages": out}


class AskIn(BaseModel):
    text: str = Field(min_length=1, max_length=8000)
    upload_ids: list[str] = Field(default_factory=list, max_length=5)
    page: dict[str, Any] | None = None
    voice: bool = False


@router.post("/assistant/conversations/{conv_id}/messages")
async def ask(conv_id: uuid.UUID, body: AskIn, user: Perm("assistant"), session: SessionDep) -> StreamingResponse:
    cfg = await asst_settings.get(session)
    if not cfg["enabled"]:
        raise ApiError("The AI assistant is switched off. An admin can turn it on in Admin → AI assistant.", "assistant_off", 409)
    await _own(session, user, conv_id)
    perms = permissions_for(user)
    if body.upload_ids and "assistant_files" not in perms:
        raise Forbidden("Your role cannot share files with the assistant (assistant_files)")
    if body.voice and "assistant_voice" not in perms:
        raise Forbidden("Your role cannot use voice (assistant_voice)")
    await rate_limit(session, f"assistant:{user.id}", limit=120, window_seconds=3600)
    await session.commit()
    page = {k: str(v)[:300] for k, v in (body.page or {}).items() if k in ("path", "title", "filters")} or None

    async def events():
        async for ev in agent.run(user.id, conv_id, body.text.strip(), body.upload_ids, page, body.voice):
            yield agent.sse(ev)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"})


# ----------------------------------------------------------------------------- uploads


@router.post("/assistant/uploads", status_code=201)
async def upload(user: Perm("assistant_files"), session: SessionDep, file: UploadFile = File(...)) -> dict:
    await rate_limit(session, f"assistant-upload:{user.id}", limit=60, window_seconds=3600)
    data = await file.read(uploads.MAX_BYTES + 1)
    try:
        up = await uploads.store(session, user.id, file.filename or "file", file.content_type or "", data)
    except uploads.UploadError as exc:
        raise ApiError(str(exc), "bad_upload") from exc
    audit(session, user, "assistant.upload", "upload", up.id, f"{up.filename} {up.row_count} rows")
    await session.commit()
    return uploads.profile(up)


@router.delete("/assistant/uploads/{upload_id}")
async def delete_upload(upload_id: uuid.UUID, user: Perm("assistant_files"), session: SessionDep) -> dict:
    await session.execute(delete(AssistantUpload).where(AssistantUpload.id == upload_id, AssistantUpload.user_id == user.id))
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- actions


async def _action(session, user_id: uuid.UUID, action_id: uuid.UUID) -> AssistantAction:
    a = (await session.execute(select(AssistantAction).where(AssistantAction.id == action_id).with_for_update())).scalar_one_or_none()
    if a is None or a.user_id != user_id:
        raise NotFound("Action")
    return a


@router.post("/assistant/actions/{action_id}/{decision_}")
async def decide_action(action_id: uuid.UUID, decision_: Literal["confirm", "cancel"], user: Perm("assistant_actions"), session: SessionDep) -> dict:
    uid = user.id  # read now: a rollback below expires loaded objects
    a = await _action(session, uid, action_id)
    if a.status != "pending":
        raise ApiError(f"This action is already {a.status}", "action_done", 409)
    if decision_ == "cancel":
        if a.status == "pending":
            a.status, a.decided_at = "cancelled", utcnow()
            await session.commit()
        return {"id": str(a.id), "status": a.status}
    try:
        result = await actions_mod.execute(session, user, a)
    except ApiError as exc:
        await session.rollback()
        a = await _action(session, uid, action_id)
        if a.status == "pending" and exc.code not in ("action_expired",):
            a.status, a.decided_at, a.result = "failed", utcnow(), {**(a.result or {}), "error": exc.message}
            await session.refresh(user)
            audit(session, user, f"assistant.action.{a.kind}", "assistant_action", a.id, f"failed: {exc.message[:200]}")
            await session.commit()
        raise
    a = await _action(session, uid, action_id)
    a.status, a.decided_at = "done", utcnow()
    a.result = {**(a.result or {}), "outcome": {k: v for k, v in result.items() if isinstance(v, (str, int, float, bool))} if isinstance(result, dict) else {}}
    audit(session, user, f"assistant.action.{a.kind}", "assistant_action", a.id, a.summary[:200])
    await session.commit()
    return {"id": str(a.id), "status": a.status, "summary": a.summary}


# ----------------------------------------------------------------------------- downloads and memory


def _safe_name(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:50] or "assistant"


@router.get("/assistant/messages/{message_id}/download.{fmt}")
async def download_message(message_id: uuid.UUID, fmt: str, user: Perm("assistant"), session: SessionDep) -> Response:
    if fmt not in downloads.FORMATS:
        raise NotFound("Format")
    m = await session.get(AssistantMessage, message_id)
    conv = await session.get(AssistantConversation, m.conversation_id) if m else None
    if m is None or conv is None or conv.user_id != user.id:
        raise NotFound("Message")
    question = (await session.execute(select(AssistantMessage).where(AssistantMessage.conversation_id == conv.id, AssistantMessage.role == "user",
                                                                     AssistantMessage.created_at <= m.created_at).order_by(AssistantMessage.created_at.desc()).limit(1))).scalar_one_or_none()
    msgs = ([agent.message_out(question)] if question and m.role == "assistant" else []) + [agent.message_out(m)]
    brand = (await get_site(session))["brand_name"]
    data = downloads.build(fmt, msgs, f"{brand} assistant — {conv.title}", brand)
    name = f"{_safe_name(conv.title)}-{m.created_at:%Y%m%d-%H%M}.{fmt}"
    return Response(data, media_type=downloads.FORMATS[fmt], headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


@router.get("/assistant/conversations/{conv_id}/download.{fmt}")
async def download_conversation(conv_id: uuid.UUID, fmt: str, user: Perm("assistant"), session: SessionDep) -> Response:
    if fmt not in downloads.FORMATS:
        raise NotFound("Format")
    c = await _own(session, user, conv_id)
    msgs = [agent.message_out(m) for m in (await session.execute(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id).order_by(AssistantMessage.created_at))).scalars()]
    brand = (await get_site(session))["brand_name"]
    data = downloads.build(fmt, msgs, f"{brand} assistant — {c.title}", brand)
    return Response(data, media_type=downloads.FORMATS[fmt], headers={"Content-Disposition": f'attachment; filename="{_safe_name(c.title)}.{fmt}"', "Cache-Control": "no-store"})


@router.get("/assistant/memory")
async def get_memory(user: Perm("assistant"), session: SessionDep) -> dict:
    return {"notes": await asst_settings.memories(session, user.id)}


class MemoryIn(BaseModel):
    notes: list[str] = Field(default_factory=list, max_length=asst_settings.MAX_NOTES)


@router.put("/assistant/memory")
async def put_memory(body: MemoryIn, user: Perm("assistant"), session: SessionDep) -> dict:
    notes = await asst_settings.set_memories(session, user.id, body.notes)
    await session.commit()
    return {"notes": notes}


# ----------------------------------------------------------------------------- AI providers


@router.get("/ai-providers")
async def providers(admin: Perm("ai_providers"), session: SessionDep) -> dict:
    return await llm_config.view(session)


class ConnectionIn(BaseModel):
    name: str = Field(default="", max_length=60)
    type: str = Field(max_length=30)
    base_url: str = Field(default="", max_length=300)
    models: list[str] = Field(default_factory=list, max_length=40)
    enabled: bool = True
    timeout_s: int = Field(default=60, ge=5, le=300)
    add_keys: list[dict[str, str]] = Field(default_factory=list, max_length=10)
    remove_keys: list[str] = Field(default_factory=list, max_length=10)


@router.post("/ai-providers/connections", status_code=201)
async def add_connection(body: ConnectionIn, admin: Perm("ai_providers"), session: SessionDep) -> dict:
    try:
        rec = await llm_config.save_connection(session, body.model_dump(), None)
    except llm_config.LlmConfigError as exc:
        raise ApiError(str(exc), "invalid_connection") from exc
    audit(session, admin, "ai_provider.create", "ai_provider", rec["id"], f"{rec['type']} {rec['name']} keys={len(rec['keys'])}")
    await session.commit()
    return await llm_config.view(session)


@router.put("/ai-providers/connections/{conn_id}")
async def edit_connection(conn_id: str, body: ConnectionIn, admin: Perm("ai_providers"), session: SessionDep) -> dict:
    if conn_id == llm_config.BUILTIN_ID:
        raise ApiError("This connection uses the Claude key from Integrations; change it there.", "builtin_connection")
    try:
        rec = await llm_config.save_connection(session, body.model_dump(), conn_id)
    except llm_config.LlmConfigError as exc:
        raise ApiError(str(exc), "invalid_connection") from exc
    audit(session, admin, "ai_provider.update", "ai_provider", conn_id, f"keys added={len(body.add_keys)} removed={len(body.remove_keys)} models={len(rec['models'])}")
    await session.commit()
    return await llm_config.view(session)


@router.delete("/ai-providers/connections/{conn_id}")
async def remove_connection(conn_id: str, admin: Perm("ai_providers"), session: SessionDep) -> dict:
    await llm_config.delete_connection(session, conn_id)
    audit(session, admin, "ai_provider.delete", "ai_provider", conn_id)
    await session.commit()
    return await llm_config.view(session)


class TestIn(BaseModel):
    model: str = Field(default="", max_length=120)


@router.post("/ai-providers/connections/{conn_id}/test")
async def test_connection(conn_id: str, body: TestIn, admin: Perm("ai_providers"), session: SessionDep) -> dict:
    await rate_limit(session, f"llm-test:{admin.id}", limit=30, window_seconds=600)
    conn = next((c for c in await llm_config.connections(session) if c.id == conn_id), None)
    if conn is None:
        raise NotFound("Connection")
    model = body.model or (conn.models[0] if conn.models else "")
    ok, message, latency = await llm_router.test_target(conn, model)
    if conn_id != llm_config.BUILTIN_ID:
        await llm_config.record_test(session, conn_id, ok, message)
    audit(session, admin, "ai_provider.test", "ai_provider", conn_id, "ok" if ok else "failed")
    await session.commit()
    return {"ok": ok, "message": message, "latency_ms": latency}


class RoutesIn(BaseModel):
    routes: dict[str, list[dict[str, str]]]


@router.put("/ai-providers/routes")
async def put_routes(body: RoutesIn, admin: Perm("ai_providers"), session: SessionDep) -> dict:
    try:
        await llm_config.save_routes(session, body.routes)
    except llm_config.LlmConfigError as exc:
        raise ApiError(str(exc), "invalid_routes") from exc
    audit(session, admin, "ai_provider.routes", "ai_provider", "routes", ", ".join(f"{r}:{len(c)}" for r, c in body.routes.items()))
    await session.commit()
    return await llm_config.view(session)

