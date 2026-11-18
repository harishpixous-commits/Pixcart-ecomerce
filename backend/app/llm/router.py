"""Runs a request on a route's fallback chain.

For each target (connection + model) in order, each API key of that connection is tried. A key that is
rate-limited, rejected or out of credit cools down for a while and the next key (then the next
target) is used. Once text has started streaming to the user, the answer is never switched to another
model mid-way; the error is reported instead.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError

from . import adapters
from .adapters import ProviderError, Turn
from .config import Connection, Target, targets

log = logging.getLogger("pixcart.llm")

_cooldown: dict[str, float] = {}  # "<connection>:<key id>" -> monotonic time it may be used again
COOLDOWN = {429: 30.0, 401: 600.0, 403: 600.0, 402: 1800.0}


@dataclass
class Used:
    connection_id: str
    connection_name: str
    provider: str
    model: str
    fallbacks: int


def _key_slots(conn: Connection) -> list[tuple[str, str]]:
    slots = list(zip(conn.key_ids, conn.keys, strict=False)) or [("none", "")]
    now = time.monotonic()
    ready = [s for s in slots if _cooldown.get(f"{conn.id}:{s[0]}", 0) <= now]
    return ready or slots  # all cooling down: try anyway rather than fail without asking


async def stream(session: AsyncSession, route: str, *, system: list[dict], messages: list[dict], tools: list[dict] | None = None,
                 max_tokens: int = 2048, chain: list[Target] | None = None) -> AsyncIterator[tuple[str, Any]]:
    """Yields adapter events plus a final ``("used", Used)``."""
    chain = chain if chain is not None else await targets(session, route)
    if not chain:
        raise ApiError("No AI model is connected. Add one in Admin → AI providers (or the Claude key in Integrations).", "ai_not_configured", 400)
    errors: list[str] = []
    attempt = 0
    plan: list[tuple[Target, str, str, bool]] = []  # (target, key id, key, retry allowed)
    for t in chain:
        for key_id, key in _key_slots(t.connection):
            plan.append((t, key_id, key, len(chain) == 1))
    skip_connection: set[str] = set()
    for t, key_id, key, may_retry in plan:
        if t.connection.id + t.model in skip_connection:
            continue
        for retry in range(2 if may_retry else 1):
            started = False
            try:
                async for ev in adapters.stream(t.connection, key, t.model, system, messages, tools or [], max_tokens):
                    if ev[0] in ("text", "tool"):
                        started = True
                    yield ev
                yield "used", Used(t.connection.id, t.connection.name, t.connection.type, t.model, attempt)
                return
            except ProviderError as exc:
                if started:
                    raise ApiError("The AI stopped part-way through. Please ask again.", "ai_interrupted", 502) from exc
                if retry == 0 and may_retry and exc.status in (500, 502, 503, 529):
                    await asyncio.sleep(1.0)  # one quick retry on the same key for a transient server error
                    continue
                errors.append(f"{t.connection.name} / {t.model}: {exc}")
                log.warning("llm %s %s key %s failed: %s", t.connection.name, t.model, key_id, exc)
                if exc.key_problem and exc.status in COOLDOWN:
                    _cooldown[f"{t.connection.id}:{key_id}"] = time.monotonic() + COOLDOWN[exc.status]
                if not exc.key_problem:
                    skip_connection.add(t.connection.id + t.model)  # other keys would fail the same way
                attempt += 1
                break
            except httpx.HTTPError as exc:
                if started:
                    raise ApiError("The AI connection dropped part-way through. Please ask again.", "ai_interrupted", 502) from exc
                errors.append(f"{t.connection.name} / {t.model}: network ({type(exc).__name__})")
                skip_connection.add(t.connection.id + t.model)
                attempt += 1
                break
    log.error("llm route %s failed on every target: %s", route, "; ".join(errors))
    raise ApiError("None of the connected AI models answered. Check Admin → AI providers. " + (errors[-1] if errors else ""), "ai_unavailable", 502)


async def complete(session: AsyncSession, route: str, *, system: list[dict], user: str, max_tokens: int) -> tuple[Turn, Used]:
    turn: Turn | None = None
    used: Used | None = None
    async for kind, value in stream(session, route, system=system, messages=[{"role": "user", "content": user}], max_tokens=max_tokens):
        if kind == "turn":
            turn = value
        elif kind == "used":
            used = value
    assert turn is not None and used is not None
    return turn, used


async def test_target(conn: Connection, model: str) -> tuple[bool, str, int]:
    """Sends a tiny prompt with every key and reports which work. Returns (ok, message, latency ms)."""
    results, ok_any, latency = [], False, 0
    for key_id, key in list(zip(conn.key_ids, conn.keys, strict=False)) or [("none", "")]:
        started = time.monotonic()
        try:
            text = ""
            async for kind, value in adapters.stream(conn, key, model, [{"type": "text", "text": "Reply with the single word OK."}],
                                                     [{"role": "user", "content": "ping"}], [], 16):
                if kind == "text":
                    text += value
            latency = int((time.monotonic() - started) * 1000)
            ok_any = True
            results.append(f"key {key_id[:6]}: OK in {latency} ms")
        except ProviderError as exc:
            results.append(f"key {key_id[:6]}: {exc}")
        except httpx.HTTPError as exc:
            results.append(f"key {key_id[:6]}: cannot reach the server ({type(exc).__name__})")
    return ok_any, f"{model}: " + "; ".join(results), latency
