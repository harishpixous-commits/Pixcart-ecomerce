"""Admin -> AI agents: the agents' on/off switches and settings, and the proposals waiting for a human decision."""
from __future__ import annotations

import uuid
from typing import Any, Literal

from fastapi import APIRouter
from sqlalchemy import func, select

from app.agents import core
from app.core.deps import SessionDep, audit
from app.core.errors import ApiError
from app.core.permissions import Perm
from app.models import AgentProposal
from app.services import growth

router = APIRouter(prefix="/api/admin/agents", tags=["agents"])


def _view(p: AgentProposal) -> dict:
    return {"id": str(p.id), "agent": p.agent, "kind": p.kind, "summary": p.summary, "details": p.details, "status": p.status, "permission": p.permission,
            "result": p.result, "created_at": p.created_at.isoformat(), "decided_at": p.decided_at.isoformat() if p.decided_at else None}


@router.get("")
async def overview(admin: Perm("assistant_actions"), session: SessionDep) -> dict:
    cfg = (await growth.get(session))["agents"]
    pending = dict((await session.execute(select(AgentProposal.agent, func.count()).where(AgentProposal.status == "pending").group_by(AgentProposal.agent))).all())
    return {"settings": cfg, "defaults": growth.defaults()["agents"],
            "agents": [{"key": a.key, "label": a.label, "job": a.job, "not_wired": a.not_wired, "enabled": bool(cfg["enabled"] and cfg[f"{a.key}_enabled"]),
                        "pending": pending.get(a.key, 0)} for a in core.registry().values()]}


@router.put("/settings")
async def put_settings(body: dict[str, Any], admin: Perm("assistant_actions"), session: SessionDep) -> dict:
    try:
        cfg = await growth.update(session, {"agents": body})
    except ValueError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "settings.agents", "settings", "agents", ", ".join(sorted(body))[:200])
    await session.commit()
    return {"settings": cfg["agents"]}


@router.get("/proposals")
async def proposals(admin: Perm("assistant_actions"), session: SessionDep, status: Literal["pending", "done", "rejected", "expired", "failed", "all"] = "pending", agent: str | None = None) -> dict:
    q = select(AgentProposal).order_by(AgentProposal.created_at.desc()).limit(200)
    if status != "all":
        q = q.where(AgentProposal.status == status)
    if agent:
        q = q.where(AgentProposal.agent == agent)
    return {"items": [_view(p) for p in (await session.execute(q)).scalars().all()]}


@router.post("/run")
async def run_now(admin: Perm("assistant_actions"), session: SessionDep) -> dict:
    made = await core.run_all(session)
    audit(session, admin, "agents.run", "settings", "agents", str(made)[:200])
    await session.commit()
    return {"new": made}


@router.post("/proposals/{pid}/{decision}")
async def decide(pid: uuid.UUID, decision: Literal["approve", "reject"], admin: Perm("assistant_actions"), session: SessionDep) -> dict:
    return _view(await core.decide(session, admin, pid, decision))
