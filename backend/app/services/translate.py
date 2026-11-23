"""The site in other languages: every piece of interface text, translated once and kept.

Pages send the text they show (button labels, headings, messages) in batches. Known lines come from the
``translations`` table; new ones are translated by the AI ("translate" route in Admin → AI providers) when the admin
allows it, within a daily limit, and saved. Staff can correct any line (origin "manual"), and a correction is never
overwritten. Without an AI model, untranslated lines simply stay in English.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import Translation

log = logging.getLogger("pixcart.translate")

MAX_TEXTS = 80          # per request
MAX_LEN = 400           # longer text (descriptions, reviews) is not interface text
AI_BATCH = 40

LANG_NAMES = {
    "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "kn": "Kannada", "ml": "Malayalam", "mr": "Marathi", "bn": "Bengali",
    "gu": "Gujarati", "pa": "Punjabi", "or": "Odia", "as": "Assamese", "ur": "Urdu", "ar": "Arabic", "fr": "French",
    "de": "German", "es": "Spanish", "pt": "Portuguese", "pt-BR": "Brazilian Portuguese", "it": "Italian", "nl": "Dutch",
    "ru": "Russian", "tr": "Turkish", "zh": "Simplified Chinese", "zh-TW": "Traditional Chinese", "ja": "Japanese",
    "ko": "Korean", "id": "Indonesian", "ms": "Malay", "th": "Thai", "vi": "Vietnamese", "fil": "Filipino", "si": "Sinhala",
    "ne": "Nepali", "sw": "Swahili", "fa": "Persian", "he": "Hebrew", "pl": "Polish", "uk": "Ukrainian", "sv": "Swedish",
}

LETTER = re.compile(r"[^\W\d_]", re.UNICODE)


def key(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def worth_translating(text: str) -> bool:
    t = text.strip()
    return 0 < len(t) <= MAX_LEN and bool(LETTER.search(t))


_BUILTIN: dict[str, dict[str, str]] = {}
BUILTIN_DIR = Path(__file__).resolve().parent.parent / "assets" / "i18n"


def builtin(lang: str) -> dict[str, str]:
    """Translations that ship with the site (Tamil and Hindi for the main screens), used when no line is saved."""
    if lang not in _BUILTIN:
        f = BUILTIN_DIR / f"{lang}.json"
        try:
            _BUILTIN[lang] = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
        except ValueError:
            _BUILTIN[lang] = {}
    return _BUILTIN[lang]


async def lookup(session: AsyncSession, lang: str, texts: list[str]) -> dict[str, str]:
    """Saved lines (AI or staff) first, then the built-in ones."""
    if not texts:
        return {}
    hashes = {key(t): t for t in texts}
    rows = (await session.execute(select(Translation.source_hash, Translation.text).where(
        Translation.lang == lang, Translation.source_hash.in_(list(hashes))))).all()
    found = {hashes[h]: text for h, text in rows if h in hashes}
    ship = builtin(lang)
    for t in texts:
        if t not in found and t in ship:
            found[t] = ship[t]
    return found


async def _ai_used_today(session: AsyncSession) -> int:
    since = utcnow() - timedelta(days=1)
    return int((await session.execute(select(func.count()).select_from(Translation).where(
        Translation.origin == "ai", Translation.created_at >= since))).scalar_one())


RULES = """You translate the interface text of an Indian online marketplace (shop, seller hub, delivery app, admin panel).
Translate each string in the JSON array into {language}. Rules:
- Return ONLY a JSON array of strings, the same length and order as the input. No notes.
- Keep it short and natural, as a native app in {language} would say it. Use the polite form for customers.
- Keep unchanged: brand names (PixCart, Razorpay, Google Pay, PhonePe, Paytm, UPI, GST, GSTIN, OTP, COD, UPI ID), numbers,
  amounts, currency symbols, codes, email addresses, web addresses, emoji and placeholders like {{name}}, {0} or %s.
- Keep leading and trailing punctuation (… : · ?), and keep words in CAPITALS as they are when they are codes.
- If a string is already in {language}, or is a name or code that should not change, return it unchanged."""


async def _ai_translate(session: AsyncSession, lang: str, texts: list[str]) -> dict[str, str]:
    from app.llm import router as llm_router

    language = LANG_NAMES.get(lang, lang)
    out: dict[str, str] = {}
    for i in range(0, len(texts), AI_BATCH):
        chunk = texts[i:i + AI_BATCH]
        turn, _ = await llm_router.complete(session, "translate", system=[{"type": "text", "text": RULES.format(language=language), "cache": True}],
                                            user=json.dumps(chunk, ensure_ascii=False), max_tokens=4000)
        raw = "".join(b.get("text", "") for b in turn.content if b.get("type") == "text").strip()
        raw = raw[raw.find("["): raw.rfind("]") + 1] if "[" in raw else raw
        try:
            got = json.loads(raw)
        except ValueError:
            log.warning("translation to %s: the model did not answer with a JSON array", lang)
            continue
        if not isinstance(got, list) or len(got) != len(chunk):
            log.warning("translation to %s: %s strings back for %s", lang, len(got) if isinstance(got, list) else "no", len(chunk))
            continue
        for src, tr in zip(chunk, got, strict=True):
            if isinstance(tr, str) and tr.strip() and len(tr) <= MAX_LEN * 3:
                out[src] = tr
    return out


async def save(session: AsyncSession, lang: str, pairs: dict[str, str], origin: str) -> None:
    """Keeps translations. AI lines never replace existing ones; staff corrections ("manual") always do."""
    if not pairs:
        return
    now = utcnow()
    rows = [{"id": uuid.uuid4(), "lang": lang, "source_hash": key(s), "source": s, "text": t, "origin": origin,
             "created_at": now, "updated_at": now} for s, t in pairs.items()]
    stmt = insert(Translation).values(rows)
    if origin == "manual":
        stmt = stmt.on_conflict_do_update(constraint="uq_translations_lang_source",
                                          set_={"text": stmt.excluded.text, "origin": "manual", "updated_at": now})
    else:
        stmt = stmt.on_conflict_do_nothing(constraint="uq_translations_lang_source")
    await session.execute(stmt)


async def translate(session: AsyncSession, cfg: dict[str, Any], lang: str, texts: list[str]) -> dict[str, str]:
    """Known translations, plus new ones from the AI when allowed. Unknown lines are left out (they stay English)."""
    enabled = {x["code"] for x in cfg["languages"] if x["enabled"]}
    if lang == "en" or lang not in enabled:
        raise ApiError("That language is not switched on", "language_off", 404)
    texts = list(dict.fromkeys(t for t in texts if isinstance(t, str) and worth_translating(t)))[:MAX_TEXTS]
    found = await lookup(session, lang, texts)
    missing = [t for t in texts if t not in found]
    if missing and cfg.get("ai_translate"):
        from app.ai.client import configured

        budget = int(cfg.get("ai_translate_daily_max") or 0) - await _ai_used_today(session)
        if budget > 0 and await configured(session, "translate"):
            try:
                new = await _ai_translate(session, lang, missing[:budget])
            except ApiError as exc:  # no model answered: keep English for now
                log.warning("translation to %s failed: %s", lang, exc)
                new = {}
            await save(session, lang, new, "ai")
            await session.commit()
            found.update(new)
    return found
