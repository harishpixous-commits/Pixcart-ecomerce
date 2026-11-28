from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.services.product_info import details_of
from app.core.deps import CurrentUser, SessionDep
from app.core.errors import ApiError, NotFound
from app.integrations import get as get_integrations
from app.models import CartItem, Product, SavedItem, Seller, Variant
from app.services import deals as deals_svc
from app.services import fees as fees_svc
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
    ck = await fees_svc.get(session)
    from app.services import growth as growth_svc
    from app.services import loyalty as loyalty_svc

    bounds = await growth_svc.seller_free_bounds(session)
    return cart_payload(group_by_seller(await load_cart(session, user.id), cfg, bounds=bounds, member_free=await loyalty_svc.free_delivery(session, user.id)), cfg, (await get_integrations(session)).online_payments, ck, bounds)


async def _purchasable(session, variant_id: uuid.UUID) -> Variant:
    row = (
        await session.execute(
            select(Variant)
            .join(Product, Product.id == Variant.product_id)
            .join(Seller, Seller.id == Product.seller_id)
            .where(Variant.id == variant_id, Variant.is_active.is_(True), Product.status == "approved", Seller.status == "approved",
                   or_(Product.publish_at.is_(None), Product.publish_at <= func.now()))
        )
    ).scalar_one_or_none()
    if row is None:
        raise NotFound("Product")
    return row


async def _set(session, user, variant_id: uuid.UUID, qty: int, *, add: bool = False) -> str:
    """Puts the quantity in the cart, lowered to what can be bought (stock, the per-item limit in Admin → Marketplace
    settings, units left at a deal price). Returns a note for the shopper when it had to be lowered."""
    item = (await session.execute(select(CartItem).where(CartItem.user_id == user.id, CartItem.variant_id == variant_id))).scalar_one_or_none()
    if qty <= 0 and not add:
        if item:
            await session.delete(item)
        return ""
    variant = await _purchasable(session, variant_id)
    cfg = await get_settings(session)
    if variant.stock <= 0:
        raise ApiError("This item is out of stock", "out_of_stock")
    wanted = (item.qty if item and add else 0) + qty
    new_qty, note = wanted, ""
    deal_left = (await deals_svc.units_left(session, [variant.id])).get(variant.id)
    for cap, why in ((cfg["max_qty_per_item"], f"You can buy at most {cfg['max_qty_per_item']} of this item in one order"),
                     (variant.stock, f"Only {variant.stock} left in stock"),
                     (deal_left or 0, f"Only {deal_left} left at the deal price")):
        if 0 < cap < new_qty:
            new_qty, note = cap, why
    product = await session.get(Product, variant.product_id)
    min_qty = max(1, min(details_of(product.details).min_qty if product else 1, cfg["max_qty_per_item"]))
    if new_qty < min_qty:
        if min_qty > variant.stock:
            raise ApiError(f"The minimum order for this item is {min_qty}, but only {variant.stock} are in stock", "below_minimum")
        new_qty, note = min_qty, f"The minimum order for this item is {min_qty}"
    if note:
        note = f"{note}, so your cart has {new_qty}."
    if item is None:
        count = len((await session.execute(select(CartItem.id).where(CartItem.user_id == user.id))).all())
        if count >= MAX_LINES:
            raise ApiError(f"Your cart can hold up to {MAX_LINES} different items", "cart_full")
        session.add(CartItem(user_id=user.id, variant_id=variant_id, qty=new_qty))
    else:
        item.qty = new_qty
    return note


@router.get("")
async def get_cart(user: CurrentUser, session: SessionDep) -> dict:
    return await _view(session, user)


@router.post("/items")
async def add_item(body: SetQty, user: CurrentUser, session: SessionDep) -> dict:
    if body.qty < 1:
        raise ApiError("Quantity must be at least 1", "invalid_qty")
    note = await _set(session, user, body.variant_id, body.qty, add=True)
    await session.commit()
    return {**(await _view(session, user)), "notice": note}


