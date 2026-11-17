"""Claude over plain HTTPS: one-shot completions (AI studio) and streamed tool use (AI assistant).

Keys come from Admin → Integrations (``app.integrations``), falling back to ``ANTHROPIC_API_KEY``.

The system prompt is sent as blocks marked for prompt caching (frozen rules first, then the brand or
knowledge block), so repeated calls bill most input tokens at the cache-read rate.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.errors import ApiError
from app.integrations import get as get_integrations

log = logging.getLogger("pixcart.ai")

transport: httpx.AsyncBaseTransport | None = None  # tests replace this with a mock transport
API_VERSION = "2023-06-01"
RETRY_STATUS = (429, 500, 502, 503, 529)


@dataclass
class Completion:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0
    latency_ms: int = 0


async def configured() -> bool:
    cfg = await get_integrations()
    return cfg.ai_provider == "anthropic" and bool(cfg.anthropic_api_key)


async def _conn() -> tuple[str, dict[str, str]]:
    cfg = await get_integrations()
    if not cfg.anthropic_api_key:
        raise ApiError("Add the Claude API key in Admin → Integrations first", "ai_not_configured", 400)
    return cfg.anthropic_api_base, {"x-api-key": cfg.anthropic_api_key, "anthropic-version": API_VERSION, "content-type": "application/json"}


def _friendly(status: int, text: str) -> ApiError:
    log.error("anthropic %s: %s", status, text[:300])
    if status == 401:
        return ApiError("The Claude API key was rejected. Update it in Admin → Integrations.", "ai_auth", 502)
    if status == 400 and "credit" in text.lower():
        return ApiError("The Claude account has no credit left. Add billing at console.anthropic.com.", "ai_billing", 502)
    return ApiError("The AI service could not answer right now. Try again in a minute.", "ai_error", 502)


async def complete(*, model: str, rules: str, brand: str, user: str, max_tokens: int) -> Completion:
    """One Messages API call. Retries once on rate limits and server errors."""
    base, headers = await _conn()
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [
            {"type": "text", "text": rules, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": brand, "cache_control": {"type": "ephemeral"}},
        ],
        "messages": [{"role": "user", "content": user}],
    }
    started = time.monotonic()
    r = None
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(base_url=base, timeout=60, transport=transport) as c:
                r = await c.post("/v1/messages", headers=headers, json=body)
        except httpx.HTTPError as exc:
            if attempt == 0:
                await asyncio.sleep(1.5)
                continue
            raise ApiError("The AI service is not reachable right now", "ai_unreachable", 502) from exc
        if r.status_code in RETRY_STATUS and attempt == 0:
            await asyncio.sleep(min(float(r.headers.get("retry-after", "2") or 2), 10))
            continue
        break
    assert r is not None
    if r.status_code >= 400:
        raise _friendly(r.status_code, r.text)
    data = r.json()
    usage = data.get("usage") or {}
    return Completion(
        text="".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip(),
        model=data.get("model", model),
        input_tokens=int(usage.get("input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
        cache_creation_tokens=int(usage.get("cache_creation_input_tokens") or 0),
        cache_read_tokens=int(usage.get("cache_read_input_tokens") or 0),
        latency_ms=int((time.monotonic() - started) * 1000),
    )


# ----------------------------------------------------------------------------- streaming with tools


@dataclass
class Turn:
    """One streamed model response, assembled."""

    content: list[dict[str, Any]]
    stop_reason: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0


async def _sse(resp: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    event_data: list[str] = []
    async for line in resp.aiter_lines():
        if line.startswith("data:"):
            event_data.append(line[5:].strip())
        elif line == "" and event_data:
            raw, event_data = "\n".join(event_data), []
            try:
                yield json.loads(raw)
            except ValueError:
                continue
    if event_data:
        try:
            yield json.loads("\n".join(event_data))
        except ValueError:
            pass


async def stream_turn(
    *, model: str, system: list[dict], messages: list[dict], tools: list[dict], max_tokens: int = 2048
) -> AsyncIterator[tuple[str, Any]]:
    """Streams one assistant turn.

    Yields ``("text", delta)`` while text arrives, ``("tool", {"id","name"})`` when the model starts a
    tool call, and finally ``("turn", Turn)`` with the full content blocks and token usage.
    """
    base, headers = await _conn()
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages, "stream": True}
    if tools:
        body["tools"] = tools
    blocks: dict[int, dict[str, Any]] = {}
    partial_json: dict[int, list[str]] = {}
    usage: dict[str, int] = {}
    stop_reason, model_used = "", model
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(base_url=base, timeout=httpx.Timeout(120.0, connect=10.0), transport=transport) as c:
                async with c.stream("POST", "/v1/messages", headers=headers, json=body) as resp:
                    if resp.status_code >= 400:
                        text = (await resp.aread()).decode(errors="replace")
                        if resp.status_code in RETRY_STATUS and attempt == 0:
                            await asyncio.sleep(min(float(resp.headers.get("retry-after", "2") or 2), 10))
                            continue
                        raise _friendly(resp.status_code, text)
                    async for ev in _sse(resp):
                        kind = ev.get("type")
                        if kind == "message_start":
                            msg = ev.get("message") or {}
                            model_used = msg.get("model", model)
                            u = msg.get("usage") or {}
                            usage["input"] = int(u.get("input_tokens") or 0)
                            usage["cache_creation"] = int(u.get("cache_creation_input_tokens") or 0)
                            usage["cache_read"] = int(u.get("cache_read_input_tokens") or 0)
                        elif kind == "content_block_start":
                            idx, cb = ev.get("index", 0), dict(ev.get("content_block") or {})
                            if cb.get("type") == "tool_use":
                                cb["input"] = {}
                                partial_json[idx] = []
                                yield "tool", {"id": cb.get("id"), "name": cb.get("name")}
                            elif cb.get("type") == "text":
                                cb["text"] = cb.get("text", "")
                            blocks[idx] = cb
                        elif kind == "content_block_delta":
                            idx, d = ev.get("index", 0), ev.get("delta") or {}
                            if d.get("type") == "text_delta" and idx in blocks:
                                blocks[idx]["text"] += d.get("text", "")
                                yield "text", d.get("text", "")
                            elif d.get("type") == "input_json_delta":
                                partial_json.setdefault(idx, []).append(d.get("partial_json", ""))
                        elif kind == "content_block_stop":
                            idx = ev.get("index", 0)
                            if idx in partial_json and idx in blocks:
                                raw = "".join(partial_json.pop(idx))
                                try:
                                    blocks[idx]["input"] = json.loads(raw) if raw.strip() else {}
                                except ValueError:
                                    blocks[idx]["input"] = {}
                        elif kind == "message_delta":
                            stop_reason = (ev.get("delta") or {}).get("stop_reason") or stop_reason
                            usage["output"] = int((ev.get("usage") or {}).get("output_tokens") or usage.get("output", 0))
                        elif kind == "error":
                            raise _friendly(529, json.dumps(ev.get("error") or {}))
            break
        except httpx.HTTPError as exc:
            if attempt == 0 and not blocks:
                await asyncio.sleep(1.5)
                continue
            raise ApiError("The AI service is not reachable right now", "ai_unreachable", 502) from exc
    content = [blocks[i] for i in sorted(blocks) if blocks[i].get("type") in ("text", "tool_use")]
    content = [b for b in content if not (b["type"] == "text" and not b.get("text"))]
    yield "turn", Turn(
        content=content, stop_reason=stop_reason or "end_turn", model=model_used,
        input_tokens=usage.get("input", 0), output_tokens=usage.get("output", 0),
        cache_creation_tokens=usage.get("cache_creation", 0), cache_read_tokens=usage.get("cache_read", 0),
    )
