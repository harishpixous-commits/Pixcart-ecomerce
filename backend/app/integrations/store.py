"""Saved integration settings: encrypted at rest, merged over the server environment, cached briefly.

Read path (anywhere in the backend)::

    cfg = await integrations.get()          # a Settings copy with admin overrides applied
    if cfg.online_payments: ...

Values saved in the admin panel win over environment values. A secret is stored as
``{"enc": <Fernet token>}`` with the same key that protects PAN and bank numbers
(``FIELD_ENCRYPTION_KEY``); the browser only ever sees whether it is set and its last 4 characters.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, settings
from app.core.security import decrypt_field, encrypt_field
from app.db import utcnow
from app.models import PlatformSetting

from .registry import BY_KEY, PROVIDERS, Provider, default_switch, validate_value

log = logging.getLogger("pixcart.integrations")

_ROW_KEY = "integrations"
_TTL_SECONDS = 15.0
_cache: tuple[float, dict[str, Any]] | None = None


class IntegrationError(ValueError):
    pass


def invalidate() -> None:
    global _cache
    _cache = None


async def _raw(session: AsyncSession | None = None) -> dict[str, Any]:
    global _cache
    if settings.environment != "test" and _cache and _cache[0] > time.monotonic():
        return _cache[1]
    if session is None:
        from app.db import SessionLocal

        async with SessionLocal() as s:
            row = await s.get(PlatformSetting, _ROW_KEY)
            value = dict(row.value) if row else {}
    else:
        row = await session.get(PlatformSetting, _ROW_KEY)
        value = dict(row.value) if row else {}
    _cache = (time.monotonic() + _TTL_SECONDS, value)
    return value


def _decrypt(stored: Any) -> tuple[Any, bool]:
    """(value, ok). A secret that no longer decrypts (key rotated) counts as not set."""
    if isinstance(stored, dict) and "enc" in stored:
        value = decrypt_field(stored["enc"])  # "" when the key changed or the value is damaged
        if not value:
            log.warning("integration secret could not be decrypted; re-enter it in the admin panel")
            return "", False
        return value, True
    return stored, True


def overrides(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in PROVIDERS:
        entry = raw.get(p.key) or {}
        for key, stored in (entry.get("values") or {}).items():
            try:
                f = p.field(key)
            except KeyError:
                continue
            value, ok = _decrypt(stored)
            if ok:
                out[f.setting] = value
        if entry.get("enabled") is True:
            out.update(p.on)
        elif entry.get("enabled") is False:
            out.update(p.off)
    return out


async def get(session: AsyncSession | None = None) -> Settings:
    """Runtime settings with the admin's integration values applied."""
    return settings.model_copy(update=overrides(await _raw(session)))


# ----------------------------------------------------------------------------- admin view


def _hint(value: str) -> str:
    v = str(value)
    return "••••" + v[-4:] if len(v) >= 10 else "••••"


def _switch(p: Provider, entry: dict[str, Any]) -> tuple[bool, str]:
    if entry.get("enabled") is not None:
        return bool(entry["enabled"]), "admin"
    return default_switch(p, settings), "environment"


