"""Foreign keys that carts, orders, refunds and the ledger are looked up by have an index (no slow scans as data grows)."""
from __future__ import annotations

from sqlalchemy import text

from app.db import SessionLocal


async def test_hot_foreign_keys_are_indexed(client):
    async with SessionLocal() as s:
        rows = (await s.execute(text("SELECT indexname FROM pg_indexes WHERE schemaname='public'"))).scalars().all()
    have = set(rows)
    for name in ("ix_cart_items_variant_id", "ix_order_items_variant_id", "ix_refunds_sub_order_id", "ix_seller_ledger_sub_order_id", "ix_reviews_user_id", "ix_audit_logs_actor_user_id"):
        assert name in have, name
