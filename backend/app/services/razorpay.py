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


async def create_order(amount: int, receipt: str, notes: dict[str, str], currency: str = "INR") -> dict[str, Any]:
    """amount is in the currency's smallest unit (paise for INR). Other currencies need Razorpay international payments."""
    return await _call("POST", "/orders", {"amount": amount, "currency": currency, "receipt": receipt[:40], "notes": notes})


async def fetch_payment(payment_id: str) -> dict[str, Any]:
    return await _call("GET", f"/payments/{payment_id}")


async def order_payments(order_id: str) -> list[dict[str, Any]]:
    data = await _call("GET", f"/orders/{order_id}/payments")
    return data.get("items", [])


async def capture_payment(payment_id: str, amount: int, currency: str = "INR") -> dict[str, Any]:
    return await _call("POST", f"/payments/{payment_id}/capture", {"amount": amount, "currency": currency})


async def refund_payment(payment_id: str, amount_paise: int, receipt: str, notes: dict[str, str]) -> dict[str, Any]:
    return await _call(
        "POST",
        f"/payments/{payment_id}/refund",
        {"amount": amount_paise, "speed": "normal", "receipt": receipt[:40], "notes": notes},
    )


# ----------------------------------------------------------------------------- customers and saved cards
# Razorpay keeps saved cards as network tokens (RBI card-on-file tokenisation) under a Razorpay customer. The shopper
# agrees to save a card inside Razorpay's payment window; we only ever see the last 4 digits, network and expiry.


async def create_customer(name: str, contact: str, email: str) -> dict[str, Any]:
    body = {"name": (name or "Customer")[:50], "fail_existing": "0"}
    if contact:
        body["contact"] = contact
    if email:
        body["email"] = email
    return await _call("POST", "/customers", body)


async def customer_tokens(customer_id: str) -> list[dict[str, Any]]:
    data = await _call("GET", f"/customers/{customer_id}/tokens")
    return data.get("items", [])


async def delete_token(customer_id: str, token_id: str) -> None:
    await _call("DELETE", f"/customers/{customer_id}/tokens/{token_id}")


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
