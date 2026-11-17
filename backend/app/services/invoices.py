"""GST tax invoices (issued by the seller, per sub-order) and credit notes (for returns), as PDF.

Numbering follows CGST rule 46: consecutive, unique per financial year, at most 16 characters,
e.g. ``MCS/26-27/000123``. The counter row is locked so numbers have no gaps or duplicates.
"""
from __future__ import annotations

import asyncio
import io
import re
from datetime import datetime, timedelta, timezone

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import STATES
from app.db import utcnow
from app.models import (
    DocumentCounter,
    Order,
    OrderItem,
    ReturnItem,
    ReturnRequest,
    Seller,
    SubOrder,
    Warehouse,
)

IST = timezone(timedelta(hours=5, minutes=30))


def fiscal_year(dt: datetime) -> str:
    d = dt.astimezone(IST)
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def default_prefix(seller: Seller) -> str:
    letters = re.sub(r"[^A-Z]", "", seller.display_name.upper())
    return (letters[:3] or "INV").ljust(3, "X")


async def next_number(session: AsyncSession, seller: Seller, doc_type: str, when: datetime) -> str:
    fy = fiscal_year(when)
    row = (
        await session.execute(
            select(DocumentCounter)
            .where(DocumentCounter.seller_id == seller.id, DocumentCounter.doc_type == doc_type, DocumentCounter.fiscal_year == fy)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None:
        row = DocumentCounter(seller_id=seller.id, doc_type=doc_type, fiscal_year=fy, last_number=0)
        session.add(row)
        await session.flush()
    row.last_number += 1
    prefix = (seller.invoice_prefix or default_prefix(seller))[:4]
    if doc_type == "CN":
        prefix = f"{prefix[:2]}CN"
    return f"{prefix}/{fy}/{row.last_number:06d}"[:16]


async def assign_invoice(session: AsyncSession, sub: SubOrder) -> None:
    if sub.invoice_number:
        return
    seller = await session.get(Seller, sub.seller_id)
    now = utcnow()
    sub.invoice_number = await next_number(session, seller, "INV", now)
    sub.invoice_date = now


# ----------------------------------------------------------------------------- amount in words (Indian system)

_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split()


def _two(n: int) -> str:
    if n < 20:
        return _ONES[n]
    return _TENS[n // 10 - 2] + ("" if n % 10 == 0 else "-" + _ONES[n % 10])


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append(f"{_ONES[h]} hundred")
    if r:
        parts.append(_two(r))
    return " ".join(parts)


def rupees_in_words(paise: int) -> str:
    rupees, p = divmod(paise, 100)
    parts = []
    for div, name in ((10_000_000, "crore"), (100_000, "lakh"), (1000, "thousand")):
        q, rupees = divmod(rupees, div)
        if q:
            parts.append(f"{_three(q) if q < 1000 else rupees_in_words(q * 100).replace('Rupees ', '').replace(' only', '')} {name}")
    if rupees:
        parts.append(_three(rupees))
    words = " ".join(parts) or "zero"
    out = f"Rupees {words}"
    if p:
        out += f" and {_two(p)} paise"
    return (out + " only").replace("  ", " ").capitalize()


# ----------------------------------------------------------------------------- PDF


def _money(p: int) -> str:
    return f"{p / 100:,.2f}"


def _pdf(title: str, header: list[list[str]], parties: list[list], rows: list[list], totals: list[list], note: str) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=12 * mm, bottomMargin=12 * mm, title=title)
    ss = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=ss["Normal"], fontSize=8, leading=10)
    story = [Paragraph(f"<b>{title}</b>", ParagraphStyle("t", parent=ss["Title"], fontSize=16, alignment=0)), Spacer(1, 4)]
    hdr = Table(header, colWidths=[38 * mm, 140 * mm])
    hdr.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8.5), ("TEXTCOLOR", (0, 0), (0, -1), colors.grey)]))
    story += [hdr, Spacer(1, 6)]
    pt = Table([[Paragraph(c, small) for c in r] for r in parties], colWidths=[89 * mm, 89 * mm])
    pt.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.5, colors.grey), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story += [pt, Spacer(1, 6)]
    head = ["#", "Item", "HSN", "Qty", "Rate", "Disc.", "Taxable", "GST %", "CGST", "SGST", "IGST", "Total"]
    data = [head] + [[Paragraph(str(c), small) if i == 1 else str(c) for i, c in enumerate(r)] for r in rows]
    widths = [6, 52, 12, 8, 15, 12, 17, 10, 13, 13, 13, 17]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E3EFF1")),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
                ("ALIGN", (3, 1), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story += [t, Spacer(1, 6)]
    tt = Table(totals, colWidths=[140 * mm, 38 * mm])
    tt.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8.5), ("ALIGN", (1, 0), (1, -1), "RIGHT"), ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold")]))
    story += [tt, Spacer(1, 8), Paragraph(note, small)]
    doc.build(story)
    return buf.getvalue()


def _addr(lines: list[str]) -> str:
    return "<br/>".join(x for x in lines if x)


