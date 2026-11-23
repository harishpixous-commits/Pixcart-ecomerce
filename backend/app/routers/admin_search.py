"""Admin panel: one search box for records (Quick find, Ctrl+K in the admin header).

``GET /api/admin/search?q=`` looks for orders, customers, sellers, listings (by title, brand or SKU), delivery
partners, support tickets and seller payouts at once, and returns a few of each, newest first. It only searches
what the caller's role can open: a support agent never gets payouts back, a catalogue manager never gets
customers. Each result carries the admin page that opens it.

Phone numbers and email addresses are shown masked (last digits only); the full details are on the record's
own page, behind the same permission. Searching changes nothing, so it is not written to the audit log.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable
from inspect import isfunction
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import ColumnElement, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import AdminUser, SessionDep
from app.core.permissions import load_roles, permissions_for
from app.models import DeliveryBoy, Order, Payout, Product, Seller, SupportTicket, User, Variant

router = APIRouter(prefix="/api/admin", tags=["admin-search"])

Kind = Literal["order", "customer", "seller", "product", "partner", "ticket", "payout"]
PER_KIND = 5
MIN_CHARS = 2
MAX_WORDS = 6


class Found(BaseModel):
    kind: Kind
    id: str
    title: str
    sub: str
    href: str


class SearchOut(BaseModel):
    q: str
    results: list[Found]


def like(text: str) -> str:
    """A case-insensitive "contains" pattern; % and _ typed by the user are matched literally."""
    return "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def matches(words: list[str], *fields) -> ColumnElement[bool]:
    """Every word appears in at least one of the fields ("vitamin serum" finds "Vitamin C Face Serum")."""
    return and_(*(or_(*(f(w) if isfunction(f) else f.ilike(like(w)) for f in fields)) for w in words))


def mask_phone(phone: str | None) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return f"•••• {digits[-4:]}" if len(digits) >= 4 else ""


def mask_email(email: str | None) -> str:
    if not email or "@" not in email:
        return ""
    name, domain = email.split("@", 1)
    return f"{name[:1]}•••@{domain}"


def _dot(*parts: str) -> str:
    return " · ".join(p for p in parts if p)


def _inr(paise: int) -> str:
    rupees, p = divmod(int(paise or 0), 100)
    return f"₹{rupees:,}" + (f".{p:02d}" if p else "")


async def _orders(s: AsyncSession, words: list[str]) -> list[Found]:
    rows = (await s.execute(
        select(Order, User.name).join(User, User.id == Order.user_id)
        .where(matches(words, Order.number, User.name, User.phone))
        .order_by(Order.created_at.desc()).limit(PER_KIND)
    )).all()
    return [Found(kind="order", id=str(o.id), title=o.number, sub=_dot(name, o.status.replace("_", " "), _inr(o.grand_total)),
                  href=f"/admin/orders/{o.id}") for o, name in rows]


async def _customers(s: AsyncSession, words: list[str]) -> list[Found]:
    is_seller = exists().where(Seller.user_id == User.id)
    rows = (await s.execute(
        select(User).where(User.deleted_at.is_(None), User.is_admin.is_(False), ~is_seller,
                           matches(words, User.name, User.phone, User.email))
        .order_by(User.created_at.desc()).limit(PER_KIND)
    )).scalars().all()
    return [Found(kind="customer", id=str(u.id), title=u.name or "Customer without a name",
                  sub=_dot(mask_phone(u.phone), mask_email(u.email), "" if u.is_active else "blocked"),
                  href=f"/admin/customers/{u.id}") for u in rows]


async def _sellers(s: AsyncSession, words: list[str]) -> list[Found]:
    rows = (await s.execute(
        select(Seller).where(matches(words, Seller.display_name, Seller.legal_name, Seller.gstin, Seller.contact_phone, Seller.contact_email))
        .order_by(Seller.created_at.desc()).limit(PER_KIND)
    )).scalars().all()
    return [Found(kind="seller", id=str(x.id), title=x.display_name, sub=_dot(x.legal_name, x.pickup_city, x.status),
                  href=f"/admin/sellers/{x.id}") for x in rows]


async def _products(s: AsyncSession, words: list[str]) -> list[Found]:
    def by_sku(w: str) -> ColumnElement[bool]:
        return exists().where(Variant.product_id == Product.id, Variant.sku.ilike(like(w)))
    rows = (await s.execute(
        select(Product, Seller.display_name).join(Seller, Seller.id == Product.seller_id)
        .where(matches(words, Product.title, Product.brand, by_sku))
        .order_by(Product.created_at.desc()).limit(PER_KIND)
    )).all()
    return [Found(kind="product", id=str(p.id), title=p.title, sub=_dot(p.brand, seller, p.status),
                  href=f"/admin/products/{p.id}") for p, seller in rows]


async def _partners(s: AsyncSession, words: list[str]) -> list[Found]:
    rows = (await s.execute(
        select(DeliveryBoy).where(matches(words, DeliveryBoy.name, DeliveryBoy.phone))
        .order_by(DeliveryBoy.created_at.desc()).limit(PER_KIND)
    )).scalars().all()
    return [Found(kind="partner", id=str(b.id), title=b.name, sub=_dot(mask_phone(b.phone), f"KYC {b.kyc_status}"),
                  href=f"/admin/delivery/partners/{b.id}") for b in rows]


async def _tickets(s: AsyncSession, words: list[str]) -> list[Found]:
    rows = (await s.execute(
        select(SupportTicket).where(matches(words, SupportTicket.number, SupportTicket.subject))
        .order_by(SupportTicket.created_at.desc()).limit(PER_KIND)
    )).scalars().all()
    return [Found(kind="ticket", id=str(t.id), title=t.number, sub=_dot(t.subject, t.status.replace("_", " ")),
                  href=f"/admin/support/{t.id}") for t in rows]


async def _payouts(s: AsyncSession, words: list[str]) -> list[Found]:
    rows = (await s.execute(
        select(Payout, Seller.display_name).join(Seller, Seller.id == Payout.seller_id)
        .where(matches(words, Payout.number, Payout.utr, Seller.display_name))
        .order_by(Payout.created_at.desc()).limit(PER_KIND)
    )).all()
    return [Found(kind="payout", id=str(p.id), title=p.number, sub=_dot(seller, _inr(p.amount), p.status),
                  href=f"/admin/payouts?seller_id={p.seller_id}") for p, seller in rows]


# kind → (permission needed, search); the order here is the order of the groups in Quick find
SOURCES: tuple[tuple[str, Callable[[AsyncSession, list[str]], Awaitable[list[Found]]]], ...] = (
    ("orders", _orders),
    ("customers", _customers),
    ("sellers", _sellers),
    ("catalog", _products),
    ("delivery", _partners),
    ("support", _tickets),
    ("payouts", _payouts),
)


@router.get("/search", response_model=SearchOut)
async def search(admin: AdminUser, session: SessionDep, q: str = Query(default="", max_length=80)) -> SearchOut:
    term = " ".join(q.split())
    if len(term) < MIN_CHARS:
        return SearchOut(q=term, results=[])
    await load_roles(session)
    allowed = permissions_for(admin)
    # an id pasted from a URL or a log finds that record directly
    try:
        return SearchOut(q=term, results=await _by_id(session, uuid.UUID(term), allowed))
    except ValueError:
        pass
    words = term.split()[:MAX_WORDS]
    results: list[Found] = []
    for permission, find in SOURCES:
        if permission in allowed:
            results += await find(session, words)
    return SearchOut(q=term, results=results)


async def _by_id(s: AsyncSession, rid: uuid.UUID, allowed: set[str]) -> list[Found]:
    out: list[Found] = []
    if "orders" in allowed and (o := await s.get(Order, rid)):
        out.append(Found(kind="order", id=str(o.id), title=o.number, sub=o.status, href=f"/admin/orders/{o.id}"))
    if "customers" in allowed and (u := await s.get(User, rid)) and not u.is_admin and u.deleted_at is None:
        out.append(Found(kind="customer", id=str(u.id), title=u.name or "Customer without a name", sub=mask_phone(u.phone),
                         href=f"/admin/customers/{u.id}"))
    if "sellers" in allowed and (x := await s.get(Seller, rid)):
        out.append(Found(kind="seller", id=str(x.id), title=x.display_name, sub=x.status, href=f"/admin/sellers/{x.id}"))
    if "catalog" in allowed and (p := await s.get(Product, rid)):
        out.append(Found(kind="product", id=str(p.id), title=p.title, sub=p.status, href=f"/admin/products/{p.id}"))
    if "delivery" in allowed and (b := await s.get(DeliveryBoy, rid)):
        out.append(Found(kind="partner", id=str(b.id), title=b.name, sub=mask_phone(b.phone), href=f"/admin/delivery/partners/{b.id}"))
    if "support" in allowed and (t := await s.get(SupportTicket, rid)):
        out.append(Found(kind="ticket", id=str(t.id), title=t.number, sub=t.subject, href=f"/admin/support/{t.id}"))
    if "payouts" in allowed and (py := await s.get(Payout, rid)):
        out.append(Found(kind="payout", id=str(py.id), title=py.number, sub=py.status, href=f"/admin/payouts?seller_id={py.seller_id}"))
    return out
