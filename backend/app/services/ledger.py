"""Seller ledger and payouts.

Delivery posts the sale and its deductions (available after the return window). A refunded return posts
proportional reversals (available at once). A payout run sweeps each seller's available, unpaid entries
into one payout when the net is positive. Payouts are executed by hand (bank CSV + UTR) or through
RazorpayX, idempotently keyed by our payout id.
"""
from __future__ import annotations

import logging
import re
import secrets
import uuid
from datetime import date, datetime, time, timedelta, timezone

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.errors import ApiError, Conflict
from app.core.security import decrypt_field
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import LedgerEntry, Payout, ReturnRequest, Seller, SubOrder
from app.services.delivery import IST
from app.services.notify import notify_seller

log = logging.getLogger("pixcart.ledger")

PAYOUT_RUN_IST = time(10, 0)  # the payout job (jobs.py) starts every day at this time and pays only on payout days
_WEEK_ZERO = date(2024, 1, 1)  # a Monday: "every second week" counts whole weeks from here


def _entry(seller_id, kind, amount, available_at, *, sub=None, ret=None, desc="") -> LedgerEntry:
    return LedgerEntry(
        seller_id=seller_id, kind=kind, amount=amount, available_at=available_at, description=desc[:200],
        sub_order_id=sub.id if sub else None, return_id=ret.id if ret else None, created_at=utcnow(),
    )


async def post_delivery(session: AsyncSession, sub: SubOrder) -> None:
    exists = (await session.execute(select(LedgerEntry.id).where(LedgerEntry.sub_order_id == sub.id, LedgerEntry.kind == "sale"))).first()
    if exists:
        return
    due = sub.settlement_due_at or utcnow()
    for kind, amount in (
        ("sale", sub.total),
        ("commission", -sub.commission_paise),
        ("commission_gst", -sub.commission_gst_paise),
        ("tcs", -sub.tcs_paise),
        ("tds", -sub.tds_paise),
    ):
        if amount:
            session.add(_entry(sub.seller_id, kind, amount, due, sub=sub, desc=f"{kind.replace('_', ' ').title()} {sub.number}"))


async def post_return(session: AsyncSession, sub: SubOrder, ret: ReturnRequest, seller_value: int) -> None:
    """Reverses the share of the sale and its deductions for a refunded return.

    seller_value: the part of the seller's sale value being returned (excludes platform-funded discount).
    """
    if sub.total <= 0 or seller_value <= 0:
        return
    share = seller_value / sub.total
    now = utcnow()
    rows = [
        ("return", -seller_value),
        ("commission_reversal", round(sub.commission_paise * share)),
        ("commission_gst_reversal", round(sub.commission_gst_paise * share)),
        ("tcs_reversal", round(sub.tcs_paise * share)),
        ("tds_reversal", round(sub.tds_paise * share)),
    ]
    for kind, amount in rows:
        if amount:
            session.add(_entry(sub.seller_id, kind, amount, now, sub=sub, ret=ret, desc=f"Return {ret.number}"))


async def balances(session: AsyncSession, seller_id: uuid.UUID) -> dict:
    now = utcnow()
    q = select(
        func.coalesce(func.sum(LedgerEntry.amount).filter(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now), 0),
        func.coalesce(func.sum(LedgerEntry.amount).filter(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at > now), 0),
        func.coalesce(func.sum(LedgerEntry.amount).filter(LedgerEntry.payout_id.is_not(None)), 0),
    ).where(LedgerEntry.seller_id == seller_id)
    available, upcoming, paid = (await session.execute(q)).one()
    return {"available": int(available), "upcoming": int(upcoming), "paid_out": int(paid)}


