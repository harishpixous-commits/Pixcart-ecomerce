"""Reports shared by the admin screens and the CSV exports."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Order, Seller, SubOrder
from app.services.platform_settings import get_settings

IST = timezone(timedelta(hours=5, minutes=30))


def month_bounds(month: str) -> tuple[datetime, datetime]:
    year, mon = int(month[:4]), int(month[5:])
    start = datetime(year, mon, 1, tzinfo=IST)
    end = datetime(year + (mon == 12), 1 if mon == 12 else mon + 1, 1, tzinfo=IST)
    return start, end


async def tcs_report_data(session: AsyncSession, month: str) -> dict:
    """Supplier-wise net taxable value and TCS for GSTR-8: packages placed in the month (IST), less returns
    received in the month."""
    start, end = month_bounds(month)
    cfg = await get_settings(session)
    rows = (
        await session.execute(
            select(
                Seller.id,
                Seller.legal_name,
                Seller.gstin,
                SubOrder.is_interstate,
                func.sum(SubOrder.taxable_total),
                func.sum(SubOrder.tcs_paise),
                func.count(),
            )
            .join(Order, Order.id == SubOrder.order_id)
            .join(Seller, Seller.id == SubOrder.seller_id)
            .where(Order.placed_at >= start, Order.placed_at < end, SubOrder.status != "cancelled")
            .group_by(Seller.id, Seller.legal_name, Seller.gstin, SubOrder.is_interstate)
            .order_by(Seller.legal_name)
        )
    ).all()
    # Returns received in the month reduce that month's figures (GSTR-8 reports net supplies).
    from app.models import LedgerEntry, OrderItem, ReturnItem, ReturnRequest

    returned_value = dict(
        (
            await session.execute(
                select(SubOrder.id, func.sum(OrderItem.taxable_value * ReturnItem.qty / OrderItem.qty))
                .join(ReturnRequest, ReturnRequest.sub_order_id == SubOrder.id)
                .join(ReturnItem, ReturnItem.return_id == ReturnRequest.id)
                .join(OrderItem, OrderItem.id == ReturnItem.order_item_id)
                .where(ReturnRequest.received_at >= start, ReturnRequest.received_at < end)
                .group_by(SubOrder.id)
            )
        ).all()
    )
    returned_tcs = dict(
        (
            await session.execute(
                select(LedgerEntry.sub_order_id, func.sum(LedgerEntry.amount))
                .where(LedgerEntry.kind == "tcs_reversal", LedgerEntry.created_at >= start, LedgerEntry.created_at < end)
                .group_by(LedgerEntry.sub_order_id)
            )
        ).all()
    )
    return_rows = []
    if returned_value or returned_tcs:
        subs = (await session.execute(select(SubOrder, Seller).join(Seller, Seller.id == SubOrder.seller_id).where(SubOrder.id.in_(set(returned_value) | set(returned_tcs))))).all()
        return_rows = [(sel.id, sel.legal_name, sel.gstin, sub.is_interstate, -int(returned_value.get(sub.id) or 0), -int(returned_tcs.get(sub.id) or 0), 0) for sub, sel in subs]

    out: dict[uuid.UUID, dict] = {}
    for sid, name, gstin, inter, taxable, tcs, n in [*rows, *return_rows]:
        r = out.setdefault(sid, {"seller_id": str(sid), "legal_name": name, "gstin": gstin, "net_taxable_value": 0, "igst_tcs": 0, "cgst_tcs": 0, "sgst_tcs": 0, "sub_orders": 0, "returned_value": 0})
        r["net_taxable_value"] += int(taxable or 0)
        if int(taxable or 0) < 0:
            r["returned_value"] -= int(taxable)
        r["sub_orders"] += n
        tcs = int(tcs or 0)
        if inter:
            r["igst_tcs"] += tcs
        else:
            half = int(tcs / 2)  # towards zero, so returns split the same way as sales
            r["cgst_tcs"] += half
            r["sgst_tcs"] += tcs - half
    items = list(out.values())
    return {
        "month": month,
        "tcs_rate_bps": cfg["tcs_bps"],
        "note": "Basis for GSTR-8 (due by the 10th of the next month): packages placed in the month, less returns received in the month. Verify with your CA before filing.",
        "items": items,
        "totals": {k: sum(i[k] for i in items) for k in ("net_taxable_value", "igst_tcs", "cgst_tcs", "sgst_tcs")},
    }
