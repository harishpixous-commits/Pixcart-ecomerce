"""Razorpay REST client (Orders, Payments, Refunds) and signature verification.

Docs: https://razorpay.com/docs/api/ — amounts are integer paise, auth is HTTP Basic (key id/secret).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any

import httpx

from app.config import Settings
from app.integrations import get as get_integrations

log = logging.getLogger("pixcart.razorpay")


class GatewayError(Exception):
    pass


# Tests replace this with an httpx.MockTransport; production uses the real network.
transport: httpx.AsyncBaseTransport | None = None


def _client(cfg: Settings) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=cfg.razorpay_api_base,
        auth=(cfg.razorpay_key_id, cfg.razorpay_key_secret),
        timeout=httpx.Timeout(15.0, connect=5.0),
        transport=transport,
    )


async def _call(method: str, path: str, json: dict | None = None) -> dict[str, Any]:
    cfg = await get_integrations()
    if not cfg.razorpay_enabled:
        raise GatewayError("Online payments are not configured")
    try:
        async with _client(cfg) as client:
            resp = await client.request(method, path, json=json)
    except httpx.HTTPError as exc:
        log.error("razorpay %s %s network error: %s", method, path, exc)
        raise GatewayError("Payment gateway is not reachable right now") from exc
    if resp.status_code >= 400:
        try:
            desc = resp.json().get("error", {}).get("description", "")
        except ValueError:
            desc = resp.text[:200]
        log.error("razorpay %s %s -> %s %s", method, path, resp.status_code, desc)
        raise GatewayError(desc or f"Payment gateway error ({resp.status_code})")
    return resp.json()


async def create_order(amount_paise: int, receipt: str, notes: dict[str, str]) -> dict[str, Any]:
    return await _call("POST", "/orders", {"amount": amount_paise, "currency": "INR", "receipt": receipt[:40], "notes": notes})


async def fetch_payment(payment_id: str) -> dict[str, Any]:
    return await _call("GET", f"/payments/{payment_id}")


async def order_payments(order_id: str) -> list[dict[str, Any]]:
    data = await _call("GET", f"/orders/{order_id}/payments")
    return data.get("items", [])


async def capture_payment(payment_id: str, amount_paise: int) -> dict[str, Any]:
    return await _call("POST", f"/payments/{payment_id}/capture", {"amount": amount_paise, "currency": "INR"})


async def refund_payment(payment_id: str, amount_paise: int, receipt: str, notes: dict[str, str]) -> dict[str, Any]:
    return await _call(
        "POST",
        f"/payments/{payment_id}/refund",
        {"amount": amount_paise, "speed": "normal", "receipt": receipt[:40], "notes": notes},
    )


async def verify_payment_signature(order_id: str, payment_id: str, signature: str) -> bool:
    secret = (await get_integrations()).razorpay_key_secret
    if not secret:
        return False
    expected = hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


async def verify_webhook_signature(body: bytes, signature: str) -> bool:
    secret = (await get_integrations()).razorpay_webhook_secret
    if not secret:
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")
