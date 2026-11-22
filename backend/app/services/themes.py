"""Storefront themes: which theme the shop uses and, per theme, the chosen colour preset and the owner's colour
changes (Admin → Storefront → Theme and layout). The themes themselves (layouts, components, presets) live in the
web app (frontend/src/themes); this module only knows their ids, so adding a theme there means adding its id here.

Stored in the site settings as:
    "theme": "bazaar",
    "theme_settings": {"bazaar": {"preset": "crimson", "colors": {"primary": "#9B1B30"}}, ...}
"""
from __future__ import annotations

import re
from typing import Any

THEMES = ("classic", "bazaar", "fresh", "luxe")
DEFAULT_THEME = "classic"
COLOR_KEYS = ("primary", "primary_dark", "accent", "buy", "success", "page")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
PRESET = re.compile(r"^[a-z0-9_-]{1,24}$")


def clean_theme(value: Any, *, strict: bool = False) -> str:
    """The theme id; an unknown one is refused when saving and read as the default (a theme removed later)."""
    v = str(value or "").strip().lower()
    if v in THEMES:
        return v
    if strict:
        raise ValueError(f"Choose one of the themes: {', '.join(THEMES)}")
    return DEFAULT_THEME


def clean_settings(raw: Any, *, strict: bool = False) -> dict[str, dict]:
    """Per-theme preset and colour changes. Saving refuses a colour that is not a hex value; reading drops it."""
    out: dict[str, dict] = {}
    if not isinstance(raw, dict):
        return out
    for theme_id, value in raw.items():
        if theme_id not in THEMES or not isinstance(value, dict):
            continue
        entry: dict[str, Any] = {}
        preset = str(value.get("preset") or "").strip()
        if preset:
            if PRESET.match(preset):
                entry["preset"] = preset
            elif strict:
                raise ValueError("Choose one of the theme's colour presets")
        colors = value.get("colors") if isinstance(value.get("colors"), dict) else {}
        clean: dict[str, str] = {}
        for k, v in colors.items():
            if k not in COLOR_KEYS or v in (None, ""):
                continue
            if HEX.match(str(v)):
                clean[k] = str(v).upper()
            elif strict:
                raise ValueError(f"Colour '{k}' must be a hex value like #0B5563")
        if clean:
            entry["colors"] = clean
        if entry:
            out[theme_id] = entry
    return out
