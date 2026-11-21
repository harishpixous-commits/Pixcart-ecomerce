"""Assistant settings (Admin → AI assistant → Settings), stored in ``platform_settings['assistant']``.

Every value has a default here and a validation rule; nothing about the assistant's behaviour is
hard-coded elsewhere. Per-person memory notes live under ``asst_mem:<user id>``.
"""
from __future__ import annotations

import ipaddress
import re
from copy import deepcopy
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import decrypt_field, encrypt_field
from app.db import utcnow
from app.models import PlatformSetting

KEY = "assistant"
LANGS = {"en-IN": "English (India)", "ta-IN": "தமிழ் Tamil", "hi-IN": "हिन्दी Hindi", "te-IN": "తెలుగు Telugu", "kn-IN": "ಕನ್ನಡ Kannada",
         "ml-IN": "മലയാളം Malayalam", "mr-IN": "मराठी Marathi", "bn-IN": "বাংলা Bengali", "gu-IN": "ગુજરાતી Gujarati", "en-US": "English (US)", "en-GB": "English (UK)"}

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "name": "Assistant",
    "max_steps": 8,  # tool rounds per question
    "max_output_tokens": 1500,
    "history_messages": 16,  # earlier messages sent word for word; older ones are condensed
    "share_contact_details": False,  # phone, email and address go to the AI provider only when on
    "instructions": "",  # extra house rules from the admin, added to the system prompt
    "suggestions": [
        "How much did we sell today?",
        "Compare this week with last week by day",
        "What needs my attention right now?",
        "Which products are low on stock?",
        "இன்னைக்கு எத்தனை ஆர்டர் வந்துச்சு?",
    ],
    "decision": {
        "provider": "rules",  # off | rules | laya
        "min_confidence": 0.55,  # below this, every tool is offered to the model
        "prefetch": True,  # run the obvious first lookup before the model is called (one round trip less)
        "laya_url": "",  # e.g. https://laya.example.com (laya-serve); public https only
        "laya_path": "/predict",
        "laya_key": "",  # stored encrypted; dropped when the address or path changes
        "laya_timeout_ms": 600,
    },
    "voice": {
        "enabled": True,
        "languages": ["en-IN", "ta-IN", "hi-IN"],
        "default_language": "en-IN",
        "speak_replies": True,
        "rate": 1.05,
        "pitch": 1.0,
        "voice_name": "",  # browser voice name; empty = best match for the language
        "auto_listen": True,  # listen again after speaking (hands-free)
    },
}


def _merge(saved: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(DEFAULTS)
    for k, v in (saved or {}).items():
        if k in ("decision", "voice") and isinstance(v, dict):
            out[k].update({kk: vv for kk, vv in v.items() if kk in DEFAULTS[k]})
        elif k in out:
            out[k] = v
    return out


async def stored(session: AsyncSession) -> dict[str, Any]:
    """The saved settings over the defaults, with the Laya token still encrypted."""
    row = await session.get(PlatformSetting, KEY)
    return _merge(row.value if row else {})


async def get(session: AsyncSession, *, reveal: bool = False) -> dict[str, Any]:
    cfg = await stored(session)
    enc = cfg["decision"].get("laya_key") or ""
    if reveal:
        cfg["decision"]["laya_key"] = decrypt_field(enc) if enc else ""
    else:
        cfg["decision"]["laya_key_set"] = bool(enc)
        cfg["decision"]["laya_key"] = ""
    return cfg


def _text(v: Any, limit: int) -> str:
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(v or ""))[:limit].strip()


_LAYA_URL = re.compile(r"^https://([A-Za-z0-9.\-]+)(:\d{1,5})?(/[\w./-]*)?$")


def _public_host(host: str) -> bool:
    """A name or address on the public internet: not private, loopback, link-local or cloud metadata."""
    host = host.lower().rstrip(".")
    if host.rsplit(".", 1)[-1].isdigit():  # an IPv4 address: no real top-level domain is a number
        try:
            ip = ipaddress.IPv4Address(host)
        except ValueError:
            return False  # short or octal forms such as 127.1
        return ip.is_global and not ip.is_multicast
    return "." in host and not host.endswith((".internal", ".local", ".localhost"))  # e.g. laya, metadata.google.internal


def _laya_url(value: Any) -> str:
    """Every staff question and the bearer token go to this address, so it must be public https."""
    url = _text(value, 300).rstrip("/")
    m = _LAYA_URL.match(url)
    if url and not m:
        raise ValueError("Laya address must start with https://, like https://laya.example.com")
    if m and not _public_host(m.group(1)):
        raise ValueError("Laya address must be a public https address, not a private, local or cloud metadata one")
    return url


