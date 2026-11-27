"""Growth and trust settings, edited in Admin -> Growth. Stored in ``platform_settings['growth']``.

One section per module: loyalty, referral, abandoned_cart, flash_sales, gift_cards, scorecard, cod_risk, seo,
bulk_edit, segments. Every module ships switched OFF so nothing changes until staff turn it on.
Seller scorecard is computed from sub orders (no extra tables)."""
from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PlatformSetting, Seller, SubOrder

KEY = "growth"

# name: (default, kind, lo, hi)   kind: bool | int | list
SCHEMA: dict[str, dict[str, tuple]] = {
    "loyalty": {"enabled": (False, "bool", 0, 0), "points_per_100": (1, "int", 0, 100), "point_value_paise": (100, "int", 1, 10000),
                "min_redeem_points": (100, "int", 1, 100000), "max_redeem_percent": (20, "int", 1, 100), "expiry_days": (365, "int", 0, 3650),
                "tier_silver_points": (500, "int", 0, 10000000), "tier_gold_points": (2000, "int", 0, 10000000)},
    "referral": {"enabled": (False, "bool", 0, 0), "referrer_reward_paise": (10000, "int", 0, 1000000), "friend_reward_paise": (5000, "int", 0, 1000000),
                 "min_order_paise": (49900, "int", 0, 10000000), "max_per_user": (20, "int", 1, 1000)},
    "abandoned_cart": {"enabled": (False, "bool", 0, 0), "first_reminder_hours": (4, "int", 1, 720), "second_reminder_hours": (24, "int", 1, 720),
                       "max_reminders": (2, "int", 1, 5), "min_cart_paise": (29900, "int", 0, 10000000), "offer_coupon": ("", "text", 0, 30)},
    "flash_sales": {"enabled": (False, "bool", 0, 0), "max_duration_hours": (48, "int", 1, 720), "max_discount_percent": (70, "int", 1, 95),
                    "show_countdown": (True, "bool", 0, 0)},
    "gift_cards": {"enabled": (False, "bool", 0, 0), "min_paise": (10000, "int", 100, 10000000), "max_paise": (1000000, "int", 100, 100000000),
                   "validity_days": (365, "int", 1, 3650), "allow_purchase": (False, "bool", 0, 0)},
    "scorecard": {"enabled": (False, "bool", 0, 0), "window_days": (30, "int", 7, 365), "ship_within_hours": (48, "int", 1, 720),
                  "late_warn_percent": (10, "int", 0, 100), "late_critical_percent": (25, "int", 0, 100),
                  "cancel_warn_percent": (5, "int", 0, 100), "cancel_critical_percent": (10, "int", 0, 100),
                  "return_warn_percent": (15, "int", 0, 100), "return_critical_percent": (30, "int", 0, 100),
                  "min_orders": (10, "int", 1, 10000), "auto_suspend": (False, "bool", 0, 0)},
    "cod_risk": {"enabled": (False, "bool", 0, 0), "max_cod_paise": (500000, "int", 0, 100000000), "block_after_refused": (2, "int", 1, 20),
                 "new_account_max_cod_paise": (200000, "int", 0, 100000000), "blocked_pincodes": ([], "list", 0, 500)},
    "seo": {"sitemap_enabled": (True, "bool", 0, 0), "sitemap_include_categories": (True, "bool", 0, 0), "sitemap_include_sellers": (False, "bool", 0, 0)},
    "bulk_edit": {"enabled": (True, "bool", 0, 0), "max_rows": (500, "int", 1, 5000)},
    "segments": {"enabled": (False, "bool", 0, 0), "vip_spend_paise": (2500000, "int", 0, 1000000000), "lapsed_days": (90, "int", 7, 1000),
                 "new_days": (30, "int", 1, 365)},
}


class GrowthError(ValueError):
    pass


def defaults() -> dict[str, dict[str, Any]]:
    return {sec: {k: v[0] for k, v in fields.items()} for sec, fields in SCHEMA.items()}


