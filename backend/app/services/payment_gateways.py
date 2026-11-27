"""Starting, checking and refunding payments across gateways (docs/PAYMENT_GATEWAYS.md sections 3 to 5).

Razorpay keeps its module (services/razorpay.py); the others go through services/gateways.py adapters. Which gateway takes a
new payment comes from services/payment_routing.py. Health events are written in their own transaction so they survive
a checkout that fails and rolls back."""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import ApiError
from app.db import SessionLocal, utcnow
from app.integrations import get as get_integrations
from app.models import Order, Payment, User
from app.services import gateways, payment_routing, razorpay, regional

ALL = payment_routing.GATEWAYS


def enabled_set(cfg: Any) -> set[str]:
    return {g for g in ALL if gateways.enabled(cfg, g)}


async def _record(gateway: str, ok: bool, ms: int, error: str = "") -> None:
    async with SessionLocal() as s:
        await payment_routing.record(s, gateway, ok, ms, error)
        await s.commit()


def _customer(user: User) -> dict[str, str]:
    return {"id": str(user.id), "name": user.name or "", "contact": f"+91{user.phone}" if user.phone else "", "email": user.email or ""}


async def candidates(session: AsyncSession, cfg: Any, currency: str, *, after: str | None = None, exclude: tuple[str, ...] = ()) -> list[str]:
    """Eligible gateways in the order to try. ``after``: start with the gateway following it (Pay another way)."""
    rcfg = await payment_routing.get(session)
    out = payment_routing.eligible(rcfg, enabled_set(cfg), currency, await payment_routing.recent_events(session), utcnow())
    out = [g for g in out if g not in exclude]
    if after in out:
        i = out.index(after)
        out = out[i + 1:] + out[:i + 1]
    return out


async def alternatives(session: AsyncSession, cfg: Any, currency: str, current: str) -> list[dict[str, str]]:
    return [{"provider": g, "label": payment_routing.NAMES[g]} for g in await candidates(session, cfg, currency, exclude=(current,))]


async def start_payment(session: AsyncSession, order: Order, user: User, *, amount: int, charge: int | None, charge_currency: str,
                        cfg: Any, preferred: str | None = None, after: str | None = None) -> Payment:
    """Creates the gateway payment for an order and adds the Payment row. The first eligible gateway is tried, then the next
    when failover is on. Raises ApiError 409 when no gateway can take it and 502 when every one failed."""
    rcfg = await payment_routing.get(session)
    if preferred:
        if preferred not in await candidates(session, cfg, charge_currency):
            raise ApiError("That payment method is not available right now.", "gateway_unavailable", 409)
        order_to_try = [preferred]
    else:
        cands = await candidates(session, cfg, charge_currency, after=after)
        if not cands:
            if charge_currency != regional.BASE:
                raise ApiError(f"Paying in {charge_currency} is not available right now. Switch the currency to ₹ (INR) and try again.", "currency_unavailable", 409)
            raise ApiError("Online payment is not available right now. Please choose cash on delivery.", "online_unavailable", 409)
        order_to_try = payment_routing.to_try(rcfg, cands)
    n = (await session.execute(select(func.count()).select_from(Payment).where(Payment.order_id == order.id))).scalar_one()
    receipt = order.number if n == 0 else f"{order.number}-{n}"
    timeout = float(rcfg["timeout_seconds"])
    last: Exception | None = None
    for code in order_to_try:
        t0 = time.monotonic()
        try:
            if code == "razorpay":
                rp = await asyncio.wait_for(razorpay.create_order(charge or amount, receipt, {"order_number": order.number}, currency=charge_currency), timeout)
                ref, data = rp["id"], None
            else:
                base = cfg.public_web_url.rstrip("/")
                adapter = gateways.build(cfg, code, timeout)
                made = await asyncio.wait_for(adapter.create(charge or amount, charge_currency, receipt, _customer(user),
                                                              f"{base}/api/payments/{code}/callback", f"{base}/api/payments/{code}/webhook"), timeout + 1)
                ref, data = made["reference"], {"mode": made["mode"], **made["fields"]}
        except (gateways.GatewayError, asyncio.TimeoutError) as exc:
            last = exc
            await _record(code, False, int((time.monotonic() - t0) * 1000), str(exc) or "time-out")
            continue
        await _record(code, True, int((time.monotonic() - t0) * 1000))
        payment = Payment(order_id=order.id, provider=code, provider_order_id=ref, amount_paise=amount, currency=charge_currency,
                          charge_amount=charge, client_data=data)
        session.add(payment)
        await session.flush()
        return payment
    text = str(last) or "the gateway did not answer in time"
    if charge_currency != regional.BASE:
        raise ApiError(f"Paying in {charge_currency} is not available right now ({text}). Switch the currency to ₹ (INR) and try again.", "currency_unavailable", 502)
    raise ApiError(f"Could not start the payment: {text}", "gateway_error", 502)


def payload(order: Order, payment: Payment, user: User, brand: str, cfg: Any) -> dict[str, Any]:
    """The `payment` object of section 4 for a gateway other than Razorpay."""
    base = {
        "provider": payment.provider, "amount": payment.charge_amount or payment.amount_paise, "currency": payment.currency or "INR", "name": brand,
        "description": f"Order {order.number}", "prefill": {"name": user.name, "contact": f"+91{user.phone}" if user.phone else "", "email": user.email or ""},
        "expires_at": order.payment_expires_at.isoformat() if order.payment_expires_at else None,
    }
    return {**base, **(payment.client_data or {"mode": "redirect"})}


