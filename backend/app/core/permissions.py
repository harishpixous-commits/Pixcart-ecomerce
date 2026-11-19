"""Staff roles and permissions for the admin panel.

Every admin endpoint asks for one permission (``Perm("orders")``). A staff member has one role; a
role is a named set of permissions stored in ``admin_roles`` and edited in Admin → Staff → Roles.

- ``CATALOG`` lists every permission with a label and a group for the permission matrix.
- ``DEFAULT_ROLES`` seeds the table (migration 0004). The owner role is locked to every permission.
- Roles are cached in memory for a few seconds; ``invalidate()`` runs after every change.
"""

import time
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SessionDep, admin_user
from app.core.errors import Forbidden
from app.models import User


@dataclass(frozen=True)
class PermissionDef:
    code: str
    label: str
    group: str
    description: str
    sensitive: bool = False  # shown with a warning in the role editor


CATALOG: tuple[PermissionDef, ...] = (
    PermissionDef("dashboard", "Overview", "General", "Dashboard, KPIs and the go-live checklist."),
    PermissionDef("assistant", "AI assistant: chat", "AI assistant", "Ask questions in chat. It only reads data this role can see."),
    PermissionDef("assistant_actions", "AI assistant: make changes", "AI assistant", "Let the assistant prepare changes (approve, cancel, coupons…). Each one still needs Confirm.", sensitive=True),
    PermissionDef("assistant_files", "AI assistant: analyse files", "AI assistant", "Upload spreadsheets to analyse and compare with live data."),
    PermissionDef("assistant_voice", "AI assistant: voice", "AI assistant", "Talk to the assistant and hear spoken answers."),
    PermissionDef("ai_providers", "AI providers and models", "Administration", "Connect LLM providers, API keys and fallbacks.", sensitive=True),
    PermissionDef("sellers", "Sellers", "Marketplace", "KYC review, approve, suspend, commission."),
    PermissionDef("catalog", "Catalogue", "Marketplace", "Listings, categories and review moderation."),
    PermissionDef("orders", "Orders and returns", "Operations", "Orders, cancellations, deliveries and returns."),
    PermissionDef("delivery", "Delivery fleet", "Operations", "Delivery partners, KYC, zones, assignment, live tracking, cash and payouts."),
    PermissionDef("customers", "Customers", "Operations", "Customer accounts, block and unblock."),
    PermissionDef("support", "Support desk", "Operations", "Tickets and grievances."),
    PermissionDef("refunds", "Refunds", "Money", "Retry and complete refunds.", sensitive=True),
    PermissionDef("payouts", "Seller payouts", "Money", "Run payouts, bank files, mark paid.", sensitive=True),
    PermissionDef("reports", "Reports and exports", "Money", "GST TCS report and data exports."),
    PermissionDef("marketing", "Marketing and storefront", "Growth", "Coupons, storefront, pages and message templates."),
    PermissionDef("settings", "Marketplace settings", "Administration", "Fees, COD, tax rates, features and AI studio."),
    PermissionDef("integrations", "Integrations and API keys", "Administration", "Payment, SMS, email, shipping and AI keys.", sensitive=True),
    PermissionDef("staff", "Staff and roles", "Administration", "Add staff, change roles, edit permissions.", sensitive=True),
    PermissionDef("audit", "Audit log", "Administration", "Who changed what, and when."),
    PermissionDef("shop_assistant", "Shop assistant: settings", "Shop assistant (website chat)",
                  "Switch the customer chat on or off, choose its features, AI use, voice, limits and budget."),
    PermissionDef("shop_assistant_kb", "Shop assistant: help articles", "Shop assistant (website chat)",
                  "Write, publish and hide the help articles the customer chat answers from."),
    PermissionDef("shop_assistant_chats", "Shop assistant: customer chats", "Shop assistant (website chat)",
                  "Read customers' chats with the website assistant, ratings and statistics.", sensitive=True),
)
PERMISSIONS: tuple[str, ...] = tuple(p.code for p in CATALOG)
OWNER = "owner"

