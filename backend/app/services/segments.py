"""Customer segments for marketing (Admin -> Growth -> Segments). Read-only: it only counts and lists customers.

A customer can sit in several segments. Orders count when they are placed and not cancelled."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow

SEGMENTS = {
    "new": "Signed up recently",
    "never_ordered": "Never placed an order",
    "repeat": "Two or more orders",
    "vip": "Spent at or above the VIP amount",
    "lapsed": "Ordered before, but not lately",
}

_BASE = """
WITH c AS (
  SELECT u.id, u.name, u.phone, u.email, u.marketing_opt_in, u.created_at,
         COUNT(o.id) AS orders, COALESCE(SUM(o.grand_total), 0) AS spent, MAX(o.placed_at) AS last_order_at
  FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.status <> 'cancelled' AND o.placed_at IS NOT NULL
  WHERE u.is_admin = false AND u.is_active = true AND u.deleted_at IS NULL
  GROUP BY u.id
)
"""
_WHERE = {
    "new": "created_at >= :new_since",
    "never_ordered": "orders = 0",
    "repeat": "orders >= 2",
    "vip": "spent >= :vip",
    "lapsed": "orders > 0 AND last_order_at < :lapsed_before",
}


def _params(cfg: dict[str, Any]) -> dict[str, Any]:
    now = utcnow()
    return {"new_since": now - timedelta(days=cfg["new_days"]), "vip": cfg["vip_spend_paise"],
            "lapsed_before": now - timedelta(days=cfg["lapsed_days"])}


async def counts(session: AsyncSession, cfg: dict[str, Any]) -> dict[str, int]:
    out = {}
    for key, cond in _WHERE.items():
        out[key] = (await session.execute(text(_BASE + f"SELECT COUNT(*) FROM c WHERE {cond}"), _params(cfg))).scalar_one()
    return out


async def members(session: AsyncSession, cfg: dict[str, Any], key: str, limit: int = 200) -> list[dict[str, Any]]:
    rows = (await session.execute(text(_BASE + f"SELECT id, name, phone, email, marketing_opt_in, orders, spent, last_order_at FROM c WHERE {_WHERE[key]} ORDER BY spent DESC, created_at DESC LIMIT :lim"),
                                  _params(cfg) | {"lim": limit})).all()
    return [{"id": str(r.id), "name": r.name, "phone": r.phone, "email": r.email, "marketing_opt_in": r.marketing_opt_in, "orders": r.orders,
             "spent_paise": int(r.spent), "last_order_at": r.last_order_at.isoformat() if r.last_order_at else None} for r in rows]
