"""AI settings edited in Admin → AI studio. Stored in platform_settings under the key "ai"."""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings as env
from app.db import utcnow
from app.models import PlatformSetting

KEY = "ai"
MODEL = re.compile(r"^claude-[a-z0-9][a-z0-9.\-]{2,60}$")

# Offered in the model picker; any claude-* id can still be typed for newer models.
MODELS = [
    {"id": "claude-haiku-5-5", "label": "Claude Haiku 5.5 — fastest, lowest cost"},
    {"id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5 — balanced"},
    {"id": "claude-opus-5-5", "label": "Claude Opus 5.5 — most capable"},
]


def defaults() -> dict[str, Any]:
    return {
        "enabled": True,
        "model": env.ai_model,
        "monthly_token_budget": 5_000_000,  # input + output tokens per calendar month (IST); 0 = no limit
        # Prices per million tokens in USD, for the cost estimate only. Update them from the provider's price list.
        "price_input_per_mtok": 1.0,
        "price_output_per_mtok": 5.0,
        "brand_voice": "Warm, clear and respectful of the shopper's time. Simple Indian English.",
        "tasks": {},  # task key -> {"enabled": bool, "instructions": str}
    }


def _merge(saved: dict) -> dict:
    out = defaults()
    for k, v in (saved or {}).items():
        if k in out:
            out[k] = v
    return out


async def get_ai_settings(session: AsyncSession) -> dict:
    row = await session.get(PlatformSetting, KEY)
    return _merge(row.value if row else {})


def task_settings(cfg: dict, task: str) -> dict:
    t = (cfg.get("tasks") or {}).get(task) or {}
    return {"enabled": bool(t.get("enabled", True)), "instructions": str(t.get("instructions", ""))}


def validate(data: dict, task_keys: set[str]) -> dict:
    cfg = _merge(data)
    if not isinstance(cfg["enabled"], bool):
        raise ValueError("enabled must be true or false")
    if not MODEL.match(str(cfg["model"])):
        raise ValueError("Choose a Claude model, e.g. claude-haiku-5-5")
    budget = cfg["monthly_token_budget"]
    if isinstance(budget, bool) or not isinstance(budget, int) or not 0 <= budget <= 2_000_000_000:
        raise ValueError("The monthly token budget must be a whole number (0 for no limit)")
    for k in ("price_input_per_mtok", "price_output_per_mtok"):
        v = cfg[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1000:
            raise ValueError("Prices must be numbers between 0 and 1000")
    cfg["brand_voice"] = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(cfg["brand_voice"]))[:600].strip()
    tasks = {}
    for k, v in (cfg.get("tasks") or {}).items():
        if k not in task_keys or not isinstance(v, dict):
            continue
        tasks[k] = {
            "enabled": bool(v.get("enabled", True)),
            # Extra instructions refine tone and content; they cannot replace the task's fixed safety rules.
            "instructions": re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(v.get("instructions", "")))[:1000].strip(),
        }
    cfg["tasks"] = tasks
    return cfg


async def save_ai_settings(session: AsyncSession, data: dict, task_keys: set[str]) -> dict:
    cfg = validate(data, task_keys)
    row = await session.get(PlatformSetting, KEY)
    if row is None:
        session.add(PlatformSetting(key=KEY, value=cfg, updated_at=utcnow()))
    else:
        row.value, row.updated_at = cfg, utcnow()
    return cfg


def cost_usd(cfg: dict, input_tokens: int, output_tokens: int) -> float:
    return round(input_tokens / 1e6 * float(cfg["price_input_per_mtok"]) + output_tokens / 1e6 * float(cfg["price_output_per_mtok"]), 4)
