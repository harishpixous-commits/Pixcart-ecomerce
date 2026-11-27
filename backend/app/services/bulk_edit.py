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


# ---- CSV round trip: download your versions, edit price / stock / active in a spreadsheet, upload the file back ----
CSV_COLUMNS = ["id", "sku", "product", "price", "stock", "active"]
CSV_MAX_BYTES = 1024 * 1024


async def export_csv(session: AsyncSession, seller: Seller) -> str:
    import csv
    import io

    cfg = (await growth.get(session))["bulk_edit"]
    if not cfg["enabled"]:
        raise ApiError("Bulk edit is switched off by the marketplace", "bulk_edit_off")
    rows = (await session.execute(
        select(Variant, Product.title).join(Product, Product.id == Variant.product_id).where(Variant.seller_id == seller.id).order_by(Product.title, Variant.sku).limit(cfg["max_rows"])
    )).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for v, title in rows:
        w.writerow([v.id, _safe(v.sku), _safe(title), f"{v.price_paise / 100:.2f}", v.stock, "yes" if v.is_active else "no"])
    return buf.getvalue()


def _safe(text: str) -> str:
    """Stop a spreadsheet from running a title or SKU that starts with = + - @ as a formula."""
    return "'" + text if text[:1] in ("=", "+", "-", "@") else text


async def apply_csv(session: AsyncSession, seller: Seller, data: bytes, dry_run: bool) -> dict[str, Any]:
    """Each row carries the version id plus new price (rupees), stock and active. A blank cell means leave it as it is. Rows are checked on their own."""
    import csv
    import io
    from decimal import Decimal, InvalidOperation

    cfg = (await growth.get(session))["bulk_edit"]
    if not cfg["enabled"]:
        raise ApiError("Bulk edit is switched off by the marketplace", "bulk_edit_off")
    if len(data) > CSV_MAX_BYTES:
        raise ApiError("File is too large (1 MB max)", "file_too_large")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ApiError("Save the file as CSV (UTF-8)", "invalid_file") from None
    reader = csv.DictReader(io.StringIO(text))
    fields = {(f or "").strip().lower() for f in (reader.fieldnames or [])}
    if "id" not in fields or not fields & {"price", "stock", "active"}:
        raise ApiError("The file needs an id column and at least one of price, stock, active", "invalid_file")
    parsed = [{(k or "").strip().lower(): (v or "").strip() for k, v in r.items()} for r in reader]
    if not parsed or len(parsed) > cfg["max_rows"]:
        raise ApiError(f"The file needs between 1 and {cfg['max_rows']} rows", "invalid_rows")
    ids: dict[int, uuid.UUID | None] = {}
    for n, r in enumerate(parsed, start=2):
        try:
            ids[n] = uuid.UUID(r.get("id", ""))
        except ValueError:
            ids[n] = None
    rows = {v.id: v for v in (await session.execute(select(Variant).where(Variant.id.in_([i for i in ids.values() if i]), Variant.seller_id == seller.id).with_for_update())).scalars()}
    busy = await active_variant_ids(session, list(rows))
    out, touched, seen = [], set(), set()
    for n, r in enumerate(parsed, start=2):
        vid = ids[n]
        v = rows.get(vid) if vid else None
        item: dict[str, Any] = {"row": n, "id": str(vid) if vid else r.get("id"), "sku": v.sku if v else None, "ok": False, "reason": None, "changes": {}}
        out.append(item)
        if vid is None:
            item["reason"] = "bad_id"
            continue
        if v is None:
            item["reason"] = "not_yours"
            continue
        if vid in seen:
            item["reason"] = "duplicate_row"
            continue
        seen.add(vid)
        new: dict[str, Any] = {}
        try:
            if r.get("price"):
                paise = int((Decimal(r["price"].replace(",", "")) * 100).to_integral_value())
                if paise != v.price_paise:
                    new["price"] = (v.price_paise, paise)
                    if vid in busy:
                        item["reason"] = "deal_running"
                    elif paise < 1 or paise > v.mrp_paise:
                        item["reason"] = "price_out_of_range"
            if r.get("stock"):
                qty = int(r["stock"])
                if not 0 <= qty <= 1_000_000:
                    item["reason"] = item["reason"] or "stock_out_of_range"
                if qty != v.stock:
                    new["stock"] = (v.stock, qty)
            if r.get("active"):
                word = r["active"].lower()
                if word not in ("yes", "no", "true", "false", "1", "0"):
                    item["reason"] = item["reason"] or "bad_active"
                else:
                    flag = word in ("yes", "true", "1")
                    if flag != v.is_active:
                        new["active"] = (v.is_active, flag)
        except (InvalidOperation, ValueError):
            item["reason"] = item["reason"] or "bad_number"
        item["changes"] = {k: {"before": b, "after": a} for k, (b, a) in new.items()}
        if item["reason"]:
            continue
        if not new:
            item["reason"] = "no_change"
            continue
        item["ok"] = True
        if not dry_run:
            if "price" in new:
                v.price_paise = new["price"][1]
            if "stock" in new:
                await inventory.set_total_via_default(session, seller, v, new["stock"][1])
            if "active" in new:
                v.is_active = new["active"][1]
            touched.add(v.product_id)
    if not dry_run:
        for pid in touched:
            await refresh_product_aggregates(session, await session.get(Product, pid))
    return {"dry_run": dry_run, "changed": sum(1 for r in out if r["ok"]), "skipped": sum(1 for r in out if not r["ok"]), "rows": out}