async def create_payouts(session: AsyncSession, *, min_amount: int = 100, seller_ids: list[uuid.UUID] | None = None) -> list[Payout]:
    """One payout per seller with a positive available balance. Negative balances carry forward."""
    now = utcnow()
    payout_mode = (await get_integrations(session)).payout_mode
    q = (
        select(LedgerEntry.seller_id, func.sum(LedgerEntry.amount))
        .join(Seller, Seller.id == LedgerEntry.seller_id)
        .where(LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now, Seller.status == "approved")
        .group_by(LedgerEntry.seller_id)
    )
    if seller_ids:
        q = q.where(LedgerEntry.seller_id.in_(seller_ids))
    created = []
    for seller_id, amount in (await session.execute(q)).all():
        if int(amount) < min_amount:
            continue
        # Lock the seller row so two runs cannot sweep the same entries.
        seller = (await session.execute(select(Seller).where(Seller.id == seller_id).with_for_update())).scalar_one()
        entry_ids = list(
            (
                await session.execute(
                    select(LedgerEntry.id).where(LedgerEntry.seller_id == seller_id, LedgerEntry.payout_id.is_(None), LedgerEntry.available_at <= now).with_for_update()
                )
            ).scalars()
        )
        total = (await session.execute(select(func.sum(LedgerEntry.amount)).where(LedgerEntry.id.in_(entry_ids)))).scalar_one()
        if not total or int(total) < min_amount:
            continue
        acct = decrypt_field(seller.bank_account_enc)
        payout = Payout(
            number=f"PO{now:%y%m%d}{secrets.token_hex(3).upper()}",
            seller_id=seller_id,
            amount=int(total),
            mode=payout_mode,
            bank_snapshot={"holder": seller.bank_holder_name, "account_last4": acct[-4:], "ifsc": seller.bank_ifsc},
        )
        session.add(payout)
        await session.flush()
        await session.execute(update(LedgerEntry).where(LedgerEntry.id.in_(entry_ids)).values(payout_id=payout.id))
        # Sub-orders whose sale entry is now in a payout are settled.
        await session.execute(
            update(SubOrder)
            .where(SubOrder.id.in_(select(LedgerEntry.sub_order_id).where(LedgerEntry.payout_id == payout.id, LedgerEntry.kind == "sale")))
            .values(settlement_status="paid")
        )
        created.append(payout)
    await session.flush()
    return created


def is_payout_day(cfg: dict, day: date) -> bool:
    """Automatic payouts run on the weekday set in Admin → Settings, every week or every second week (IST dates)."""
    return day.weekday() == cfg["payout_weekday"] and (day - _WEEK_ZERO).days // 7 % cfg["payout_every_weeks"] == 0


def payout_schedule(cfg: dict, now: datetime | None = None) -> dict:
    """The automatic payout schedule sellers see; ``next_at`` is when the next run starts (None when runs are off)."""
    now = now or utcnow()
    next_at = None
    if cfg["auto_payouts"]:
        today = now.astimezone(IST).date()
        runs = (datetime.combine(today + timedelta(days=n), PAYOUT_RUN_IST, IST) for n in range(15))
        next_at = next((r for r in runs if r > now and is_payout_day(cfg, r.date())), None)
    return {"auto": cfg["auto_payouts"], "weekday": cfg["payout_weekday"], "every_weeks": cfg["payout_every_weeks"],
            "min_paise": cfg["payout_min_paise"], "next_at": next_at.astimezone(timezone.utc).isoformat() if next_at else None}


async def mark_paid(session: AsyncSession, payout: Payout, utr: str) -> None:
    if payout.status in ("paid", "cancelled"):
        raise Conflict(f"Payout is already {payout.status}", "invalid_status")
    payout.status, payout.utr, payout.paid_at = "paid", utr, utcnow()
    await notify_seller(
        session, payout.seller_id, "payout_sent",
        {"payout_number": payout.number, "amount": f"₹{payout.amount / 100:,.2f}", "last4": payout.bank_snapshot.get("account_last4", ""), "utr": utr},
        link="/seller/payouts",
    )


async def fail_payout(session: AsyncSession, payout: Payout, reason: str) -> None:
    """Returns the swept entries to the available balance so the next run picks them up again."""
    payout.status, payout.failure_reason = "failed", reason[:300]
    await session.execute(update(LedgerEntry).where(LedgerEntry.payout_id == payout.id).values(payout_id=None))
    await session.execute(
        update(SubOrder).where(SubOrder.settlement_status == "paid", SubOrder.id.in_(select(LedgerEntry.sub_order_id).where(LedgerEntry.payout_id.is_(None)))).values(settlement_status="pending")
    )


# ----------------------------------------------------------------------------- RazorpayX

transport: httpx.AsyncBaseTransport | None = None