async def get(session: AsyncSession) -> dict[str, dict[str, Any]]:
    row = await session.get(PlatformSetting, KEY)
    out = defaults()
    for sec, vals in ((row.value if row else None) or {}).items():
        if sec in out and isinstance(vals, dict):
            out[sec].update({k: v for k, v in vals.items() if k in out[sec]})
    return out


def _clean(sec: str, k: str, v: Any) -> Any:
    _d, kind, lo, hi = SCHEMA[sec][k]
    if kind == "bool":
        if not isinstance(v, bool):
            raise GrowthError(f"{sec}.{k} must be on or off")
    elif kind == "int":
        if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
            raise GrowthError(f"{sec}.{k} must be a whole number between {lo} and {hi}")
    elif kind == "text":
        if not isinstance(v, str) or len(v.strip()) > hi:
            raise GrowthError(f"{sec}.{k} is too long")
        v = v.strip().upper()
    else:
        if not isinstance(v, list) or len(v) > hi:
            raise GrowthError(f"{sec}.{k} has too many entries")
        v = list(dict.fromkeys(str(x).strip() for x in v if str(x).strip().isdigit() and len(str(x).strip()) == 6))
    return v


async def update(session: AsyncSession, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    clean: dict[str, dict[str, Any]] = {}
    for sec, vals in data.items():
        if sec not in SCHEMA or not isinstance(vals, dict):
            raise GrowthError(f"Unknown section: {sec}")
        for k, v in vals.items():
            if k not in SCHEMA[sec]:
                raise GrowthError(f"Unknown setting: {sec}.{k}")
            clean.setdefault(sec, {})[k] = _clean(sec, k, v)
    cur = await get(session)
    if "loyalty" in clean:
        m = {**cur["loyalty"], **clean["loyalty"]}
        if m["tier_gold_points"] and m["tier_gold_points"] <= m["tier_silver_points"]:
            raise GrowthError("Gold tier needs more points than silver")
    for sec in ("scorecard",):
        if sec in clean:
            m = {**cur[sec], **clean[sec]}
            for a in ("late", "cancel", "return"):
                if m[f"{a}_critical_percent"] < m[f"{a}_warn_percent"]:
                    raise GrowthError(f"{a}: critical level must not be below the warning level")
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    merged = dict(row.value or {})
    for sec, vals in clean.items():
        merged[sec] = {**(merged.get(sec) or {}), **vals}
    row.value = merged
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


def _level(pct: float, warn: int, crit: int) -> str:
    if crit and pct >= crit:
        return "critical"
    if warn and pct >= warn:
        return "warning"
    return "ok"


async def seller_scorecard(session: AsyncSession, cfg: dict[str, Any], seller_id: uuid.UUID | None = None) -> list[dict]:
    """Late shipments, seller cancellations and returns per seller over the window, with ok/warning/critical levels."""
    since = utcnow() - timedelta(days=cfg["window_days"])
    q = select(SubOrder, Seller.display_name).join(Seller, Seller.id == SubOrder.seller_id).where(
        SubOrder.created_at >= since, SubOrder.status.notin_(("pending_payment",)))
    if seller_id:
        q = q.where(SubOrder.seller_id == seller_id)
    stats: dict[uuid.UUID, dict] = {}
    limit = timedelta(hours=cfg["ship_within_hours"])
    now = utcnow()
    for so, name in (await session.execute(q)).all():
        s = stats.setdefault(so.seller_id, {"seller_id": str(so.seller_id), "seller": name, "orders": 0, "late": 0, "cancelled_by_seller": 0, "returned": 0})
        s["orders"] += 1
        if so.status == "cancelled":
            if so.cancelled_by == "seller":
                s["cancelled_by_seller"] += 1
            continue
        shipped = so.shipped_at or (now if so.status in ("placed", "confirmed", "packed") else None)
        if shipped and shipped - so.created_at > limit:
            s["late"] += 1
        if (so.returned_total or 0) > 0:
            s["returned"] += 1
    out = []
    for s in stats.values():
        n = s["orders"]
        s["late_percent"] = round(100 * s["late"] / n, 1)
        s["cancel_percent"] = round(100 * s["cancelled_by_seller"] / n, 1)
        s["return_percent"] = round(100 * s["returned"] / n, 1)
        enough = n >= cfg["min_orders"]
        levels = [_level(s["late_percent"], cfg["late_warn_percent"], cfg["late_critical_percent"]),
                  _level(s["cancel_percent"], cfg["cancel_warn_percent"], cfg["cancel_critical_percent"]),
                  _level(s["return_percent"], cfg["return_warn_percent"], cfg["return_critical_percent"])]
        s["level"] = "not_enough_orders" if not enough else ("critical" if "critical" in levels else "warning" if "warning" in levels else "ok")
        out.append(s)
    return sorted(out, key=lambda x: ({"critical": 0, "warning": 1, "ok": 2, "not_enough_orders": 3}[x["level"]], -x["orders"]))


async def cod_block_reason(session: AsyncSession, user_id: uuid.UUID, pincode: str, grand_total: int) -> str | None:
    """Why cash on delivery is refused for this order under the Admin -> Growth -> COD risk rules, or None.
    (The existing marketplace limit cod_max_order_paise is checked separately.)"""
    from app.models import Order

    cfg = (await get(session))["cod_risk"]
    if not cfg["enabled"]:
        return None
    if pincode in cfg["blocked_pincodes"]:
        return "Cash on delivery is not available for this pincode. Please pay online."
    if cfg["max_cod_paise"] and grand_total > cfg["max_cod_paise"]:
        return "Cash on delivery is not available for this order value. Please pay online."
    if cfg["new_account_max_cod_paise"]:
        delivered = (await session.execute(
            select(SubOrder.id).join(Order, Order.id == SubOrder.order_id).where(Order.user_id == user_id, SubOrder.status == "delivered").limit(1))).first()
        if not delivered and grand_total > cfg["new_account_max_cod_paise"]:
            return "Cash on delivery for a first order is limited. Please pay online or order a smaller amount."
    return None


AUTO_SUSPEND_MAX_PER_RUN = 5


def _why(s: dict, cfg: dict[str, Any]) -> str:
    parts = []
    for key, label in (("late", "late shipments"), ("cancel", "seller cancellations"), ("return", "returns")):
        if cfg[f"{key}_critical_percent"] and s[f"{key}_percent"] >= cfg[f"{key}_critical_percent"]:
            parts.append(f"{label} {s[f'{key}_percent']}% (limit {cfg[f'{key}_critical_percent']}%)")
    return "; ".join(parts)


async def auto_suspend_sellers(session: AsyncSession) -> int:
    """Admin -> Growth -> Seller scorecard -> auto_suspend. Suspends approved sellers who are at the critical level with enough orders in the
    window (at most 5 per run). A seller who is approved again after an automatic suspension is left alone for one full window, so a reinstated seller is not
    suspended again for the same old orders. Staff reinstate from the seller page as for any suspension."""
    from app.core.deps import audit
    from app.models import AuditLog
    from app.services.notify import notify_seller

    cfg = (await get(session))["scorecard"]
    if not (cfg["enabled"] and cfg["auto_suspend"]):
        return 0
    since = utcnow() - timedelta(days=cfg["window_days"])
    done = 0
    for s in await seller_scorecard(session, cfg):
        if s["level"] != "critical" or done >= AUTO_SUSPEND_MAX_PER_RUN:
            continue
        seller = await session.get(Seller, uuid.UUID(s["seller_id"]), with_for_update=True)
        if seller is None or seller.status != "approved":
            continue
        recent = (await session.execute(select(AuditLog.id).where(
            AuditLog.entity_type == "seller", AuditLog.entity_id == str(seller.id), AuditLog.action == "seller.auto_suspend", AuditLog.created_at >= since).limit(1))).first()
        if recent:
            continue
        reason = "Automatic: " + _why(s, cfg)
        seller.status = "suspended"
        seller.rejection_reason = reason[:500]
        audit(session, None, "seller.auto_suspend", "seller", seller.id, reason)
        await notify_seller(session, seller.id, "seller_kyc_update", {"status": "suspended", "message": f"Your store is suspended: {reason}. Contact seller support."}, link="/seller/onboarding")
        done += 1
    return done
