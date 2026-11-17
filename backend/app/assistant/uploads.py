"""Files given to the assistant: parse once, profile, query and compare with live data.

Accepted: CSV/TSV, Excel (.xlsx, first sheet), plain text, Markdown and JSON — at most 5 MB, 50,000 rows
and 100 columns. Excel formulas are read as their last saved values and never evaluated; macros
(.xlsm) are refused. Files belong to the person who uploaded them and are deleted after 7 days.

All arithmetic on uploaded data (sums, counts, matches) is done here in Python with exact decimals,
so the assistant reports computed numbers instead of estimating them.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import utcnow
from app.models import AssistantUpload, Order, Payout, Product, Seller, SubOrder, User, Variant

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 50_000
MAX_COLS = 100
TEXT_LIMIT = 200_000
KEEP_DAYS = 7
EXTENSIONS = (".csv", ".tsv", ".xlsx", ".txt", ".md", ".json")


class UploadError(ValueError):
    pass


def _cell(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, (int, float)):
        return v
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v).strip()


def _dedupe(headers: list[str]) -> list[str]:
    out, seen = [], Counter()
    for i, h in enumerate(headers):
        name = re.sub(r"\s+", " ", str(h or "").strip())[:80] or f"Column {i + 1}"
        seen[name] += 1
        out.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
    return out


def parse(filename: str, data: bytes) -> dict[str, Any]:
    name = filename.lower()
    if len(data) > MAX_BYTES:
        raise UploadError("The file is larger than 5 MB. Export fewer rows or split it.")
    if not name.endswith(EXTENSIONS):
        raise UploadError("Upload a CSV, Excel (.xlsx), text or JSON file.")
    if name.endswith(".xlsx"):
        if not data.startswith(b"PK"):
            raise UploadError("This is not a valid Excel file.")
        from openpyxl import load_workbook

        try:
            wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception:  # noqa: BLE001 — corrupt or password-protected workbook
            raise UploadError("This Excel file could not be read. Save it again as .xlsx (no password).") from None
        ws = wb.worksheets[0]
        rows_iter = ws.iter_rows(values_only=True)
        header = next(rows_iter, None) or ()
        rows, truncated = [], False
        for r in rows_iter:
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            vals = [_cell(v) for v in list(r)[:MAX_COLS]]
            if any(v != "" for v in vals):
                rows.append(vals)
        wb.close()
        return _table(list(header)[:MAX_COLS], rows, truncated)
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    if name.endswith((".csv", ".tsv")):
        sample = text[:5000]
        delim = "\t" if name.endswith(".tsv") or sample.count("\t") > sample.count(",") else ","
        reader = csv.reader(io.StringIO(text), delimiter=delim)
        header = next(reader, [])
        rows, truncated = [], False
        for r in reader:
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            vals = [v.strip() for v in r[:MAX_COLS]]
            if any(vals):
                rows.append(vals)
        return _table(header[:MAX_COLS], rows, truncated)
    if name.endswith(".json"):
        try:
            obj = json.loads(text)
        except ValueError:
            raise UploadError("This JSON file is not valid.") from None
        if isinstance(obj, list) and obj and all(isinstance(x, dict) for x in obj[:50]):
            keys: list[str] = []
            for x in obj[:500]:
                for k in x:
                    if k not in keys and len(keys) < MAX_COLS:
                        keys.append(k)
            rows = [[_cell(x.get(k)) if not isinstance(x.get(k), (dict, list)) else json.dumps(x.get(k))[:500] for k in keys] for x in obj[:MAX_ROWS]]
            return _table(keys, rows, len(obj) > MAX_ROWS)
        return {"columns": [], "rows": [], "row_count": 0, "truncated": len(text) > TEXT_LIMIT, "text": json.dumps(obj, indent=1, ensure_ascii=False)[:TEXT_LIMIT]}
    return {"columns": [], "rows": [], "row_count": 0, "truncated": len(text) > TEXT_LIMIT, "text": text[:TEXT_LIMIT]}


def _table(header: list[Any], rows: list[list[Any]], truncated: bool) -> dict[str, Any]:
    width = max([len(header)] + [len(r) for r in rows[:1000]] + [0])
    cols = _dedupe([str(h) if h is not None else "" for h in header] + [""] * (width - len(header)))
    rows = [r + [""] * (width - len(r)) for r in rows]
    if not cols:
        raise UploadError("The file has no header row.")
    return {"columns": cols, "rows": rows, "row_count": len(rows), "truncated": truncated, "text": ""}


async def store(session: AsyncSession, user_id, filename: str, content_type: str, data: bytes) -> AssistantUpload:
    parsed = parse(filename, data)
    now = utcnow()
    up = AssistantUpload(
        user_id=user_id, filename=re.sub(r"[^\w.\- ()]+", "_", filename)[:200], content_type=(content_type or "")[:100], size=len(data),
        sha256=hashlib.sha256(data).hexdigest(), columns=parsed["columns"], rows=parsed["rows"], row_count=parsed["row_count"],
        truncated=parsed["truncated"], text=parsed["text"], created_at=now, expires_at=now + timedelta(days=KEEP_DAYS),
    )
    session.add(up)
    await session.flush()
    return up


# ----------------------------------------------------------------------------- numbers


_NUM_CLEAN = re.compile(r"[₹,\s]|^rs\.?|inr", re.I)


def to_decimal(v: Any) -> Decimal | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return Decimal(str(v))
    s = _NUM_CLEAN.sub("", str(v or "")).strip()
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    if not s or not re.fullmatch(r"-?\d+(\.\d+)?", s):
        return None
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def profile(up: AssistantUpload) -> dict[str, Any]:
    if not up.columns:
        return {"id": str(up.id), "filename": up.filename, "kind": "text", "characters": len(up.text), "truncated": up.truncated, "preview": up.text[:3000]}
    cols = []
    for i, name in enumerate(up.columns):
        values = [r[i] for r in up.rows if i < len(r) and r[i] not in ("", None)]
        nums = [d for d in (to_decimal(v) for v in values) if d is not None]
        kind = "number" if values and len(nums) >= 0.9 * len(values) else ("date" if values and all(re.match(r"^\d{4}-\d{2}-\d{2}", str(v)) or re.match(r"^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", str(v)) for v in values[:50]) else "text")
        info: dict[str, Any] = {"name": name, "type": kind, "filled": len(values), "empty": up.row_count - len(values), "distinct": len(set(map(str, values)))}
        if kind == "number" and nums:
            total = sum(nums)
            info |= {"sum": str(total), "min": str(min(nums)), "max": str(max(nums)), "average": str((total / len(nums)).quantize(Decimal("0.01")))}
        else:
            info["examples"] = [str(v)[:40] for v, _ in Counter(map(str, values)).most_common(3)]
        cols.append(info)
    return {"id": str(up.id), "filename": up.filename, "kind": "table", "rows": up.row_count, "truncated": up.truncated, "columns": cols,
            "first_rows": [dict(zip(up.columns, r, strict=False)) for r in up.rows[:5]]}


# ----------------------------------------------------------------------------- query


OPS = ("equals", "not_equals", "contains", "greater_than", "less_than", "is_empty", "not_empty")
METRICS = ("count", "sum", "average", "min", "max")


def _col(up: AssistantUpload, name: str) -> int:
    for i, c in enumerate(up.columns):
        if c.lower() == str(name).strip().lower():
            return i
    raise ValueError(f"No column named '{name}'. Columns are: {', '.join(up.columns[:40])}")


def _match(v: Any, op: str, want: Any) -> bool:
    s = str(v if v is not None else "").strip()
    if op == "is_empty":
        return s == ""
    if op == "not_empty":
        return s != ""
    if op in ("greater_than", "less_than"):
        a, b = to_decimal(v), to_decimal(want)
        if a is None or b is None:
            return False
        return a > b if op == "greater_than" else a < b
    w = str(want if want is not None else "").strip().lower()
    if op == "contains":
        return w in s.lower()
    da, db = to_decimal(v), to_decimal(want)
    eq = (da == db) if da is not None and db is not None else s.lower() == w
    return eq if op == "equals" else not eq


def query(up: AssistantUpload, *, filters: list[dict] | None = None, group_by: str | None = None, metric: str = "count",
          value_column: str | None = None, sort: str = "desc", limit: int = 50) -> dict[str, Any]:
    if not up.columns:
        raise ValueError("This file is plain text, not a table")
    if metric not in METRICS:
        raise ValueError(f"metric is one of {', '.join(METRICS)}")
    rows = up.rows
    for f in filters or []:
        op = f.get("op", "equals")
        if op not in OPS:
            raise ValueError(f"op is one of {', '.join(OPS)}")
        i = _col(up, f.get("column", ""))
        rows = [r for r in rows if _match(r[i] if i < len(r) else "", op, f.get("value"))]
    vi = _col(up, value_column) if value_column else None
    if metric != "count" and vi is None:
        raise ValueError("Say which column to add up (value_column)")

    def agg(rs: list[list[Any]]) -> Decimal | int:
        if metric == "count":
            return len(rs)
        nums = [d for d in (to_decimal(r[vi]) for r in rs) if d is not None]
        if not nums:
            return Decimal(0)
        return {"sum": lambda: sum(nums), "average": lambda: (sum(nums) / len(nums)).quantize(Decimal("0.01")), "min": lambda: min(nums), "max": lambda: max(nums)}[metric]()

    limit = max(1, min(int(limit or 50), 500))
    if group_by:
        gi = _col(up, group_by)
        groups: dict[str, list] = defaultdict(list)
        for r in rows:
            groups[str(r[gi]) if gi < len(r) else ""].append(r)
        items = [{"group": k or "(blank)", "value": agg(v), "rows": len(v)} for k, v in groups.items()]
        items.sort(key=lambda x: Decimal(str(x["value"])), reverse=sort != "asc")
        return {"matched_rows": len(rows), "groups": len(items), "metric": metric, "value_column": value_column,
                "items": [{**x, "value": str(x["value"])} for x in items[:limit]]}
    return {"matched_rows": len(rows), "metric": metric, "value_column": value_column, "value": str(agg(rows)),
            "sample": [dict(zip(up.columns, r, strict=False)) for r in rows[:min(limit, 20)]]}


# ----------------------------------------------------------------------------- compare with live data


# entity -> (live key description, candidate header names for the key, comparable fields)
ENTITIES: dict[str, dict[str, Any]] = {
    "orders": {"key": "order number", "headers": ("order", "order number", "order no", "order_no", "order id", "order_id"),
               "fields": {"total": ("order total", "grand total", "total", "amount", "value"), "status": ("status", "order status"), "payment": ("payment", "payment method", "mode")}},
    "packages": {"key": "package number", "headers": ("package", "package number", "sub order", "suborder", "shipment"),
                 "fields": {"total": ("package total", "total", "amount"), "status": ("status",), "awb": ("awb", "tracking", "tracking number")}},
    "products": {"key": "SKU", "headers": ("sku", "seller sku", "item sku", "product sku"),
                 "fields": {"price": ("price", "selling price", "sale price"), "mrp": ("mrp",), "stock": ("stock", "quantity", "qty", "inventory"), "status": ("status",)}},
    "payouts": {"key": "payout number or UTR", "headers": ("payout", "payout number", "utr", "reference", "utr number"),
                "fields": {"amount": ("amount", "payout amount", "value"), "status": ("status",), "utr": ("utr",)}},
    "customers": {"key": "mobile or email", "headers": ("mobile", "phone", "email", "customer phone", "contact"),
                  "fields": {"orders": ("orders", "order count"), "name": ("name", "customer name")}},
    "sellers": {"key": "GSTIN", "headers": ("gstin", "gst", "gst number"), "fields": {"status": ("status",), "store": ("store", "store name", "seller", "name")}},
}
MONEY_FIELDS = {"total", "price", "mrp", "amount"}


def _guess(up: AssistantUpload, names: tuple[str, ...]) -> str | None:
    lower = {c.lower().strip(): c for c in up.columns}
    for n in names:
        if n in lower:
            return lower[n]
    for c in up.columns:
        if any(n in c.lower() for n in names):
            return c
    return None


async def _live(session: AsyncSession, entity: str, keys: list[str]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not keys:
        return out
    for i in range(0, len(keys), 1000):
        chunk = keys[i:i + 1000]
        if entity == "orders":
            rows = (await session.execute(select(Order.number, Order.grand_total, Order.status, Order.payment_method).where(func.upper(Order.number).in_([k.upper() for k in chunk])))).all()
            out |= {n.upper(): {"total": t, "status": s, "payment": p} for n, t, s, p in rows}
        elif entity == "packages":
            rows = (await session.execute(select(SubOrder.number, SubOrder.total, SubOrder.status, SubOrder.tracking_number).where(func.upper(SubOrder.number).in_([k.upper() for k in chunk])))).all()
            out |= {n.upper(): {"total": t, "status": s, "awb": a} for n, t, s, a in rows}
        elif entity == "products":
            rows = (await session.execute(select(Variant.sku, Variant.price_paise, Variant.mrp_paise, Variant.stock, Product.status)
                                          .join(Product, Product.id == Variant.product_id).where(func.upper(Variant.sku).in_([k.upper() for k in chunk])))).all()
            out |= {n.upper(): {"price": p, "mrp": m, "stock": st, "status": s} for n, p, m, st, s in rows}
        elif entity == "payouts":
            ups = [k.upper() for k in chunk]
            rows = (await session.execute(select(Payout.number, Payout.utr, Payout.amount, Payout.status).where((func.upper(Payout.number).in_(ups)) | (func.upper(Payout.utr).in_(ups))))).all()
            for n, utr, a, s in rows:
                rec = {"amount": a, "status": s, "utr": utr}
                out[n.upper()] = rec
                if utr:
                    out[utr.upper()] = rec
        elif entity == "customers":
            phones = [re.sub(r"\D", "", k)[-10:] for k in chunk]
            emails = [k.lower() for k in chunk if "@" in k]
            n_orders = select(func.count()).where(Order.user_id == User.id, Order.status == "placed").correlate(User).scalar_subquery()
            rows = (await session.execute(select(User.phone, User.email, User.name, n_orders).where((User.phone.in_(phones)) | (func.lower(User.email).in_(emails))))).all()
            for ph, em, name, n in rows:
                rec = {"orders": int(n or 0), "name": name or ""}
                if ph:
                    out[ph] = rec
                if em:
                    out[em.lower()] = rec
        elif entity == "sellers":
            rows = (await session.execute(select(Seller.gstin, Seller.status, Seller.display_name).where(func.upper(Seller.gstin).in_([k.upper() for k in chunk])))).all()
            out |= {(g or "").upper(): {"status": s, "store": d} for g, s, d in rows}
    return out


def _norm_key(entity: str, v: Any) -> str:
    s = str(v or "").strip()
    if entity == "customers":
        return s.lower() if "@" in s else re.sub(r"\D", "", s)[-10:]
    return s.upper()


async def compare(session: AsyncSession, up: AssistantUpload, *, entity: str, key_column: str | None = None,
                  columns: dict[str, str] | None = None, limit: int = 100) -> dict[str, Any]:
    """Matches every row of the file to live records and lists what differs.

    ``columns`` maps a live field (e.g. ``total``) to the file's column header. Money in the file is in
    rupees; live money is converted from paise before comparing. Differences under ₹0.01 are ignored.
    """
    if entity not in ENTITIES:
        raise ValueError(f"entity is one of {', '.join(ENTITIES)}")
    if not up.columns:
        raise ValueError("This file is plain text, not a table")
    spec = ENTITIES[entity]
    key_col = key_column or _guess(up, spec["headers"])
    if not key_col:
        raise ValueError(f"Which column holds the {spec['key']}? Columns are: {', '.join(up.columns[:40])}")
    ki = _col(up, key_col)
    mapping = dict(columns or {})
    if not mapping:
        for field_name, names in spec["fields"].items():
            c = _guess(up, names)
            if c and c != key_col:
                mapping[field_name] = c
    for field_name in mapping:
        if field_name not in spec["fields"]:
            raise ValueError(f"For {entity} you can compare: {', '.join(spec['fields'])}")
    idx = {f: _col(up, c) for f, c in mapping.items()}
    keys = [_norm_key(entity, r[ki]) for r in up.rows if ki < len(r) and str(r[ki]).strip()]
    live = await _live(session, entity, list(dict.fromkeys(keys)))
    matched = missing = differing = 0
    diffs: list[dict[str, Any]] = []
    not_found: list[str] = []
    totals = {f: {"file": Decimal(0), "live": Decimal(0)} for f in idx if f in MONEY_FIELDS or f in ("stock", "orders")}
    seen: Counter = Counter()
    for r in up.rows:
        raw = r[ki] if ki < len(r) else ""
        k = _norm_key(entity, raw)
        if not k:
            continue
        seen[k] += 1
        rec = live.get(k)
        if rec is None:
            missing += 1
            if len(not_found) < limit:
                not_found.append(str(raw))
            continue
        matched += 1
        row_diffs = []
        for f, i in idx.items():
            fv = r[i] if i < len(r) else ""
            lv = rec.get(f)
            if f in MONEY_FIELDS:
                a, b = to_decimal(fv), Decimal(int(lv or 0)) / 100
                if a is not None:
                    totals[f]["file"] += a
                    totals[f]["live"] += b
                if a is None or abs(a - b) >= Decimal("0.01"):
                    row_diffs.append({"field": f, "file": str(fv), "live": f"{b:.2f}"})
            elif f in ("stock", "orders"):
                a = to_decimal(fv)
                if a is not None:
                    totals[f]["file"] += a
                    totals[f]["live"] += Decimal(int(lv or 0))
                if a is None or a != Decimal(int(lv or 0)):
                    row_diffs.append({"field": f, "file": str(fv), "live": str(lv)})
            elif str(fv).strip().lower() != str(lv or "").strip().lower():
                row_diffs.append({"field": f, "file": str(fv), "live": str(lv or "")})
        if row_diffs:
            differing += 1
            if len(diffs) < limit:
                diffs.append({"key": str(raw), "differences": row_diffs})
    dupes = [k for k, n in seen.items() if n > 1][:20]
    return {
        "entity": entity, "key_column": key_col, "compared_columns": mapping, "file_rows": up.row_count, "rows_with_key": sum(seen.values()),
        "matched": matched, "not_found_in_live": missing, "rows_with_differences": differing, "rows_identical": matched - differing,
        "duplicate_keys_in_file": dupes,
        "totals": {f: {"file": f"{v['file']:.2f}", "live": f"{v['live']:.2f}", "difference": f"{v['file'] - v['live']:.2f}"} for f, v in totals.items()},
        "differences": diffs, "not_found": not_found,
    }
