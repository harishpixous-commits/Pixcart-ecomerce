"""Customer fees and the bill at checkout (Admin → Checkout and fees). Stored in ``platform_settings['checkout']``.

The bill a shopper sees, in order:

    Item total                    (selling prices; savings against M.R.P. shown separately)
    Delivery fee                  (per seller package: ``shipping_fee_paise``, free when the seller's items reach
                                   ``free_shipping_threshold_paise``; marketplace settings)
    Cash on delivery fee          (``cod_fee_paise``)
    Handling fee                  (optional; a struck-through regular amount shows a discount; free above an amount)
    Small cart fee                (optional; when the item total is below an amount)
    Platform fee                  (optional)
    Bad weather fee               (optional; staff switch it on during heavy rain or very high demand, for a few hours
                                   or until they switch it off; partners can earn a bonus per trip meanwhile)
    Late night fee                (optional; on orders placed in a time window, India time)
    Delivery partner tip          (optional; goes to the delivery partner in full)
    Coupon                        (minus)
    To pay

Delivery and cash-on-delivery fees belong to the seller's package (as before). Handling, small cart, platform, bad
weather and late night fees are the marketplace's own charges for its service: they are not part of any seller's sale,
the amounts include GST at ``fees_gst_bps``, they are refunded when every package of the order is cancelled (if
switched on) and they are collected with the first live package of a cash-on-delivery order.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting

KEY = "checkout"
FEE_CODES = ("handling", "small_cart", "platform", "surge", "late_night")
IST = ZoneInfo("Asia/Kolkata")
SURGE_HOURS_MAX = 72

DEFAULTS: dict[str, Any] = {
    "delivery_label": "Delivery fee",
    "delivery_info": "Charged for each seller's package. Free when your items from that seller reach the free-delivery amount.",
    "handling_enabled": False,
    "handling_paise": 0,
    "handling_list_paise": 0,        # shown struck through when higher than the fee (a discounted fee)
    "handling_free_above_paise": 0,  # 0 = always charged
    "handling_label": "Handling fee",
    "handling_info": "Covers careful packing and handling of your order.",
    "small_cart_enabled": False,
    "small_cart_paise": 0,
    "small_cart_below_paise": 9900,  # charged when the item total is below this
    "small_cart_label": "Small cart fee",
    "small_cart_info": "Small orders cost more to pack and deliver.",
    "platform_enabled": False,
    "platform_paise": 0,
    "platform_label": "Platform fee",
    "platform_info": "Helps us run the store and keep improving it.",
    "surge_enabled": False,          # bad weather or very high demand
    "surge_paise": 0,
    "surge_until": "",               # switches itself off at this moment (UTC, ISO 8601); empty = until staff switch it off
    "surge_label": "Bad weather fee",
    "surge_info": "Charged during heavy rain or very high demand, when deliveries take longer and cost more.",
    "late_night_enabled": False,
    "late_night_paise": 0,
    "late_night_from": "23:00",      # India time, 24-hour clock; the window may run past midnight
    "late_night_to": "06:00",
    "late_night_label": "Late night fee",
    "late_night_info": "Orders placed late at night cost more to pack and deliver.",
    "fees_gst_bps": 1800,            # GST included in the marketplace's own fees
    "fees_sac_code": "998599",       # SAC on the marketplace's tax invoice for its fees (other support services)
    "fee_invoice_prefix": "MKT",     # that invoice's number series: MKT/26-27/000001
    "fees_refund_on_cancel": True,   # refunded when every package of the order is cancelled
    "tip_enabled": False,
    "tip_presets": [1000, 2000, 3000],
    "tip_max_paise": 50000,
    "gstin_enabled": True,           # "Add GSTIN" for business purchases (the GSTIN goes on the tax invoices)
    "instructions_enabled": True,    # delivery instructions for the delivery partner or courier
    "no_bag_enabled": False,         # "I don't need a bag"
    "cancellation_note": "You can cancel until your order is shipped. After delivery, use returns if the product allows them.",
}

_INTS = {"handling_paise": (0, 100_000), "handling_list_paise": (0, 100_000), "handling_free_above_paise": (0, 100_000_000),
         "small_cart_paise": (0, 100_000), "small_cart_below_paise": (0, 10_000_000), "platform_paise": (0, 100_000),
         "fees_gst_bps": (0, 2800), "tip_max_paise": (0, 500_000), "surge_paise": (0, 100_000), "late_night_paise": (0, 100_000)}
_TEXTS = {"delivery_label": 40, "delivery_info": 300, "handling_label": 40, "handling_info": 300, "small_cart_label": 40, "small_cart_info": 300,
          "platform_label": 40, "platform_info": 300, "surge_label": 40, "surge_info": 300, "late_night_label": 40, "late_night_info": 300,
          "cancellation_note": 600}
TIMES = ("late_night_from", "late_night_to")
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_CODES = {"fees_sac_code": (re.compile(r"^\d{4,8}$"), "The SAC code is 4 to 8 digits, like 998599"),
          "fee_invoice_prefix": (re.compile(r"^[A-Z0-9]{2,4}$"), "The invoice prefix is 2 to 4 capital letters or digits, like MKT")}


def valid_time(v: Any) -> bool:
    """A 24-hour clock time like '23:00'."""
    return isinstance(v, str) and bool(_HHMM.match(v))


class CheckoutSettingsError(ValueError):
    pass


async def get(session: AsyncSession) -> dict[str, Any]:
    row = await session.get(PlatformSetting, KEY)
    out = dict(DEFAULTS)
    if row:
        out.update({k: v for k, v in (row.value or {}).items() if k in DEFAULTS})
    return out


def _until(ck: dict) -> datetime | None:
    """When the bad weather fee switches itself off (None: it stays on until staff switch it off)."""
    try:
        return datetime.fromisoformat(ck["surge_until"]) if ck.get("surge_until") else None
    except ValueError:
        return None


def surge_hours_until(hours: Any, now: datetime | None = None) -> str:
    """``surge_hours`` (how long to charge the bad weather fee from now; 0 = until switched off) as a ``surge_until``."""
    if isinstance(hours, bool) or not isinstance(hours, int) or not 0 <= hours <= SURGE_HOURS_MAX:
        raise CheckoutSettingsError(f"Charge the bad weather fee for 1 to {SURGE_HOURS_MAX} hours, or until you switch it off")
    return "" if hours == 0 else ((now or utcnow()) + timedelta(hours=hours)).isoformat()


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, Any]:
    """Saves checkout settings. Besides the keys in DEFAULTS it takes ``surge_hours``: how long the bad weather fee is
    charged from now (0 = until it is switched off), which the server turns into ``surge_until`` with its own clock."""
    data = dict(data)
    clean: dict[str, Any] = {}
    if "surge_hours" in data:
        clean["surge_until"] = surge_hours_until(data.pop("surge_hours"))
        data.pop("surge_until", None)
    for k, v in data.items():
        if k not in DEFAULTS:
            raise CheckoutSettingsError(f"Unknown setting: {k}")
        if k == "surge_until":
            if not isinstance(v, str) or (v and _until({"surge_until": v}) is None) or (v and _until({"surge_until": v}).tzinfo is None):
                raise CheckoutSettingsError("surge_until must be a date and time with a time zone, or empty")
            v = _until({"surge_until": v}).astimezone(timezone.utc).isoformat() if v else ""
        elif k in TIMES:
            if not valid_time(v):
                raise CheckoutSettingsError("Late night times use the 24-hour clock, like 23:00")
        elif k in _CODES:
            v = str(v or "").strip().upper()
            if not _CODES[k][0].match(v):
                raise CheckoutSettingsError(_CODES[k][1])
        elif k in _INTS:
            lo, hi = _INTS[k]
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise CheckoutSettingsError(f"{k} must be a whole number between {lo} and {hi}")
        elif k in _TEXTS:
            if not isinstance(v, str) or len(v) > _TEXTS[k]:
                raise CheckoutSettingsError(f"{k} must be text up to {_TEXTS[k]} characters")
            v = " ".join(v.split()) if k.endswith("_label") else v.strip()
            if k.endswith("_label") and len(v) < 2:
                raise CheckoutSettingsError("Fee names need at least 2 characters")
        elif k == "tip_presets":
            if not isinstance(v, list) or not 1 <= len(v) <= 4 or any(isinstance(x, bool) or not isinstance(x, int) or not 100 <= x <= 100_000 for x in v):
                raise CheckoutSettingsError("Tip amounts: 1 to 4 amounts between ₹1 and ₹1,000")
            v = sorted(set(v))
        elif not isinstance(v, bool):
            raise CheckoutSettingsError(f"{k} must be on or off")
        clean[k] = v
    current = await get(session)
    if "surge_enabled" in clean and clean["surge_enabled"] != current["surge_enabled"] and "surge_until" not in clean:
        # switching it off forgets the end time; switching it on again without a duration charges it until switched off
        clean["surge_until"] = ""
    merged = {**current, **clean}
    if merged["handling_list_paise"] and merged["handling_list_paise"] <= merged["handling_paise"]:
        raise CheckoutSettingsError("The regular handling fee shown struck through must be higher than the fee charged")
    if merged["late_night_from"] == merged["late_night_to"]:
        raise CheckoutSettingsError("The late night fee needs a start time different from its end time")
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


def _rupees(paise: int) -> str:
    return f"₹{paise / 100:,.0f}" if paise % 100 == 0 else f"₹{paise / 100:,.2f}"


def _gst_split(amount: int, bps: int) -> tuple[int, int]:
    """(taxable value, GST) inside a GST-inclusive amount."""
    taxable = round(amount * 10_000 / (10_000 + bps)) if bps else amount
    return taxable, amount - taxable


def surge_active(ck: dict, now: datetime | None = None) -> bool:
    """The bad weather fee is being charged right now."""
    if not (ck["surge_enabled"] and ck["surge_paise"] > 0):
        return False
    until = _until(ck)
    return until is None or (now or utcnow()) < until


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def in_night_window(ck: dict, now: datetime | None = None) -> bool:
    """India time is inside the late night window (which may run past midnight, like 23:00 to 06:00)."""
    t = (now or utcnow()).astimezone(IST)
    m, start, end = t.hour * 60 + t.minute, _minutes(ck["late_night_from"]), _minutes(ck["late_night_to"])
    return start <= m < end if start < end else (m >= start or m < end)


def clock(hhmm: str) -> str:
    """'23:00' → '11 pm', '06:30' → '6:30 am'."""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{h % 12 or 12}{f':{m:02d}' if m else ''} {'am' if h < 12 else 'pm'}"


def status(ck: dict, now: datetime | None = None) -> dict:
    """For the admin page: whether the time-bound fees are being charged at this moment."""
    until = _until(ck)
    return {"surge_active": surge_active(ck, now), "surge_until": until.isoformat() if until else None,
            "surge_ended": bool(ck["surge_enabled"] and until and (now or utcnow()) >= until),
            "late_night_active": bool(ck["late_night_enabled"] and ck["late_night_paise"] > 0 and in_night_window(ck, now)),
            "night_window_now": in_night_window(ck, now)}


def order_fees(ck: dict, items_total: int, *, now: datetime | None = None, night: bool | None = None) -> list[dict]:
    """The marketplace's own fees for an order with this item total (before coupons). Each line carries its GST split.
    ``night`` overrides the clock for the late night fee (the admin preview); ``now`` defaults to this moment."""
    lines: list[dict] = []

    def add(code: str, amount: int, *, list_amount: int = 0, hint: str = "") -> None:
        taxable, gst = _gst_split(amount, ck["fees_gst_bps"])
        lines.append({"code": code, "label": ck[f"{code}_label"], "info": ck[f"{code}_info"], "amount": amount, "list_amount": list_amount if list_amount > amount else 0,
                      "taxable": taxable, "gst": gst, "gst_bps": ck["fees_gst_bps"], "hint": hint})

    if items_total <= 0:
        return lines
    if ck["handling_enabled"] and ck["handling_paise"] > 0:
        free_above = ck["handling_free_above_paise"]
        if free_above and items_total >= free_above:
            pass  # waived
        else:
            add("handling", ck["handling_paise"], list_amount=ck["handling_list_paise"],
                hint=f"Free handling on orders of {_rupees(free_above)} or more" if free_above else "")
    if ck["small_cart_enabled"] and ck["small_cart_paise"] > 0 and items_total < ck["small_cart_below_paise"]:
        add("small_cart", ck["small_cart_paise"], hint=f"No small cart fee on orders of {_rupees(ck['small_cart_below_paise'])} or more")
    if ck["platform_enabled"] and ck["platform_paise"] > 0:
        add("platform", ck["platform_paise"])
    if surge_active(ck, now):
        add("surge", ck["surge_paise"])
    is_night = in_night_window(ck, now) if night is None else night
    if ck["late_night_enabled"] and ck["late_night_paise"] > 0 and is_night:
        add("late_night", ck["late_night_paise"], hint=f"On orders placed between {clock(ck['late_night_from'])} and {clock(ck['late_night_to'])}")
    return lines


def tip_amount(ck: dict, tip: int | None) -> int:
    if not tip:
        return 0
    if not ck["tip_enabled"]:
        raise ValueError("Tips are not available right now")
    if tip < 0 or tip > ck["tip_max_paise"]:
        raise ValueError(f"A tip can be at most {_rupees(ck['tip_max_paise'])}")
    return int(tip)


def hints(ck: dict, cfg: dict, items_total: int, groups: list[dict]) -> list[str]:
    """Short nudges under the bill: how much more for free delivery or to drop the small cart fee."""
    out = []
    if ck["small_cart_enabled"] and ck["small_cart_paise"] and 0 < items_total < ck["small_cart_below_paise"]:
        out.append(f"Add items worth {_rupees(ck['small_cart_below_paise'] - items_total)} to avoid the small cart fee")
    for g in groups:
        gap = g.get("free_shipping_gap") or 0
        if gap and g.get("shipping_fee"):
            out.append(f"Add items worth {_rupees(gap)} from {g['seller']['name']} for free delivery")
    if ck["handling_enabled"] and ck["handling_free_above_paise"] and 0 < items_total < ck["handling_free_above_paise"]:
        out.append(f"Add items worth {_rupees(ck['handling_free_above_paise'] - items_total)} for free handling")
    return out[:3]


_GSTIN_NAME = re.compile(r"^[\w&.,()'/ -]{2,160}$")


def public(ck: dict) -> dict:
    """Options the checkout screen needs."""
    return {
        "tip_enabled": ck["tip_enabled"], "tip_presets": ck["tip_presets"], "tip_max_paise": ck["tip_max_paise"], "gstin_enabled": ck["gstin_enabled"],
        "instructions_enabled": ck["instructions_enabled"], "no_bag_enabled": ck["no_bag_enabled"], "cancellation_note": ck["cancellation_note"],
        "delivery_label": ck["delivery_label"], "delivery_info": ck["delivery_info"],
    }


def check_business(name: str) -> str:
    name = " ".join(name.split())
    if not _GSTIN_NAME.match(name):
        raise ValueError("Enter the business name as registered for GST")
    return name
