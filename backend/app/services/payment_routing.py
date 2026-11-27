"""Which payment gateway takes a new payment, and when the next one takes over (docs/PAYMENT_GATEWAYS.md sections 2 and 3).

Pure rules plus the health events table; the adapters that talk to the gateways come later."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import PaymentGatewayEvent, PlatformSetting

KEY = "payment_routing"
GATEWAYS = ["razorpay", "cashfree", "phonepe", "payu", "stripe"]  # table order of section 1
NAMES = {"razorpay": "Razorpay", "cashfree": "Cashfree Payments", "phonepe": "PhonePe Payment Gateway", "payu": "PayU", "stripe": "Stripe"}
CURRENCIES: dict[str, set[str] | None] = {"razorpay": None, "cashfree": {"INR"}, "phonepe": {"INR"}, "payu": {"INR"}, "stripe": None}  # None = any
DEFAULTS: dict[str, Any] = {"order": list(GATEWAYS), "failover": True, "strategy": "priority", "timeout_seconds": 8,
                            "circuit_failures": 3, "circuit_cooldown_seconds": 120, "window_minutes": 15, "min_samples": 5}
_LIMITS = {"timeout_seconds": (3, 30), "circuit_failures": (1, 20), "circuit_cooldown_seconds": (10, 3600), "window_minutes": (5, 1440), "min_samples": (1, 100)}


class RoutingError(ValueError):
    pass


@dataclass(frozen=True)
class Event:
    gateway: str
    ok: bool
    at: datetime


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
            raise RoutingError(f"Unknown setting: {k}")
        if k in _LIMITS:
            lo, hi = _LIMITS[k]
            if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
                raise RoutingError(f"{k} must be a whole number between {lo} and {hi}")
        elif k == "failover":
            if not isinstance(v, bool):
                raise RoutingError("failover must be on or off")
        elif k == "strategy":
            if v not in ("priority", "success_rate"):
                raise RoutingError("strategy must be priority or success_rate")
        else:
            if not isinstance(v, list) or any(x not in GATEWAYS for x in v) or len(set(v)) != len(v):
                raise RoutingError("order must list known gateways without repeats")
        clean[k] = v
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update())).scalar_one_or_none()
    if row is None:
        row = PlatformSetting(key=KEY, value={}, updated_at=utcnow())
        session.add(row)
    row.value = {**(row.value or {}), **clean}
    row.updated_at = utcnow()
    await session.flush()
    return await get(session)


def circuit_state(events: list[Event], cfg: dict[str, Any], now: datetime) -> str:
    """closed | open | half_open for one gateway, from its events (any order)."""
    last = sorted(events, key=lambda e: e.at, reverse=True)[: cfg["circuit_failures"]]
    if len(last) < cfg["circuit_failures"] or any(e.ok for e in last):
        return "closed"
    return "open" if now - last[0].at < timedelta(seconds=cfg["circuit_cooldown_seconds"]) else "half_open"


def success_rate(events: list[Event], cfg: dict[str, Any], now: datetime) -> float:
    recent = [e for e in events if now - e.at <= timedelta(minutes=cfg["window_minutes"])]
    if len(recent) < cfg["min_samples"]:
        return 1.0
    return sum(1 for e in recent if e.ok) / len(recent)


def eligible(cfg: dict[str, Any], enabled: set[str], currency: str, events: list[Event], now: datetime) -> list[str]:
    """Gateways to try for a payment in ``currency``: the routing order, then the other enabled ones in table order."""
    ordered = [g for g in cfg["order"] if g in GATEWAYS] + [g for g in GATEWAYS if g not in cfg["order"]]
    out = []
    for g in ordered:
        if g not in enabled:
            continue
        cur = CURRENCIES[g]
        if cur is not None and currency not in cur:
            continue
        if circuit_state([e for e in events if e.gateway == g], cfg, now) == "open":
            continue
        out.append(g)
    if cfg["strategy"] == "success_rate":
        rate = {g: success_rate([e for e in events if e.gateway == g], cfg, now) for g in out}
        out.sort(key=lambda g: -rate[g])  # stable: ties keep the priority order
    return out


def to_try(cfg: dict[str, Any], candidates: list[str]) -> list[str]:
    """Failover off: only the first eligible gateway is tried."""
    return candidates if cfg["failover"] else candidates[:1]


async def recent_events(session: AsyncSession, now: datetime | None = None) -> list[Event]:
    now = now or utcnow()
    rows = (await session.execute(select(PaymentGatewayEvent).where(PaymentGatewayEvent.created_at >= now - timedelta(days=1)))).scalars().all()
    return [Event(r.gateway, r.ok, r.created_at) for r in rows]


async def record(session: AsyncSession, gateway: str, ok: bool, ms: int, error: str = "") -> None:
    now = utcnow()
    session.add(PaymentGatewayEvent(gateway=gateway, ok=ok, ms=max(0, int(ms)), error=error[:300], created_at=now))
    await session.execute(delete(PaymentGatewayEvent).where(PaymentGatewayEvent.created_at < now - timedelta(days=7)))
    await session.flush()
