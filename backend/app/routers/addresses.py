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
    label: str = Field(default="", max_length=40)  # the shopper's own name for it, e.g. "Amma's house"
    instructions: str = Field(default="", max_length=300)  # for the delivery partner or courier
    # map pin (from "use my current location" or dragging the pin); India only
    lat: float | None = Field(default=None, ge=6.0, le=38.0)
    lng: float | None = Field(default=None, ge=68.0, le=98.0)

    @field_validator("label", "instructions")
    @classmethod
    def _tidy(cls, v: str) -> str:
        return " ".join(v.split())

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
        "label": a.label,
        "instructions": a.instructions,
        "lat": float(a.lat) if a.lat is not None else None,
        "lng": float(a.lng) if a.lng is not None else None,
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
    a = Address(user_id=user.id, **_coords(body.model_dump(exclude={"is_default"})), is_default=make_default)
    session.add(a)
    await session.commit()
    return address_out(a)


def _coords(data: dict) -> dict:
    """Both or neither: a pin needs latitude and longitude, rounded to about 10 cm."""
    if data.get("lat") is None or data.get("lng") is None:
        data["lat"] = data["lng"] = None
    else:
        data["lat"], data["lng"] = round(data["lat"], 6), round(data["lng"], 6)
    return data


class InstructionsIn(BaseModel):
    instructions: str = Field(default="", max_length=300)


@router.patch("/{address_id}/instructions")
async def set_instructions(address_id: uuid.UUID, body: InstructionsIn, user: CurrentUser, session: SessionDep) -> dict:
    """Saves delivery instructions for next time (from checkout)."""
    a = await get_owned_address(session, user.id, address_id)
    a.instructions = " ".join(body.instructions.split())
    await session.commit()
    return address_out(a)


class LocationIn(BaseModel):
    lat: float | None = Field(default=None, ge=6.0, le=38.0)  # India
    lng: float | None = Field(default=None, ge=68.0, le=98.0)


@router.patch("/{address_id}/location")
async def set_location(address_id: uuid.UUID, body: LocationIn, user: CurrentUser, session: SessionDep) -> dict:
    """Pins (or un-pins, with nulls) an address on the map, e.g. "Use my current location" at checkout."""
    a = await get_owned_address(session, user.id, address_id)
    pin = _coords(body.model_dump())
    a.lat, a.lng = pin["lat"], pin["lng"]
    await session.commit()
    return address_out(a)


@router.put("/{address_id}")
async def update_address(address_id: uuid.UUID, body: AddressIn, user: CurrentUser, session: SessionDep) -> dict:
    a = await get_owned_address(session, user.id, address_id)
    for k, v in _coords(body.model_dump(exclude={"is_default"})).items():
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