async def check(session: AsyncSession, payment: Payment, mark_paid) -> dict:
    """check_with_gateway for the non-Razorpay gateways: the gateway's own records decide, never the browser."""
    if payment.status == "captured":
        return {"result": "already_paid", "attempts": [], "payment": {"id": payment.provider_payment_id, "method": payment.method, "status": "captured"},
                "waiting": False, "reason": ""}
    cfg = await get_integrations(session)
    rcfg = await payment_routing.get(session)
    adapter = gateways.build(cfg, payment.provider, float(rcfg["timeout_seconds"]))
    t0 = time.monotonic()
    try:
        attempts = await adapter.attempts(payment.provider_order_id)
    except gateways.GatewayError as exc:
        await _record(payment.provider, False, int((time.monotonic() - t0) * 1000), str(exc))
        raise
    await _record(payment.provider, True, int((time.monotonic() - t0) * 1000))
    seen = [{"id": a["id"], "status": a["status"], "method": a["method"], "error": a["error"]} for a in attempts]
    done = next((a for a in attempts if a["status"] in ("captured", "authorized")), None)
    if done is None:
        failed = next((a for a in attempts if a["status"] == "failed"), None)
        reason = (failed["error"] or "The payment did not go through") if failed else ""
        if failed and payment.status != "captured":
            payment.error = reason[:500]
        return {"result": "not_paid", "attempts": seen, "waiting": any(a["status"] in ("created", "pending") for a in attempts), "reason": reason}
    result = await mark_paid(session, payment, done["id"], done["method"], int(done["amount"]))
    return {"result": result, "attempts": seen, "payment": {"id": done["id"], "method": done["method"], "status": "captured"}, "waiting": False, "reason": ""}


async def refund(session: AsyncSession, payment: Payment, provider_payment_id: str, charge_paise: int, refund_id: str, note: str) -> dict[str, Any]:
    cfg = await get_integrations(session)
    adapter = gateways.build(cfg, payment.provider)
    return await adapter.refund(payment.provider_order_id, provider_payment_id, charge_paise, refund_id, note)


async def health(session: AsyncSession) -> list[dict[str, Any]]:
    """Admin → Payments: every gateway with its switch, mode and the last 24 hours."""
    from datetime import timedelta

    from app.models import PaymentGatewayEvent

    cfg = await get_integrations(session)
    rcfg = await payment_routing.get(session)
    now = utcnow()
    rows = (await session.execute(select(PaymentGatewayEvent).where(PaymentGatewayEvent.created_at >= now - timedelta(days=1))
                                  .order_by(PaymentGatewayEvent.created_at))).scalars().all()
    out = []
    for g in ALL:
        mine = [r for r in rows if r.gateway == g]
        events = [payment_routing.Event(r.gateway, r.ok, r.created_at) for r in mine]
        ok = sum(1 for r in mine if r.ok)
        times = sorted(r.ms for r in mine)
        bad = [r for r in mine if not r.ok]
        if g == "razorpay":
            mode = "live" if cfg.razorpay_key_id.startswith("rzp_live_") else ("test" if cfg.razorpay_key_id else "")
            configured = cfg.razorpay_enabled
        else:
            adapter = gateways.build(cfg, g) if gateways.configured(cfg, g) else None
            mode = ("test" if adapter.sandbox else "live") if adapter else ""
            configured = adapter is not None
        out.append({
            "code": g, "name": payment_routing.NAMES[g], "configured": configured, "enabled": g in enabled_set(cfg), "mode": mode,
            "currencies": sorted(payment_routing.CURRENCIES[g]) if payment_routing.CURRENCIES[g] else ["any"],
            "client_mode": {"razorpay": "modal", "cashfree": "modal", "phonepe": "redirect", "payu": "form", "stripe": "redirect"}[g],
            "circuit": payment_routing.circuit_state(events, rcfg, now),
            "attempts": len(mine), "ok": ok, "success_rate": round(ok / len(mine), 3) if mine else None,
            "avg_ms": round(sum(times) / len(times)) if times else None, "p95_ms": times[min(len(times) - 1, int(len(times) * 0.95))] if times else None,
            "last_error": bad[-1].error if bad else "", "last_error_at": bad[-1].created_at.isoformat() if bad else None,
        })
    order = [g for g in rcfg["order"] if g in ALL] + [g for g in ALL if g not in rcfg["order"]]
    return sorted(out, key=lambda r: order.index(r["code"]))


async def test_gateway(session: AsyncSession, code: str) -> dict[str, Any]:
    cfg = await get_integrations(session)
    t0 = time.monotonic()
    try:
        if code == "razorpay":
            if not cfg.razorpay_enabled:
                return {"ok": False, "ms": 0, "message": "Enter the Razorpay keys first."}
            await razorpay._call("GET", "/orders?count=1")  # noqa: SLF001 - the one harmless authenticated call
        else:
            if not gateways.configured(cfg, code):
                return {"ok": False, "ms": 0, "message": "Enter the keys on Admin → Integrations first."}
            await gateways.build(cfg, code, 10.0).ping()
    except gateways.GatewayError as exc:
        ms = int((time.monotonic() - t0) * 1000)
        await payment_routing.record(session, code, False, ms, str(exc))
        return {"ok": False, "ms": ms, "message": str(exc)[:200]}
    ms = int((time.monotonic() - t0) * 1000)
    await payment_routing.record(session, code, True, ms)
    return {"ok": True, "ms": ms, "message": "Connected."}
