"""Bulk edit of a seller's product versions (price by percent, stock, on/off). Switched on or off, with a row cap, in
Admin -> Growth -> Bulk edit. Each row is checked on its own: rows that cannot change are skipped with a reason and the rest
still apply. dry_run (the default) only reports what would change."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.models import Product, Seller, Variant
from app.services import growth, inventory
from app.services.catalog import refresh_product_aggregates
from app.services.deals import active_variant_ids

ACTIONS = ("price_percent", "stock_set", "stock_add", "activate", "deactivate")


async def apply(session: AsyncSession, seller: Seller, ids: list[uuid.UUID], action: str, value: int | None, dry_run: bool) -> dict[str, Any]:
    cfg = (await growth.get(session))["bulk_edit"]
    if not cfg["enabled"]:
        raise ApiError("Bulk edit is switched off by the marketplace", "bulk_edit_off")
    ids = list(dict.fromkeys(ids))
    if not ids or len(ids) > cfg["max_rows"]:
        raise ApiError(f"Choose between 1 and {cfg['max_rows']} versions", "invalid_rows")
    if action not in ACTIONS:
        raise ApiError("Unknown bulk action", "invalid_action")
    if action in ("price_percent", "stock_set", "stock_add") and value is None:
        raise ApiError("This action needs a number", "value_required")
    if action == "price_percent" and not -90 <= value <= 500:
        raise ApiError("Price change must be between -90% and +500%", "invalid_value")
    if action == "stock_set" and not 0 <= value <= 1_000_000:
        raise ApiError("Stock must be between 0 and 1,000,000", "invalid_value")
    rows = {v.id: v for v in (await session.execute(select(Variant).where(Variant.id.in_(ids), Variant.seller_id == seller.id).with_for_update())).scalars()}
    busy = await active_variant_ids(session, list(rows)) if action == "price_percent" else set()
    out, touched = [], set()
    for vid in ids:
        v = rows.get(vid)
        if v is None:
            out.append({"id": str(vid), "sku": None, "ok": False, "reason": "not_yours"})
            continue
        before: Any
        after: Any
        reason = None
        if action == "price_percent":
            before, after = v.price_paise, round(v.price_paise * (100 + value) / 100)
            if v.id in busy:
                reason = "deal_running"
            elif after < 1 or after > v.mrp_paise:
                reason = "price_out_of_range"
        elif action in ("stock_set", "stock_add"):
            before = v.stock
            after = value if action == "stock_set" else v.stock + value
            if after < 0 or after > 1_000_000:
                reason = "stock_out_of_range"
        else:
            before, after = v.is_active, action == "activate"
        ok = reason is None and before != after
        out.append({"id": str(vid), "sku": v.sku, "ok": ok, "reason": reason or ("no_change" if before == after else None), "before": before, "after": after})
        if ok and not dry_run:
            if action == "price_percent":
                v.price_paise = after
            elif action.startswith("stock"):
                await inventory.set_total_via_default(session, seller, v, after)
            else:
                v.is_active = after
            touched.add(v.product_id)
    if not dry_run:
        for pid in touched:
            await refresh_product_aggregates(session, await session.get(Product, pid))
    return {"dry_run": dry_run, "changed": sum(1 for r in out if r["ok"]), "skipped": sum(1 for r in out if not r["ok"]), "rows": out}
