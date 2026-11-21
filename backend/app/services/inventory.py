"""Multi-warehouse stock. inventory_levels holds the truth per (variant, warehouse); variants.stock is the
sum, kept in step here so listing and cart queries stay cheap. Every change writes a stock movement."""
from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import utcnow
from app.models import (
    InventoryLevel,
    Product,
    Seller,
    StockMovement,
    Variant,
    Warehouse,
)


async def default_warehouse(session: AsyncSession, seller: Seller, *, create: bool = True) -> Warehouse | None:
    wh = (
        await session.execute(select(Warehouse).where(Warehouse.seller_id == seller.id, Warehouse.is_default.is_(True)))
    ).scalar_one_or_none()
    if wh is None and create and seller.pickup_line1:
        wh = Warehouse(
            seller_id=seller.id,
            code="MAIN",
            name="Main warehouse",
            line1=seller.pickup_line1,
            line2=seller.pickup_line2,
            city=seller.pickup_city,
            state_code=seller.pickup_state_code,
            pincode=seller.pickup_pincode,
            contact_name=seller.display_name,
            contact_phone=seller.contact_phone,
            is_default=True,
        )
        session.add(wh)
        await session.flush()
    return wh


async def sync_default_warehouse(session: AsyncSession, seller: Seller) -> None:
    """Keeps the default warehouse address equal to the KYC pickup address."""
    wh = await default_warehouse(session, seller)
    if wh is None:
        return
    wh.line1, wh.line2, wh.city = seller.pickup_line1, seller.pickup_line2, seller.pickup_city
    wh.state_code, wh.pincode = seller.pickup_state_code, seller.pickup_pincode


async def _level(session: AsyncSession, variant_id: uuid.UUID, warehouse_id: uuid.UUID, *, lock: bool = True) -> InventoryLevel:
    stmt = select(InventoryLevel).where(InventoryLevel.variant_id == variant_id, InventoryLevel.warehouse_id == warehouse_id)
    if lock:
        stmt = stmt.with_for_update()
    lvl = (await session.execute(stmt)).scalar_one_or_none()
    if lvl is None:
        lvl = InventoryLevel(variant_id=variant_id, warehouse_id=warehouse_id, quantity=0, updated_at=utcnow())
        session.add(lvl)
        await session.flush()
    return lvl


async def refresh_variant_total(session: AsyncSession, variant: Variant) -> None:
    total = (
        await session.execute(
            select(func.coalesce(func.sum(InventoryLevel.quantity), 0))
            .join(Warehouse, Warehouse.id == InventoryLevel.warehouse_id)
            .where(InventoryLevel.variant_id == variant.id, Warehouse.is_active.is_(True))
        )
    ).scalar_one()
    variant.stock = int(total)


async def change(
    session: AsyncSession,
    variant: Variant,
    warehouse_id: uuid.UUID,
    delta: int,
    kind: str,
    *,
    reference: str = "",
    note: str = "",
    actor_id: uuid.UUID | None = None,
) -> int:
    lvl = await _level(session, variant.id, warehouse_id)
    new_qty = lvl.quantity + delta
    if new_qty < 0:
        raise ApiError("Not enough stock in this warehouse", "insufficient_stock")
    lvl.quantity = new_qty
    lvl.updated_at = utcnow()
    session.add(
        StockMovement(
            variant_id=variant.id, warehouse_id=warehouse_id, kind=kind, delta=delta, balance_after=new_qty,
            reference=reference[:80], note=note[:300], actor_user_id=actor_id, created_at=utcnow(),
        )
    )
    await session.flush()
    await refresh_variant_total(session, variant)
    return new_qty


async def set_quantity(session: AsyncSession, variant: Variant, warehouse_id: uuid.UUID, qty: int, *, actor_id=None, note: str = "") -> int:
    lvl = await _level(session, variant.id, warehouse_id)
    delta = qty - lvl.quantity
    if delta == 0:
        return qty
    return await change(session, variant, warehouse_id, delta, "set", note=note, actor_id=actor_id)


async def set_total_via_default(session: AsyncSession, seller: Seller, variant: Variant, total: int, *, actor_id=None) -> None:
    """Product-form stock edits: the default warehouse absorbs the difference to reach the requested total of
    sellable stock (the stock in the seller's other ACTIVE warehouses; switched-off warehouses do not count, exactly
    as for the total shoppers see). Below what the other warehouses hold, the main warehouse goes to 0 (the form says
    to lower the other warehouses in Inventory)."""
    wh = await default_warehouse(session, seller)
    if wh is None:
        variant.stock = total
        return
    others = (
        await session.execute(
            select(func.coalesce(func.sum(InventoryLevel.quantity), 0))
            .join(Warehouse, Warehouse.id == InventoryLevel.warehouse_id)
            .where(InventoryLevel.variant_id == variant.id, InventoryLevel.warehouse_id != wh.id, Warehouse.is_active.is_(True))
        )
    ).scalar_one()
    await set_quantity(session, variant, wh.id, max(0, total - int(others)), actor_id=actor_id, note="Edited in product form")


