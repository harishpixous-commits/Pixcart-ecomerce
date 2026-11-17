"""Admin-managed integrations (encrypted, merged over env, tested), roles and permissions, export formats."""
import io

import httpx
from openpyxl import load_workbook

from app.config import settings
from app.db import SessionLocal
from app.integrations import checks, store
from app.models import PlatformSetting

PW = "Admin@12345"  # conftest admin fixture


async def test_integration_save_is_encrypted_and_overrides_env(admin, client, monkeypatch):
    r = await admin.get("/api/admin/integrations")
    assert r.status_code == 200
    razor = next(i for i in r.json()["items"] if i["key"] == "razorpay")
    assert razor["fields"][0]["source"] == "environment"  # conftest sets RAZORPAY_KEY_ID
    assert "rzp_test_secret" not in r.text  # secrets never leave the server

    # wrong password is refused
    bad = await admin.put("/api/admin/integrations/msg91", {"values": {"auth_key": "k" * 20}, "password": "nope"})
    assert bad.status_code == 403

    # cannot switch on with required fields missing
    r = await admin.put("/api/admin/integrations/msg91", {"values": {"auth_key": "msgkey123456789"}, "enabled": True, "password": PW})
    assert r.status_code == 400 and "OTP template ID" in r.json()["error"]["message"]

    r = await admin.put("/api/admin/integrations/msg91", {"values": {"auth_key": "msgkey123456789", "otp_template_id": "tmpl12345678"}, "enabled": True, "password": PW})
    assert r.status_code == 200, r.text
    item = r.json()["item"]
    assert item["ready"] and item["enabled"]
    key_field = next(f for f in item["fields"] if f["key"] == "auth_key")
    assert key_field["hint"] == "••••6789"
    assert "msgkey123456789" not in r.text

    async with SessionLocal() as s:
        row = await s.get(PlatformSetting, "integrations")
        stored = row.value["msg91"]["values"]["auth_key"]
        assert isinstance(stored, dict) and "enc" in stored and "msgkey" not in str(stored)

    cfg = await store.get()
    assert cfg.sms_provider == "msg91" and cfg.msg91_auth_key == "msgkey123456789"

    # switching off falls back to the console provider; env values untouched
    r = await admin.put("/api/admin/integrations/msg91", {"enabled": False, "password": PW})
    assert r.status_code == 200
    assert (await store.get()).sms_provider == "console"
    assert settings.sms_provider == "console"

    # audit records field names only
    audit = (await admin.get("/api/admin/audit?action=integration.update")).text
    assert "msgkey123456789" not in audit


async def test_integration_validation_and_checkout_switch(admin, client):
    r = await admin.put("/api/admin/integrations/razorpay", {"values": {"key_id": "not-a-key"}, "password": PW})
    assert r.status_code == 400 and "rzp_test_" in r.json()["error"]["message"]
    r = await admin.put("/api/admin/integrations/razorpay", {"enabled": False, "password": PW})
    assert r.status_code == 200
    site = (await client.get("/api/site")).json()
    assert site["online_payments"] is False
    assert (await store.get()).razorpay_enabled  # refunds still possible with the keys
    r = await admin.put("/api/admin/integrations/razorpay", {"enabled": True, "password": PW})
    assert (await client.get("/api/site")).json()["online_payments"] is True


