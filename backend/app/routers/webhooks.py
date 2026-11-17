"""Inbound webhooks from RazorpayX (payout status) and Shiprocket (shipment tracking)."""
from __future__ import annotations

import hashlib
import hmac
import json

from fastapi import APIRouter, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.deps import SessionDep
from app.core.errors import ApiError
from app.db import utcnow
from app.integrations import get as get_integrations
from app.models import SubOrder, WebhookEvent
from app.services import shipping
from app.services.ledger import apply_payout_webhook
from app.services.orders import cancel_sub_order, transition

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])


async def _once(session, provider: str, event_id: str, event_type: str) -> bool:
    session.add(WebhookEvent(provider=provider, event_id=event_id[:80], event_type=event_type[:60], received_at=utcnow()))
    try:
        await session.flush()
        return True
    except IntegrityError:
        await session.rollback()
        return False


@router.post("/razorpayx")
async def razorpayx(request: Request, session: SessionDep) -> dict:
    body = await request.body()
    secret = (await get_integrations(session)).razorpayx_webhook_secret
    sig = request.headers.get("x-razorpay-signature", "")
    if not secret or not hmac.compare_digest(hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(), sig):
        raise ApiError("Invalid signature", "bad_signature", 400)
    event = json.loads(body)
    eid = request.headers.get("x-razorpay-event-id") or hashlib.sha256(body).hexdigest()
    if not await _once(session, "razorpayx", eid, event.get("event", "")):
        return {"ok": True, "duplicate": True}
    etype = event.get("event", "")
    if etype.startswith("payout."):
        p = event.get("payload", {}).get("payout", {}).get("entity", {})
        status = etype.split(".", 1)[1]
        await apply_payout_webhook(session, p.get("id", ""), status, p.get("utr") or "", (p.get("status_details") or {}).get("description", "") or p.get("failure_reason") or "")
    await session.commit()
    return {"ok": True}


@router.post("/shiprocket")
async def shiprocket(request: Request, session: SessionDep) -> dict:
    token = (await get_integrations(session)).shiprocket_webhook_token
    if not token or not hmac.compare_digest(request.headers.get("x-api-key", ""), token):
        raise ApiError("Invalid token", "bad_token", 401)
    data = await request.json()
    awb = str(data.get("awb", ""))
    status = str(data.get("current_status", ""))
    eid = f"{awb}:{status}:{data.get('current_timestamp', '')}"
    if not awb or not await _once(session, "shiprocket", eid, status):
        return {"ok": True}
    sub = (await session.execute(select(SubOrder).where(SubOrder.tracking_number == awb).with_for_update())).scalar_one_or_none()
    if sub is None:
        await session.commit()
        return {"ok": True}
    action = shipping.classify(status)
    if action == "shipped" and sub.status == "packed":
        await transition(session, sub, "shipped", "system", f"Courier: {status}")
    elif action == "delivered" and sub.status in ("packed", "shipped"):
        if sub.status == "packed":
            await transition(session, sub, "shipped", "system", "Courier picked up")
        await transition(session, sub, "delivered", "system", "Delivered (courier update)")
    elif action == "rto" and sub.status in ("shipped",):
        await cancel_sub_order(session, sub, actor="system", reason="Returned to the seller by the courier (not delivered)")
    await session.commit()
    return {"ok": True}
