"""Bulk listing upload for sellers: one CSV row per product option (SKU), grouped into products.

The file is checked completely before anything is saved. A dry run returns the preview with every problem
and its row number; a real run creates the valid products as drafts (sellers add photos and submit them for
review as usual) and reports the rest. Formulas, prices and categories are validated like the listing form.
"""
from __future__ import annotations

import csv
import io
import re
from collections import OrderedDict
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.models import Category, Seller, Variant
from app.services.catalog import listing_return_window

MAX_BYTES = 2 * 1024 * 1024
MAX_ROWS = 2000
MAX_PRODUCTS = 300

COLUMNS = [
    "product_key", "title", "category", "brand", "description", "highlights", "hsn_code", "gst_rate", "return_window_days",
    "country_of_origin", "sku", "option_1_name", "option_1_value", "option_2_name", "option_2_value", "mrp", "price", "stock", "weight_grams",
]
REQUIRED = {"product_key", "title", "category", "hsn_code", "sku", "mrp", "price", "stock"}

TEMPLATE_ROWS = [
    ["KURTA-01", "Kovai Men's Cotton Straight Kurta, Sky Blue", "Men's Clothing", "Kovai", "Breathable pure cotton kurta for daily wear. Machine wash cold.",
     "100% cotton|Regular fit|Machine washable", "6205", "5", "7", "India", "KURTA01-M", "Size", "M", "", "", "1299", "699", "25", "300"],
    ["KURTA-01", "", "", "", "", "", "", "", "", "", "KURTA01-L", "Size", "L", "", "", "1299", "699", "30", "320"],
]


def template_csv() -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(COLUMNS)
    w.writerows(TEMPLATE_ROWS)
    return "﻿" + buf.getvalue()


def _paise(v: str, field: str) -> int:
    try:
        d = Decimal(v.replace(",", "").replace("₹", "").strip())
    except InvalidOperation as exc:
        raise ValueError(f"{field} must be a number in rupees") from exc
    if d <= 0:
        raise ValueError(f"{field} must be more than 0")
    return int((d * 100).quantize(Decimal("1")))


def _int(v: str, field: str, default: int | None = None) -> int:
    if not v.strip():
        if default is None:
            raise ValueError(f"{field} is required")
        return default
    if not re.fullmatch(r"\d+", v.strip()):
        raise ValueError(f"{field} must be a whole number")
    return int(v.strip())


FRIENDLY = {
    "hsn_code": "HSN code must be 4, 6 or 8 digits",
    "title": "Title must be 10 to 200 characters",
    "gst_bps": "GST rate must be one of 0, 0.25, 3, 5, 12, 18, 28 or 40",
    "country_of_origin": "Country of origin is required",
    "return_window_days": "Return window must be 0 to 30 days",
}


def _messages(exc: ValidationError, has_row_errors: bool) -> list[str]:
    out = []
    for e in exc.errors():
        loc = [str(x) for x in e["loc"] if x != "__root__"]
        if loc == ["variants"] and has_row_errors:
            continue  # the rows themselves already explain why no option could be read
        msg = str(e["msg"]).removeprefix("Value error, ")
        if loc and loc[0] in FRIENDLY:
            out.append(FRIENDLY[loc[0]])
        elif loc and loc[0] == "variants" and len(loc) >= 3:
            out.append(f"Option {int(loc[1]) + 1}, {loc[2].replace('_paise', '')}: {msg}")
        else:
            out.append(msg)
    return list(dict.fromkeys(out))


async def _leaf_categories(session: AsyncSession) -> dict[str, Category]:
    cats = list((await session.execute(select(Category).where(Category.is_active.is_(True)))).scalars())
    parents = {c.parent_id for c in cats if c.parent_id}
    by_id = {c.id: c for c in cats}
    out: dict[str, Category] = {}
    for c in cats:
        if c.id in parents:
            continue
        path, cur = [c.name], c
        while cur.parent_id and cur.parent_id in by_id:
            cur = by_id[cur.parent_id]
            path.insert(0, cur.name)
        for key in (c.name, c.slug, " > ".join(path), " › ".join(path)):
            out.setdefault(key.lower(), c)
    return out