async def test_connection_checks_use_saved_keys(admin, monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization", "") or request.headers.get("x-api-key", "")
        if request.url.path.endswith("/v1/models"):
            return httpx.Response(200, json={"data": [{"id": "claude-haiku-5-5"}]})
        return httpx.Response(200, json={"items": [], "count": 0})

    monkeypatch.setattr(checks, "transport", httpx.MockTransport(handler))
    r = await admin.post("/api/admin/integrations/razorpay/test", {})
    assert r.status_code == 200 and r.json()["ok"], r.text
    assert "/orders" in seen["url"] and seen["auth"].startswith("Basic ")

    await admin.put("/api/admin/integrations/ai", {"values": {"api_key": "sk-ant-test-123456"}, "enabled": True, "password": PW})
    r = await admin.post("/api/admin/integrations/ai/test", {})
    assert r.json()["ok"] and seen["auth"] == "sk-ant-test-123456"
    listing = (await admin.get("/api/admin/integrations")).json()
    ai = next(i for i in listing["items"] if i["key"] == "ai")
    assert ai["last_test"]["ok"] is True
    await admin.put("/api/admin/integrations/ai", {"clear": ["api_key"], "enabled": False, "password": PW})


async def test_roles_matrix_and_escalation_guards(admin, client):
    perms = (await admin.get("/api/admin/permissions")).json()["items"]
    assert {"integrations", "assistant", "staff"} <= {p["code"] for p in perms}
    r = await admin.post("/api/admin/roles", {"name": "Warehouse lead", "description": "Ships orders", "permissions": ["orders", "support"]})
    assert r.status_code == 201, r.text
    code = r.json()["code"]
    assert r.json()["permissions"][0] == "dashboard"  # always added
    assert (await admin.post("/api/admin/roles", {"name": "warehouse lead", "permissions": []})).status_code == 409
    assert (await admin.put("/api/admin/roles/owner", {"name": "Owner", "permissions": []})).status_code == 409

    r = await admin.post("/api/admin/staff", {"email": "lead@kadai.in", "name": "Lead", "role": code, "password": "Warehouse@2026x"})
    assert r.status_code == 201
    token = (await client.post("/api/auth/login", json={"email": "lead@kadai.in", "password": "Warehouse@2026x"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await client.get("/api/admin/orders", headers=h)).status_code == 200
    assert (await client.get("/api/admin/integrations", headers=h)).status_code == 403
    me = (await client.get("/api/admin/me", headers=h)).json()
    assert me["role"] == code and "orders" in me["permissions"] and "payouts" not in me["permissions"]

    # permission change applies at once
    await admin.put(f"/api/admin/roles/{code}", {"name": "Warehouse lead", "permissions": ["orders"]})
    t = await client.get("/api/admin/tickets", headers=h)
    assert t.status_code == 403, t.text

    # a role in use cannot be deleted
    assert (await admin.delete(f"/api/admin/roles/{code}")).status_code == 409

    # a non-owner with staff permission cannot hand out permissions they lack
    await admin.put(f"/api/admin/roles/{code}", {"name": "Warehouse lead", "permissions": ["orders", "staff"]})
    assert (await client.post("/api/admin/roles", json={"name": "Sneaky", "permissions": ["integrations"]}, headers=h)).status_code == 403
    assert (await client.post("/api/admin/staff", json={"email": "x@kadai.in", "name": "Xavier", "role": "owner", "password": "Sneaky@2026xx"}, headers=h)).status_code == 403
    assert (await client.put(f"/api/admin/roles/{code}", json={"name": "Warehouse lead", "permissions": ["orders", "staff", "payouts"]}, headers=h)).status_code == 403


async def test_export_formats_filters_and_columns(admin, client):
    r = await admin.get("/api/admin/exports")
    orders = next(i for i in r.json()["items"] if i["name"] == "orders")
    assert orders["formats"] == ["csv", "xlsx", "pdf"] and any(f["key"] == "payment_method" for f in orders["filters"])

    r = await admin.get("/api/admin/exports/products.xlsx", params={"status": "approved"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
    wb = load_workbook(io.BytesIO(r.content))
    assert wb.sheetnames[-1] == "About"
    assert wb.worksheets[0]["A1"].value == "SKU"

    r = await admin.get("/api/admin/exports/products.csv", params=[("columns", "SKU"), ("columns", "Price")])
    assert r.status_code == 200
    assert r.content.decode("utf-8-sig").splitlines()[0] == "SKU,Price"

    r = await admin.get("/api/admin/exports/orders.pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")

    r = await admin.get("/api/admin/exports/orders.pdf", params=[("columns", c) for c in orders["columns"]])
    assert r.status_code == 400 and "14 columns" in r.json()["error"]["message"]
    assert (await admin.get("/api/admin/exports/orders.csv", params={"low_stock": 3})).status_code == 400
    assert (await admin.get("/api/admin/exports/orders.doc")).status_code == 404
    assert (await admin.get("/api/admin/exports/lookup/seller")).status_code == 200

