"""Ratings and reviews settings, edited in Admin → Reviews → Settings. Stored in ``platform_settings['reviews']``.

The defaults follow common Indian marketplace practice and BIS IS 19000:2022 (online consumer reviews):
only signed-in customers write, verified buyers by default, photos and videos must be the reviewer's own,
anyone can read, and reports from customers send a review back to staff.
The on/off switch for reviews and "hold every review for moderation" stay in marketplace settings
(``feature_reviews`` and ``reviews_need_approval``).
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

KEY = "reviews"

DEFAULT_TOPICS: list[dict] = [
    {"name": "Quality", "words": ["quality", "build", "material", "durable", "sturdy", "flimsy", "premium"]},
    {"name": "Value for money", "words": ["value", "worth", "money", "price", "expensive", "costly", "overpriced"]},
    {"name": "Effectiveness", "words": ["effective", "works", "working", "result", "results", "useless", "not working"]},
    {"name": "Size and fit", "words": ["size", "fit", "fits", "fitting", "tight", "loose"]},
    {"name": "Taste", "words": ["taste", "tasty", "flavour", "flavor", "aroma", "fresh"]},
    {"name": "Fragrance", "words": ["smell", "fragrance", "scent", "odour", "odor"]},
    {"name": "Comfort", "words": ["comfort", "comfortable", "soft", "smooth"]},
    {"name": "Colour and look", "words": ["colour", "color", "look", "looks", "design", "shade"]},
    {"name": "Packaging", "words": ["packaging", "packed", "package", "leak", "leaked", "seal", "damaged"]},
    {"name": "Delivery", "words": ["delivery", "delivered", "late", "on time", "courier"]},
]

DEFAULT_GUIDELINES = (
    "Tell other shoppers about the product: how you used it, what you liked and what could be better. "
    "Share only your own honest experience; reviews written in return for money, free products or discounts are not allowed. "
    "Photos and videos must be your own and show the product. "
    "Do not include phone numbers, email addresses, links, other people's details or offensive language."
)

REPORT_REASONS: dict[str, str] = {
    "spam": "Spam or advertising",
    "fake": "Fake or paid review",
    "offensive": "Offensive or abusive",
    "not_product": "Not about this product",
    "personal": "Shares personal information",
    "wrong_media": "Photos or videos are not of this product",
    "other": "Something else",
}

DEFAULTS: dict[str, Any] = {
    "buyers_only": True,           # only customers whose order was delivered (otherwise: any signed-in customer)
    "media_need_approval": False,  # photos and videos wait for staff before anyone else sees them
    "photos": True,
    "max_photos": 5,
    "videos": True,
    "max_video_mb": 30,
    "media_public": True,          # visitors who are not signed in also see customer photos and videos
    "report_hide_at": 3,           # this many reports hide a review until staff check it; 0 = never
    "seller_can_report": True,     # sellers can flag reviews of their products to staff
    "min_body_chars": 0,           # shortest review text accepted (0 = a star rating alone is fine)
    "topics_enabled": True,        # "What customers talk about" chips with counts
    "topics": DEFAULT_TOPICS,
    "guidelines": DEFAULT_GUIDELINES,
}

_INTS = {"max_photos": (0, 10), "max_video_mb": (5, 100), "report_hide_at": (0, 50), "min_body_chars": (0, 500)}
_WORD = re.compile(r"^[\w' -]{2,30}$")


class ReviewSettingsError(ValueError):
    pass


async def get(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    out = dict(DEFAULTS)
    if row:
        out.update({k: v for k, v in (row.value or {}).items() if k in DEFAULTS})
    return out


def _topics(v: Any) -> list[dict]:
    if not isinstance(v, list) or len(v) > 20:
        raise ReviewSettingsError("Add at most 20 topics")
    out = []
    for t in v:
        if not isinstance(t, dict):
            raise ReviewSettingsError("Each topic needs a name and words")
        name = str(t.get("name", "")).strip()
        if not 2 <= len(name) <= 30:
            raise ReviewSettingsError("Topic names are 2 to 30 characters")
        words = [str(w).strip().lower() for w in (t.get("words") or []) if str(w).strip()]
        if not words or len(words) > 20:
            raise ReviewSettingsError(f"Give '{name}' between 1 and 20 words")
        bad = [w for w in words if not _WORD.match(w)]
        if bad:
            raise ReviewSettingsError(f"Use letters, numbers and spaces only in topic words ('{bad[0]}')")
        out.append({"name": name, "words": list(dict.fromkeys(words))})
    return out


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in DEFAULTS:
            raise ReviewSettingsError(f"Unknown setting: {k}")
        if k in _INTS:
            lo, hi = _INTS[k]
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise ReviewSettingsError(f"{k} must be a whole number between {lo} and {hi}")
        elif k == "topics":
            v = _topics(v)
        elif k == "guidelines":
            if not isinstance(v, str) or len(v) > 2000:
                raise ReviewSettingsError("Keep the guidelines under 2,000 characters")
            v = v.strip()
        elif not isinstance(v, bool):
            raise ReviewSettingsError(f"{k} must be on or off")
        clean[k] = v
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


def public(cfg: dict[str, Any]) -> dict[str, Any]:
    """What the storefront needs to know (no internal thresholds)."""
    return {
        "buyers_only": cfg["buyers_only"], "photos": cfg["photos"] and cfg["max_photos"] > 0, "max_photos": cfg["max_photos"],
        "videos": cfg["videos"], "max_video_mb": cfg["max_video_mb"], "media_public": cfg["media_public"],
        "min_body_chars": cfg["min_body_chars"], "guidelines": cfg["guidelines"], "report_reasons": REPORT_REASONS,
    }


def topic_pattern(words: list[str]) -> str:
    """A PostgreSQL case-insensitive regular expression matching any of the words as whole words."""
    return r"\m(" + "|".join(re.sub(r"[^\w' -]", "", w) for w in words) + r")\M"


def topic_regex(words: list[str]) -> re.Pattern:
    return re.compile(r"\b(" + "|".join(re.escape(w) for w in words) + r")\b", re.IGNORECASE)
