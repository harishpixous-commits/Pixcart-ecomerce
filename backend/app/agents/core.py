from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Awaitable, Callable

from fastapi import BackgroundTasks
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import audit
from app.core.errors import ApiError
from app.core.permissions import load_roles, permissions_for
from app.db import utcnow
from app.models import AgentProposal, User
from app.services import growth


@dataclass(frozen=True)
class AgentDef:
    key: str
    label: str
    job: str  # what it does today, in plain words
    not_wired: str  # what it does not do yet
    scan: Callable[[AsyncSession, dict[str, Any]], Awaitable[list[dict]]]


class Stale(Exception):
    """The thing the proposal was about changed, so it is no longer needed."""


def registry() -> dict[str, AgentDef]:
    from . import delivery, marketing, orderupdate, reorder

    return {a.key: a for a in (delivery.AGENT, orderupdate.AGENT, reorder.AGENT, marketing.AGENT)}


async def propose(session: AsyncSession, agent: str, kind: str, key: str, summary: str, details: list[list[str]], params: dict, permission: str) -> bool:
    """Writes a pending proposal. Returns False if the same idea was already proposed (even if it was rejected)."""
    stmt = pg_insert(AgentProposal).values(
        id=uuid.uuid4(), agent=agent, kind=kind, dedupe_key=f"{kind}:{key}"[:120], summary=summary[:500], details=details, params=params,
        permission=permission, status="pending", result={}, created_at=utcnow(),
    ).on_conflict_do_nothing(index_elements=["dedupe_key"])
    res = await session.execute(stmt)
    return bool(res.rowcount)


async def run_agent(session: AsyncSession, key: str, *, force: bool = False) -> int:
    """Runs one agent's scan. Returns how many new proposals were written. Off agents write nothing."""
    cfg = (await growth.get(session))["agents"]
    a = registry()[key]
    if not force and not (cfg["enabled"] and cfg[f"{key}_enabled"]):
        return 0
    made = 0
    for p in (await a.scan(session, cfg))[: cfg["max_per_run"]]:
        if await propose(session, key, **p):
            made += 1
    await session.flush()
    return made


async def run_all(session: AsyncSession) -> dict[str, int]:
    out = {k: await run_agent(session, k) for k in registry()}
    await expire_old(session)
    return out


async def expire_old(session: AsyncSession) -> int:
    cfg = (await growth.get(session))["agents"]
    res = await session.execute(
        update(AgentProposal).where(AgentProposal.status == "pending", AgentProposal.created_at < utcnow() - timedelta(hours=cfg["expire_hours"]))
        .values(status="expired", decided_at=utcnow(), result={"note": "Nobody decided in time."}))
    return res.rowcount or 0


async def decide(session: AsyncSession, user: User, pid: uuid.UUID, decision: str) -> AgentProposal:
    from . import executors

    row = (await session.execute(select(AgentProposal).where(AgentProposal.id == pid).with_for_update())).scalar_one_or_none()
    if row is None:
        raise ApiError("Proposal not found", "not_found", 404)
    if row.status != "pending":
        raise ApiError(f"This proposal is already {row.status}", "proposal_done", 409)
    await load_roles(session)
    if row.permission not in permissions_for(user):
        raise ApiError(f"Your role cannot do this ({row.permission}).", "forbidden", 403)
    uid = user.id
    if decision == "reject":
        row.status, row.decided_at, row.decided_by = "rejected", utcnow(), uid
        audit(session, user, f"agent.{row.agent}.reject", "agent_proposal", row.id, row.summary[:200])
        await session.commit()
        return row
    row.status, row.decided_at, row.decided_by = "running", utcnow(), uid
    await session.commit()
    await session.refresh(user)
    bg = BackgroundTasks()
    try:
        out = await executors.run(session, user, row, bg)
    except Stale as exc:
        await session.rollback()
        row = await session.get(AgentProposal, pid)
        row.status, row.result = "expired", {"note": str(exc)}
        await session.commit()
        raise ApiError(str(exc), "proposal_stale", 409) from exc
    except ApiError as exc:
        await session.rollback()
        row = await session.get(AgentProposal, pid)
        row.status, row.result = "failed", {"error": exc.message}
        await session.commit()
        raise
    except Exception as exc:  # never leave a proposal stuck in "running"
        await session.rollback()
        row = await session.get(AgentProposal, pid)
        row.status, row.result = "failed", {"error": str(exc)[:300]}
        await session.commit()
        raise ApiError("The agent could not do this. Check the package by hand.", "proposal_failed", 500) from exc
    row = await session.get(AgentProposal, pid)
    row.status = "done"
    row.result = {"outcome": {k: v for k, v in (out or {}).items() if isinstance(v, (str, int, float, bool))}}
    await session.refresh(user)
    audit(session, user, f"agent.{row.agent}.{row.kind}", "agent_proposal", row.id, row.summary[:200])
    await session.commit()
    await bg()
    return row