def provider_status(p: Provider, raw: dict[str, Any]) -> dict[str, Any]:
    entry = raw.get(p.key) or {}
    saved = entry.get("values") or {}
    fields, missing = [], []
    for f in p.fields:
        source, value, undecryptable = "", None, False
        if f.key in saved:
            value, ok = _decrypt(saved[f.key])
            source = "admin" if ok else ""
            undecryptable = not ok
        if not source:
            env_value = getattr(settings, f.setting, "")
            value = env_value  # a built-in default is shown but does not count as configured
            if env_value not in ("", None) and env_value != Settings.model_fields[f.setting].default:
                source = "environment"
        is_set = source != "" and value not in ("", None)
        if f.required and not is_set:
            missing.append(f.label)
        item: dict[str, Any] = {
            "key": f.key, "label": f.label, "kind": f.kind, "required": f.required, "options": list(f.options), "help": f.help,
            "placeholder": f.placeholder, "pattern_hint": f.pattern_hint, "min": f.min, "max": f.max, "set": is_set, "source": source,
            "undecryptable": undecryptable,
        }
        if f.secret:
            item["hint"] = _hint(value) if is_set else ""
        else:
            item["value"] = value if value is not None else ""
        fields.append(item)
    enabled, switch_source = _switch(p, entry)
    eff = settings.model_copy(update=overrides(raw))
    mode = ""
    if p.key == "razorpay" and eff.razorpay_key_id:
        mode = "live" if eff.razorpay_key_id.startswith("rzp_live_") else "test"
    warnings = []
    if p.key == "razorpayx" and enabled and not eff.razorpay_enabled:
        warnings.append("RazorpayX uses the Razorpay API keys. Fill them in under Razorpay payments first.")
    if p.key == "razorpay" and mode == "test" and settings.environment == "production":
        warnings.append("Test keys: payments are not real. Switch to live keys before launch.")
    return {
        "key": p.key, "name": p.name, "group": p.group, "purpose": p.purpose, "docs_url": p.docs_url, "setup_steps": list(p.setup_steps),
        "needed_for_launch": p.needed_for_launch, "testable": p.testable, "restart_note": p.restart_note,
        "webhook_url": f"{settings.public_web_url.rstrip('/')}{p.webhook_path}" if p.webhook_path else "",
        "webhook_events": list(p.webhook_events),
        "enabled": enabled, "switch_source": switch_source, "ready": enabled and not missing, "missing": missing, "mode": mode,
        "warnings": warnings, "fields": fields, "last_test": entry.get("last_test"), "updated_at": entry.get("updated_at"),
        "updated_by": entry.get("updated_by", ""),
    }


async def status(session: AsyncSession) -> list[dict[str, Any]]:
    raw = await _raw(session)
    return [provider_status(p, raw) for p in PROVIDERS]


# ----------------------------------------------------------------------------- writes


async def _row(session: AsyncSession) -> PlatformSetting:
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == _ROW_KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=_ROW_KEY, value={}, updated_at=utcnow())
        session.add(row)
    return row


async def save(
    session: AsyncSession, provider_key: str, *, values: dict[str, Any], clear: list[str], enabled: bool | None, actor_name: str
) -> list[str]:
    """Validates and stores one provider's settings. Returns the field keys that changed (never values)."""
    p = BY_KEY.get(provider_key)
    if p is None:
        raise IntegrationError("Unknown integration")
    row = await _row(session)
    data = dict(row.value or {})
    entry = dict(data.get(p.key) or {})
    stored = dict(entry.get("values") or {})
    changed: list[str] = []
    for key, value in values.items():
        try:
            f = p.field(key)
        except KeyError:
            raise IntegrationError(f"Unknown field: {key}") from None
        if f.secret and (value is None or (isinstance(value, str) and not value.strip())):
            continue  # an empty secret box means "keep what is saved"
        try:
            clean = validate_value(f, value)
        except ValueError as exc:
            raise IntegrationError(str(exc)) from None
        new = {"enc": encrypt_field(clean)} if f.secret else clean
        old_value = _decrypt(stored[key])[0] if key in stored else None
        if old_value != clean:
            changed.append(key)
        stored[key] = new
    for key in clear:
        try:
            p.field(key)
        except KeyError:
            raise IntegrationError(f"Unknown field: {key}") from None
        if key in stored:
            stored.pop(key)
            changed.append(key)
    entry["values"] = stored
    if enabled is not None and entry.get("enabled") != enabled:
        entry["enabled"] = enabled
        changed.append("enabled")
    data[p.key] = entry
    status_now = provider_status(p, data)
    if status_now["enabled"] and status_now["missing"]:
        raise IntegrationError(f"Fill in {', '.join(status_now['missing'])} before switching {p.name} on")
    if changed:
        entry["updated_at"] = utcnow().isoformat()
        entry["updated_by"] = actor_name[:80]
        entry.pop("last_test", None)  # an old test result no longer describes these settings
    row.value = data
    row.updated_at = utcnow()
    await session.flush()
    invalidate()
    return changed


async def record_test(session: AsyncSession, provider_key: str, ok: bool, message: str) -> dict[str, Any]:
    row = await _row(session)
    data = dict(row.value or {})
    entry = dict(data.get(provider_key) or {})
    entry["last_test"] = {"ok": ok, "message": message[:300], "at": utcnow().isoformat()}
    data[provider_key] = entry
    row.value = data
    row.updated_at = utcnow()
    await session.flush()
    invalidate()
    return entry["last_test"]
