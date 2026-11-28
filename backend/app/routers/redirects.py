"""URL redirects: staff map an old address to a new one. The shop asks here when a page is not found and, if there is a
match, sends the visitor on. Existing pages are never overridden, so a redirect can only fill a gap."""
from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.permissions import Perm
from app.models import UrlRedirect
from app.services.cms import SAFE_HREF

router = APIRouter(prefix="/api", tags=["redirects"])
FROM_OK = re.compile(r"^/[A-Za-z0-9\-_/.%]*$")
RESERVED = ("/api", "/admin", "/seller", "/delivery", "/checkout")
MAX_RULES = 500


def norm_from(v: str) -> str:
    v = v.strip().split("?")[0].split("#")[0]
    if len(v) > 1:
        v = v.rstrip("/")
    return v.lower()


class RedirectIn(BaseModel):
    from_path: str = Field(min_length=1, max_length=300)
    to_path: str = Field(min_length=1, max_length=500)
    status_code: int = Field(default=301)
    is_active: bool = True


def _out(r: UrlRedirect) -> dict:
    return {"id": str(r.id), "from_path": r.from_path, "to_path": r.to_path, "status_code": r.status_code, "is_active": r.is_active, "hits": r.hits}


async def _check(session, body: RedirectIn, but: uuid.UUID | None = None) -> tuple[str, str]:
    src, dst = norm_from(body.from_path), body.to_path.strip()
    if body.status_code not in (301, 302):
        raise ApiError("Use 301 (permanent) or 302 (temporary)", "bad_status", status_code=422)
    if not FROM_OK.match(src) or src == "/":
        raise ApiError("The old address must start with / and look like /old-page", "bad_from", status_code=422)
    if src.startswith(RESERVED):
        raise ApiError("Admin, seller, delivery, checkout and API addresses cannot be redirected", "reserved_from", status_code=422)
    if not SAFE_HREF.match(dst):
        raise ApiError("The new address must start with / or https://", "bad_to", status_code=422)
    if norm_from(dst) == src:
        raise ApiError("The old and new address are the same", "same_address", status_code=422)
    if dst.startswith("/"):
        back = (await session.execute(select(UrlRedirect.id).where(UrlRedirect.from_path == norm_from(dst), UrlRedirect.to_path.in_([src, src + "/"]), UrlRedirect.is_active.is_(True)))).first()
        if back is not None:
            raise ApiError("That would send visitors in a circle with an existing redirect", "redirect_loop", status_code=422)
    stmt = select(UrlRedirect.id).where(UrlRedirect.from_path == src)
    if but:
        stmt = stmt.where(UrlRedirect.id != but)
    if (await session.execute(stmt)).first() is not None:
        raise Conflict("There is already a redirect for that old address", "redirect_exists")
    return src, dst


@router.get("/admin/redirects")
async def admin_redirects(admin: Perm("marketing"), session: SessionDep) -> dict:
    rows = (await session.execute(select(UrlRedirect).order_by(UrlRedirect.from_path))).scalars().all()
    return {"items": [_out(r) for r in rows]}


@router.post("/admin/redirects", status_code=201)
async def create_redirect(body: RedirectIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    if (await session.execute(select(func.count()).select_from(UrlRedirect))).scalar_one() >= MAX_RULES:
        raise ApiError(f"You can keep up to {MAX_RULES} redirects. Delete old ones first.", "too_many", status_code=422)
    src, dst = await _check(session, body)
    r = UrlRedirect(from_path=src, to_path=dst, status_code=body.status_code, is_active=body.is_active)
    session.add(r)
    audit(session, admin, "redirect.create", "redirect", src)
    await session.commit()
    return _out(r)


@router.put("/admin/redirects/{redirect_id}")
async def edit_redirect(redirect_id: uuid.UUID, body: RedirectIn, admin: Perm("marketing"), session: SessionDep) -> dict:
    r = await session.get(UrlRedirect, redirect_id)
    if r is None:
        raise NotFound("Redirect")
    src, dst = await _check(session, body, r.id)
    r.from_path, r.to_path, r.status_code, r.is_active = src, dst, body.status_code, body.is_active
    audit(session, admin, "redirect.edit", "redirect", src)
    await session.commit()
    return _out(r)


@router.delete("/admin/redirects/{redirect_id}")
async def delete_redirect(redirect_id: uuid.UUID, admin: Perm("marketing"), session: SessionDep) -> dict:
    r = await session.get(UrlRedirect, redirect_id)
    if r is None:
        raise NotFound("Redirect")
    audit(session, admin, "redirect.delete", "redirect", r.from_path)
    await session.delete(r)
    await session.commit()
    return {"ok": True}


@router.get("/catalog/redirect")
async def resolve_redirect(session: SessionDep, path: str = Query(max_length=300)) -> dict:
    """Where an old address now lives (404 when there is no rule). The shop calls this from its page-not-found screen."""
    r = (await session.execute(select(UrlRedirect).where(UrlRedirect.from_path == norm_from(path), UrlRedirect.is_active.is_(True)))).scalar_one_or_none()
    if r is None:
        raise NotFound("Redirect")
    r.hits += 1
    await session.commit()
    return {"to": r.to_path, "status": r.status_code}
