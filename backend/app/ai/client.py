"""AI studio's one-shot completions, on top of the model-agnostic router in ``app.llm``.

Kept as a small facade so AI studio code stays simple: ``complete()`` runs on the "studio" route
(any provider, with fallbacks) and returns text plus usage for the AI run log.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.llm import config as llm_config
from app.llm import router as llm_router


@dataclass
class Completion:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0
    latency_ms: int = 0


async def configured(session: AsyncSession | None = None, route: str = "studio") -> bool:
    if session is None:
        from app.db import SessionLocal

        async with SessionLocal() as s:
            return bool(await llm_config.targets(s, route))
    return bool(await llm_config.targets(session, route))


async def complete(session: AsyncSession, *, rules: str, brand: str, user: str, max_tokens: int) -> Completion:
    started = time.monotonic()
    turn, used = await llm_router.complete(session, "studio", system=[{"type": "text", "text": rules, "cache": True}, {"type": "text", "text": brand, "cache": True}],
                                           user=user, max_tokens=max_tokens)
    text = "".join(b.get("text", "") for b in turn.content if b.get("type") == "text").strip()
    return Completion(text=text, model=turn.model or used.model, input_tokens=turn.input_tokens, output_tokens=turn.output_tokens,
                      cache_creation_tokens=turn.cache_creation_tokens, cache_read_tokens=turn.cache_read_tokens,
                      latency_ms=int((time.monotonic() - started) * 1000))
