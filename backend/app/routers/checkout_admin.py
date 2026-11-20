"""Admin → Checkout and fees: every charge a shopper sees on the bill, in one place.

Delivery and cash-on-delivery amounts live in the marketplace settings (they belong to the seller's package); the
marketplace's own fees, the tip, business (GSTIN) purchases, delivery instructions and the cancellation note live in
``platform_settings['checkout']``. This endpoint reads and writes both, so staff edit them together.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError
from app.core.permissions import Perm
from app.services import fees as fees_svc
from app.services.platform_settings import get_settings, update_settings

router = APIRouter(prefix="/api/admin/checkout", tags=["checkout-admin"])

MARKETPLACE_KEYS = ("shipping_fee_paise", "free_shipping_threshold_paise", "cod_enabled", "cod_fee_paise", "cod_max_order_paise")


async def _out(session) -> dict:
    cfg = await get_settings(session)
    ck = await fees_svc.get(session)
    return {"marketplace": {k: cfg[k] for k in MARKETPLACE_KEYS}, "fees": ck, "status": fees_svc.status(ck)}


@router.get("")
async def read(admin: Perm("settings"), session: SessionDep) -> dict:
    return await _out(session)


@router.put("")
async def write(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    market = {k: v for k, v in (body.get("marketplace") or {}).items() if k in MARKETPLACE_KEYS}
    fees = dict(body.get("fees") or {})
    try:
        if market:
            await update_settings(session, market)
        if fees:
            await fees_svc.update(session, fees)
    except (ValueError, fees_svc.CheckoutSettingsError) as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "settings.checkout", "settings", "checkout", ",".join(sorted([*market, *fees]))[:200])
    await session.commit()
    return await _out(session)


@router.post("/preview")
async def preview(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    """The bill for a sample cart with the (unsaved) settings, for the live preview. ``night`` shows the bill of an
    order placed inside the late night window, whatever the time now."""
    cfg = {**(await get_settings(session)), **{k: v for k, v in (body.get("marketplace") or {}).items() if k in MARKETPLACE_KEYS}}
    sent = dict(body.get("fees") or {})
    saved = await fees_svc.get(session)
    ck = {**saved, **{k: v for k, v in sent.items() if k in fees_svc.DEFAULTS and k != "surge_until"}}
    try:
        if "surge_hours" in sent:
            ck["surge_until"] = fees_svc.surge_hours_until(sent["surge_hours"])
        elif "surge_enabled" in sent and sent["surge_enabled"] != saved["surge_enabled"]:
            ck["surge_until"] = ""  # as saving would do: switched on without a duration, it is charged until switched off
    except fees_svc.CheckoutSettingsError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    if not all(fees_svc.valid_time(ck.get(k)) for k in fees_svc.TIMES) or ck["late_night_from"] == ck["late_night_to"]:
        ck["late_night_enabled"] = False  # the form shows the problem; the preview leaves the fee out meanwhile
    items = max(0, int(body.get("items_total") or 0))
    cod = bool(body.get("cod"))
    shipping = 0 if items >= cfg["free_shipping_threshold_paise"] or items == 0 else cfg["shipping_fee_paise"]
    lines = fees_svc.order_fees(ck, items, night=bool(body.get("night")))
    cod_fee = cfg["cod_fee_paise"] if cod else 0
    return {"items_total": items, "shipping": shipping, "cod_fee": cod_fee, "fees": lines,
            "total": items + shipping + cod_fee + sum(f["amount"] for f in lines),
            "hints": fees_svc.hints(ck, cfg, items, [{"seller": {"name": "a seller"}, "shipping_fee": shipping,
                                                     "free_shipping_gap": max(0, cfg["free_shipping_threshold_paise"] - items) if shipping else 0}])}