class InsufficientStock(ApiError):
    """Fewer units are left in the seller's active warehouses than the line asks for (another buyer was quicker)."""

    def __init__(self, variant_id: uuid.UUID, available: int):
        super().__init__("Not enough stock", "insufficient_stock")
        self.variant_id, self.available = variant_id, available


async def allocate(
    session: AsyncSession, seller: Seller, lines: list[tuple[Variant, int]], ship_state: str
) -> dict[uuid.UUID, list[tuple[Warehouse, int]]]:
    """Where each line ships from, as (warehouse, quantity) pieces. Prefers one warehouse that can ship everything
    (same state as the customer first, then the default); otherwise each line from the best warehouse that holds all
    of it; otherwise the line is split across warehouses, fullest first, so the fewest packages carry it. Any quantity
    the seller holds in total across active warehouses can be ordered. Rows are locked."""
    warehouses = list(
        (await session.execute(select(Warehouse).where(Warehouse.seller_id == seller.id, Warehouse.is_active.is_(True)))).scalars()
    )
    if not warehouses:
        raise ApiError(f"{seller.display_name} has no active warehouse", "no_warehouse")
    variant_ids = sorted(v.id for v, _ in lines)
    levels = list(
        (
            await session.execute(
                select(InventoryLevel)
                .where(InventoryLevel.variant_id.in_(variant_ids), InventoryLevel.warehouse_id.in_([w.id for w in warehouses]))
                .order_by(InventoryLevel.variant_id, InventoryLevel.warehouse_id)
                .with_for_update()
            )
        ).scalars()
    )
    qty_at = {(lv.variant_id, lv.warehouse_id): lv.quantity for lv in levels}

    def rank(w: Warehouse) -> tuple:
        return (w.state_code != ship_state, not w.is_default, w.code)

    ranked = sorted(warehouses, key=rank)
    for w in ranked:
        if all(qty_at.get((v.id, w.id), 0) >= q for v, q in lines):
            return {v.id: [(w, q)] for v, q in lines}
    out: dict[uuid.UUID, list[tuple[Warehouse, int]]] = {}
    for v, q in lines:
        whole = next((w for w in ranked if qty_at.get((v.id, w.id), 0) >= q), None)
        if whole is not None:
            out[v.id] = [(whole, q)]
            continue
        pieces: list[tuple[Warehouse, int]] = []
        left = q
        for w in sorted(ranked, key=lambda w: (-qty_at.get((v.id, w.id), 0), rank(w))):
            have = qty_at.get((v.id, w.id), 0)
            if have <= 0 or left == 0:
                break
            pieces.append((w, min(have, left)))
            left -= pieces[-1][1]
        if left:
            raise InsufficientStock(v.id, q - left)
        out[v.id] = pieces
    return out


async def warehouse_summary(session: AsyncSession, seller_id: uuid.UUID) -> list[dict]:
    rows = (
        await session.execute(
            select(Warehouse, func.coalesce(func.sum(InventoryLevel.quantity), 0), func.count(InventoryLevel.variant_id))
            .outerjoin(InventoryLevel, InventoryLevel.warehouse_id == Warehouse.id)
            .where(Warehouse.seller_id == seller_id)
            .group_by(Warehouse.id)
            .order_by(Warehouse.is_default.desc(), Warehouse.code)
        )
    ).all()
    return [
        {
            "id": str(w.id), "code": w.code, "name": w.name, "line1": w.line1, "line2": w.line2, "city": w.city,
            "state_code": w.state_code, "pincode": w.pincode, "contact_name": w.contact_name, "contact_phone": w.contact_phone,
            "gstin": w.gstin, "is_default": w.is_default, "is_active": w.is_active, "units": int(units), "skus": int(skus),
        }
        for w, units, skus in rows
    ]


async def product_ids_for(session: AsyncSession, variant_ids: list[uuid.UUID]) -> list[Product]:
    if not variant_ids:
        return []
    return list(
        (await session.execute(select(Product).join(Variant, Variant.product_id == Product.id).where(Variant.id.in_(variant_ids)).distinct())).scalars()
    )
