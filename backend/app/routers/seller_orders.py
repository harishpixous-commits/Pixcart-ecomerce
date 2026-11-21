"""Seller order processing (accept → pack → ship → deliver / reject), dashboard and earnings."""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Query
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import func, or_, select

from app.core.deps import ApprovedSeller, CurrentUser, SellerAccount, SessionDep, audit
from app.core.errors import ApiError, NotFound
from app.db import utcnow
from app.models import DeliveryBoy, Order, OrderEvent, OrderItem, Product, SubOrder, Variant
from app.routers.orders import run_refunds
from app.services import delivery_settings, fleet, inventory
from app.services.catalog import refresh_product_aggregates
from app.services.ledger import balances
from app.services.orders import cancel_sub_order, collect_amount, transition
from app.services.platform_settings import get_settings

router = APIRouter(prefix="/api/seller", tags=["seller-orders"])

STATUS = Literal["placed", "confirmed", "packed", "shipped", "delivered", "cancelled"]


class ShipIn(BaseModel):
    courier_name: str = Field(min_length=2, max_length=60)
    tracking_number: str = Field(min_length=4, max_length=60, pattern=r"^[A-Za-z0-9\-]+$")
    tracking_url: HttpUrl | None = None


class RejectIn(BaseModel):
    reason: Literal["out_of_stock", "cannot_ship_to_pincode", "pricing_error", "other"]
    note: str = Field(default="", max_length=200)
    # out of stock: the order lines whose stock in this package's warehouse is really gone (empty = every line)
    out_of_stock_items: list[uuid.UUID] = Field(default_factory=list, max_length=100)


REASON_TEXT = {
    "out_of_stock": "Seller is out of stock",
    "cannot_ship_to_pincode": "Seller cannot deliver to this PIN code",
    "pricing_error": "Listing had a pricing error",
    "other": "Cancelled by seller",
}


def sub_out(s: SubOrder, o: Order, items: list[OrderItem], *, full: bool) -> dict:
    data = {
        "id": str(s.id),
        "number": s.number,
        "order_number": o.number,
        "status": s.status,
        "payment_method": o.payment_method,
        "created_at": s.created_at.isoformat(),
        "items_total": s.items_total,
        "shipping_fee": s.shipping_fee,
        "total": s.total,
        "seller_payout": s.seller_payout_paise,
        "item_count": sum(i.qty for i in items),
        "items": [
            {"id": str(i.id), "title": i.title, "variant_label": i.variant_label, "sku": i.sku, "image": i.image_url, "qty": i.qty, "unit_price": i.unit_price,
             "line_total": i.line_total}
            for i in items
        ],
        "ship_to_city": o.ship_to.get("city"),
        "ship_to_pincode": o.ship_to.get("pincode"),
        "courier_name": s.courier_name,
        "tracking_number": s.tracking_number,
        "tracking_url": s.tracking_url,
        "invoice_number": s.invoice_number,
        "label_url": s.label_url,
        "expected_delivery_at": s.expected_delivery_at.isoformat() if s.expected_delivery_at else None,
    }
    if full:
        # Full address only once the order is the seller's to fulfil (not while unpaid).
        data["ship_to"] = o.ship_to if s.status != "pending_payment" else None
        data["breakdown"] = {
            "gross": s.total,
            "commission": s.commission_paise,
            "commission_gst": s.commission_gst_paise,
            "tcs": s.tcs_paise,
            "tds": s.tds_paise,
            "payout": s.seller_payout_paise,
            "taxable_total": s.taxable_total,
            "is_interstate": s.is_interstate,
        }
        data["items_tax"] = [
            {"title": i.title, "hsn_code": i.hsn_code, "gst_bps": i.gst_bps, "taxable_value": i.taxable_value, "cgst": i.cgst, "sgst": i.sgst, "igst": i.igst}
            for i in items
        ]
        data["confirmed_at"] = s.confirmed_at.isoformat() if s.confirmed_at else None
        data["packed_at"] = s.packed_at.isoformat() if s.packed_at else None
        data["shipped_at"] = s.shipped_at.isoformat() if s.shipped_at else None
        data["delivered_at"] = s.delivered_at.isoformat() if s.delivered_at else None
        data["cancel_reason"] = s.cancel_reason
        data["settlement_status"] = s.settlement_status
        data["settlement_due_at"] = s.settlement_due_at.isoformat() if s.settlement_due_at else None
    return data


async def _own_sub(session, seller_id: uuid.UUID, sub_id: uuid.UUID, *, lock: bool = True) -> tuple[SubOrder, Order]:
    stmt = select(SubOrder).where(SubOrder.id == sub_id)
    s = (await session.execute(stmt.with_for_update() if lock else stmt)).scalar_one_or_none()
    if s is None or s.seller_id != seller_id or s.status == "pending_payment":
        raise NotFound("Order")
    return s, await session.get(Order, s.order_id)


