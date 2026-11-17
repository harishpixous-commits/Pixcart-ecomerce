from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, update

from app.core.deps import CurrentUser, SessionDep
from app.core.errors import ApiError, NotFound
from app.core.validators import (
    STATES,
    normalize_mobile,
    validate_pincode,
    validate_state_code,
)
from app.models import Address

router = APIRouter(prefix="/api/addresses", tags=["addresses"])

MAX_ADDRESSES = 20


class AddressIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=120)
    phone: str
    line1: str = Field(min_length=3, max_length=200)
    line2: str = Field(default="", max_length=200)
    landmark: str = Field(default="", max_length=120)
    city: str = Field(min_length=2, max_length=80)
    state_code: str
    pincode: str
    kind: Literal["home", "work", "other"] = "home"
    is_default: bool = False

    @field_validator("phone")
    @classmethod
    def _phone(cls, v: str) -> str:
        return normalize_mobile(v)

    @field_validator("pincode")
    @classmethod
    def _pin(cls, v: str) -> str:
        return validate_pincode(v)

    @field_validator("state_code")
    @classmethod
    def _state(cls, v: str) -> str:
        return validate_state_code(v)

    @field_validator("full_name", "line1", "line2", "landmark", "city")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


def address_out(a: Address) -> dict:
    return {
        "id": str(a.id),
        "full_name": a.full_name,
        "phone": a.phone,
        "line1": a.line1,
        "line2": a.line2,
        "landmark": a.landmark,
        "city": a.city,
        "state_code": a.state_code,
        "state": STATES.get(a.state_code, ""),
        "pincode": a.pincode,
        "kind": a.kind,
        "is_default": a.is_default,
    }


async def get_owned_address(session, user_id: uuid.UUID, address_id: uuid.UUID) -> Address:
    a = await session.get(Address, address_id)
    if a is None or a.user_id != user_id or a.is_deleted:
        raise NotFound("Address")
    return a


@router.get("")
async def list_addresses(user: CurrentUser, session: SessionDep) -> list[dict]:
    rows = (
        await session.execute(
            select(Address).where(Address.user_id == user.id, Address.is_deleted.is_(False)).order_by(Address.is_default.desc(), Address.created_at.desc())
        )
    ).scalars()
    return [address_out(a) for a in rows]


@router.post("", status_code=201)
async def create_address(body: AddressIn, user: CurrentUser, session: SessionDep) -> dict:
    count = (
        await session.execute(select(func.count()).select_from(Address).where(Address.user_id == user.id, Address.is_deleted.is_(False)))
    ).scalar_one()
    if count >= MAX_ADDRESSES:
        raise ApiError(f"You can save up to {MAX_ADDRESSES} addresses", "address_limit")
    make_default = body.is_default or count == 0
    if make_default:
        await session.execute(update(Address).where(Address.user_id == user.id).values(is_default=False))
    a = Address(user_id=user.id, **body.model_dump(exclude={"is_default"}), is_default=make_default)
    session.add(a)
    await session.commit()
    return address_out(a)


@router.put("/{address_id}")
async def update_address(address_id: uuid.UUID, body: AddressIn, user: CurrentUser, session: SessionDep) -> dict:
    a = await get_owned_address(session, user.id, address_id)
    for k, v in body.model_dump(exclude={"is_default"}).items():
        setattr(a, k, v)
    if body.is_default and not a.is_default:
        await session.execute(update(Address).where(Address.user_id == user.id).values(is_default=False))
        a.is_default = True
    await session.commit()
    return address_out(a)


@router.delete("/{address_id}")
async def delete_address(address_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    a = await get_owned_address(session, user.id, address_id)
    # Soft delete: past orders keep their own snapshot, but the row stays for audit.
    a.is_deleted = True
    was_default = a.is_default
    a.is_default = False
    await session.flush()
    if was_default:
        nxt = (
            await session.execute(
                select(Address).where(Address.user_id == user.id, Address.is_deleted.is_(False)).order_by(Address.created_at.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if nxt:
            nxt.is_default = True
    await session.commit()
    return {"ok": True}
