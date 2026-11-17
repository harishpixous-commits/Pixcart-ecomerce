"""Admin → Staff: staff accounts, roles and the permission matrix.

Guards against privilege escalation and lock-out:
- only an owner can give out the owner role or change the owner role's members;
- a non-owner can only grant permissions they hold themselves, and cannot edit their own role;
- the owner role is locked to every permission; at least one active owner always remains;
- a role that still has staff cannot be deleted.
"""
from __future__ import annotations

import re
import uuid

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select, update

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, Forbidden, NotFound
from app.core.permissions import CATALOG, OWNER, PERMISSIONS, Perm, invalidate, load_roles, permissions_for, role_code
from app.core.security import hash_password
from app.db import utcnow
from app.models import AdminRole, RefreshSession, User

router = APIRouter(prefix="/api/admin", tags=["staff"])


def _strong(pw: str) -> None:
    if not (re.search(r"[a-z]", pw) and re.search(r"[A-Z]", pw) and re.search(r"\d", pw)):
        raise ApiError("Use upper and lower case letters and a number, at least 12 characters", "weak_password", fields={"password": "Too weak"})


async def _role(session, code: str) -> AdminRole:
    role = await session.get(AdminRole, code)
    if role is None:
        raise NotFound("Role")
    return role


async def _active_owners(session) -> int:
    return (
        await session.execute(
            select(func.count()).select_from(User).where(User.is_admin.is_(True), User.is_active.is_(True), func.coalesce(func.nullif(User.admin_role, ""), OWNER) == OWNER)
        )
    ).scalar_one()


def _is_owner(user: User) -> bool:
    return role_code(user) == OWNER


async def _role_counts(session) -> dict[str, int]:
    rows = (await session.execute(select(User.admin_role, func.count()).where(User.is_admin.is_(True)).group_by(User.admin_role))).all()
    out: dict[str, int] = {}
    for code, n in rows:
        out[code or OWNER] = out.get(code or OWNER, 0) + n
    return out


def _role_out(r: AdminRole, counts: dict[str, int]) -> dict:
    perms = list(PERMISSIONS) if r.code == OWNER else [p for p in PERMISSIONS if p in set(r.permissions or [])]
    return {"code": r.code, "name": r.name, "description": r.description, "permissions": perms, "is_locked": r.is_locked or r.code == OWNER,
            "staff_count": counts.get(r.code, 0), "updated_at": r.updated_at.isoformat() if r.updated_at else None}


@router.get("/permissions")
async def permission_catalog(admin: Perm("staff")) -> dict:
    return {"items": [{"code": p.code, "label": p.label, "group": p.group, "description": p.description, "sensitive": p.sensitive} for p in CATALOG]}


@router.get("/roles")
async def list_roles(admin: Perm("staff"), session: SessionDep) -> dict:
    counts = await _role_counts(session)
    rows = (await session.execute(select(AdminRole).order_by(AdminRole.is_locked.desc(), AdminRole.created_at, AdminRole.name))).scalars()
    return {"items": [_role_out(r, counts) for r in rows]}


class RoleIn(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    description: str = Field(default="", max_length=300)
    permissions: list[str] = Field(default_factory=list, max_length=len(PERMISSIONS))


def _clean_permissions(admin: User, wanted: list[str]) -> list[str]:
    unknown = [p for p in wanted if p not in PERMISSIONS]
    if unknown:
        raise ApiError(f"Unknown permission: {', '.join(unknown)}", "unknown_permission")
    if not _is_owner(admin):
        mine = permissions_for(admin)
        extra = [p for p in wanted if p not in mine]
        if extra:
            raise Forbidden(f"You can only give permissions you have yourself (not: {', '.join(extra)})")
    if "dashboard" not in wanted:
        wanted = ["dashboard", *wanted]  # every staff member needs the overview to sign in
    return [p for p in PERMISSIONS if p in set(wanted)]


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:32] or "role"


@router.post("/roles", status_code=201)
async def create_role(body: RoleIn, admin: Perm("staff"), session: SessionDep) -> dict:
    perms = _clean_permissions(admin, body.permissions)
    name = " ".join(body.name.split())
    if (await session.execute(select(AdminRole.code).where(func.lower(AdminRole.name) == name.lower()))).first():
        raise Conflict("A role with this name already exists", "role_exists")
    code, n = _slug(name), 2
    while await session.get(AdminRole, code):
        code, n = f"{_slug(name)[:30]}_{n}", n + 1
    now = utcnow()
    role = AdminRole(code=code, name=name, description=body.description.strip(), permissions=perms, is_locked=False, created_at=now, updated_at=now)
    session.add(role)
    audit(session, admin, "role.create", "role", code, ",".join(perms))
    await session.commit()
    invalidate()
    return _role_out(role, {})


