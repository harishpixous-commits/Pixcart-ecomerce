from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.integrations import get as get_integrations
from app.core.deps import CurrentUser, SessionDep
from app.core.errors import ApiError, NotFound
from app.models import CartItem, Product, Seller, Variant
from app.services.orders import cart_payload, group_by_seller, load_cart
from app.services.platform_settings import get_settings

router = APIRouter(prefix="/api/cart", tags=["cart"])

MAX_LINES = 50


class SetQty(BaseModel):
    variant_id: uuid.UUID
    qty: int = Field(ge=0, le=10)  # 0 removes


class MergeIn(BaseModel):
    items: list[SetQty] = Field(max_length=MAX_LINES)


async def _view(session, user) -> dict:
    cfg = await get_settings(session)
    return cart_payload(group_by_seller(await load_cart(session, user.id), cfg), cfg, (await get_integrations(session)).online_payments)


async def _purchasable(session, variant_id: uuid.UUID) -> Variant:
    row = (
        await session.execute(
            select(Variant)
            .join(Product, Product.id == Variant.product_id)
            .join(Seller, Seller.id == Product.seller_id)
            .where(Variant.id == variant_id, Variant.is_active.is_(True), Product.status == "approved", Seller.status == "approved")
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound("Product")
    return row


async def _set(session, user, variant_id: uuid.UUID, qty: int, *, add: bool = False) -> None:
    item = (await session.execute(select(CartItem).where(CartItem.user_id == user.id, CartItem.variant_id == variant_id))).scalar_one_or_none()
    if qty <= 0 and not add:
        if item:
            await session.delete(item)
        return
    variant = await _purchasable(session, variant_id)
    cfg = await get_settings(session)
    new_qty = (item.qty if item and add else 0) + qty
    new_qty = min(new_qty, cfg["max_qty_per_item"])
    if variant.stock <= 0:
        raise ApiError("This item is out of stock", "out_of_stock")
    new_qty = min(new_qty, variant.stock)
    if item is None:
        count = len((await session.execute(select(CartItem.id).where(CartItem.user_id == user.id))).all())
        if count >= MAX_LINES:
            raise ApiError(f"Your cart can hold up to {MAX_LINES} different items", "cart_full")
        session.add(CartItem(user_id=user.id, variant_id=variant_id, qty=new_qty))
    else:
        item.qty = new_qty


@router.get("")
async def get_cart(user: CurrentUser, session: SessionDep) -> dict:
    return await _view(session, user)


@router.post("/items")
async def add_item(body: SetQty, user: CurrentUser, session: SessionDep) -> dict:
    if body.qty < 1:
        raise ApiError("Quantity must be at least 1", "invalid_qty")
    await _set(session, user, body.variant_id, body.qty, add=True)
    await session.commit()
    return await _view(session, user)


@router.put("/items")
async def set_item(body: SetQty, user: CurrentUser, session: SessionDep) -> dict:
    await _set(session, user, body.variant_id, body.qty)
    await session.commit()
    return await _view(session, user)


@router.post("/merge")
async def merge_guest_cart(body: MergeIn, user: CurrentUser, session: SessionDep) -> dict:
    """Moves a signed-out (browser) cart into the account after login; unavailable items are skipped."""
    for it in body.items:
        if it.qty < 1:
            continue
        try:
            await _set(session, user, it.variant_id, it.qty, add=True)
        except ApiError:
            continue
    await session.commit()
    return await _view(session, user)
