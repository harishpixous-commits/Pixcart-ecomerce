"""Push notifications through Firebase Cloud Messaging: setup in Admin → Integrations, device tokens, sending after
commit, removal of tokens that Firebase reports as gone."""
from __future__ import annotations

import asyncio
import json

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app.db import SessionLocal
from app.models import PushToken
from app.services import push
from tests.conftest import login_phone
from tests.test_delivery import CHENNAI, cod_order, make_zone, ready_partner
from tests.test_phase2_money import setup

PW = "Admin@12345"


def service_key() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    return pem.replace("\n", "\\n")  # as it appears inside the JSON file


async def test_push_setup_tokens_and_delivery_request_push(client, admin, categories, monkeypatch):
    sent: list[dict] = []
    tokens_asked = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            tokens_asked.append(1)
            return httpx.Response(200, json={"access_token": "ya29.test", "expires_in": 3600})
        body = json.loads(request.content)
        sent.append(body["message"])
        if body["message"]["token"].startswith("dead"):
            return httpx.Response(404, json={"error": {"status": "NOT_FOUND", "message": "Requested entity was not found."}})
        return httpx.Response(200, json={"name": "projects/demo/messages/1"})

    monkeypatch.setattr(push, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr(push, "_token", None)

    # not set up: the browser is told push is off
    assert (await client.get("/api/push/config")).json() == {"enabled": False}
    values = {"project_id": "pixcart-demo", "client_email": "push@pixcart-demo.iam.gserviceaccount.com", "private_key": service_key(),
              "api_key": "AIzaSyD" + "x" * 32, "sender_id": "123456789012", "app_id": "1:123456789012:web:abc123def456", "vapid_key": "B" + "y" * 86}
    r = await admin.put("/api/admin/integrations/firebase", {"values": values, "enabled": True, "password": PW})
    assert r.status_code == 200, r.text
    from app.config import settings
    monkeypatch.setattr(settings, "firebase_oauth_url", "https://oauth.test/token")
    monkeypatch.setattr(settings, "firebase_fcm_base", "https://fcm.test")
    check = (await admin.post("/api/admin/integrations/firebase/test", {})).json()
    assert check["ok"] is True, check
    cfg = (await client.get("/api/push/config")).json()
    assert cfg["enabled"] and cfg["projectId"] == "pixcart-demo" and "private_key" not in json.dumps(cfg)

    # a partner's phone registers; a new delivery request reaches it as an urgent push
    zone_id = await make_zone("Chennai Central", "Chennai", CHENNAI)
    await admin.put("/api/admin/delivery/settings", {"auto_assign": True})
    tn, ka, shirt, _ = await setup(client, admin, categories)
    rider = await ready_partner(client, admin, "9600000901", "Push Rider", zone_id, 13.083, 80.271)
    assert (await rider.post("/api/push/tokens", {"token": "phone-token-" + "a" * 30, "platform": "android", "app": "delivery"})).status_code == 201
    assert (await rider.post("/api/push/tokens", {"token": "dead-token-" + "b" * 30, "platform": "web", "app": "delivery"})).status_code == 201
    sent.clear()
    buyer, o = await cod_order(client, shirt, "9600000902")
    sub = o["sub_orders"][0]["id"]
    await tn.post(f"/api/seller/orders/{sub}/confirm")
    await tn.post(f"/api/seller/orders/{sub}/ready-for-pickup")
    for _ in range(50):  # the push goes out right after the commit, in the background
        if len(sent) >= 2:
            break
        await asyncio.sleep(0.05)
    offers = [m for m in sent if m["data"].get("event") == "delivery_new_offer"]
    assert len(offers) == 2 and offers[0]["notification"]["title"] == "New delivery request" and offers[0]["data"]["urgent"] == "1"
    assert offers[0]["android"]["priority"] == "HIGH"
    await asyncio.sleep(0.1)
    async with SessionLocal() as s:
        left = list((await s.execute(select(PushToken.token))).scalars())
        assert left == ["phone-token-" + "a" * 30]  # the dead browser token was removed
    assert len(tokens_asked) == 1  # made once for the connection test, then reused from the cache for every push

    # signing out removes the device; another account on the same phone takes the token over
    await rider.post("/api/push/tokens/remove", {"token": "phone-token-" + "a" * 30})
    other = await login_phone(client, "9600000903", name="Other")
    await other.post("/api/push/tokens", {"token": "phone-token-" + "a" * 30})
    async with SessionLocal() as s:
        row = (await s.execute(select(PushToken))).scalar_one()
        assert str(row.user_id) == other.user["id"]
