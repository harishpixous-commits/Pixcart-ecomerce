"""Delivery fleet settings, edited in Admin → Delivery → Settings. Stored in ``platform_settings['delivery']``.

Fleet modes decide which packages the own delivery partners carry:
- ``zones``: the pickup (the seller's warehouse) and the customer's PIN code are both in active delivery zones of the
  same city; every other package keeps the courier flow (seller AWB or Shiprocket);
- ``all``: every package (a package outside the zones waits in the admin queue for a manual assignment);
- ``seller_choice``: the seller picks "Ready for pickup" (fleet) or "Ship by courier" for packages inside the zones;
- ``off``: couriers only.
"""
from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

KEY = "delivery"
FLEET_MODES = ("off", "zones", "all", "seller_choice")
FEE_MODES = ("fixed", "distance")
VEHICLE_LABELS = {"bike": "Motorbike", "scooter": "Scooter", "ev": "Electric bike or scooter", "cycle": "Bicycle", "auto": "Auto", "van": "Van"}
ID_PROOFS = {"aadhaar": "Aadhaar", "pan": "PAN card", "voter": "Voter ID", "passport": "Passport"}
REJECT_REASONS = {
    "too_far": "Too far from me",
    "vehicle": "Vehicle problem",
    "busy": "Already on another delivery",
    "ending_shift": "Ending my shift",
    "unsafe": "Area not safe right now",
    "other": "Other reason",
}
FAIL_REASONS = {
    "not_available": "Customer not available",
    "wrong_address": "Address wrong or not found",
    "refused": "Customer refused the package",
    "no_cash": "Customer could not pay cash",
    "damaged": "Package damaged",
    "other": "Other reason",
}
COMPLAINTS = {
    "late": "Delivered late",
    "rude": "Rude or unprofessional",
    "damaged": "Package damaged",
    "not_received": "Marked delivered but not received",
    "extra_money": "Asked for extra money",
    "other": "Something else",
}

DEFAULTS: dict[str, Any] = {
    "enabled": True,                 # partner app, assignment and tracking
    "fleet_mode": "zones",
    "registration_open": True,       # new partners can sign up in the app
    "return_pickups": True,          # partners collect customers' returns of packages the fleet delivered
    "auto_assign": True,             # offer packages to the nearest free partner automatically
    "offer_seconds": 30,             # time a partner has to accept
    "radius_km": 8,                  # partners further than this from the store are not offered the package
    "max_active": 3,                 # packages a partner carries at once
    "max_offers": 5,                 # partners tried before the package goes to the admin queue
    "fee_mode": "fixed",             # fixed | distance
    "fee_fixed_paise": 3000,         # ₹30 a delivery
    "fee_base_paise": 2000,          # distance mode: ₹20 plus...
    "fee_per_km_paise": 800,         # ... ₹8 a km
    "fee_min_paise": 2500,
    "fee_max_paise": 15000,
    "weather_bonus_paise": 0,        # extra per trip finished while the bad weather fee is on (Admin → Checkout and fees)
    "cod_limit_paise": 500000,       # cash a partner may hold; above it they get no cash-on-delivery packages
    "cod_deduct_from_payout": False, # take cash not yet deposited out of the weekly payout
    "stuck_minutes": 30,             # alert staff when a package stays in one step this long
    "proof_photo_required": True,
    "delivery_otp_required": True,
    "pickup_code_required": True,
    "location_seconds": 20,          # how often the app sends the partner's position while online
    "map_tiles": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "map_attribution": "© OpenStreetMap contributors",
    "support_phone": "",
    "support_whatsapp": "",
    "android_apk_url": "",           # uploaded APK (Admin → Delivery → Settings → App)
    "play_store_url": "",
    "app_version": "",
    "require_vehicle_doc": False,    # registration certificate (RC) photo
}