async def _rx(cfg: Settings, method: str, path: str, json: dict, idem: str | None = None) -> dict:
    # RazorpayX requires X-Payout-Idempotency on every payout since 15 March 2025; a retry with the
    # same key returns the existing payout instead of paying twice.
    headers = {"X-Payout-Idempotency": idem} if idem else {}
    async with httpx.AsyncClient(base_url=cfg.razorpay_api_base, auth=(cfg.razorpay_key_id, cfg.razorpay_key_secret), timeout=20, transport=transport) as c:
        r = await c.request(method, path, json=json, headers=headers)
    if r.status_code >= 400:
        raise ApiError(f"RazorpayX: {r.json().get('error', {}).get('description', r.text[:200])}", "payout_gateway", 502)
    return r.json()


async def execute_razorpayx(session: AsyncSession, payout: Payout) -> None:
    cfg = await get_integrations(session)
    if not (cfg.razorpay_enabled and cfg.razorpayx_account_number):
        raise ApiError("RazorpayX is not configured", "payout_not_configured")
    seller = await session.get(Seller, payout.seller_id)
    if not seller.payout_fund_account_id:
        contact = await _rx(cfg, "POST", "/contacts", {"name": seller.legal_name[:50], "email": seller.contact_email, "contact": seller.contact_phone, "type": "vendor", "reference_id": str(seller.id)[:40]})
        fund = await _rx(
            cfg, "POST", "/fund_accounts",
            {"contact_id": contact["id"], "account_type": "bank_account", "bank_account": {"name": seller.bank_holder_name, "ifsc": seller.bank_ifsc, "account_number": decrypt_field(seller.bank_account_enc)}},
        )
        seller.payout_contact_id, seller.payout_fund_account_id = contact["id"], fund["id"]
    data = await _rx(
        cfg, "POST", "/payouts",
        {
            "account_number": cfg.razorpayx_account_number,
            "fund_account_id": seller.payout_fund_account_id,
            "amount": payout.amount,
            "currency": "INR",
            "mode": "IMPS" if payout.amount <= 500_000_00 else "NEFT",
            "purpose": "vendor bill",
            "queue_if_low_balance": True,
            "reference_id": payout.number,
            "narration": _narration(await _brand(session), payout.number),
        },
        idem=str(payout.id),
    )
    payout.provider_payout_id = data.get("id", "")
    payout.status = "processing"


async def apply_payout_webhook(session: AsyncSession, payout_id: str, status: str, utr: str, reason: str) -> None:
    payout = (await session.execute(select(Payout).where(Payout.provider_payout_id == payout_id).with_for_update())).scalar_one_or_none()
    if payout is None:
        return
    if status == "processed" and payout.status != "paid":
        await mark_paid(session, payout, utr or "")
    elif status in ("failed", "reversed", "rejected", "cancelled") and payout.status not in ("failed", "cancelled"):
        await fail_payout(session, payout, reason or status)


async def _brand(session: AsyncSession) -> str:
    from app.services.cms import get_site

    return (await get_site(session))["brand_name"]


def _narration(brand: str, number: str) -> str:
    # Banks accept letters, digits and spaces in the narration, up to 30 characters.
    return " ".join(re.sub(r"[^A-Za-z0-9 ]", " ", f"{brand} {number}").split())[:30].strip()


def _csv_cell(value: str) -> str:
    """Quotes a cell and defuses spreadsheet formulas (a name starting with =, +, - or @)."""
    v = str(value)
    if v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        v = "'" + v
    return '"' + v.replace('"', '""') + '"'


def bank_csv(rows: list[tuple[Payout, Seller]], brand: str) -> str:
    out = ["Payout number,Beneficiary name,Account number,IFSC,Amount (INR),Narration"]
    for p, s in rows:
        acct = decrypt_field(s.bank_account_enc)
        out.append(",".join([_csv_cell(p.number), _csv_cell(s.bank_holder_name), _csv_cell(acct), _csv_cell(s.bank_ifsc), f"{p.amount / 100:.2f}", _csv_cell(_narration(brand, p.number))]))
    return "\n".join(out) + "\n"


def payout_out(p: Payout, seller_name: str = "") -> dict:
    return {
        "id": str(p.id), "number": p.number, "seller_id": str(p.seller_id), "seller_name": seller_name, "amount": p.amount,
        "status": p.status, "mode": p.mode, "utr": p.utr, "failure_reason": p.failure_reason, "bank": p.bank_snapshot,
        "created_at": p.created_at.isoformat(), "paid_at": p.paid_at.isoformat() if p.paid_at else None,
    }
