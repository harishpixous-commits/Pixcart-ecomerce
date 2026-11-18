"""Shop assistant settings, edited in Admin → Shop assistant. Stored in ``platform_settings['shop_assistant']``."""
from __future__ import annotations

import copy
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

KEY = "shop_assistant"
LANG = re.compile(r"^[a-z]{2,3}(-[A-Z]{2})?$")

DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "name": "Help assistant",
    "greeting": "Hi! I can track your orders, help with cancellations, returns and refunds, find products, or connect you with our support team.",
    "allow_guests": True,
    "ai": "auto",  # auto = use the AI model when one is connected; guided = rules only (no AI cost)
    "instructions": "",
    "quick_replies": ["Track my order", "Return an item", "Refund status", "Find a product", "Talk to support"],
    # What the chat may do. Off = the assistant says it cannot do that here and links the right page.
    "features": {
        "product_search": True,   # find products, product details
        "orders": True,           # order status, tracking, delivery dates
        "cancel_orders": True,    # prepare a cancellation the customer confirms
        "returns_refunds": True,  # return eligibility, returns and refund status
        "tickets": True,          # raise support requests from chat, show their status
        "help_articles": True,    # answer from the help knowledge base
    },
    "max_steps": 5,
    "max_output_tokens": 700,
    "history_messages": 12,
    "monthly_token_budget": 0,  # 0 = no limit; counts only the shop assistant's own AI use
    "limits": {"per_minute": 12, "per_day_customer": 150, "per_day_guest": 40},
    "voice": {
        "enabled": True,
        "languages": [{"code": "en-IN", "label": "English"}, {"code": "ta-IN", "label": "தமிழ்"}, {"code": "hi-IN", "label": "हिन्दी"}],
        "default_language": "en-IN",
        "speak_replies": False,
        "rate": 1.0,
        "pitch": 1.0,
        "auto_listen": True,
    },
}


class SettingsError(ValueError):
    pass


FEATURE_LABELS = {
    "product_search": ("Find products", "Search the catalogue and answer questions about a product."),
    "orders": ("Order status and tracking", "Show the customer's orders, package progress, courier and delivery dates."),
    "cancel_orders": ("Cancel orders from chat", "Prepare a cancellation; the customer presses Confirm."),
    "returns_refunds": ("Returns and refunds", "Return eligibility and dates, return and refund status."),
    "tickets": ("Support requests", "Fill in a support request the customer sends, and show request status."),
    "help_articles": ("Help articles", "Answer policy and how-to questions from the help articles."),
}


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _merge(out[k], v)
        elif k in out:
            out[k] = v
    return out


async def get(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    return _merge(DEFAULTS, row.value if row else {})


def _text(v: Any, limit: int) -> str:
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(v or "")).strip()[:limit]


def _int(v: Any, lo: int, hi: int, name: str) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise SettingsError(f"{name} must be a whole number") from None
    if not lo <= n <= hi:
        raise SettingsError(f"{name} must be between {lo} and {hi}")
    return n


def validate(data: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    new = _merge(current, data)
    new["enabled"] = bool(new["enabled"])
    new["allow_guests"] = bool(new["allow_guests"])
    new["name"] = _text(new["name"], 40) or DEFAULTS["name"]
    new["greeting"] = _text(new["greeting"], 400) or DEFAULTS["greeting"]
    new["instructions"] = _text(new["instructions"], 3000)
    if new["ai"] not in ("auto", "guided"):
        raise SettingsError("Choose how the assistant answers")
    new["features"] = {k: bool(new["features"].get(k, True)) for k in DEFAULTS["features"]}
    qr = [_text(q, 40) for q in (new["quick_replies"] or []) if _text(q, 40)]
    new["quick_replies"] = qr[:8]
    new["max_steps"] = _int(new["max_steps"], 1, 8, "Tool rounds")
    new["max_output_tokens"] = _int(new["max_output_tokens"], 200, 2000, "Longest answer")
    new["history_messages"] = _int(new["history_messages"], 2, 40, "Messages remembered")
    new["monthly_token_budget"] = _int(new["monthly_token_budget"], 0, 1_000_000_000, "Monthly token budget")
    lim = new["limits"]
    new["limits"] = {"per_minute": _int(lim["per_minute"], 1, 60, "Messages per minute"),
                     "per_day_customer": _int(lim["per_day_customer"], 5, 2000, "Messages per day (customer)"),
                     "per_day_guest": _int(lim["per_day_guest"], 0, 500, "Messages per day (guest)")}
    v = new["voice"]
    langs = []
    for item in v.get("languages") or []:
        code, label = str(item.get("code", "")).strip(), _text(item.get("label"), 30)
        if LANG.match(code) and label:
            langs.append({"code": code, "label": label})
    if not langs:
        raise SettingsError("Keep at least one voice language")
    default = v.get("default_language") if any(lang["code"] == v.get("default_language") for lang in langs) else langs[0]["code"]
    try:
        rate, pitch = float(v.get("rate", 1)), float(v.get("pitch", 1))
    except (TypeError, ValueError):
        raise SettingsError("Voice speed and pitch must be numbers") from None
    new["voice"] = {"enabled": bool(v.get("enabled")), "languages": langs[:10], "default_language": default,
                    "speak_replies": bool(v.get("speak_replies")), "rate": min(max(rate, 0.5), 2.0), "pitch": min(max(pitch, 0.5), 2.0),
                    "auto_listen": bool(v.get("auto_listen", True))}
    return new


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, Any]:
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    current = _merge(DEFAULTS, row.value if row else {})
    new = validate(data, current)
    if row is None:
        session.add(PlatformSetting(key=KEY, value=new, updated_at=utcnow()))
    else:
        row.value, row.updated_at = new, utcnow()
    await session.flush()
    return new