async def invoice_pdf(session: AsyncSession, sub: SubOrder) -> bytes:
    from app.services.cms import get_site, public_business

    op = public_business(await get_site(session))
    order = await session.get(Order, sub.order_id)
    seller = await session.get(Seller, sub.seller_id)
    wh = await session.get(Warehouse, sub.warehouse_id) if sub.warehouse_id else None
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalars())
    st = order.ship_to
    origin_state = wh.state_code if wh else seller.pickup_state_code
    gstin = (wh.gstin if wh and wh.gstin else seller.gstin) or ""
    rows, i = [], 0
    for i, it in enumerate(items, start=1):
        rows.append([i, f"{it.title}{' (' + it.variant_label + ')' if it.variant_label else ''}", it.hsn_code, it.qty, _money(it.unit_price), _money(it.seller_discount),
                     _money(it.taxable_value), f"{it.gst_bps / 100:g}", _money(it.cgst), _money(it.sgst), _money(it.igst), _money(it.line_total - it.seller_discount)])
    extra = sub.shipping_fee + sub.cod_fee
    if extra:
        from app.core.money import split_inclusive_gst

        sp = split_inclusive_gst(extra, sub.shipping_gst_bps, interstate=sub.is_interstate)
        rows.append([i + 1, "Delivery charges" + (" and COD fee" if sub.cod_fee else ""), "996812", 1, _money(extra), "0.00", _money(sp.taxable),
                     f"{sub.shipping_gst_bps / 100:g}", _money(sp.cgst), _money(sp.sgst), _money(sp.igst), _money(extra)])
    header = [
        ["Invoice number", sub.invoice_number or "(issued when shipped)"],
        ["Invoice date", (sub.invoice_date or sub.created_at).astimezone(IST).strftime("%d %b %Y")],
        ["Order", f"{order.number} / {sub.number}"],
        ["Place of supply", f"{STATES.get(st.get('state_code', ''), '')} ({st.get('state_code', '')})"],
        ["Reverse charge", "No"],
    ]
    parties = [
        [
            "<b>Sold by</b><br/>" + _addr([seller.legal_name, wh.line1 if wh else seller.pickup_line1, f"{wh.city if wh else seller.pickup_city}, {STATES.get(origin_state, '')} {wh.pincode if wh else seller.pickup_pincode}", f"GSTIN: {gstin}"]),
            "<b>Bill to / Ship to</b><br/>" + _addr([st.get("full_name", ""), st.get("line1", ""), st.get("line2", ""), f"{st.get('city', '')}, {st.get('state', '')} {st.get('pincode', '')}", f"Phone: {st.get('phone', '')}"]),
        ]
    ]
    totals = [["Total (inclusive of GST)", _money(sub.total)], ["Amount in words", ""], [rupees_in_words(sub.total), ""]]
    note = (
        f"This is a computer-generated invoice issued by the seller, {seller.legal_name}, and does not need a signature. "
        f"Sold through {op['legal_name']}{', GSTIN ' + op['gstin'] if op['gstin'] else ''} (e-commerce operator; TCS collected under section 52 of the CGST Act)."
    )
    return await asyncio.to_thread(_pdf, "Tax invoice", header, parties, rows, totals, note)


async def credit_note_pdf(session: AsyncSession, ret: ReturnRequest) -> bytes:
    sub = await session.get(SubOrder, ret.sub_order_id)
    order = await session.get(Order, sub.order_id)
    seller = await session.get(Seller, sub.seller_id)
    items = (await session.execute(select(ReturnItem, OrderItem).join(OrderItem, OrderItem.id == ReturnItem.order_item_id).where(ReturnItem.return_id == ret.id))).all()
    from app.core.money import split_inclusive_gst

    rows = []
    for i, (ri, it) in enumerate(items, start=1):
        value = (it.line_total - it.seller_discount) * ri.qty // it.qty
        sp = split_inclusive_gst(value, it.gst_bps, interstate=sub.is_interstate)
        rows.append([i, it.title, it.hsn_code, ri.qty, _money(it.unit_price), "", _money(sp.taxable), f"{it.gst_bps / 100:g}", _money(sp.cgst), _money(sp.sgst), _money(sp.igst), _money(value)])
    total = sum(int(round(float(r[-1].replace(",", "")) * 100)) for r in rows)
    st = order.ship_to
    header = [
        ["Credit note number", ret.credit_note_number or "-"],
        ["Date", (ret.refunded_at or ret.updated_at).astimezone(IST).strftime("%d %b %Y")],
        ["Against invoice", sub.invoice_number or sub.number],
        ["Return", ret.number],
    ]
    parties = [["<b>Seller</b><br/>" + _addr([seller.legal_name, f"GSTIN: {seller.gstin}"]), "<b>Customer</b><br/>" + _addr([st.get("full_name", ""), f"{st.get('city', '')}, {st.get('state', '')}"])]]
    return await asyncio.to_thread(_pdf, "Credit note", header, parties, rows, [["Total credit", _money(total)], [rupees_in_words(total), ""]], "Issued for goods returned by the customer.")
