"""AI studio (admin) and AI drafts for staff and sellers. Every draft is reviewed by a person before use."""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.ai import client
from app.ai import service as ai
from app.ai.briefs import order_risk, seller_risk
from app.ai.settings import (
    MODELS,
    cost_usd,
    get_ai_settings,
    save_ai_settings,
    task_settings,
)
from app.ai.tasks import TASKS, TONES
from app.config import settings as env
from app.core.deps import AdminUser, CurrentUser, SellerAccount, SessionDep, audit
from app.core.errors import ApiError, Forbidden, NotFound
from app.core.permissions import Perm, permissions_for
from app.models import AiRun, Order, Seller, User
from app.services.notify import notify

router = APIRouter(tags=["ai"])


class RunIn(BaseModel):
    subject_id: str = Field(default="", max_length=40)
    tone: Literal["friendly", "formal", "apologetic"] = "friendly"
    intent: str = Field(default="", max_length=300)
    # listing writer
    notes: str = Field(default="", max_length=4000)
    category_id: uuid.UUID | None = None
    brand: str = Field(default="", max_length=80)


class FinishIn(BaseModel):
    final_text: str = Field(default="", max_length=10000)


class SendIn(BaseModel):
    subject: str = Field(min_length=3, max_length=150)
    text: str = Field(min_length=10, max_length=2000)


async def _inputs(session, task: str, body: RunIn) -> dict:
    if task == "listing_writer":
        if len(body.notes.strip()) < 20:
            raise ApiError("Describe the product in at least 20 characters", "notes_too_short", fields={"notes": "Too short"})
        from app.models import Category

        cat = await session.get(Category, body.category_id) if body.category_id else None
        return {"notes": body.notes.strip(), "category": cat.name if cat else "", "brand": body.brand.strip()}
    if task == "customer_message" and len(body.intent.strip()) < 5:
        raise ApiError("Say what the message should tell the customer", "intent_required", fields={"intent": "Required"})
    return {"tone": body.tone if body.tone in TONES else "friendly", "intent": body.intent.strip()}


# ----------------------------------------------------------------------------- AI studio (admin)


@router.get("/api/admin/ai")
async def studio(admin: Perm("settings"), session: SessionDep) -> dict:
    cfg = await get_ai_settings(session)
    used = await ai.usage_this_month(session)
    by_task = dict((await session.execute(select(AiRun.task, func.count()).where(AiRun.created_at >= ai.month_start()).group_by(AiRun.task))).all())
    applied = dict((await session.execute(
        select(AiRun.task, func.count()).where(AiRun.created_at >= ai.month_start(), AiRun.status.in_(("applied", "sent"))).group_by(AiRun.task)
    )).all())
    return {
        "settings": cfg,
        "status": {"mode": await ai.mode(), "key_configured": await client.configured(), "environment": env.environment},
        "models": MODELS,
        "usage": used | {"cost_usd": cost_usd(cfg, used["input_tokens"], used["output_tokens"]),
                         "budget_left": max(0, cfg["monthly_token_budget"] - used["input_tokens"] - used["output_tokens"]) if cfg["monthly_token_budget"] else None},
        "tasks": [
            {"key": t.key, "label": t.label, "description": t.description, "audience": t.audience, "output": t.output, "rules": t.rules,
             **task_settings(cfg, t.key), "runs_this_month": int(by_task.get(t.key, 0)), "used_this_month": int(applied.get(t.key, 0))}
            for t in TASKS.values()
        ],
    }


@router.put("/api/admin/ai")
async def studio_save(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    try:
        cfg = await save_ai_settings(session, body, set(TASKS))
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_ai_settings") from exc
    audit(session, admin, "ai.settings", "settings", "ai", f"enabled={cfg['enabled']} model={cfg['model']}")
    await session.commit()
    return await studio(admin, session)


@router.get("/api/admin/ai/runs")
async def runs(admin: Perm("settings"), session: SessionDep, task: str | None = None, status: str | None = None, page: int = Query(default=1, ge=1)) -> dict:
    cfg = await get_ai_settings(session)
    stmt = select(AiRun, User.name).outerjoin(User, User.id == AiRun.created_by)
    if task:
        stmt = stmt.where(AiRun.task == task)
    if status:
        stmt = stmt.where(AiRun.status == status)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(AiRun.created_at.desc()).offset((page - 1) * 30).limit(30))).all()
    return {"items": [ai.run_out(r, cfg) | {"by": n or "System"} for r, n in rows], "total": total, "page": page, "page_size": 30}


@router.get("/api/admin/ai/runs/{run_id}")
async def run_detail(run_id: uuid.UUID, admin: Perm("settings"), session: SessionDep) -> dict:
    r = await session.get(AiRun, run_id)
    if r is None:
        raise NotFound("AI run")
    return ai.run_out(r, await get_ai_settings(session)) | {"inputs": r.inputs}