DEFAULT_ROLES: dict[str, tuple[str, str, set[str]]] = {
    OWNER: ("Owner", "Full access, including keys, staff and roles. Cannot be edited.", set(PERMISSIONS)),
    "operations": ("Operations", "Day-to-day orders, sellers, customers and support.",
                   {"dashboard", "assistant", "assistant_actions", "assistant_files", "assistant_voice", "sellers", "orders", "refunds", "customers", "support", "audit",
                    "shop_assistant_kb", "shop_assistant_chats", "delivery"}),
    "catalog": ("Catalogue manager", "Listings, categories, reviews and storefront.", {"dashboard", "assistant", "catalog", "marketing"}),
    "finance": ("Finance", "Payouts, refunds, TCS and exports.", {"dashboard", "assistant", "assistant_files", "assistant_voice", "payouts", "refunds", "reports", "orders", "audit"}),
    "support": ("Customer support", "Tickets, orders and customers.", {"dashboard", "assistant", "orders", "support", "customers", "shop_assistant_kb", "shop_assistant_chats"}),
    "marketing": ("Marketing", "Coupons, storefront and catalogue.", {"dashboard", "assistant", "marketing", "catalog", "shop_assistant_kb"}),
}

_TTL = 10.0
_roles: dict[str, set[str]] = {}
_names: dict[str, str] = {}
_loaded_at = 0.0


def invalidate() -> None:
    global _loaded_at
    _loaded_at = 0.0


async def load_roles(session: AsyncSession, *, force: bool = False) -> dict[str, set[str]]:
    global _roles, _names, _loaded_at
    from app.config import settings

    if not force and _roles and settings.environment != "test" and time.monotonic() - _loaded_at < _TTL:
        return _roles
    from app.models import AdminRole

    rows = list((await session.execute(select(AdminRole))).scalars())
    if not rows:
        rows = await _seed(session)
    roles = {r.code: (set(PERMISSIONS) if r.code == OWNER else set(r.permissions or []) & set(PERMISSIONS)) for r in rows}
    roles.setdefault(OWNER, set(PERMISSIONS))
    _roles, _names = roles, {r.code: r.name for r in rows}
    _loaded_at = time.monotonic()
    return _roles


async def _seed(session: AsyncSession) -> list:
    """Creates the starting roles when the table is empty (a new or wiped database)."""
    from app.db import utcnow
    from app.models import AdminRole

    now = utcnow()
    rows = [
        AdminRole(code=code, name=name, description=desc, permissions=[p for p in PERMISSIONS if p in perms], is_locked=code == OWNER, created_at=now, updated_at=now)
        for code, (name, desc, perms) in DEFAULT_ROLES.items()
    ]
    session.add_all(rows)
    await session.commit()  # runs before the endpoint body, so nothing else is pending
    return rows


def role_code(user: User) -> str:
    return user.admin_role or OWNER  # admins created before roles existed are owners


def role_name(code: str) -> str:
    return _names.get(code) or DEFAULT_ROLES.get(code, (code.replace("_", " ").title(),))[0]


def permissions_for(user: User) -> set[str]:
    """Permissions of an admin. ``require`` loads the roles first, so this is current inside a request."""
    if not user.is_admin:
        return set()
    code = role_code(user)
    if code in _roles:
        return _roles[code]
    if code in DEFAULT_ROLES and not _roles:
        return DEFAULT_ROLES[code][2]
    return set()  # a role that was deleted grants nothing


def require(permission: str):
    if permission not in PERMISSIONS:
        raise ValueError(f"Unknown permission {permission}")

    # No postponed annotations in this module's dependency: FastAPI must see real types on _dep.
    async def _dep(user: Annotated[User, Depends(admin_user)], session: SessionDep) -> User:
        await load_roles(session)
        if permission not in permissions_for(user):
            raise Forbidden(f"Your role does not allow this ({permission})")
        return user

    return _dep


def Perm(permission: str):  # noqa: N802 — reads like a type in signatures
    return Annotated[User, Depends(require(permission))]
