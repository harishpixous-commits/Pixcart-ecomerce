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

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.core.errors import ApiError, Conflict
from app.core.security import decrypt_field
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import LedgerEntry, Payout, ReturnRequest, Seller, SubOrder
from app.services.notify import notify_seller

log = logging.getLogger("pixcart.ledger")


def _entry(seller_id, kind, amount, available_at, *, sub=None, ret=None, desc="") -> LedgerEntry:
    return LedgerEntry(
        seller_id=seller_id, kind=kind, amount=amount, available_at=available_at, description=desc[:200],
        sub_order_id=sub.id if sub else None, return_id=ret.id if ret else None, created_at=utcnow(),
    )


async def post_delivery(session: AsyncSession, sub: SubOrder, *, cod_held_by_seller: int = 0) -> None:
    """Posts the sale and its deductions, available after the return window. ``cod_held_by_seller``: cash on delivery
    the seller's own courier collected for this package (it is already with the seller, so it comes off the payout at
    the same time as the sale is paid)."""
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
    if cod_held_by_seller:
        session.add(_entry(sub.seller_id, "cod_collected", -cod_held_by_seller, due, sub=sub, desc=f"Cash collected by your courier {sub.number}"))


async def post_return(session: AsyncSession, sub: SubOrder, ret: ReturnRequest, seller_value: int) -> None:
    """Reverses, for a refunded return, the returned lines' sale value and exactly the deductions charged on them:
    each line's own commission (charged per line at its category's rate), the GST on that commission at the rate
    charged, TCS on the returned taxable value and TDS on the returned gross.

    seller_value: the part of the seller's sale value being returned (excludes platform-funded discount).
    """
    if sub.total <= 0 or seller_value <= 0:
        return
    from app.models import OrderItem, ReturnItem

    lines = (await session.execute(select(ReturnItem.qty, OrderItem).join(OrderItem, OrderItem.id == ReturnItem.order_item_id)
                                   .where(ReturnItem.return_id == ret.id))).all()
    commission = sum(it.commission_paise * qty // it.qty for qty, it in lines if it.qty)
    taxable = sum(it.taxable_value * qty // it.qty for qty, it in lines if it.qty)
    now = utcnow()
    rows = [
        ("return", -seller_value),
        ("commission_reversal", commission),
        ("commission_gst_reversal", round(sub.commission_gst_paise * commission / sub.commission_paise) if sub.commission_paise else 0),
        ("tcs_reversal", round(sub.tcs_paise * taxable / sub.taxable_total) if sub.taxable_total else 0),
        ("tds_reversal", round(sub.tds_paise * seller_value / sub.total)),
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
        payout = Payout(
            number=f"PO{now:%y%m%d}{secrets.token_hex(3).upper()}",
            seller_id=seller_id,
            amount=int(total),
            mode=payout_mode,
            bank_snapshot=bank_snapshot(seller),
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
    """Returns the swept entries to the available balance so the next run picks them up again. Only the packages whose
    sale was in THIS payout go back to unpaid (other sellers' and other payouts' packages are left alone)."""
    payout.status, payout.failure_reason = "failed", reason[:300]
    own_sales = select(LedgerEntry.sub_order_id).where(LedgerEntry.payout_id == payout.id, LedgerEntry.kind == "sale")
    await session.execute(update(SubOrder).where(SubOrder.settlement_status == "paid", SubOrder.id.in_(own_sales)).values(settlement_status="pending"))
    await session.execute(update(LedgerEntry).where(LedgerEntry.payout_id == payout.id).values(payout_id=None))


def bank_snapshot(seller: Seller) -> dict:
    """The account a payout is made out to, fixed when it is created: the bank file and RazorpayX pay exactly this.
    ``account_enc`` stays encrypted and is never sent to a screen (see payout_out)."""
    acct = decrypt_field(seller.bank_account_enc)
    return {"holder": seller.bank_holder_name, "account_last4": acct[-4:], "ifsc": seller.bank_ifsc, "account_enc": seller.bank_account_enc}


def bank_changed(payout: Payout, seller: Seller) -> bool:
    """The seller's bank details changed after this payout was created (staff must confirm before it is paid)."""
    snap = payout.bank_snapshot or {}
    if not snap.get("account_enc"):
        return False  # made before snapshots kept the account: nothing to compare
    return (decrypt_field(snap["account_enc"]) != decrypt_field(seller.bank_account_enc) or snap.get("ifsc") != seller.bank_ifsc
            or snap.get("holder") != seller.bank_holder_name)


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
    seller = await session.get(Seller, payout.seller_id)
    if bank_changed(payout, seller):
        # the fund account below is the seller's current one: never send money to an account staff did not see
        raise Conflict("The seller's bank account changed after this payout was created. Check it with the seller, then confirm the new "
                       "account on the payout (or cancel it) before sending.", "bank_changed")
    if not (cfg.razorpay_enabled and cfg.razorpayx_account_number):
        raise ApiError("RazorpayX is not configured", "payout_not_configured")
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
    """The bank's bulk-transfer file: each payout to the account fixed on it when it was created (payouts whose
    seller changed bank details since are left out: staff confirm them first)."""
    out = ["Payout number,Beneficiary name,Account number,IFSC,Amount (INR),Narration"]
    for p, s in rows:
        snap = p.bank_snapshot or {}
        if bank_changed(p, s):
            continue
        acct = decrypt_field(snap["account_enc"]) if snap.get("account_enc") else decrypt_field(s.bank_account_enc)
        holder, ifsc = snap.get("holder") or s.bank_holder_name, snap.get("ifsc") or s.bank_ifsc
        out.append(",".join([_csv_cell(p.number), _csv_cell(holder), _csv_cell(acct), _csv_cell(ifsc), f"{p.amount / 100:.2f}", _csv_cell(_narration(brand, p.number))]))
    return "\n".join(out) + "\n"


def payout_out(p: Payout, seller_name: str = "", *, seller: Seller | None = None) -> dict:
    return {
        "id": str(p.id), "number": p.number, "seller_id": str(p.seller_id), "seller_name": seller_name, "amount": p.amount,
        "status": p.status, "mode": p.mode, "utr": p.utr, "failure_reason": p.failure_reason,
        "bank": {k: v for k, v in (p.bank_snapshot or {}).items() if k != "account_enc"},
        "bank_changed": bool(seller and p.status == "pending" and bank_changed(p, seller)),
        "created_at": p.created_at.isoformat(), "paid_at": p.paid_at.isoformat() if p.paid_at else None,
    }
