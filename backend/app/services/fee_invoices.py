"""The marketplace's own tax invoice for the fees on an order (handling, small cart, platform, bad weather, late night).

Sellers invoice the goods, delivery and cash on delivery (services/invoices). These fees are the operator's own supply
of a service, so the operator invoices them under its GSTIN, in its own gap-free series per financial year
(``MKT/26-27/000001``; prefix and SAC code in Admin → Checkout and fees), with CGST + SGST when the customer's state is
the operator's and IGST otherwise. The invoice is issued when the first package of the order is delivered (the service
has been given and, for cash on delivery, paid), or when every package is cancelled while the marketplace keeps the
fees. Fees given back on cancellation are therefore never invoiced, so no credit note is needed for them. Without a
GSTIN in Admin → Storefront → Business no invoice is issued (an unregistered operator cannot issue tax invoices).
"""
from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import STATES
from app.db import utcnow
from app.models import Order, PlatformSetting
from app.services import fees as fees_svc
from app.services.invoices import IST, _addr, _money, _pdf, fiscal_year, rupees_in_words

KEY = "operator_documents"  # platform_settings row holding the operator's counters: {"INV/26-27": last number}


async def _operator(session: AsyncSession) -> dict:
    from app.services.cms import get_site, public_business

    return public_business(await get_site(session))


async def _next_number(session: AsyncSession, prefix: str, when) -> str:
    """Gap-free: the counter row is locked until the order's transaction commits (a rollback gives the number back)."""
    fy = fiscal_year(when)
    await session.execute(insert(PlatformSetting).values(key=KEY, value={}, updated_at=utcnow()).on_conflict_do_nothing(index_elements=[PlatformSetting.key]))
    row = (await session.execute(select(PlatformSetting).where(PlatformSetting.key == KEY).with_for_update()
                                 .execution_options(populate_existing=True))).scalar_one()
    counters = dict(row.value or {})
    n = int(counters.get(f"INV/{fy}", 0)) + 1
    counters[f"INV/{fy}"] = n
    row.value, row.updated_at = counters, utcnow()
    return f"{prefix}/{fy}/{n:06d}"[:16]


async def issue(session: AsyncSession, order: Order) -> None:
    """Gives the order its fee invoice number, once (no-op without fees or without the operator's GSTIN)."""
    if order.fee_invoice_number or not order.fees_total or not order.fees:
        return
    if not (await _operator(session))["gstin"]:
        return
    now = utcnow()
    order.fee_invoice_number = await _next_number(session, (await fees_svc.get(session))["fee_invoice_prefix"], now)
    order.fee_invoice_date = now


async def pdf(session: AsyncSession, order: Order) -> bytes:
    op = await _operator(session)
    ck = await fees_svc.get(session)
    st = order.ship_to or {}
    buyer_state = (order.buyer_gstin or "")[:2] or st.get("state_code", "")
    intra = bool(op["gstin"]) and op["gstin"][:2] == buyer_state
    rows = []
    for i, f in enumerate(order.fees or [], start=1):
        gst = int(f.get("gst", 0))
        cgst = gst // 2 if intra else 0
        rows.append([i, f.get("label", ""), ck["fees_sac_code"], 1, _money(int(f["amount"])), "0.00", _money(int(f.get("taxable", f["amount"]))),
                     f"{int(f.get('gst_bps', 0)) / 100:g}", _money(cgst), _money(gst - cgst if intra else 0), _money(0 if intra else gst), _money(int(f["amount"]))])
    header = [
        ["Invoice number", order.fee_invoice_number or "-"],
        ["Invoice date", (order.fee_invoice_date or order.created_at).astimezone(IST).strftime("%d %b %Y")],
        ["Order", order.number],
        ["Place of supply", f"{STATES.get(buyer_state, '')} ({buyer_state})"],
        ["Reverse charge", "No"],
    ]
    issuer = "<b>Issued by</b><br/>" + _addr([op["legal_name"], op["registered_address"], f"GSTIN: {op['gstin']}"])
    buyer = (("<b>Bill to</b><br/>" + _addr([order.buyer_business, f"GSTIN: {order.buyer_gstin}"]) + "<br/>") if order.buyer_gstin else "<b>Bill to</b><br/>") \
        + _addr([st.get("full_name", ""), st.get("line1", ""), st.get("line2", ""), f"{st.get('city', '')}, {st.get('state', '')} {st.get('pincode', '')}"])
    totals = [["Total (inclusive of GST)", _money(order.fees_total)], ["Amount in words", ""], [rupees_in_words(order.fees_total), ""]]
    note = (f"Tax invoice for {op['legal_name']}'s own service fees on order {order.number}. The goods, delivery and cash on delivery are "
            "invoiced separately by each seller. This is a computer-generated invoice and does not need a signature.")
    return await asyncio.to_thread(_pdf, "Tax invoice: marketplace fees", header, [[issuer, buyer]], rows, totals, note)