def laya_changed(before: dict[str, Any], after: dict[str, Any]) -> bool:
    """Whether a save changes where questions go (address, path) or the token. Takes stored decision settings."""
    return any(before.get(k, "") != after.get(k, "") for k in ("laya_url", "laya_path", "laya_key"))


def validate(data: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """Checks and cleans new settings. ``current`` is the stored decision settings (``stored()['decision']``)."""
    cfg = _merge(data)
    if not isinstance(cfg["enabled"], bool) or not isinstance(cfg["share_contact_details"], bool):
        raise ValueError("Switches must be on or off")
    for k, lo, hi in (("max_steps", 1, 15), ("max_output_tokens", 256, 8000), ("history_messages", 4, 60)):
        v = cfg[k]
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise ValueError(f"{k.replace('_', ' ')} must be a whole number from {lo} to {hi}")
    cfg["name"] = _text(cfg["name"], 40) or "Assistant"
    cfg["instructions"] = _text(cfg["instructions"], 2000)
    cfg["suggestions"] = [_text(s, 120) for s in (cfg["suggestions"] or []) if _text(s, 120)][:8]
    d = cfg["decision"]
    if d["provider"] not in ("off", "rules", "laya"):
        raise ValueError("Decision layer is off, rules or laya")
    try:
        d["min_confidence"] = float(d["min_confidence"])
        d["laya_timeout_ms"] = int(d["laya_timeout_ms"])
    except (TypeError, ValueError):
        raise ValueError("Decision layer numbers are not valid") from None
    if not 0 <= d["min_confidence"] <= 1 or not 100 <= d["laya_timeout_ms"] <= 5000:
        raise ValueError("Confidence is 0–1 and the Laya timeout 100–5000 ms")
    d["prefetch"] = bool(d["prefetch"])
    d["laya_url"] = _laya_url(d["laya_url"])
    d["laya_path"] = _text(d["laya_path"], 60) or "/predict"
    if not d["laya_path"].startswith("/"):
        raise ValueError("Laya path must start with /")
    if d["provider"] == "laya" and not d["laya_url"]:
        raise ValueError("Enter the Laya server address, or choose the built-in rules")
    new_key = _text(d.pop("laya_key", ""), 300)
    d.pop("laya_key_set", None)
    # The saved token only ever goes to the server it was entered for: a new address or path drops it.
    moved = (d["laya_url"], d["laya_path"]) != (current.get("laya_url", ""), current.get("laya_path", "/predict"))
    asked = data.get("decision")
    drop = moved or (isinstance(asked, dict) and bool(asked.get("clear_laya_key")))
    d["laya_key"] = encrypt_field(new_key) if new_key else ("" if drop else current.get("laya_key", ""))
    v = cfg["voice"]
    v["languages"] = [lang for lang in (v["languages"] or []) if lang in LANGS][:8] or ["en-IN"]
    if v["default_language"] not in v["languages"]:
        v["default_language"] = v["languages"][0]
    for k, lo, hi in (("rate", 0.5, 2.0), ("pitch", 0.5, 2.0)):
        try:
            v[k] = float(v[k])
        except (TypeError, ValueError):
            raise ValueError(f"Voice {k} must be a number") from None
        if not lo <= v[k] <= hi:
            raise ValueError(f"Voice {k} must be between {lo} and {hi}")
    v["enabled"], v["speak_replies"], v["auto_listen"] = bool(v["enabled"]), bool(v["speak_replies"]), bool(v["auto_listen"])
    v["voice_name"] = _text(v["voice_name"], 120)
    return cfg


async def save(session: AsyncSession, cfg: dict[str, Any]) -> dict[str, Any]:
    """Stores settings that ``validate`` returned."""
    row = await session.get(PlatformSetting, KEY)
    if row is None:
        session.add(PlatformSetting(key=KEY, value=cfg, updated_at=utcnow()))
    else:
        row.value, row.updated_at = cfg, utcnow()
    await session.flush()
    return await get(session)


# ----------------------------------------------------------------------------- memory notes


MAX_NOTES = 30


def _mem_key(user_id) -> str:
    return f"asst_mem:{user_id}"


async def memories(session: AsyncSession, user_id) -> list[str]:
    row = await session.get(PlatformSetting, _mem_key(user_id))
    return list((row.value or {}).get("notes", [])) if row else []


async def set_memories(session: AsyncSession, user_id, notes: list[str]) -> list[str]:
    notes = [_text(n, 300) for n in notes if _text(n, 300)][-MAX_NOTES:]
    row = await session.get(PlatformSetting, _mem_key(user_id))
    if row is None:
        session.add(PlatformSetting(key=_mem_key(user_id), value={"notes": notes}, updated_at=utcnow()))
    else:
        row.value, row.updated_at = {"notes": notes}, utcnow()
    await session.flush()
    return notes