async def parse(session: AsyncSession, seller: Seller, data: bytes) -> tuple[list[dict], list[dict]]:
    """Returns (products, file_errors). Each product: {key, row, title, payload, variants, errors}."""
    from app.routers.seller_products import ProductIn

    if len(data) > MAX_BYTES:
        return [], [{"row": 0, "error": "The file is larger than 2 MB. Split it into smaller files."}]
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return [], [{"row": 0, "error": "Save the file as CSV UTF-8 and upload it again."}]
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    missing = REQUIRED - set(headers)
    if missing:
        return [], [{"row": 1, "error": f"Missing columns: {', '.join(sorted(missing))}. Download the template for the exact headers."}]
    reader.fieldnames = headers
    cats = await _leaf_categories(session)
    groups: OrderedDict[str, dict] = OrderedDict()
    file_errors: list[dict] = []
    for n, raw in enumerate(reader, start=2):
        if n - 1 > MAX_ROWS:
            file_errors.append({"row": n, "error": f"Only the first {MAX_ROWS} rows are read; upload the rest in another file."})
            break
        row = {k: (v or "").strip() for k, v in raw.items() if k}
        if not any(row.values()):
            continue
        key = row.get("product_key") or row.get("title")
        if not key:
            file_errors.append({"row": n, "error": "product_key is empty"})
            continue
        g = groups.setdefault(key, {"key": key, "row": n, "first": row, "variants": [], "errors": []})
        try:
            options = {}
            for i in (1, 2):
                name, value = row.get(f"option_{i}_name", ""), row.get(f"option_{i}_value", "")
                if name or value:
                    if not (name and value):
                        raise ValueError(f"option_{i}_name and option_{i}_value go together")
                    options[name] = value
            g["variants"].append({
                "sku": row["sku"], "options": options, "mrp_paise": _paise(row["mrp"], "mrp"), "price_paise": _paise(row["price"], "price"),
                "stock": _int(row["stock"], "stock"), "weight_grams": _int(row.get("weight_grams", ""), "weight_grams", 500),
            })
        except (ValueError, KeyError) as exc:
            g["errors"].append(f"Row {n}: {exc}")
    if len(groups) > MAX_PRODUCTS:
        file_errors.append({"row": 0, "error": f"Upload at most {MAX_PRODUCTS} products per file."})
        return [], file_errors

    all_skus = [v["sku"] for g in groups.values() for v in g["variants"]]
    taken = set()
    if all_skus:
        taken = {s.lower() for s in (await session.execute(
            select(Variant.sku).where(Variant.seller_id == seller.id, func.lower(Variant.sku).in_([s.lower() for s in all_skus]))
        )).scalars()}
    seen: dict[str, str] = {}
    products = []
    for g in groups.values():
        f = g["first"]
        errors = list(g["errors"])
        cat = cats.get(f.get("category", "").lower())
        if cat is None:
            errors.append(f"Row {g['row']}: category \"{f.get('category')}\" not found. Use a sub-category name from the listing form.")
        for v in g["variants"]:
            low = v["sku"].lower()
            if low in taken:
                errors.append(f"SKU {v['sku']} already exists in your catalogue")
            elif low in seen and seen[low] != g["key"]:
                errors.append(f"SKU {v['sku']} is also used by product {seen[low]} in this file")
            seen[low] = g["key"]
        payload = None
        if cat is not None:
            try:
                gst = f.get("gst_rate", "")
                gst_bps = int(Decimal(gst) * 100) if gst else cat.default_gst_bps
                payload = ProductIn(
                    category_id=cat.id, title=f.get("title", ""), brand=f.get("brand", ""), description=f.get("description", ""),
                    highlights=[h for h in f.get("highlights", "").split("|") if h.strip()][:10], hsn_code=f.get("hsn_code", ""), gst_bps=gst_bps,
                    country_of_origin=f.get("country_of_origin") or "India",
                    return_window_days=_int(f.get("return_window_days", ""), "return_window_days", cat.return_window_days),
                    variants=g["variants"],
                )
                listing_return_window(cat, payload.return_window_days)
            except ValidationError as exc:
                errors.extend(_messages(exc, bool(g["errors"])))
            except (ValueError, InvalidOperation) as exc:
                errors.append(str(exc))
            except ApiError as exc:
                errors.append(exc.message)
        products.append({"key": g["key"], "row": g["row"], "title": f.get("title", ""), "category": cat.name if cat else f.get("category", ""),
                         "variants": len(g["variants"]), "errors": errors, "payload": payload if not errors else None})
    return products, file_errors