async def _items(session, sub_ids: list[uuid.UUID]) -> dict[uuid.UUID, list[OrderItem]]:
    if not sub_ids:
        return {}
    out: dict[uuid.UUID, list[OrderItem]] = {}
    for it in (await session.execute(select(OrderItem).where(OrderItem.sub_order_id.in_(sub_ids)))).scalars():
        out.setdefault(it.sub_order_id, []).append(it)
    return out


@router.get("/orders")
async def list_orders(
    seller: SellerAccount,
    session: SessionDep,
    status: STATUS | None = None,
    q: str = Query(default="", max_length=40),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
) -> dict:
    stmt = select(SubOrder, Order).join(Order, Order.id == SubOrder.order_id).where(SubOrder.seller_id == seller.id, SubOrder.status != "pending_payment")
    if status:
        stmt = stmt.where(SubOrder.status == status)
    if q.strip():
        stmt = stmt.where(or_(SubOrder.number.ilike(f"%{q.strip()}%"), Order.number.ilike(f"%{q.strip()}%")))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    # Oldest first for work queues; newest first for history.
    order_by = SubOrder.created_at.asc() if status in ("placed", "confirmed", "packed") else SubOrder.created_at.desc()
    rows = (await session.execute(stmt.order_by(order_by).offset((page - 1) * page_size).limit(page_size))).all()
    items = await _items(session, [r.SubOrder.id for r in rows])
    counts = dict(
        (await session.execute(select(SubOrder.status, func.count()).where(SubOrder.seller_id == seller.id, SubOrder.status != "pending_payment").group_by(SubOrder.status))).all()
    )
    return {
        "items": [sub_out(r.SubOrder, r.Order, items.get(r.SubOrder.id, []), full=False) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "status_counts": counts,
    }


async def fleet_info(session, s: SubOrder, o: Order) -> dict:
    """Own delivery fleet on the seller's order: whether to show "Ready for pickup", the pickup code and the partner."""
    if s.status in ("pending_payment", "cancelled", "delivered") and s.shipping_provider != "fleet":
        return {"eligible": False, "choice": False, "active": False}
    r = await fleet.route(session, s, o) if s.shipping_provider != "fleet" else {"eligible": True, "choice": False}
    out = {"eligible": r["eligible"], "choice": r["choice"], "active": s.shipping_provider == "fleet",
           "ready_for_pickup_at": s.ready_for_pickup_at.isoformat() if s.ready_for_pickup_at else None,
           "pickup_code": s.pickup_code if s.shipping_provider == "fleet" and s.status == "packed" else "", "partner": None, "step": None}
    if s.shipping_provider == "fleet":
        cfg = await delivery_settings.get(session)
        out["choice"] = cfg["fleet_mode"] == "seller_choice"
        a = await fleet.active_assignment(session, s.id)
        if a is not None and a.status != "offered":
            boy = await session.get(DeliveryBoy, a.delivery_boy_id)
            out["partner"] = {"name": boy.name, "phone": boy.phone, "photo": boy.photo, "vehicle": fleet.VEHICLE_LABELS.get(boy.vehicle_type, ""), "vehicle_no": boy.vehicle_no}
            out["step"] = {"status": a.status, "label": fleet.STEP_LABEL.get(a.status, a.status), "kind": a.kind}
        elif a is not None:
            out["step"] = {"status": "offered", "label": "Finding a delivery partner", "kind": a.kind}
        elif s.status == "packed":
            out["step"] = {"status": "waiting", "label": "Waiting for a delivery partner", "kind": "delivery"}
    return out


@router.get("/orders/{sub_id}")
async def get_order(sub_id: uuid.UUID, seller: SellerAccount, session: SessionDep) -> dict:
    s, o = await _own_sub(session, seller.id, sub_id, lock=False)
    data = sub_out(s, o, (await _items(session, [s.id])).get(s.id, []), full=True)
    events = (await session.execute(select(OrderEvent).where(OrderEvent.sub_order_id == s.id).order_by(OrderEvent.created_at))).scalars()
    data["timeline"] = [{"from": e.from_status, "to": e.to_status, "actor": e.actor, "note": e.note, "at": e.created_at.isoformat()} for e in events]
    data["fleet"] = await fleet_info(session, s, o)
    # what the courier collects for this package: the total less the marketplace's coupon, plus the marketplace's fees
    # and the tip on the first package of the order (0 when prepaid)
    data["cod_to_collect"] = await collect_amount(session, s, o) if s.status not in ("cancelled", "pending_payment") else 0
    return data


async def _act(session, seller, user, sub_id: uuid.UUID, dst: str, note: str = "", **fields) -> dict:
    s, o = await _own_sub(session, seller.id, sub_id)
    if dst in ("shipped", "delivered"):
        if s.shipping_provider == "fleet":
            raise ApiError("Our delivery partner picks up and delivers this order; the steps update by themselves", "fleet_order")
        if dst == "shipped":
            r = await fleet.route(session, s, o)
            if r["eligible"] and not r["choice"]:
                raise ApiError("Our delivery partners deliver this order. Mark it Ready for pickup instead of shipping by courier.", "fleet_order")
    for k, v in fields.items():
        setattr(s, k, v)
    await transition(session, s, dst, "seller", note)
    audit(session, user, f"suborder.{dst}", "sub_order", s.id, note)
    await session.commit()
    data = sub_out(s, o, (await _items(session, [s.id])).get(s.id, []), full=True)
    data["fleet"] = await fleet_info(session, s, o)
    return data


@router.post("/orders/{sub_id}/ready-for-pickup")
async def ready_for_pickup(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    """Hands the packed order to the own delivery fleet (staff or auto-assign find a partner)."""
    s, o = await _own_sub(session, seller.id, sub_id)
    await fleet.ready_for_pickup(session, s, user)
    audit(session, user, "suborder.ready_for_pickup", "sub_order", s.id)
    await session.commit()
    data = sub_out(s, o, (await _items(session, [s.id])).get(s.id, []), full=True)
    data["fleet"] = await fleet_info(session, s, o)
    return data


@router.post("/orders/{sub_id}/use-courier")
async def use_courier(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    """Takes the order back from the fleet before pickup to ship it by courier (only when the marketplace lets sellers choose)."""
    s, o = await _own_sub(session, seller.id, sub_id)
    if (await delivery_settings.get(session))["fleet_mode"] != "seller_choice":
        raise ApiError("Our delivery partners deliver this order; contact the marketplace team to change it", "fleet_order")
    if s.shipping_provider != "fleet":
        raise ApiError("This order is not with the delivery fleet", "not_fleet")
    await fleet.use_courier(session, s, user, actor="seller")
    audit(session, user, "suborder.use_courier", "sub_order", s.id)
    await session.commit()
    data = sub_out(s, o, (await _items(session, [s.id])).get(s.id, []), full=True)
    data["fleet"] = await fleet_info(session, s, o)
    return data


@router.post("/orders/{sub_id}/confirm")
async def confirm(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    return await _act(session, seller, user, sub_id, "confirmed")


@router.post("/orders/{sub_id}/pack")
async def pack(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    return await _act(session, seller, user, sub_id, "packed")


@router.post("/orders/{sub_id}/ship")
async def ship(sub_id: uuid.UUID, body: ShipIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    return await _act(
        session,
        seller,
        user,
        sub_id,
        "shipped",
        f"{body.courier_name} {body.tracking_number}",
        courier_name=body.courier_name.strip(),
        tracking_number=body.tracking_number.strip(),
        tracking_url=str(body.tracking_url) if body.tracking_url else "",
    )


@router.post("/orders/{sub_id}/deliver")
async def deliver(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    return await _act(session, seller, user, sub_id, "delivered", "Marked delivered by seller")


@router.post("/orders/{sub_id}/reject")
async def reject(sub_id: uuid.UUID, body: RejectIn, seller: SellerAccount, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    s, o = await _own_sub(session, seller.id, sub_id)
    if s.status not in ("placed", "confirmed", "packed"):
        raise ApiError("Only orders that are not yet shipped can be cancelled", "not_cancellable")
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id == s.id))).scalars())
    gone = {i.variant_id for i in items if not body.out_of_stock_items or i.id in set(body.out_of_stock_items)} if body.reason == "out_of_stock" else set()
    if body.reason == "out_of_stock" and body.out_of_stock_items and not gone:
        raise ApiError("Choose the items that are out of stock in this order", "invalid_items")
    reason = REASON_TEXT[body.reason] + (f": {body.note.strip()}" if body.note.strip() else "")
    refund = await cancel_sub_order(session, s, actor="seller", reason=reason)
    if gone:
        # The units just put back do not exist: set this warehouse's stock of those items to 0 through a recorded stock
        # change (the warehouse levels are the truth; the total follows), so they stop selling and do not come back.
        for v in (await session.execute(select(Variant).where(Variant.id.in_(gone)).order_by(Variant.id).with_for_update())).scalars():
            if s.warehouse_id:
                await inventory.set_quantity(session, v, s.warehouse_id, 0, actor_id=user.id, note=f"Out of stock: seller cancelled {s.number}")
            else:
                v.stock = 0
        for p in (await session.execute(select(Product).where(Product.id.in_({i.product_id for i in items if i.variant_id in gone})))).scalars():
            await refresh_product_aggregates(session, p)
    audit(session, user, "suborder.seller_cancel", "sub_order", s.id, reason + (f" ({len(gone)} item(s) set to 0 in stock)" if gone else ""))
    await session.flush()
    rid = refund.id if refund else None
    await session.commit()
    if rid:
        background.add_task(run_refunds, [rid])
    return sub_out(s, o, (await _items(session, [s.id])).get(s.id, []), full=True)


@router.get("/dashboard")
async def dashboard(seller: SellerAccount, session: SessionDep) -> dict:
    now = utcnow()
    since = now - timedelta(days=30)
    counts = dict(
        (await session.execute(select(SubOrder.status, func.count()).where(SubOrder.seller_id == seller.id).group_by(SubOrder.status))).all()
    )
    sales = (
        await session.execute(
            select(func.coalesce(func.sum(SubOrder.total), 0), func.count())
            .where(SubOrder.seller_id == seller.id, SubOrder.created_at >= since, SubOrder.status.notin_(("pending_payment", "cancelled")))
        )
    ).one()
    daily = (
        await session.execute(
            select(func.date_trunc("day", SubOrder.created_at).label("d"), func.sum(SubOrder.total), func.count())
            .where(SubOrder.seller_id == seller.id, SubOrder.created_at >= since, SubOrder.status.notin_(("pending_payment", "cancelled")))
            .group_by("d")
            .order_by("d")
        )
    ).all()
    # from the ledger, like the Payouts page: returns, ad spend and cash your courier holds are already netted
    bal = await balances(session, seller.id)
    product_counts = dict((await session.execute(select(Product.status, func.count()).where(Product.seller_id == seller.id).group_by(Product.status))).all())
    threshold = (await get_settings(session))["low_stock_threshold"]
    low_stock = (
        await session.execute(
            select(func.count()).select_from(Variant).join(Product, Product.id == Variant.product_id)
            .where(Variant.seller_id == seller.id, Variant.is_active.is_(True), Variant.stock <= threshold, Product.status == "approved")
        )
    ).scalar_one()
    return {
        "seller_status": seller.status,
        "orders": {
            "to_confirm": counts.get("placed", 0),
            "to_pack": counts.get("confirmed", 0),
            "to_ship": counts.get("packed", 0),
            "in_transit": counts.get("shipped", 0),
            "delivered": counts.get("delivered", 0),
            "cancelled": counts.get("cancelled", 0),
        },
        "sales_30d": {"amount": int(sales[0]), "orders": sales[1]},
        "daily_sales": [{"date": d.date().isoformat(), "amount": int(a or 0), "orders": c} for d, a, c in daily],
        "earnings": {"in_return_window": bal["upcoming"], "ready_for_payout": bal["available"]},
        "products": product_counts,
        "low_stock_variants": low_stock,
        "low_stock_threshold": threshold,
    }


@router.get("/earnings")
async def earnings(
    seller: SellerAccount,
    session: SessionDep,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    now = utcnow()
    stmt = select(SubOrder).where(SubOrder.seller_id == seller.id, SubOrder.status == "delivered")
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = list((await session.execute(stmt.order_by(SubOrder.delivered_at.desc()).offset((page - 1) * page_size).limit(page_size))).scalars())
    sums = (
        await session.execute(
            select(
                func.coalesce(func.sum(SubOrder.total), 0),
                func.coalesce(func.sum(SubOrder.commission_paise), 0),
                func.coalesce(func.sum(SubOrder.commission_gst_paise), 0),
                func.coalesce(func.sum(SubOrder.tcs_paise), 0),
                func.coalesce(func.sum(SubOrder.tds_paise), 0),
                func.coalesce(func.sum(SubOrder.seller_payout_paise), 0),
            ).where(SubOrder.seller_id == seller.id, SubOrder.status == "delivered")
        )
    ).one()
    return {
        "totals": {"gross": int(sums[0]), "commission": int(sums[1]), "commission_gst": int(sums[2]), "tcs": int(sums[3]), "tds": int(sums[4]), "payout": int(sums[5])},
        "items": [
            {
                "sub_order_id": str(s.id),
                "number": s.number,
                "delivered_at": s.delivered_at.isoformat() if s.delivered_at else None,
                "gross": s.total,
                "commission": s.commission_paise,
                "commission_gst": s.commission_gst_paise,
                "tcs": s.tcs_paise,
                "tds": s.tds_paise,
                "payout": s.seller_payout_paise,
                "settlement_status": s.settlement_status,
                "eligible": s.settlement_status == "pending" and s.settlement_due_at is not None and s.settlement_due_at <= now,
                "settlement_due_at": s.settlement_due_at.isoformat() if s.settlement_due_at else None,
            }
            for s in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }
