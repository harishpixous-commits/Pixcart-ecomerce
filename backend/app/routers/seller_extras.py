"""Seller hub: warehouses and inventory, returns, payouts and ledger, analytics, coupons, reviews,
store preferences, AI listing writer, courier booking, invoices and CSV import/export."""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, File, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from app.core.deps import ApprovedSeller, CurrentUser, SellerAccount, SessionDep, audit
from app.core.errors import ApiError, Conflict, NotFound
from app.core.validators import (
    normalize_mobile,
    validate_gstin,
    validate_pincode,
    validate_state_code,
)
from app.db import utcnow
from app.models import (
    Coupon,
    InventoryLevel,
    LedgerEntry,
    Payout,
    Product,
    ProductReport,
    ReturnRequest,
    Review,
    ReviewReport,
    StockMovement,
    SubOrder,
    User,
    Variant,
    Warehouse,
)
from app.routers.orders import run_refunds
from app.services import inventory, product_page, review_settings, shipping
from app.services import returns as returns_svc
from app.services.analytics import kpis, product_performance
from app.services.catalog import refresh_product_aggregates
from app.services.invoices import credit_note_pdf, invoice_pdf
from app.services.ledger import balances, payout_out, payout_schedule
from app.services.orders import transition
from app.services.platform_settings import PRODUCT_REPORT_REASONS, get_settings

router = APIRouter(prefix="/api/seller", tags=["seller-extras"])


# ----------------------------------------------------------------------------- preferences


class PrefsIn(BaseModel):
    dispatch_days: int = Field(ge=0, le=10)
    holiday_mode: bool
    invoice_prefix: str = Field(default="", max_length=4, pattern=r"^[A-Z0-9]{0,4}$")
    # Orders placed before this time (IST) are packed that day; shoppers see "Order within ..." on product pages.
    dispatch_cutoff: str | None = Field(default=None, pattern=r"^((?:[01]\d|2[0-3]):[0-5]\d)?$")
    # Own free-delivery threshold in paise; null clears it (back to the marketplace's). Only when sent, and only while Growth -> Seller shipping is on.
    free_shipping_threshold_paise: int | None = Field(default=None, ge=0, le=10_000_000)


@router.get("/preferences")
async def get_prefs(seller: SellerAccount, session: SessionDep) -> dict:
    from app.services import growth as growth_svc

    bounds = await growth_svc.seller_free_bounds(session)
    return {"free_shipping_bounds": {"min_paise": bounds[0], "max_paise": bounds[1]} if bounds else None, "dispatch_days": seller.dispatch_days, "holiday_mode": seller.holiday_mode, "invoice_prefix": seller.invoice_prefix,
            "dispatch_cutoff": seller.dispatch_cutoff, "free_shipping_threshold_paise": seller.free_shipping_threshold_paise, "rating_avg": float(seller.rating_avg or 0), "rating_count": seller.rating_count}


@router.put("/preferences")
async def put_prefs(body: PrefsIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    seller.dispatch_days, seller.holiday_mode, seller.invoice_prefix = body.dispatch_days, body.holiday_mode, body.invoice_prefix
    if body.dispatch_cutoff is not None:
        seller.dispatch_cutoff = body.dispatch_cutoff
    if "free_shipping_threshold_paise" in body.model_fields_set:
        v = body.free_shipping_threshold_paise
        if v is not None and v != seller.free_shipping_threshold_paise:  # an unchanged value sent back with the form is not re-checked
            from app.services import growth as growth_svc

            bounds = await growth_svc.seller_free_bounds(session)
            if bounds is None:
                raise ApiError("Own free-delivery amounts are not switched on", "seller_shipping_off")
            if not bounds[0] <= v <= bounds[1]:
                raise ApiError(f"Choose an amount between {bounds[0] // 100} and {bounds[1] // 100} rupees", "threshold_out_of_range")
        seller.free_shipping_threshold_paise = v
    audit(session, user, "seller.preferences", "seller", seller.id, f"holiday={body.holiday_mode}")
    await session.commit()
    return await get_prefs(seller, session)


# ----------------------------------------------------------------------------- warehouses


class WarehouseIn(BaseModel):
    code: str = Field(min_length=2, max_length=20, pattern=r"^[A-Za-z0-9\-]+$")
    name: str = Field(min_length=2, max_length=80)
    line1: str = Field(min_length=3, max_length=200)
    line2: str = Field(default="", max_length=200)
    city: str = Field(min_length=2, max_length=80)
    state_code: str
    pincode: str
    contact_name: str = Field(default="", max_length=120)
    contact_phone: str = ""
    gstin: str = ""
    is_active: bool = True

    @field_validator("state_code")
    @classmethod
    def _s(cls, v: str) -> str:
        return validate_state_code(v)

    @field_validator("pincode")
    @classmethod
    def _p(cls, v: str) -> str:
        return validate_pincode(v)

    @field_validator("contact_phone")
    @classmethod
    def _ph(cls, v: str) -> str:
        return normalize_mobile(v) if v else ""

    @field_validator("gstin")
    @classmethod
    def _g(cls, v: str) -> str:
        return validate_gstin(v) if v else ""


def _check_gst(seller, body: WarehouseIn) -> str:
    """A warehouse in another state needs that state's GSTIN under the same PAN."""
    if seller.gstin and body.state_code != seller.gstin[:2]:
        if not body.gstin:
            raise ApiError("This warehouse is in a different state from your GSTIN. Enter your GSTIN for that state.", "gstin_required", fields={"gstin": "Required"})
        if body.gstin[:2] != body.state_code or body.gstin[2:12] != seller.gstin[2:12]:
            raise ApiError("The GSTIN must belong to this state and to your PAN", "gstin_mismatch", fields={"gstin": "Does not match"})
    return body.gstin


@router.get("/warehouses")
async def list_warehouses(seller: SellerAccount, session: SessionDep) -> list[dict]:
    await inventory.default_warehouse(session, seller)
    await session.commit()
    return await inventory.warehouse_summary(session, seller.id)


@router.post("/warehouses", status_code=201)
async def add_warehouse(body: WarehouseIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> list[dict]:
    if (await session.execute(select(Warehouse.id).where(Warehouse.seller_id == seller.id, func.upper(Warehouse.code) == body.code.upper()))).first():
        raise Conflict("Another warehouse already uses this code", "code_taken")
    count = (await session.execute(select(func.count()).select_from(Warehouse).where(Warehouse.seller_id == seller.id))).scalar_one()
    if count >= 20:
        raise ApiError("You can add up to 20 warehouses", "warehouse_limit")
    gstin = _check_gst(seller, body)
    session.add(Warehouse(seller_id=seller.id, **body.model_dump(exclude={"gstin", "code"}), code=body.code.upper(), gstin=gstin))
    audit(session, user, "warehouse.create", "seller", seller.id, body.code)
    await session.commit()
    return await inventory.warehouse_summary(session, seller.id)


@router.put("/warehouses/{wid}")
async def edit_warehouse(wid: uuid.UUID, body: WarehouseIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> list[dict]:
    wh = await session.get(Warehouse, wid)
    if wh is None or wh.seller_id != seller.id:
        raise NotFound("Warehouse")
    if wh.is_default and (body.state_code != wh.state_code or body.pincode != wh.pincode or body.line1 != wh.line1):
        raise ApiError("The main warehouse follows your verified pickup address; contact seller support to change it", "default_locked")
    if wh.is_default and not body.is_active:
        raise ApiError("The main warehouse cannot be switched off", "default_locked")
    gstin = _check_gst(seller, body)
    was_active = wh.is_active
    for k, v in body.model_dump(exclude={"gstin", "code"}).items():
        setattr(wh, k, v)
    wh.gstin = gstin
    if wh.is_active != was_active:
        # Switched off, its stock stops counting as available; switched back on, it counts (and sells) again.
        await session.flush()
        stmt = (select(Variant).join(InventoryLevel, InventoryLevel.variant_id == Variant.id).where(InventoryLevel.warehouse_id == wh.id)
                .order_by(Variant.id).with_for_update(of=Variant))
        for v in (await session.execute(stmt)).scalars():
            await inventory.refresh_variant_total(session, v)
            await refresh_product_aggregates(session, await session.get(Product, v.product_id))
    audit(session, user, "warehouse.update", "seller", seller.id, wh.code + ("" if wh.is_active == was_active else (" switched on" if wh.is_active else " switched off")))
    await session.commit()
    return await inventory.warehouse_summary(session, seller.id)


# ----------------------------------------------------------------------------- inventory


@router.get("/inventory")
async def inventory_grid(
    seller: SellerAccount,
    session: SessionDep,
    q: str = Query(default="", max_length=100),
    low_stock: bool = False,
    page: int = Query(default=1, ge=1),
) -> dict:
    whs = list((await session.execute(select(Warehouse).where(Warehouse.seller_id == seller.id).order_by(Warehouse.is_default.desc(), Warehouse.code))).scalars())
    stmt = select(Variant, Product.title, Product.id).join(Product, Product.id == Variant.product_id).where(Variant.seller_id == seller.id, Product.status != "archived")
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where((Product.title.ilike(like)) | (Variant.sku.ilike(like)))
    threshold = (await get_settings(session))["low_stock_threshold"]
    if low_stock:
        stmt = stmt.where(Variant.stock <= threshold, Variant.is_active.is_(True))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(Product.title, Variant.sku).offset((page - 1) * 50).limit(50))).all()
    levels = {}
    if rows:
        for lv in (await session.execute(select(InventoryLevel).where(InventoryLevel.variant_id.in_([r.Variant.id for r in rows])))).scalars():
            levels[(lv.variant_id, lv.warehouse_id)] = lv.quantity
    return {
        "warehouses": [{"id": str(w.id), "code": w.code, "name": w.name, "is_active": w.is_active} for w in whs],
        "items": [
            {
                "variant_id": str(v.id), "product_id": str(pid), "title": title, "sku": v.sku,
                "label": " / ".join(f"{k}: {val}" for k, val in v.options.items()), "total": v.stock, "is_active": v.is_active,
                "levels": {str(w.id): levels.get((v.id, w.id), 0) for w in whs},
            }
            for v, title, pid in rows
        ],
        "total": total, "page": page, "page_size": 50, "low_stock_threshold": threshold,
    }


class AdjustIn(BaseModel):
    variant_id: uuid.UUID
    warehouse_id: uuid.UUID
    mode: Literal["set", "add", "remove"]
    quantity: int = Field(ge=0, le=1_000_000)
    note: str = Field(default="", max_length=300)


async def _owned_variant(session, seller, vid) -> Variant:
    v = (await session.execute(select(Variant).where(Variant.id == vid).with_for_update())).scalar_one_or_none()
    if v is None or v.seller_id != seller.id:
        raise NotFound("Product option")
    return v


async def _owned_wh(session, seller, wid) -> Warehouse:
    wh = await session.get(Warehouse, wid)
    if wh is None or wh.seller_id != seller.id:
        raise NotFound("Warehouse")
    return wh


@router.post("/inventory/adjust")
async def adjust(body: AdjustIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    v = await _owned_variant(session, seller, body.variant_id)
    wh = await _owned_wh(session, seller, body.warehouse_id)
    if body.mode == "set":
        qty = await inventory.set_quantity(session, v, wh.id, body.quantity, actor_id=user.id, note=body.note)
    else:
        delta = body.quantity if body.mode == "add" else -body.quantity
        qty = await inventory.change(session, v, wh.id, delta, "adjust", note=body.note, actor_id=user.id)
    await refresh_product_aggregates(session, await session.get(Product, v.product_id))
    await session.commit()
    return {"variant_id": str(v.id), "warehouse_id": str(wh.id), "quantity": qty, "total": v.stock}


class TransferIn(BaseModel):
    variant_id: uuid.UUID
    from_warehouse_id: uuid.UUID
    to_warehouse_id: uuid.UUID
    quantity: int = Field(gt=0, le=1_000_000)


@router.post("/inventory/transfer")
async def transfer(body: TransferIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    if body.from_warehouse_id == body.to_warehouse_id:
        raise ApiError("Choose two different warehouses", "same_warehouse")
    v = await _owned_variant(session, seller, body.variant_id)
    a = await _owned_wh(session, seller, body.from_warehouse_id)
    b = await _owned_wh(session, seller, body.to_warehouse_id)
    await inventory.change(session, v, a.id, -body.quantity, "transfer", reference=f"to {b.code}", actor_id=user.id)
    await inventory.change(session, v, b.id, body.quantity, "transfer", reference=f"from {a.code}", actor_id=user.id)
    await session.commit()
    return {"ok": True, "total": v.stock}


@router.get("/inventory/{variant_id}/movements")
async def movements(variant_id: uuid.UUID, seller: SellerAccount, session: SessionDep) -> dict:
    v = await session.get(Variant, variant_id)
    if v is None or v.seller_id != seller.id:
        raise NotFound("Product option")
    rows = (
        await session.execute(
            select(StockMovement, Warehouse.code).join(Warehouse, Warehouse.id == StockMovement.warehouse_id)
            .where(StockMovement.variant_id == v.id).order_by(StockMovement.created_at.desc()).limit(100)
        )
    ).all()
    return {"items": [{"at": m.created_at.isoformat(), "warehouse": code, "kind": m.kind, "delta": m.delta, "balance": m.balance_after, "reference": m.reference, "note": m.note} for m, code in rows]}


@router.post("/inventory/import")
async def import_stock(seller: SellerAccount, user: CurrentUser, session: SessionDep, file: UploadFile = File(...)) -> dict:
    """CSV with columns sku, warehouse_code, quantity. Sets absolute quantities; errors are reported per row."""
    raw = (await file.read(2 * 1024 * 1024 + 1)).decode("utf-8-sig", errors="replace")
    if len(raw) > 2 * 1024 * 1024:
        raise ApiError("The file is larger than 2 MB", "file_too_large")
    reader = csv.DictReader(io.StringIO(raw))
    need = {"sku", "warehouse_code", "quantity"}
    if not reader.fieldnames or not need.issubset({f.strip().lower() for f in reader.fieldnames}):
        raise ApiError("The CSV needs the columns sku, warehouse_code and quantity", "bad_csv")
    whs = {w.code.upper(): w for w in (await session.execute(select(Warehouse).where(Warehouse.seller_id == seller.id))).scalars()}
    updated, errors = 0, []
    touched: set[uuid.UUID] = set()
    for n, row in enumerate(reader, start=2):
        row = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        if n > 5001:
            errors.append({"row": n, "error": "Only 5000 rows per file"})
            break
        wh = whs.get(row["warehouse_code"].upper())
        if not re.fullmatch(r"\d{1,7}", row["quantity"]):
            errors.append({"row": n, "error": "Quantity must be a whole number"})
            continue
        if wh is None:
            errors.append({"row": n, "error": f"Unknown warehouse code {row['warehouse_code']}"})
            continue
        v = (await session.execute(select(Variant).where(Variant.seller_id == seller.id, func.lower(Variant.sku) == row["sku"].lower()).with_for_update())).scalar_one_or_none()
        if v is None:
            errors.append({"row": n, "error": f"Unknown SKU {row['sku']}"})
            continue
        await inventory.set_quantity(session, v, wh.id, int(row["quantity"]), actor_id=user.id, note="CSV import")
        touched.add(v.product_id)
        updated += 1
    for pid in touched:
        await refresh_product_aggregates(session, await session.get(Product, pid))
    await session.commit()
    return {"updated": updated, "errors": errors[:200]}


# ----------------------------------------------------------------------------- returns


class ItemCondition(BaseModel):
    order_item_id: uuid.UUID
    condition: Literal["sellable", "damaged"]


class ReturnAction(BaseModel):
    action: Literal["approve", "reject", "picked_up", "received"]
    note: str = Field(default="", max_length=2000)
    courier: str = Field(default="", max_length=60)
    tracking: str = Field(default="", max_length=60)
    # on receipt: each item back in sellable stock, or damaged and kept out of stock (missing = by the return reason)
    items: list[ItemCondition] = Field(default_factory=list, max_length=100)


@router.get("/returns")
async def seller_returns(seller: SellerAccount, session: SessionDep, status: str | None = None, page: int = Query(default=1, ge=1)) -> dict:
    stmt = select(ReturnRequest).where(ReturnRequest.seller_id == seller.id)
    if status:
        stmt = stmt.where(ReturnRequest.status == status)
    rows = list((await session.execute(stmt.order_by(ReturnRequest.created_at.desc()).offset((page - 1) * 20).limit(20))).scalars())
    counts = dict((await session.execute(select(ReturnRequest.status, func.count()).where(ReturnRequest.seller_id == seller.id).group_by(ReturnRequest.status))).all())
    return {"items": [await returns_svc.return_out(session, r, viewer="seller") for r in rows], "status_counts": counts, "page": page}


@router.post("/returns/{return_id}")
async def act_return(return_id: uuid.UUID, body: ReturnAction, seller: SellerAccount, user: CurrentUser, session: SessionDep, background: BackgroundTasks) -> dict:
    ret = (await session.execute(select(ReturnRequest).where(ReturnRequest.id == return_id).with_for_update())).scalar_one_or_none()
    if ret is None or ret.seller_id != seller.id:
        raise NotFound("Return")
    if body.action == "reject" and len(body.note.strip()) < 10:
        raise ApiError("Explain to the customer why the return cannot be accepted", "note_required", fields={"note": "Required"})
    dst = {"approve": "approved", "reject": "rejected", "picked_up": "picked_up", "received": "received"}[body.action]
    conditions = {c.order_item_id: c.condition for c in body.items}
    refund_ids = await returns_svc.set_status(session, ret, dst, note=body.note, courier=body.courier, tracking=body.tracking, conditions=conditions)
    damaged = sum(1 for c in conditions.values() if c == "damaged")
    audit(session, user, f"return.{dst}", "return", ret.id, (body.note[:150] + (f" ({damaged} item(s) kept out of stock)" if damaged else "")).strip())
    await session.commit()
    if refund_ids:
        background.add_task(run_refunds, refund_ids)
    return await returns_svc.return_out(session, ret, viewer="seller")


# ----------------------------------------------------------------------------- money


@router.get("/payouts")
async def seller_payouts(seller: SellerAccount, session: SessionDep) -> dict:
    rows = list((await session.execute(select(Payout).where(Payout.seller_id == seller.id).order_by(Payout.created_at.desc()).limit(100))).scalars())
    return {"balances": await balances(session, seller.id), "payouts": [payout_out(p) for p in rows],
            "schedule": payout_schedule(await get_settings(session))}


@router.get("/ledger")
async def seller_ledger(seller: SellerAccount, session: SessionDep, page: int = Query(default=1, ge=1)) -> dict:
    rows = (
        await session.execute(
            select(LedgerEntry, SubOrder.number, Payout.number)
            .outerjoin(SubOrder, SubOrder.id == LedgerEntry.sub_order_id)
            .outerjoin(Payout, Payout.id == LedgerEntry.payout_id)
            .where(LedgerEntry.seller_id == seller.id)
            .order_by(LedgerEntry.created_at.desc(), LedgerEntry.kind)
            .offset((page - 1) * 50).limit(50)
        )
    ).all()
    now = utcnow()
    return {
        "items": [
            {"at": e.created_at.isoformat(), "kind": e.kind, "amount": e.amount, "description": e.description, "order": sub_no,
             "available_at": e.available_at.isoformat(), "available": e.available_at <= now, "payout": po_no}
            for e, sub_no, po_no in rows
        ],
        "page": page,
    }


# ----------------------------------------------------------------------------- analytics


@router.get("/analytics")
async def seller_analytics(seller: SellerAccount, session: SessionDep, days: int = Query(default=30, ge=7, le=365)) -> dict:
    data = await kpis(session, days, seller.id)
    data["products"] = await product_performance(session, seller.id, days)
    return data


# ----------------------------------------------------------------------------- coupons (seller-funded)


class SellerCouponIn(BaseModel):
    code: str = Field(min_length=4, max_length=30, pattern=r"^[A-Za-z0-9]+$")
    description: str = Field(default="", max_length=200)
    kind: Literal["percent", "flat"]
    value: int = Field(gt=0)
    max_discount_paise: int | None = Field(default=None, gt=0)
    min_order_paise: int = Field(default=0, ge=0)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    usage_limit: int | None = Field(default=None, gt=0)
    per_user_limit: int = Field(default=1, ge=1, le=10)
    is_active: bool = True


def coupon_admin_out(c: Coupon) -> dict:
    return {
        "id": str(c.id), "code": c.code, "description": c.description, "kind": c.kind, "value": c.value, "max_discount_paise": c.max_discount_paise,
        "min_order_paise": c.min_order_paise, "starts_at": c.starts_at.isoformat() if c.starts_at else None, "ends_at": c.ends_at.isoformat() if c.ends_at else None,
        "usage_limit": c.usage_limit, "per_user_limit": c.per_user_limit, "used_count": c.used_count, "funded_by": c.funded_by,
        "seller_id": str(c.seller_id) if c.seller_id else None, "category_id": str(c.category_id) if c.category_id else None,
        "first_order_only": c.first_order_only, "is_active": c.is_active, "show_on_checkout": c.show_on_checkout,
    }


def _check_coupon_values(kind: str, value: int) -> None:
    if kind == "percent" and not 100 <= value <= 9000:
        raise ApiError("A percentage coupon must be between 1% and 90%", "invalid_value")


@router.get("/coupons")
async def seller_coupons(seller: ApprovedSeller, session: SessionDep) -> list[dict]:
    rows = (await session.execute(select(Coupon).where(Coupon.seller_id == seller.id).order_by(Coupon.created_at.desc()))).scalars()
    return [coupon_admin_out(c) for c in rows]


@router.post("/coupons", status_code=201)
async def seller_coupon_create(body: SellerCouponIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    _check_coupon_values(body.kind, body.value)
    if (await session.execute(select(Coupon.id).where(func.upper(Coupon.code) == body.code.upper()))).first():
        raise Conflict("This code is already used", "code_taken")
    c = Coupon(**body.model_dump(exclude={"code"}), code=body.code.upper(), funded_by="seller", seller_id=seller.id)
    session.add(c)
    audit(session, user, "coupon.create", "coupon", c.code)
    await session.commit()
    return coupon_admin_out(c)


@router.put("/coupons/{coupon_id}")
async def seller_coupon_update(coupon_id: uuid.UUID, body: SellerCouponIn, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    c = await session.get(Coupon, coupon_id)
    if c is None or c.seller_id != seller.id:
        raise NotFound("Coupon")
    _check_coupon_values(body.kind, body.value)
    for k, v in body.model_dump(exclude={"code"}).items():
        setattr(c, k, v)
    audit(session, user, "coupon.update", "coupon", c.code)
    await session.commit()
    return coupon_admin_out(c)


# ----------------------------------------------------------------------------- reviews


class ReplyIn(BaseModel):
    reply: str = Field(max_length=2000)
    ai_run_id: str | None = Field(default=None, max_length=40)


@router.get("/reviews")
async def seller_reviews(seller: SellerAccount, session: SessionDep, page: int = Query(default=1, ge=1),
                         rating: int | None = Query(default=None, ge=1, le=5), unanswered: bool = False, media: bool = False,
                         q: str = Query(default="", max_length=80)) -> dict:
    stmt = select(Review, Product.title, Product.slug).join(Product, Product.id == Review.product_id).where(Product.seller_id == seller.id)
    if rating:
        stmt = stmt.where(Review.rating == rating)
    if unanswered:
        stmt = stmt.where(Review.seller_reply == "")
    if media:
        stmt = stmt.where(func.jsonb_array_length(Review.media) > 0)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(Product.title.ilike(like) | Review.title.ilike(like) | Review.body.ilike(like))
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(Review.created_at.desc()).offset((page - 1) * 20).limit(20))).all()
    rcfg = await review_settings.get(session)
    dist = dict((await session.execute(
        select(Review.rating, func.count()).join(Product, Product.id == Review.product_id)
        .where(Product.seller_id == seller.id, Review.status == "published").group_by(Review.rating))).all())
    reported = set((await session.execute(
        select(ReviewReport.review_id).where(ReviewReport.user_id == seller.user_id, ReviewReport.review_id.in_([r.id for r, _, _ in rows])))).scalars()) if rows else set()
    return {
        "rating_avg": float(seller.rating_avg or 0), "rating_count": seller.rating_count,
        "distribution": {str(k): dist.get(k, 0) for k in range(5, 0, -1)},
        "topics": await product_page.review_topics(session, rcfg["topics"], seller_id=seller.id) if rcfg["topics_enabled"] else [],
        "can_report": rcfg["seller_can_report"], "report_reasons": review_settings.REPORT_REASONS,
        "items": [{"id": str(r.id), "product": t, "slug": slug, "rating": r.rating, "title": r.title, "body": r.body, "reply": r.seller_reply,
                   "status": r.status, "verified": r.verified, "media": r.media if r.media_status != "hidden" else [], "media_status": r.media_status,
                   "helpful_count": r.helpful_count, "reported": r.id in reported, "at": r.created_at.isoformat()} for r, t, slug in rows],
        "total": total, "page": page, "has_more": page * 20 < total,
    }


@router.post("/reviews/{review_id}/report")
async def seller_report_review(review_id: uuid.UUID, body: dict, seller: ApprovedSeller, session: SessionDep) -> dict:
    """Sellers cannot remove reviews; they can ask staff to check one (abuse, wrong product, personal details)."""
    from app.routers.customer import ReportIn, file_review_report

    if not (await review_settings.get(session))["seller_can_report"]:
        raise ApiError("Reporting reviews is switched off", "reports_off")
    r = await session.get(Review, review_id)
    p = await session.get(Product, r.product_id) if r else None
    if r is None or p.seller_id != seller.id:
        raise NotFound("Review")
    return await file_review_report(session, r, seller.user_id, ReportIn.model_validate(body))


# ----------------------------------------------------------------------------- product reports (customer feedback on listings)


@router.get("/product-reports")
async def seller_product_reports(seller: SellerAccount, session: SessionDep, status: Literal["open", "resolved", "dismissed"] | None = None,
                                 page: int = Query(default=1, ge=1)) -> dict:
    """Reports customers made about this seller's listings, without the customer's identity."""
    stmt = select(ProductReport, Product.title, Product.slug).join(Product, Product.id == ProductReport.product_id).where(ProductReport.seller_id == seller.id)
    if status:
        stmt = stmt.where(ProductReport.status == status)
    total = (await session.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (await session.execute(stmt.order_by(ProductReport.created_at.desc()).offset((page - 1) * 20).limit(20))).all()
    return {
        "items": [{"id": str(x.id), "product_id": str(x.product_id), "product": t, "slug": slug, "reason": x.reason,
                   "reason_label": PRODUCT_REPORT_REASONS.get(x.reason, x.reason), "note": x.note, "url": x.url, "status": x.status,
                   "admin_note": x.admin_note, "seller_note": x.seller_note, "at": x.created_at.isoformat()} for x, t, slug in rows],
        "total": total, "page": page, "has_more": page * 20 < total,
        "open": (await session.execute(select(func.count()).select_from(ProductReport).where(ProductReport.seller_id == seller.id, ProductReport.status == "open"))).scalar_one(),
    }


class SellerNoteIn(BaseModel):
    note: str = Field(min_length=2, max_length=2000)


@router.post("/product-reports/{report_id}/respond")
async def seller_respond_report(report_id: uuid.UUID, body: SellerNoteIn, seller: SellerAccount, user: CurrentUser, session: SessionDep) -> dict:
    x = await session.get(ProductReport, report_id)
    if x is None or x.seller_id != seller.id:
        raise NotFound("Report")
    x.seller_note = body.note.strip()
    audit(session, user, "product_report.seller_note", "product_report", x.id)
    await session.commit()
    return {"ok": True}


@router.put("/reviews/{review_id}/reply")
async def reply_review(review_id: uuid.UUID, body: ReplyIn, seller: ApprovedSeller, session: SessionDep) -> dict:
    r = await session.get(Review, review_id)
    p = await session.get(Product, r.product_id) if r else None
    if r is None or p.seller_id != seller.id:
        raise NotFound("Review")
    r.seller_reply = body.reply.strip()
    if body.ai_run_id:
        from app.ai import service as ai_service

        user = await session.get(User, seller.user_id)
        await ai_service.finish(session, body.ai_run_id, "applied", user, final_text=r.seller_reply, seller_id=seller.id)
    await session.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- courier booking & documents


@router.post("/orders/{sub_id}/book-courier")
async def book_courier(sub_id: uuid.UUID, seller: ApprovedSeller, user: CurrentUser, session: SessionDep) -> dict:
    sub = (await session.execute(select(SubOrder).where(SubOrder.id == sub_id).with_for_update())).scalar_one_or_none()
    if sub is None or sub.seller_id != seller.id:
        raise NotFound("Order")
    if sub.status != "packed":
        raise Conflict("Pack the order before booking the courier", "not_packed")
    from app.services import fleet

    if sub.shipping_provider == "fleet":
        raise ApiError("Our delivery partner picks up this order", "fleet_order")
    r = await fleet.route(session, sub)
    if r["eligible"] and not r["choice"]:
        raise ApiError("Our delivery partners deliver this order. Mark it Ready for pickup instead.", "fleet_order")
    await shipping.book(session, sub)
    await transition(session, sub, "shipped", "seller", f"Booked with {sub.courier_name} {sub.tracking_number}")
    audit(session, user, "suborder.book_courier", "sub_order", sub.id)
    await session.commit()
    return {"courier_name": sub.courier_name, "tracking_number": sub.tracking_number, "label_url": sub.label_url, "status": sub.status}


@router.get("/shipping")
async def shipping_mode(seller: SellerAccount) -> dict:
    return {"provider": "shiprocket" if await shipping.enabled() else "manual"}


@router.get("/orders/{sub_id}/invoice.pdf")
async def seller_invoice(sub_id: uuid.UUID, seller: SellerAccount, session: SessionDep) -> Response:
    sub = await session.get(SubOrder, sub_id)
    if sub is None or sub.seller_id != seller.id or not sub.invoice_number:
        raise NotFound("Invoice")
    return Response(await invoice_pdf(session, sub), media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="invoice-{sub.number}.pdf"', "Cache-Control": "private, no-store"})


@router.get("/returns/{return_id}/credit-note.pdf")
async def seller_credit_note(return_id: uuid.UUID, seller: SellerAccount, session: SessionDep) -> Response:
    ret = await session.get(ReturnRequest, return_id)
    if ret is None or ret.seller_id != seller.id or not ret.credit_note_number:
        raise NotFound("Credit note")
    return Response(await credit_note_pdf(session, ret), media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="credit-note-{ret.number}.pdf"'})


