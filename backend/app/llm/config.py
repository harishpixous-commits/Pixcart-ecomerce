"""LLM connections and routes, edited in Admin → AI providers. Stored in ``platform_settings['llm']``.

Shape::

    {"connections": [{"id", "name", "type", "base_url", "models": [...], "enabled", "timeout_s",
                      "keys": [{"id", "label", "enc", "added_at"}]}],
     "routes": {"assistant": [{"connection": id, "model": "..."}, ...], ...}}

API keys are Fernet-encrypted (same key as PAN and bank numbers); the browser only sees their last 4
characters. When nothing is configured, the Claude key from Admin → Integrations (or ANTHROPIC_API_KEY)
is used as a built-in connection, so existing setups keep working.
"""
from __future__ import annotations

import ipaddress
import re
import secrets
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_field, encrypt_field
from app.db import utcnow
from app.models import PlatformSetting

from .catalog import ROUTES, TYPES

KEY = "llm"
BUILTIN_ID = "claude-default"
MAX_CONNECTIONS = 30
MAX_KEYS = 10
MAX_TARGETS = 8
_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,120}$")


class LlmConfigError(ValueError):
    pass


@dataclass
class Connection:
    id: str
    name: str
    type: str
    base_url: str
    keys: list[str]  # decrypted, in order
    key_ids: list[str]
    models: list[str]
    enabled: bool = True
    timeout_s: int = 60
    builtin: bool = False
    extra_headers: dict[str, str] = field(default_factory=dict)

    @property
    def protocol(self) -> str:
        return TYPES[self.type].protocol if self.type in TYPES else "openai"

    @property
    def auth(self) -> str:
        return TYPES[self.type].auth if self.type in TYPES else "bearer"


@dataclass
class Target:
    connection: Connection
    model: str


async def _raw(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    return dict(row.value) if row else {"connections": [], "routes": {}}


async def _builtin(session: AsyncSession) -> Connection | None:
    from app.ai.settings import get_ai_settings
    from app.integrations import get as get_integrations

    cfg = await get_integrations(session)
    if not cfg.anthropic_api_key:
        return None
    model = (await get_ai_settings(session))["model"]
    return Connection(id=BUILTIN_ID, name="Claude (key from Integrations)", type="anthropic", base_url=cfg.anthropic_api_base,
                      keys=[cfg.anthropic_api_key], key_ids=["integrations"], models=[model], builtin=True)


def _connection(c: dict[str, Any]) -> Connection:
    keys, ids = [], []
    for k in c.get("keys") or []:
        v = decrypt_field(k.get("enc"))
        if v:
            keys.append(v)
            ids.append(k.get("id", ""))
    return Connection(id=c["id"], name=c["name"], type=c["type"], base_url=c["base_url"], keys=keys, key_ids=ids,
                      models=list(c.get("models") or []), enabled=bool(c.get("enabled", True)), timeout_s=int(c.get("timeout_s") or 60),
                      extra_headers=dict(c.get("extra_headers") or {}))


async def connections(session: AsyncSession) -> list[Connection]:
    raw = await _raw(session)
    out = [_connection(c) for c in raw.get("connections") or []]
    b = await _builtin(session)
    if b:
        out.insert(0, b)
    return out


async def targets(session: AsyncSession, route: str) -> list[Target]:
    """The ordered fallback chain for a route; empty routes fall back to the assistant route, then Claude."""
    raw = await _raw(session)
    conns = {c.id: c for c in await connections(session)}
    chain = (raw.get("routes") or {}).get(route) or []
    if not chain and route != "assistant":
        chain = (raw.get("routes") or {}).get("assistant") or []
    out = [Target(conns[t["connection"]], t["model"]) for t in chain if t.get("connection") in conns and conns[t["connection"]].enabled]
    if not out and BUILTIN_ID in conns:
        b = conns[BUILTIN_ID]
        out = [Target(b, b.models[0])]
    return [t for t in out if t.connection.keys or not TYPES.get(t.connection.type, TYPES["custom"]).needs_key]


# ----------------------------------------------------------------------------- admin view and edits


def _hint(v: str) -> str:
    return "••••" + v[-4:] if len(v) >= 8 else "••••"


async def view(session: AsyncSession) -> dict[str, Any]:
    raw = await _raw(session)
    conns = []
    b = await _builtin(session)
    if b:
        conns.append({"id": b.id, "name": b.name, "type": b.type, "base_url": b.base_url, "models": b.models, "enabled": True, "timeout_s": 60,
                      "builtin": True, "keys": [{"id": "integrations", "label": "Integrations key", "hint": _hint(b.keys[0])}]})
    for c in raw.get("connections") or []:
        keys = [{"id": k.get("id"), "label": k.get("label", ""), "hint": _hint(decrypt_field(k.get("enc"))) if decrypt_field(k.get("enc")) else "unreadable — add again",
                 "added_at": k.get("added_at")} for k in c.get("keys") or []]
        conns.append({k: c.get(k) for k in ("id", "name", "type", "base_url", "models", "enabled", "timeout_s", "last_test")} | {"keys": keys, "builtin": False})
    return {
        "connections": conns,
        "routes": {r: (raw.get("routes") or {}).get(r) or [] for r in ROUTES},
        "route_info": ROUTES,
        "types": [{"key": t.key, "name": t.name, "protocol": t.protocol, "base_url": t.base_url, "needs_key": t.needs_key, "local": t.local,
                   "example_models": list(t.example_models), "docs_url": t.docs_url, "notes": t.notes} for t in TYPES.values()],
    }


def _check_url(type_key: str, url: str) -> str:
    url = url.strip().rstrip("/")
    p = urlparse(url)
    if p.scheme not in ("https", "http") or not p.hostname:
        raise LlmConfigError("Enter the full address, starting with https://")
    host = p.hostname.lower()
    local = TYPES.get(type_key) and TYPES[type_key].local
    if p.scheme == "http" and not (local or type_key in ("custom", "vllm")):
        raise LlmConfigError("Cloud providers must use https://")
    if host in ("metadata.google.internal",) or host.endswith(".internal") and not local:
        raise LlmConfigError("That address is not allowed")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            raise LlmConfigError("That address is not allowed")  # e.g. 169.254.169.254 (cloud metadata)
    except ValueError:
        pass
    if "YOUR-RESOURCE" in url:
        raise LlmConfigError("Replace YOUR-RESOURCE with your Azure resource name")
    return url


async def _row(session: AsyncSession) -> PlatformSetting:
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={"connections": [], "routes": {}}, updated_at=utcnow())
        session.add(row)
    return row


async def save_connection(session: AsyncSession, data: dict[str, Any], conn_id: str | None) -> dict[str, Any]:
    row = await _row(session)
    value = dict(row.value or {})
    items = list(value.get("connections") or [])
    current = next((c for c in items if c["id"] == conn_id), None) if conn_id else None
    if conn_id and current is None:
        raise LlmConfigError("Connection not found")
    type_key = str(data.get("type") or (current or {}).get("type") or "")
    if type_key not in TYPES:
        raise LlmConfigError("Choose a provider")
    name = " ".join(str(data.get("name") or (current or {}).get("name") or TYPES[type_key].name).split())[:60]
    base_url = _check_url(type_key, str(data.get("base_url") or (current or {}).get("base_url") or TYPES[type_key].base_url))
    models = [m.strip() for m in (data.get("models") if data.get("models") is not None else (current or {}).get("models") or []) if str(m).strip()]
    bad = [m for m in models if not _MODEL.match(m)]
    if bad:
        raise LlmConfigError(f"Model name not valid: {bad[0]}")
    if not models:
        raise LlmConfigError("Add at least one model name")
    timeout = int(data.get("timeout_s") or (current or {}).get("timeout_s") or 60)
    if not 5 <= timeout <= 300:
        raise LlmConfigError("Timeout must be 5 to 300 seconds")
    keys = list((current or {}).get("keys") or [])
    remove = set(data.get("remove_keys") or [])
    keys = [k for k in keys if k.get("id") not in remove]
    for k in data.get("add_keys") or []:
        text = str(k.get("key") if isinstance(k, dict) else k).strip()
        if not text:
            continue
        if any(ord(ch) < 33 for ch in text) or len(text) > 400:
            raise LlmConfigError("An API key contains spaces or hidden characters")
        keys.append({"id": secrets.token_hex(4), "label": str(k.get("label", "") if isinstance(k, dict) else "")[:40], "enc": encrypt_field(text), "added_at": utcnow().isoformat()})
    if len(keys) > MAX_KEYS:
        raise LlmConfigError(f"At most {MAX_KEYS} keys per connection")
    if TYPES[type_key].needs_key and not keys:
        raise LlmConfigError("Add an API key")
    record = {"id": conn_id or secrets.token_hex(6), "name": name, "type": type_key, "base_url": base_url, "models": models[:40],
              "enabled": bool(data.get("enabled", (current or {}).get("enabled", True))), "timeout_s": timeout, "keys": keys,
              "last_test": (current or {}).get("last_test")}
    if current:
        items = [record if c["id"] == conn_id else c for c in items]
    else:
        if len(items) >= MAX_CONNECTIONS:
            raise LlmConfigError(f"At most {MAX_CONNECTIONS} connections")
        items.append(record)
    value["connections"] = items
    row.value, row.updated_at = value, utcnow()
    await session.flush()
    return record


async def delete_connection(session: AsyncSession, conn_id: str) -> None:
    row = await _row(session)
    value = dict(row.value or {})
    value["connections"] = [c for c in value.get("connections") or [] if c["id"] != conn_id]
    value["routes"] = {r: [t for t in chain if t.get("connection") != conn_id] for r, chain in (value.get("routes") or {}).items()}
    row.value, row.updated_at = value, utcnow()
    await session.flush()


async def save_routes(session: AsyncSession, routes: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    known = {c.id: c for c in await connections(session)}
    clean: dict[str, list[dict[str, str]]] = {}
    for r, chain in routes.items():
        if r not in ROUTES:
            raise LlmConfigError(f"Unknown route {r}")
        if len(chain) > MAX_TARGETS:
            raise LlmConfigError(f"At most {MAX_TARGETS} fallbacks per route")
        out = []
        for t in chain:
            c = known.get(str(t.get("connection")))
            model = str(t.get("model") or "").strip()
            if c is None:
                raise LlmConfigError("A route points to a connection that does not exist")
            if not _MODEL.match(model):
                raise LlmConfigError(f"Model name not valid: {model}")
            out.append({"connection": c.id, "model": model})
        clean[r] = out
    row = await _row(session)
    value = dict(row.value or {})
    value["routes"] = clean
    row.value, row.updated_at = value, utcnow()
    await session.flush()
    return clean


async def record_test(session: AsyncSession, conn_id: str, ok: bool, message: str) -> None:
    row = await _row(session)
    value = dict(row.value or {})
    items = []
    for c in value.get("connections") or []:
        if c["id"] == conn_id:
            c = {**c, "last_test": {"ok": ok, "message": message[:300], "at": utcnow().isoformat()}}
        items.append(c)
    value["connections"] = items
    row.value, row.updated_at = value, utcnow()
    await session.flush()
