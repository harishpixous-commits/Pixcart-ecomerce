"""Coupon validation and allocation.

Platform-funded coupons lower what the customer pays; the seller is paid on the full price and the
platform absorbs the difference. Seller-funded coupons lower the seller's own sale value, so GST,
commission and TCS are worked out on the discounted price.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.core.money import apply_bps
from app.db import utcnow
from app.models import Category, Coupon, CouponRedemption, Order
from app.services.catalog import category_descendant_ids


@dataclass
class CouponResult:
    coupon: Coupon
    discount: int
    # per cart line key (variant id) -> discount paise
    per_line: dict[uuid.UUID, int] = field(default_factory=dict)


def _allocate(total_discount: int, weights: dict[uuid.UUID, int]) -> dict[uuid.UUID, int]:
    """Splits paise proportionally with the largest-remainder method so the parts add up exactly."""
    base = sum(weights.values())
    if base <= 0 or total_discount <= 0:
        return {k: 0 for k in weights}
    raw = {k: total_discount * w / base for k, w in weights.items()}
    out = {k: int(v) for k, v in raw.items()}
    left = total_discount - sum(out.values())
    for k in sorted(raw, key=lambda k: raw[k] - out[k], reverse=True)[:left]:
        out[k] += 1
    return out


async def evaluate(session: AsyncSession, code: str, user_id: uuid.UUID, lines: list) -> CouponResult:
    """lines: CartLine objects (variant, product, seller, qty). Raises ApiError with a clear reason."""
    c = (await session.execute(select(Coupon).where(func.upper(Coupon.code) == code.strip().upper()))).scalar_one_or_none()
    now = utcnow()
    if c is None or not c.is_active:
        raise ApiError("This coupon code is not valid", "coupon_invalid")
    if c.starts_at and c.starts_at > now:
        raise ApiError("This coupon is not active yet", "coupon_not_started")
    if c.ends_at and c.ends_at < now:
        raise ApiError("This coupon has expired", "coupon_expired")
    if c.usage_limit is not None and c.used_count >= c.usage_limit:
        raise ApiError("This coupon has been fully used", "coupon_exhausted")
    used = (
        await session.execute(
            select(func.count()).select_from(CouponRedemption).where(
                CouponRedemption.coupon_id == c.id, CouponRedemption.user_id == user_id, CouponRedemption.released.is_(False)
            )
        )
    ).scalar_one()
    if used >= c.per_user_limit:
        raise ApiError("You have already used this coupon", "coupon_used")
    if c.first_order_only:
        placed = (await session.execute(select(func.count()).where(Order.user_id == user_id, Order.status == "placed"))).scalar_one()
        if placed:
            raise ApiError("This coupon is for your first order only", "coupon_first_order")

    allowed_categories: set[uuid.UUID] | None = None
    if c.category_id:
        cat = await session.get(Category, c.category_id)
        allowed_categories = set(await category_descendant_ids(session, cat.id)) if cat else set()
    eligible = {
        line.variant.id: line.line_total
        for line in lines
        if not line.problem
        and (c.seller_id is None or line.seller.id == c.seller_id)
        and (allowed_categories is None or line.product.category_id in allowed_categories)
    }
    base = sum(eligible.values())
    if base == 0:
        raise ApiError("This coupon does not apply to the items in your cart", "coupon_not_applicable")
    if base < c.min_order_paise:
        raise ApiError(f"Add items worth ₹{(c.min_order_paise - base) / 100:,.0f} more to use this coupon", "coupon_min_order")
    discount = apply_bps(base, c.value) if c.kind == "percent" else c.value
    if c.max_discount_paise:
        discount = min(discount, c.max_discount_paise)
    discount = min(discount, base)
    return CouponResult(c, discount, _allocate(discount, eligible))


async def list_for_checkout(session: AsyncSession) -> list[dict]:
    now = utcnow()
    rows = (
        await session.execute(
            select(Coupon).where(
                Coupon.is_active.is_(True),
                Coupon.show_on_checkout.is_(True),
                (Coupon.starts_at.is_(None)) | (Coupon.starts_at <= now),
                (Coupon.ends_at.is_(None)) | (Coupon.ends_at >= now),
            ).order_by(Coupon.created_at.desc()).limit(10)
        )
    ).scalars()
    return [coupon_public(c) for c in rows if c.usage_limit is None or c.used_count < c.usage_limit]


def coupon_public(c: Coupon) -> dict:
    return {
        "code": c.code,
        "description": c.description,
        "kind": c.kind,
        "value": c.value,
        "max_discount_paise": c.max_discount_paise,
        "min_order_paise": c.min_order_paise,
        "ends_at": c.ends_at.isoformat() if c.ends_at else None,
    }
