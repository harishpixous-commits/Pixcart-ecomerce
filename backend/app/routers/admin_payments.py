"""Admin -> Payments: gateway order, routing settings and health (docs/PAYMENT_GATEWAYS.md sections 5 and 7)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.core.deps import SessionDep, audit
from app.core.errors import ApiError, NotFound
from app.core.permissions import Perm
from app.services import payment_gateways, payment_routing

router = APIRouter(prefix="/api/admin/payments", tags=["admin-payments"])


@router.get("/gateways")
async def gateways_health(admin: Perm("settings"), session: SessionDep) -> dict:
    return {"gateways": await payment_gateways.health(session), "routing": await payment_routing.get(session), "defaults": payment_routing.DEFAULTS}


@router.put("/routing")
async def put_routing(body: dict[str, Any], admin: Perm("settings"), session: SessionDep) -> dict:
    try:
        cfg = await payment_routing.update(session, body)
    except payment_routing.RoutingError as exc:
        raise ApiError(str(exc), "invalid_setting") from exc
    audit(session, admin, "payments.routing", "settings", payment_routing.KEY, ", ".join(sorted(body))[:200])
    await session.commit()
    return {"routing": cfg, "gateways": await payment_gateways.health(session)}


@router.post("/gateways/{code}/test")
async def test_gateway(code: str, admin: Perm("settings"), session: SessionDep) -> dict:
    if code not in payment_routing.GATEWAYS:
        raise NotFound("Gateway")
    out = await payment_gateways.test_gateway(session, code)
    await session.commit()
    return out
