"""Wire protocols. Both adapters take the same canonical conversation and yield the same events.

Canonical format (Anthropic-style content blocks, used everywhere in the app):

- ``system``: list of ``{"type": "text", "text": ...}`` (cache hints are applied by the Anthropic adapter)
- ``messages``: ``{"role": "user"|"assistant", "content": str | [blocks]}`` with blocks
  ``text``, ``tool_use`` ``{id, name, input}`` and ``tool_result`` ``{tool_use_id, content, is_error}``
- ``tools``: ``{"name", "description", "input_schema"}``

Events: ``("text", delta)``, ``("tool", {"id","name"})`` and finally ``("turn", Turn)``.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Connection

# Tests replace this with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None
ANTHROPIC_VERSION = "2023-06-01"


@dataclass
class Turn:
    content: list[dict[str, Any]]
    stop_reason: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_tokens: int = 0
    cache_read_tokens: int = 0


class ProviderError(Exception):
    """A provider failure. ``retryable`` ones move on to the next key or fallback model."""

    def __init__(self, message: str, *, status: int = 0, retryable: bool = True, key_problem: bool = False) -> None:
        super().__init__(message)
        self.status, self.retryable, self.key_problem = status, retryable, key_problem


def classify(status: int, body: str) -> ProviderError:
    text = body[:300]
    if status in (401, 403):
        return ProviderError(f"Key rejected ({status})", status=status, retryable=True, key_problem=True)
    if status == 429:
        return ProviderError("Rate limited", status=status, retryable=True, key_problem=True)
    if status == 402 or (status == 400 and ("credit" in text.lower() or "billing" in text.lower() or "quota" in text.lower())):
        return ProviderError("Out of credit", status=status, retryable=True, key_problem=True)
    if status == 404:
        return ProviderError("Model or address not found", status=status, retryable=True)
    if status >= 500 or status == 408:
        return ProviderError(f"Provider error ({status})", status=status, retryable=True)
    return ProviderError(f"Request rejected ({status}): {text[:160]}", status=status, retryable=True)


def _headers(conn: Connection, key: str) -> dict[str, str]:
    h = {"content-type": "application/json", **conn.extra_headers}
    if conn.protocol == "anthropic":
        h |= {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}
    elif conn.auth == "api-key":
        h["api-key"] = key
    elif conn.auth == "x-api-key":
        h["x-api-key"] = key
    elif conn.auth == "bearer" and key:
        h["Authorization"] = f"Bearer {key}"
    return h


async def _sse(resp: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    data: list[str] = []
    async for line in resp.aiter_lines():
        if line.startswith("data:"):
            data.append(line[5:].strip())
        elif line == "" and data:
            raw, data = "\n".join(data), []
            if raw == "[DONE]":
                return
            try:
                yield json.loads(raw)
            except ValueError:
                continue
    if data and data != ["[DONE]"]:
        try:
            yield json.loads("\n".join(data))
        except ValueError:
            pass


# ----------------------------------------------------------------------------- Anthropic


async def anthropic_stream(conn: Connection, key: str, model: str, system: list[dict], messages: list[dict], tools: list[dict],
                           max_tokens: int) -> AsyncIterator[tuple[str, Any]]:
    # Blocks marked "cache" become prompt-cache breakpoints (max 4); dynamic blocks stay uncached.
    sys_blocks = []
    marks = 0
    for b in system:
        blk = {"type": "text", "text": b.get("text", "")}
        if b.get("cache") and marks < 4:
            blk["cache_control"] = {"type": "ephemeral"}
            marks += 1
        sys_blocks.append(blk)
    body: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": sys_blocks, "messages": messages, "stream": True}
    if tools:
        body["tools"] = tools
    blocks: dict[int, dict[str, Any]] = {}
    partial: dict[int, list[str]] = {}
    usage: dict[str, int] = {}
    stop, used_model = "", model
    async with httpx.AsyncClient(base_url=conn.base_url, timeout=httpx.Timeout(float(conn.timeout_s), connect=10.0), transport=transport) as c:
        async with c.stream("POST", "/v1/messages", headers=_headers(conn, key), json=body) as resp:
            if resp.status_code >= 400:
                raise classify(resp.status_code, (await resp.aread()).decode(errors="replace"))
            async for ev in _sse(resp):
                kind = ev.get("type")
                if kind == "message_start":
                    msg = ev.get("message") or {}
                    used_model = msg.get("model", model)
                    u = msg.get("usage") or {}
                    usage = {"input": int(u.get("input_tokens") or 0), "cache_creation": int(u.get("cache_creation_input_tokens") or 0),
                             "cache_read": int(u.get("cache_read_input_tokens") or 0)}
                elif kind == "content_block_start":
                    idx, cb = ev.get("index", 0), dict(ev.get("content_block") or {})
                    if cb.get("type") == "tool_use":
                        cb["input"] = {}
                        partial[idx] = []
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
                        partial.setdefault(idx, []).append(d.get("partial_json", ""))
                elif kind == "content_block_stop":
                    idx = ev.get("index", 0)
                    if idx in partial and idx in blocks:
                        raw = "".join(partial.pop(idx))
                        try:
                            blocks[idx]["input"] = json.loads(raw) if raw.strip() else {}
                        except ValueError:
                            blocks[idx]["input"] = {}
                elif kind == "message_delta":
                    stop = (ev.get("delta") or {}).get("stop_reason") or stop
                    usage["output"] = int((ev.get("usage") or {}).get("output_tokens") or usage.get("output", 0))
                elif kind == "error":
                    err = ev.get("error") or {}
                    raise ProviderError(str(err.get("message") or "stream error")[:200], status=529)
    content = [blocks[i] for i in sorted(blocks) if blocks[i].get("type") in ("text", "tool_use")]
    content = [b for b in content if not (b["type"] == "text" and not b.get("text"))]
    yield "turn", Turn(content, stop or "end_turn", used_model, usage.get("input", 0), usage.get("output", 0), usage.get("cache_creation", 0), usage.get("cache_read", 0))


# ----------------------------------------------------------------------------- OpenAI-compatible


def to_openai(system: list[dict], messages: list[dict], tools: list[dict]) -> tuple[list[dict], list[dict]]:
    out: list[dict[str, Any]] = []
    sys_text = "\n\n".join(b.get("text", "") for b in system if b.get("text"))
    if sys_text:
        out.append({"role": "system", "content": sys_text})
    for m in messages:
        content = m["content"]
        if isinstance(content, str):
            out.append({"role": m["role"], "content": content})
            continue
        if m["role"] == "assistant":
            text = "".join(b.get("text", "") for b in content if b.get("type") == "text")
            calls = [{"id": b["id"], "type": "function", "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {}, ensure_ascii=False)}}
                     for b in content if b.get("type") == "tool_use"]
            msg: dict[str, Any] = {"role": "assistant", "content": text or None}
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
        else:
            texts = []
            for b in content:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    if isinstance(c, list):
                        c = "".join(x.get("text", "") for x in c if isinstance(x, dict))
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"], "content": str(c)})
                elif b.get("type") == "text":
                    texts.append(b.get("text", ""))
            if texts:
                out.append({"role": "user", "content": "\n".join(texts)})
    fns = [{"type": "function", "function": {"name": t["name"], "description": t.get("description", ""), "parameters": t.get("input_schema") or {"type": "object"}}}
           for t in tools]
    return out, fns


async def openai_stream(conn: Connection, key: str, model: str, system: list[dict], messages: list[dict], tools: list[dict],
                        max_tokens: int) -> AsyncIterator[tuple[str, Any]]:
    msgs, fns = to_openai(system, messages, tools)
    body: dict[str, Any] = {"model": model, "messages": msgs, "stream": True, "max_tokens": max_tokens, "stream_options": {"include_usage": True}}
    if fns:
        body["tools"] = fns
    text_parts: list[str] = []
    calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, int] = {}
    finish, used_model = "", model
    async with httpx.AsyncClient(base_url=conn.base_url, timeout=httpx.Timeout(float(conn.timeout_s), connect=10.0), transport=transport) as c:
        async with c.stream("POST", "/chat/completions", headers=_headers(conn, key), json=body) as resp:
            if resp.status_code == 400:
                raw = (await resp.aread()).decode(errors="replace")
                if "stream_options" in raw:  # some servers reject the usage option; retry without it
                    body.pop("stream_options", None)
                    raise ProviderError("retry-without-usage", status=400)
                raise classify(400, raw)
            if resp.status_code >= 400:
                raise classify(resp.status_code, (await resp.aread()).decode(errors="replace"))
            async for ev in _sse(resp):
                if ev.get("error"):
                    raise ProviderError(str((ev["error"] or {}).get("message", "stream error"))[:200], status=500)
                used_model = ev.get("model") or used_model
                if ev.get("usage"):
                    u = ev["usage"]
                    usage = {"input": int(u.get("prompt_tokens") or 0), "output": int(u.get("completion_tokens") or 0),
                             "cache_read": int(((u.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)}
                for ch in ev.get("choices") or []:
                    d = ch.get("delta") or {}
                    if d.get("content"):
                        text_parts.append(d["content"])
                        yield "text", d["content"]
                    for tc in d.get("tool_calls") or []:
                        i = tc.get("index", len(calls))
                        slot = calls.setdefault(i, {"id": "", "name": "", "args": []})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                            yield "tool", {"id": slot["id"] or f"call_{i}", "name": fn["name"]}
                        if fn.get("arguments"):
                            slot["args"].append(fn["arguments"])
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
    content: list[dict[str, Any]] = []
    if text_parts:
        content.append({"type": "text", "text": "".join(text_parts)})
    for i in sorted(calls):
        slot = calls[i]
        raw = "".join(slot["args"])
        try:
            args = json.loads(raw) if raw.strip() else {}
        except ValueError:
            args = {}
        content.append({"type": "tool_use", "id": slot["id"] or f"call_{i}", "name": slot["name"], "input": args if isinstance(args, dict) else {}})
    stop = "tool_use" if any(b["type"] == "tool_use" for b in content) else ("max_tokens" if finish == "length" else "end_turn")
    yield "turn", Turn(content, stop, used_model, usage.get("input", 0), usage.get("output", 0), 0, usage.get("cache_read", 0))


async def stream(conn: Connection, key: str, model: str, system: list[dict], messages: list[dict], tools: list[dict],
                 max_tokens: int) -> AsyncIterator[tuple[str, Any]]:
    if conn.protocol == "anthropic":
        async for ev in anthropic_stream(conn, key, model, system, messages, tools, max_tokens):
            yield ev
        return
    try:
        async for ev in openai_stream(conn, key, model, system, messages, tools, max_tokens):
            yield ev
    except ProviderError as exc:
        if str(exc) != "retry-without-usage":
            raise
        # Same request without stream_options (older OpenAI-compatible servers).
        conn2 = conn
        msgs, fns = to_openai(system, messages, tools)
        body: dict[str, Any] = {"model": model, "messages": msgs, "stream": True, "max_tokens": max_tokens}
        if fns:
            body["tools"] = fns
        async with httpx.AsyncClient(base_url=conn2.base_url, timeout=float(conn2.timeout_s), transport=transport) as c:
            r = await c.post("/chat/completions", headers=_headers(conn2, key), json=body | {"stream": False})
        if r.status_code >= 400:
            raise classify(r.status_code, r.text) from None
        data = r.json()
        msg = ((data.get("choices") or [{}])[0].get("message")) or {}
        content: list[dict[str, Any]] = []
        if msg.get("content"):
            content.append({"type": "text", "text": msg["content"]})
            yield "text", msg["content"]
        for i, tc in enumerate(msg.get("tool_calls") or []):
            fn = tc.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            content.append({"type": "tool_use", "id": tc.get("id") or f"call_{i}", "name": fn.get("name", ""), "input": args})
            yield "tool", {"id": tc.get("id"), "name": fn.get("name")}
        u = data.get("usage") or {}
        yield "turn", Turn(content, "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn", data.get("model", model),
                           int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0))
