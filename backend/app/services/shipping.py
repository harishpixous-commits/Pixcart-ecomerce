"""Courier integration. 'manual': the seller books a courier and enters the AWB. 'shiprocket': the platform
books the shipment through Shiprocket (create order → assign AWB → schedule pickup → label) and moves
the order along from Shiprocket's tracking webhook.

Shiprocket API: https://apiv2.shiprocket.in/v1/external — login gives a JWT valid for 10 days, which is
stored in integration_tokens so every app instance shares it.
"""
from __future__ import annotations

import logging
from datetime import timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations import get as get_integrations
from app.core.errors import ApiError
from app.core.validators import STATES
from app.db import utcnow
from app.models import (
    IntegrationToken,
    Order,
    OrderItem,
    Seller,
    SubOrder,
    Variant,
    Warehouse,
)

log = logging.getLogger("pixcart.shipping")
transport: httpx.AsyncBaseTransport | None = None


async def enabled() -> bool:
    cfg = await get_integrations()
    return cfg.shipping_provider == "shiprocket" and bool(cfg.shiprocket_email and cfg.shiprocket_password)


async def _token(session: AsyncSession) -> str:
    row = await session.get(IntegrationToken, "shiprocket")
    if row and row.expires_at > utcnow() + timedelta(hours=6):
        return row.token
    cfg = await get_integrations(session)
    async with httpx.AsyncClient(base_url=cfg.shiprocket_api_base, timeout=20, transport=transport) as c:
        r = await c.post("/auth/login", json={"email": cfg.shiprocket_email, "password": cfg.shiprocket_password})
    if r.status_code >= 400 or "token" not in r.json():
        raise ApiError("Shiprocket login failed; check the API user in settings", "shiprocket_auth", 502)
    token = r.json()["token"]
    if row is None:
        row = IntegrationToken(provider="shiprocket", token=token, expires_at=utcnow() + timedelta(days=9))
        session.add(row)
    else:
        row.token, row.expires_at = token, utcnow() + timedelta(days=9)
    await session.flush()
    return token


async def _call(session: AsyncSession, method: str, path: str, json: dict | None = None) -> dict:
    token = await _token(session)
    async with httpx.AsyncClient(base_url=(await get_integrations(session)).shiprocket_api_base, timeout=30, transport=transport) as c:
        r = await c.request(method, path, json=json, headers={"Authorization": f"Bearer {token}"})
    if r.status_code >= 400:
        log.error("shiprocket %s %s -> %s %s", method, path, r.status_code, r.text[:300])
        try:
            msg = r.json().get("message", "")
        except ValueError:
            msg = ""
        raise ApiError(f"Shiprocket: {msg or 'request failed'}", "shiprocket_error", 502)
    return r.json()


async def ensure_pickup(session: AsyncSession, seller: Seller, wh: Warehouse) -> str:
    if wh.shiprocket_pickup_name:
        return wh.shiprocket_pickup_name
    name = f"PC{str(wh.id).replace('-', '')[:10]}"  # pickup location names must be unique and short
    await _call(session, "POST", "/settings/company/addpickup", {
        "pickup_location": name, "name": wh.contact_name or seller.display_name, "email": seller.contact_email,
        "phone": wh.contact_phone or seller.contact_phone, "address": wh.line1[:80], "address_2": wh.line2[:80],
        "city": wh.city, "state": STATES.get(wh.state_code, ""),
        "country": "India", "pin_code": wh.pincode,
    })
    wh.shiprocket_pickup_name = name
    return name


async def book(session: AsyncSession, sub: SubOrder) -> None:
    """Creates the Shiprocket order, assigns an AWB, schedules pickup and fetches the label."""
    if not await enabled():
        raise ApiError("Courier booking is not set up; enter the courier and AWB yourself", "shipping_manual")
    order = await session.get(Order, sub.order_id)
    seller = await session.get(Seller, sub.seller_id)
    wh = await session.get(Warehouse, sub.warehouse_id)
    items = list((await session.execute(select(OrderItem).where(OrderItem.sub_order_id == sub.id))).scalars())
    weights = dict((await session.execute(select(Variant.id, Variant.weight_grams).where(Variant.id.in_([i.variant_id for i in items])))).all())
    weight_kg = max(0.1, sum(weights.get(i.variant_id, 500) * i.qty for i in items) / 1000)
    pickup = await ensure_pickup(session, seller, wh)
    st = order.ship_to
    created = await _call(session, "POST", "/orders/create/adhoc", {
        "order_id": sub.number, "order_date": sub.created_at.strftime("%Y-%m-%d %H:%M"), "pickup_location": pickup,
        "billing_customer_name": st.get("full_name", ""), "billing_last_name": "", "billing_address": st.get("line1", ""),
        "billing_address_2": st.get("line2", ""), "billing_city": st.get("city", ""), "billing_pincode": st.get("pincode", ""),
        "billing_state": st.get("state", ""), "billing_country": "India", "billing_email": "", "billing_phone": st.get("phone", ""),
        "shipping_is_billing": True,
        "order_items": [{"name": i.title[:100], "sku": i.sku, "units": i.qty, "selling_price": f"{i.unit_price / 100:.2f}", "hsn": i.hsn_code} for i in items],
        "payment_method": "COD" if order.payment_method == "cod" else "Prepaid",
        "shipping_charges": f"{sub.shipping_fee / 100:.2f}", "sub_total": f"{(sub.total - sub.shipping_fee) / 100:.2f}",
        "length": 20, "breadth": 15, "height": 10, "weight": round(weight_kg, 2),
    })
    sub.provider_order_id = str(created.get("order_id", ""))
    sub.provider_shipment_id = str(created.get("shipment_id", ""))
    awb = await _call(session, "POST", "/courier/assign/awb", {"shipment_id": sub.provider_shipment_id})
    data = (awb.get("response") or {}).get("data") or {}
    sub.tracking_number = str(data.get("awb_code", ""))
    sub.courier_name = str(data.get("courier_name", ""))[:60]
    sub.tracking_url = f"https://shiprocket.co/tracking/{sub.tracking_number}" if sub.tracking_number else ""
    await _call(session, "POST", "/courier/generate/pickup", {"shipment_id": [sub.provider_shipment_id]})
    label = await _call(session, "POST", "/courier/generate/label", {"shipment_id": [sub.provider_shipment_id]})
    sub.label_url = str(label.get("label_url", ""))[:400]
    sub.shipping_provider = "shiprocket"


# Shiprocket current_status text → our action
DELIVERED = {"DELIVERED"}
IN_TRANSIT = {"PICKED UP", "SHIPPED", "IN TRANSIT", "OUT FOR DELIVERY", "REACHED AT DESTINATION HUB", "OUT FOR PICKUP"}
RTO_DONE = {"RTO DELIVERED"}


def classify(status: str) -> str:
    s = (status or "").upper().strip()
    if s in DELIVERED:
        return "delivered"
    if s in RTO_DONE:
        return "rto"
    if s in IN_TRANSIT:
        return "shipped"
    return "ignore"
