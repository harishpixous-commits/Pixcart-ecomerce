"""Admin panel: each staff member's own interface preferences.

Used by the admin shell (frontend ``src/components/admin-shell``): the layout switcher in the admin header and
Admin → My account → Appearance. Every staff member reads and changes only their own preferences; there is no way
to address another person's. The owner's default layout is the marketplace setting ``admin_layout_default``
(Admin → Marketplace settings), used while a staff member has not chosen their own.

Stored in ``users.ui_prefs``:
- ``admin_layout``: "sidebar" | "topnav" | "rail" | "glass", or null to follow the owner's default
- ``nav_collapsed``: names of the menu sections the person folded away (at most 20, each at most 40 characters)
- ``sidebar_collapsed``: the sidebar is folded down to icons

These are personal display settings that change nothing anyone else sees, so they are not written to the audit log.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, StrictBool, field_validator

from app.config import settings
from app.core.deps import AdminUser, SessionDep
from app.models import User
from app.services.platform_settings import ADMIN_LAYOUTS, get_settings

router = APIRouter(prefix="/api/admin/me", tags=["admin-prefs"])

DEFAULT_LAYOUT = "sidebar"
MAX_GROUPS = 20
MAX_GROUP_CHARS = 40


def _clean_groups(raw: Any) -> list[str]:
    """Section names, whitespace tidied, without blanks or repeats; anything invalid is left out."""
    out: list[str] = []
    if not isinstance(raw, list):
        return out
    for name in raw:
        if not isinstance(name, str):
            continue
        name = " ".join(name.split())
        if name and len(name) <= MAX_GROUP_CHARS and name not in out:
            out.append(name)
    return out[:MAX_GROUPS]


def normalize(raw: Any) -> dict[str, Any]:
    """The stored preferences with every field present and valid (old or damaged values fall back to the defaults)."""
    raw = raw if isinstance(raw, dict) else {}
    layout = raw.get("admin_layout")
    return {
        "admin_layout": layout if layout in ADMIN_LAYOUTS else None,
        "nav_collapsed": _clean_groups(raw.get("nav_collapsed")),
        "sidebar_collapsed": raw.get("sidebar_collapsed") is True,
    }


async def default_layout(session) -> str:
    value = (await get_settings(session)).get("admin_layout_default")
    return value if value in ADMIN_LAYOUTS else DEFAULT_LAYOUT


async def prefs_out(session, user: User) -> dict[str, Any]:
    prefs = normalize(user.ui_prefs)
    fallback = await default_layout(session)
    return {
        "ui_prefs": prefs,
        "admin_layout": prefs["admin_layout"] or fallback,  # the layout this person sees
        "default_layout": fallback,  # the owner's default
        "layouts": list(ADMIN_LAYOUTS),
        # shown as a badge in the admin header outside production, so nobody mistakes a test install for the live one
        "environment": settings.environment,
    }


class PrefsIn(BaseModel):
    """Fields left out keep their saved value; unknown fields are dropped. ``admin_layout: null`` goes back to the
    owner's default."""

    model_config = ConfigDict(extra="ignore")

    admin_layout: str | None = None
    nav_collapsed: list[str] | None = None
    sidebar_collapsed: StrictBool | None = None

    @field_validator("admin_layout")
    @classmethod
    def _layout(cls, v: str | None) -> str | None:
        if v is not None and v not in ADMIN_LAYOUTS:
            raise ValueError(f"Choose one of: {', '.join(ADMIN_LAYOUTS)}")
        return v

    @field_validator("nav_collapsed")
    @classmethod
    def _groups(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        if len(v) > MAX_GROUPS:
            raise ValueError(f"At most {MAX_GROUPS} menu sections can be folded")
        out: list[str] = []
        for name in v:
            name = " ".join(name.split())
            if not name or len(name) > MAX_GROUP_CHARS:
                raise ValueError(f"Each menu section name is 1 to {MAX_GROUP_CHARS} characters")
            if name not in out:
                out.append(name)
        return out


@router.get("/preferences")
async def read_preferences(user: AdminUser, session: SessionDep) -> dict:
    return await prefs_out(session, user)


@router.put("/preferences")
async def write_preferences(body: PrefsIn, user: AdminUser, session: SessionDep) -> dict:
    prefs = normalize(user.ui_prefs)
    sent = body.model_fields_set
    if "admin_layout" in sent:
        prefs["admin_layout"] = body.admin_layout
    if "nav_collapsed" in sent:
        prefs["nav_collapsed"] = body.nav_collapsed or []
    if "sidebar_collapsed" in sent:
        prefs["sidebar_collapsed"] = bool(body.sidebar_collapsed)
    user.ui_prefs = prefs  # a new dict, so the JSONB column is saved
    await session.commit()
    return await prefs_out(session, user)
