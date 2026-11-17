"""Admin-editable marketplace settings with safe defaults.

Statutory rates are settings, not constants, because they change by notification:
GST TCS (s.52 CGST Act) is 0.5% since 10 July 2024 (it was 1%), and income-tax TDS on
e-commerce operators is 0.1% since 1 October 2024 (it was 1%). Confirm with a CA before launch.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

DEFAULTS: dict[str, Any] = {
    "shipping_fee_paise": 4000,
    "free_shipping_threshold_paise": 49900,
    "cod_enabled": True,
    "cod_fee_paise": 0,
    "cod_max_order_paise": 5_000_000,
    "tcs_bps": 50,
    "tds_bps": 10,
    "commission_gst_bps": 1800,
    "max_qty_per_item": 10,
    # features customers and sellers see
    "feature_wishlist": True,
    "feature_reviews": True,
    "feature_returns": True,
    "feature_coupons": True,
    "feature_support": True,
    "reviews_need_approval": False,
    "auto_approve_returns": False,
    # delivery estimate (days in transit, added to the seller's dispatch days)
    "transit_days_same_city": 1,
    "transit_days_same_state": 3,
    "transit_days_national": 6,
    # orders
    "auto_cancel_unconfirmed_hours": 72,  # 0 = off; placed orders the seller never confirms
    # payouts
    "auto_payouts": False,
    "payout_min_paise": 10000,
}

# key -> (type, min, max)
LIMITS: dict[str, tuple[type, int, int]] = {
    "shipping_fee_paise": (int, 0, 100_000),
    "free_shipping_threshold_paise": (int, 0, 10_000_000),
    "cod_enabled": (bool, 0, 1),
    "cod_fee_paise": (int, 0, 10_000),
    "cod_max_order_paise": (int, 0, 100_000_000),
    "tcs_bps": (int, 0, 100),
    "tds_bps": (int, 0, 500),
    "commission_gst_bps": (int, 0, 2800),
    "max_qty_per_item": (int, 1, 10),
    "feature_wishlist": (bool, 0, 1),
    "feature_reviews": (bool, 0, 1),
    "feature_returns": (bool, 0, 1),
    "feature_coupons": (bool, 0, 1),
    "feature_support": (bool, 0, 1),
    "reviews_need_approval": (bool, 0, 1),
    "auto_approve_returns": (bool, 0, 1),
    "transit_days_same_city": (int, 0, 15),
    "transit_days_same_state": (int, 0, 20),
    "transit_days_national": (int, 0, 30),
    "auto_cancel_unconfirmed_hours": (int, 0, 720),
    "auto_payouts": (bool, 0, 1),
    "payout_min_paise": (int, 100, 10_000_000),
}

RETURN_REASONS = {
    "damaged": "Item arrived damaged",
    "defective": "Item does not work",
    "wrong_item": "Received a different item",
    "not_as_described": "Not as described or shown",
    "size_fit": "Size or fit is not right",
    "missing_parts": "Parts or accessories missing",
    "quality": "Quality is not as expected",
}

_ROW_KEY = "marketplace"


async def get_settings(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, _ROW_KEY)
    merged = dict(DEFAULTS)
    if row:
        merged.update({k: v for k, v in row.value.items() if k in DEFAULTS})
    return merged


def validate_updates(updates: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in updates.items():
        if key not in LIMITS:
            raise ValueError(f"Unknown setting: {key}")
        typ, lo, hi = LIMITS[key]
        if typ is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be true or false")
        else:
            if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                raise ValueError(f"{key} must be a whole number between {lo} and {hi}")
        clean[key] = value
    return clean


async def update_settings(session: AsyncSession, updates: dict[str, Any]) -> dict[str, Any]:
    clean = validate_updates(updates)
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == _ROW_KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=_ROW_KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get_settings(session)