@router.put("/roles/{code}")
async def update_role(code: str, body: RoleIn, admin: Perm("staff"), session: SessionDep) -> dict:
    role = await _role(session, code)
    if role.is_locked or role.code == OWNER:
        raise Conflict("The owner role always has every permission and cannot be edited", "role_locked")
    if role_code(admin) == code and not _is_owner(admin):
        raise Forbidden("You cannot change your own role's permissions")
    perms = _clean_permissions(admin, body.permissions)
    name = " ".join(body.name.split())
    clash = (await session.execute(select(AdminRole.code).where(func.lower(AdminRole.name) == name.lower(), AdminRole.code != code))).first()
    if clash:
        raise Conflict("A role with this name already exists", "role_exists")
    before = set(role.permissions or [])
    role.name, role.description, role.permissions, role.updated_at = name, body.description.strip(), perms, utcnow()
    added, removed = sorted(set(perms) - before), sorted(before - set(perms))
    audit(session, admin, "role.update", "role", code, f"+{','.join(added)} -{','.join(removed)}")
    await session.commit()
    invalidate()
    return _role_out(role, await _role_counts(session))


@router.delete("/roles/{code}")
async def delete_role(code: str, admin: Perm("staff"), session: SessionDep) -> dict:
    role = await _role(session, code)
    if role.is_locked or role.code == OWNER:
        raise Conflict("The owner role cannot be deleted", "role_locked")
    count = (await _role_counts(session)).get(code, 0)
    if count:
        raise Conflict(f"{count} staff member(s) still have this role. Move them to another role first.", "role_in_use")
    await session.delete(role)
    audit(session, admin, "role.delete", "role", code, role.name)
    await session.commit()
    invalidate()
    return {"ok": True}


# ----------------------------------------------------------------------------- staff


@router.get("/staff")
async def list_staff(admin: Perm("staff"), session: SessionDep) -> dict:
    roles = await load_roles(session, force=True)
    names = {r.code: r.name for r in (await session.execute(select(AdminRole))).scalars()}
    rows = (await session.execute(select(User).where(User.is_admin.is_(True)).order_by(User.created_at))).scalars()
    return {
        "can_manage_owners": _is_owner(admin),
        "roles": [{"code": c, "name": names.get(c, c)} for c in roles],
        "items": [
            {"id": str(u.id), "name": u.name, "email": u.email, "role": role_code(u), "role_name": names.get(role_code(u), "Missing role"),
             "is_active": u.is_active, "is_you": u.id == admin.id, "totp_enabled": u.totp_enabled,
             "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None, "created_at": u.created_at.isoformat()}
            for u in rows
        ],
    }


class StaffIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=2, max_length=120)
    role: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=12, max_length=200)


class StaffPatch(BaseModel):
    role: str | None = Field(default=None, max_length=40)
    is_active: bool | None = None
    name: str | None = Field(default=None, min_length=2, max_length=120)
    reset_two_step: bool = False


async def _check_assignable(admin: User, session, code: str) -> None:
    await _role(session, code)
    if code == OWNER and not _is_owner(admin):
        raise Forbidden("Only an owner can make someone an owner")
    if not _is_owner(admin):
        roles = await load_roles(session)
        extra = roles.get(code, set()) - permissions_for(admin)
        if extra:
            raise Forbidden("You can only give a role whose permissions you have yourself")


@router.post("/staff", status_code=201)
async def add_staff(body: StaffIn, admin: Perm("staff"), session: SessionDep) -> dict:
    _strong(body.password)
    await _check_assignable(admin, session, body.role)
    email = body.email.lower()
    if (await session.execute(select(User.id).where(User.email == email))).first():
        raise Conflict("An account with this email already exists", "email_taken")
    u = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password), is_admin=True, admin_role=body.role)
    session.add(u)
    await session.flush()
    audit(session, admin, "staff.create", "user", u.id, f"{email} as {body.role}")
    await session.commit()
    return {"id": str(u.id)}


@router.patch("/staff/{user_id}")
async def edit_staff(user_id: uuid.UUID, body: StaffPatch, admin: Perm("staff"), session: SessionDep) -> dict:
    u = await session.get(User, user_id)
    if u is None or not u.is_admin:
        raise NotFound("Staff member")
    if role_code(u) == OWNER and not _is_owner(admin):
        raise Forbidden("Only an owner can change another owner")
    if u.id == admin.id and (body.is_active is False or (body.role and body.role != role_code(admin))):
        raise Conflict("You cannot change your own role or deactivate yourself", "self_lockout")
    changes = []
    if body.role and body.role != role_code(u):
        await _check_assignable(admin, session, body.role)
        changes.append(f"role {role_code(u)}→{body.role}")
        u.admin_role = body.role
    if body.name:
        u.name = body.name.strip()
        changes.append("name")
    if body.reset_two_step:
        if not _is_owner(admin):
            raise Forbidden("Only an owner can reset two-step sign-in")
        u.totp_enabled, u.totp_secret_enc = False, None
        changes.append("two-step reset")
    if body.is_active is not None and body.is_active != u.is_active:
        u.is_active = body.is_active
        changes.append("activated" if body.is_active else "deactivated")
    if body.is_active is False or body.reset_two_step:
        # Sign them out everywhere. Role changes need no sign-out: permissions are read on every request.
        await session.execute(update(RefreshSession).where(RefreshSession.user_id == u.id, RefreshSession.revoked_at.is_(None)).values(revoked_at=utcnow()))
    await session.flush()
    if await _active_owners(session) == 0:
        raise Conflict("At least one active owner is needed", "last_owner")
    audit(session, admin, "staff.update", "user", u.id, "; ".join(changes) or "no change")
    await session.commit()
    return {"ok": True}