_INTS: dict[str, tuple[int, int]] = {
    "offer_seconds": (10, 180), "radius_km": (1, 100), "max_active": (1, 10), "max_offers": (1, 30),
    "fee_fixed_paise": (0, 100_000), "fee_base_paise": (0, 100_000), "fee_per_km_paise": (0, 20_000),
    "fee_min_paise": (0, 100_000), "fee_max_paise": (0, 500_000), "weather_bonus_paise": (0, 50_000), "cod_limit_paise": (0, 10_000_000),
    "stuck_minutes": (5, 720), "location_seconds": (5, 300),
}
_CHOICES = {"fleet_mode": FLEET_MODES, "fee_mode": FEE_MODES}
_TEXTS = {"map_attribution": 200, "support_phone": 20, "support_whatsapp": 20, "app_version": 20}
_URLS = ("map_tiles", "android_apk_url", "play_store_url")
_SAFE_URL = re.compile(r"^(https://[^\s\"'<>]+|/(?!/)[^\s\"'<>]*)$")


class DeliverySettingsError(ValueError):
    pass


async def get(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    out = dict(DEFAULTS)
    if row:
        out.update({k: v for k, v in (row.value or {}).items() if k in DEFAULTS})
    return out


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for k, v in data.items():
        if k not in DEFAULTS:
            raise DeliverySettingsError(f"Unknown setting: {k}")
        if k in _INTS:
            lo, hi = _INTS[k]
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise DeliverySettingsError(f"{k} must be a whole number between {lo} and {hi}")
        elif k in _CHOICES:
            if v not in _CHOICES[k]:
                raise DeliverySettingsError(f"{k} must be one of {', '.join(_CHOICES[k])}")
        elif k in _TEXTS:
            if not isinstance(v, str) or len(v) > _TEXTS[k]:
                raise DeliverySettingsError(f"{k} must be text up to {_TEXTS[k]} characters")
            v = v.strip()
        elif k in _URLS:
            if not isinstance(v, str) or len(v) > 400 or (v and not _SAFE_URL.match(v.strip())):
                raise DeliverySettingsError(f"{k} must start with https:// (or / for an uploaded file)")
            v = v.strip()
            if k == "map_tiles" and v and not all(p in v for p in ("{z}", "{x}", "{y}")):
                raise DeliverySettingsError("The map tile address needs {z}, {x} and {y}")
        elif not isinstance(v, bool):
            raise DeliverySettingsError(f"{k} must be on or off")
        clean[k] = v
    merged = {**(await get(session)), **clean}
    if merged["fee_min_paise"] > merged["fee_max_paise"]:
        raise DeliverySettingsError("The lowest fee cannot be more than the highest fee")
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


def public(cfg: dict[str, Any]) -> dict[str, Any]:
    """What the partner app and the storefront need (no internal thresholds)."""
    return {
        "enabled": cfg["enabled"], "registration_open": cfg["registration_open"], "offer_seconds": cfg["offer_seconds"],
        "proof_photo_required": cfg["proof_photo_required"], "delivery_otp_required": cfg["delivery_otp_required"],
        "pickup_code_required": cfg["pickup_code_required"], "location_seconds": cfg["location_seconds"],
        "map_tiles": cfg["map_tiles"], "map_attribution": cfg["map_attribution"], "support_phone": cfg["support_phone"],
        "support_whatsapp": cfg["support_whatsapp"], "android_apk_url": cfg["android_apk_url"], "play_store_url": cfg["play_store_url"],
        "app_version": cfg["app_version"], "require_vehicle_doc": cfg["require_vehicle_doc"], "fee_mode": cfg["fee_mode"],
        "fee_fixed_paise": cfg["fee_fixed_paise"], "fee_base_paise": cfg["fee_base_paise"], "fee_per_km_paise": cfg["fee_per_km_paise"],
        "weather_bonus_paise": cfg["weather_bonus_paise"], "vehicles": VEHICLE_LABELS, "id_proofs": ID_PROOFS, "reject_reasons": REJECT_REASONS, "fail_reasons": FAIL_REASONS,
    }