@router.post("/api/admin/ai/tasks/{task}")
async def admin_run(task: str, body: RunIn, admin: AdminUser, session: SessionDep) -> dict:
    spec = TASKS.get(task)
    if spec is None or spec.audience != "admin":
        raise NotFound("AI task")
    if spec.permission not in permissions_for(admin):
        raise Forbidden(f"Your role does not allow this ({spec.permission})")
    r, _ = await ai.run(session, task, actor=admin, inputs=await _inputs(session, task, body), subject_id=body.subject_id)
    await session.commit()
    return ai.run_out(r, await get_ai_settings(session))


async def _own_admin_run(session, run_id: uuid.UUID, admin: User) -> AiRun:
    r = await session.get(AiRun, run_id)
    if r is None or r.seller_id is not None:
        raise NotFound("AI draft")
    spec = TASKS.get(r.task)
    if spec and spec.permission and spec.permission not in permissions_for(admin):
        raise Forbidden("Your role does not allow this")
    return r


# The fixed /send route is declared before /{action} so it is matched first.
@router.post("/api/admin/ai/runs/{run_id}/send")
async def admin_send(run_id: uuid.UUID, body: SendIn, admin: Perm("orders"), session: SessionDep) -> dict:
    """Sends a reviewed customer message (in-app and email). The final text is what the staff member approved."""
    r = await _own_admin_run(session, run_id, admin)
    if r.task != "customer_message" or r.status != "draft":
        raise ApiError("Only an unsent customer message draft can be sent", "ai_run_closed", 409)
    order = await session.get(Order, uuid.UUID(r.subject_id))
    customer = await session.get(User, order.user_id) if order else None
    if customer is None or customer.deleted_at is not None:
        raise ApiError("The customer's account is closed", "customer_gone", 409)
    await notify(session, "staff_message", customer, {"subject": body.subject.strip(), "message": body.text.strip(), "order_number": order.number},
                 link=f"/orders/{order.id}", channels=("inapp", "email"))
    await ai.finish(session, str(run_id), "sent", admin, final_text=f"{body.subject}\n\n{body.text}")
    audit(session, admin, "ai.customer_message.sent", "order", order.id, body.subject[:200])
    await session.commit()
    return ai.run_out(r)


@router.post("/api/admin/ai/runs/{run_id}/{action}")
async def admin_finish(run_id: uuid.UUID, action: Literal["apply", "discard"], body: FinishIn, admin: AdminUser, session: SessionDep) -> dict:
    await _own_admin_run(session, run_id, admin)
    r = await ai.finish(session, str(run_id), "applied" if action == "apply" else "discarded", admin, final_text=body.final_text)
    if r is None:
        raise ApiError("This draft was already used or discarded", "ai_run_closed", 409)
    await session.commit()
    return ai.run_out(r)


@router.get("/api/admin/ai/briefs/seller/{seller_id}")
async def seller_brief(seller_id: uuid.UUID, admin: Perm("sellers"), session: SessionDep) -> dict:
    s = await session.get(Seller, seller_id)
    if s is None:
        raise NotFound("Seller")
    return await seller_risk(session, s)


@router.get("/api/admin/ai/briefs/order/{order_id}")
async def order_brief(order_id: uuid.UUID, admin: Perm("orders"), session: SessionDep) -> dict:
    o = await session.get(Order, order_id)
    if o is None:
        raise NotFound("Order")
    return await order_risk(session, o)


# ----------------------------------------------------------------------------- sellers


@router.post("/api/seller/ai/tasks/{task}")
async def seller_run(task: str, body: RunIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    spec = TASKS.get(task)
    if spec is None or spec.audience != "seller":
        raise NotFound("AI task")
    r, out = await ai.run(session, task, actor=user, inputs=await _inputs(session, task, body), subject_id=body.subject_id, seller_id=seller.id)
    await session.commit()
    return ai.run_out(r)


@router.post("/api/seller/ai/runs/{run_id}/{action}")
async def seller_finish(run_id: uuid.UUID, action: Literal["apply", "discard"], body: FinishIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    r = await ai.finish(session, str(run_id), "applied" if action == "apply" else "discarded", user, final_text=body.final_text, seller_id=seller.id)
    if r is None:
        raise NotFound("AI draft")
    await session.commit()
    return ai.run_out(r)


@router.post("/api/seller/ai/listing")
async def seller_listing(body: RunIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    """Kept for the product editor: the listing writer's fields plus the draft id."""
    r, out = await ai.run(session, "listing_writer", actor=user, inputs=await _inputs(session, "listing_writer", body), seller_id=seller.id)
    await session.commit()
    return out | {"run_id": str(r.id), "mode": r.mode}