@router.put("/items")
async def set_item(body: SetQty, user: CurrentUser, session: SessionDep) -> dict:
    note = await _set(session, user, body.variant_id, body.qty)
    await session.commit()
    return {**(await _view(session, user)), "notice": note}


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


@router.post("/reorder/{order_id}")
async def reorder(order_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    """"Order again": puts the items of one of the shopper's own orders back in the cart. Each line follows the normal cart rules
    (stock, per-item limit, deal units); lines that cannot be bought now are listed in "skipped" with the reason."""
    from app.models import Order, OrderItem, SubOrder

    order = await session.get(Order, order_id)
    if order is None or order.user_id != user.id:
        raise NotFound("Order")
    lines = (await session.execute(
        select(OrderItem.variant_id, OrderItem.qty, OrderItem.title).join(SubOrder, SubOrder.id == OrderItem.sub_order_id)
        .where(SubOrder.order_id == order.id).order_by(OrderItem.title))).all()
    added, skipped, notices = 0, [], []
    for variant_id, qty, title in lines:
        try:
            note = await _set(session, user, variant_id, max(1, min(qty, 10)), add=True)
        except ApiError as e:
            skipped.append({"title": title, "reason": e.message})
            continue
        added += 1
        if note:
            notices.append(f"{title}: {note}")
    await session.commit()
    return {**(await _view(session, user)), "added": added, "skipped": skipped, "notices": notices}


# ----------------------------------------------------------------------------- saved for later


async def _saved_view(session, user) -> dict:
    from app.services.catalog import images_for, variant_label

    rows = (await session.execute(
        select(SavedItem, Variant, Product).join(Variant, Variant.id == SavedItem.variant_id).join(Product, Product.id == Variant.product_id)
        .where(SavedItem.user_id == user.id).order_by(SavedItem.created_at.desc()))).all()
    imgs = await images_for(session, list({p.id for _, _, p in rows}))
    items = []
    for s, v, p in rows:
        available = p.status == "approved" and v.is_active
        items.append({"variant_id": str(v.id), "product_id": str(p.id), "slug": p.slug, "title": p.title, "variant_label": variant_label(v.options),
                      "image": (imgs.get(p.id) or [""])[0], "price": v.price_paise, "mrp": v.mrp_paise, "in_stock": available and v.stock > 0,
                      "available": available, "saved_at": s.created_at.isoformat()})
    return {"items": items}


@router.get("/saved")
async def saved_for_later(user: CurrentUser, session: SessionDep) -> dict:
    return await _saved_view(session, user)


@router.post("/items/{variant_id}/save-for-later")
async def save_for_later(variant_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    """Moves a cart line to "Saved for later" (it keeps its place even when out of stock)."""
    from app.db import utcnow

    item = (await session.execute(select(CartItem).where(CartItem.user_id == user.id, CartItem.variant_id == variant_id))).scalar_one_or_none()
    if item is None:
        raise NotFound("Cart item")
    await session.delete(item)
    if await session.get(SavedItem, (user.id, variant_id)) is None:
        count = len((await session.execute(select(SavedItem.variant_id).where(SavedItem.user_id == user.id))).all())
        if count >= 100:
            raise ApiError("You can save up to 100 items for later", "saved_full")
        session.add(SavedItem(user_id=user.id, variant_id=variant_id, created_at=utcnow()))
    await session.commit()
    return {"cart": await _view(session, user), "saved": await _saved_view(session, user)}


@router.post("/saved/{variant_id}/move-to-cart")
async def move_to_cart(variant_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    saved = await session.get(SavedItem, (user.id, variant_id))
    if saved is None:
        raise NotFound("Saved item")
    await _set(session, user, variant_id, 1, add=True)
    await session.delete(saved)
    await session.commit()
    return {"cart": await _view(session, user), "saved": await _saved_view(session, user)}


@router.delete("/saved/{variant_id}")
async def delete_saved(variant_id: uuid.UUID, user: CurrentUser, session: SessionDep) -> dict:
    saved = await session.get(SavedItem, (user.id, variant_id))
    if saved:
        await session.delete(saved)
        await session.commit()
    return await _saved_view(session, user)
