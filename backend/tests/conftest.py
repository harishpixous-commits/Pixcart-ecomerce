"""Test harness: a real PostgreSQL database migrated with Alembic, and an in-memory Razorpay."""
from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

TEST_DB = os.environ.get("TEST_DATABASE_NAME", "pixcart_test")
PG = os.environ.get("TEST_PG_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432")
_tmp = tempfile.mkdtemp(prefix="pixcart-test-")
os.environ.update(
    {
        "ENVIRONMENT": "test",
        "DATABASE_URL": f"{PG}/{TEST_DB}",
        "RAZORPAY_KEY_ID": "rzp_test_key",
        "RAZORPAY_KEY_SECRET": "rzp_test_secret",
        "RAZORPAY_WEBHOOK_SECRET": "whsec_test",
        "MEDIA_ROOT": f"{_tmp}/media",
        "PRIVATE_ROOT": f"{_tmp}/private",
        "SMS_PROVIDER": "console",
        "RUN_JOBS": "false",
    }
)

import httpx  # noqa: E402
import psycopg2  # noqa: E402
import pytest  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import text  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]


def _recreate_db() -> None:
    sync = PG.replace("+asyncpg", "")
    conn = psycopg2.connect(f"{sync}/postgres")
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
    cur.execute(f"CREATE DATABASE {TEST_DB}")
    conn.close()
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND, check=True, env=os.environ.copy())


_recreate_db()

from app.core.security import hash_password  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Category, User  # noqa: E402
from app.services import razorpay, sms  # noqa: E402

# ----------------------------------------------------------------------------- fake Razorpay


class FakeRazorpay:
    """Implements the Razorpay endpoints the app uses, with real-shaped responses."""

    def __init__(self) -> None:
        self.orders: dict[str, dict] = {}
        self.payments: dict[str, dict] = {}
        self.refunds: dict[str, dict] = {}
        self.fail_next: str | None = None
        self.auto_capture = True
        self.customers: dict[str, dict] = {}
        self.tokens: dict[str, list[dict]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        if auth != "Basic " + base64.b64encode(b"rzp_test_key:rzp_test_secret").decode():
            return httpx.Response(401, json={"error": {"description": "auth"}})
        if self.fail_next:
            msg, self.fail_next = self.fail_next, None
            return httpx.Response(502, json={"error": {"description": msg}})
        path = request.url.path.removeprefix("/v1")
        body = json.loads(request.content or b"{}")
        if request.method == "POST" and path == "/orders":
            oid = "order_" + secrets.token_hex(7)
            self.orders[oid] = {"id": oid, "amount": body["amount"], "currency": body.get("currency", "INR"), "receipt": body["receipt"], "status": "created"}
            return httpx.Response(200, json=self.orders[oid])
        if request.method == "POST" and path == "/customers":
            existing = next((c for c in self.customers.values() if c.get("contact") == body.get("contact")), None)
            if existing:
                return httpx.Response(200, json=existing)
            cid = "cust_" + secrets.token_hex(7)
            self.customers[cid] = {"id": cid, "name": body.get("name"), "contact": body.get("contact"), "email": body.get("email")}
            self.tokens[cid] = []
            return httpx.Response(200, json=self.customers[cid])
        if path.startswith("/customers/") and "/tokens" in path:
            parts = path.split("/")
            cid = parts[2]
            if cid not in self.customers:
                return httpx.Response(400, json={"error": {"description": "The id provided does not exist"}})
            if request.method == "GET":
                return httpx.Response(200, json={"entity": "collection", "count": len(self.tokens[cid]), "items": self.tokens[cid]})
            if request.method == "DELETE":
                self.tokens[cid] = [t for t in self.tokens[cid] if t["id"] != parts[4]]
                return httpx.Response(200, json={"deleted": True})
        if request.method == "GET" and path.startswith("/orders/") and path.endswith("/payments"):
            oid = path.split("/")[2]
            return httpx.Response(200, json={"items": [p for p in self.payments.values() if p["order_id"] == oid]})
        if request.method == "GET" and path.startswith("/payments/"):
            p = self.payments.get(path.split("/")[2])
            return httpx.Response(200, json=p) if p else httpx.Response(400, json={"error": {"description": "not found"}})
        if request.method == "POST" and path.endswith("/capture"):
            p = self.payments[path.split("/")[2]]
            p["status"] = "captured"
            return httpx.Response(200, json=p)
        if request.method == "POST" and path.endswith("/refund"):
            pid = path.split("/")[2]
            existing = next((r for r in self.refunds.values() if r["receipt"] == body["receipt"]), None)
            if existing:
                return httpx.Response(200, json=existing)
            rid = "rfnd_" + secrets.token_hex(7)
            self.refunds[rid] = {"id": rid, "payment_id": pid, "amount": body["amount"], "receipt": body["receipt"], "status": "processed"}
            return httpx.Response(200, json=self.refunds[rid])
        return httpx.Response(404, json={"error": {"description": f"unhandled {request.method} {path}"}})

    def save_card(self, customer_id: str, last4: str = "1111", network: str = "Visa") -> str:
        """What happens when the shopper ticks "save this card" in Razorpay's window: a network token."""
        tid = "token_" + secrets.token_hex(7)
        self.tokens[customer_id].append({"id": tid, "entity": "token", "method": "card", "used_at": 1700000000,
                                         "card": {"last4": last4, "network": network, "type": "credit", "issuer": "HDFC",
                                                  "expiry_month": 12, "expiry_year": 2030, "international": False}})
        return tid

    def pay(self, order_id: str, *, amount: int | None = None, method: str = "upi") -> tuple[str, str]:
        """Simulates the customer completing Checkout; returns (payment_id, signature)."""
        pid = "pay_" + secrets.token_hex(7)
        self.payments[pid] = {
            "id": pid,
            "order_id": order_id,
            "amount": amount if amount is not None else self.orders[order_id]["amount"],
            "status": "captured" if self.auto_capture else "authorized",
            "method": method,
        }
        sig = hmac.new(b"rzp_test_secret", f"{order_id}|{pid}".encode(), hashlib.sha256).hexdigest()
        return pid, sig


@pytest.fixture
def gateway():
    fake = FakeRazorpay()
    razorpay.transport = httpx.MockTransport(fake.handler)
    yield fake
    razorpay.transport = None


# ----------------------------------------------------------------------------- db + client


@pytest.fixture(autouse=True)
async def clean_db():
    async with engine.begin() as conn:
        tables = (await conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'alembic_version'"))).scalars().all()
        await conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " RESTART IDENTITY CASCADE"))
    sms.DEV_OUTBOX.clear()
    yield


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class Api:
    """Small helper around an authenticated client."""

    def __init__(self, client: httpx.AsyncClient, token: str, user: dict):
        self.c, self.token, self.user = client, token, user

    def h(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    async def get(self, url, **kw):
        return await self.c.get(url, headers=self.h(), **kw)

    async def post(self, url, json=None, **kw):
        return await self.c.post(url, json=json, headers=self.h(), **kw)

    async def put(self, url, json=None):
        return await self.c.put(url, json=json, headers=self.h())

    async def delete(self, url):
        return await self.c.delete(url, headers=self.h())

    async def patch(self, url, json=None):
        return await self.c.patch(url, json=json, headers=self.h())


async def login_phone(client: httpx.AsyncClient, phone: str, name: str = "Test User") -> Api:
    r = await client.post("/api/auth/otp/request", json={"phone": phone})
    assert r.status_code == 200, r.text
    code = sms.DEV_OUTBOX[phone[-10:]]
    r = await client.post("/api/auth/otp/verify", json={"phone": phone, "code": code, "name": name})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


@pytest.fixture
async def admin(client) -> Api:
    async with SessionLocal() as s:
        s.add(User(email="admin@pixcart.in", name="Admin", password_hash=hash_password("Admin@12345"), is_admin=True))
        await s.commit()
    r = await client.post("/api/auth/login", json={"email": "admin@pixcart.in", "password": "Admin@12345"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


@pytest.fixture
async def categories() -> dict[str, str]:
    async with SessionLocal() as s:
        root = Category(name="Fashion", slug="fashion", commission_bps=1000, default_gst_bps=500)
        s.add(root)
        await s.flush()
        shirts = Category(name="Men's Shirts", slug="mens-shirts", parent_id=root.id, commission_bps=1200, default_gst_bps=500)
        elec = Category(name="Electronics", slug="electronics", commission_bps=800, default_gst_bps=1800)
        s.add_all([shirts, elec])
        await s.flush()
        phones = Category(name="Mobiles", slug="mobiles", parent_id=elec.id, commission_bps=500, default_gst_bps=1800)
        s.add(phones)
        await s.commit()
        return {"fashion": str(root.id), "shirts": str(shirts.id), "electronics": str(elec.id), "mobiles": str(phones.id)}


def png_bytes(size=(400, 400), color=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def valid_gstin(state: str, pan: str) -> str:
    from app.core.validators import gstin_check_char

    first = f"{state}{pan}1Z"
    return first + gstin_check_char(first)


async def make_seller(client, admin: Api, phone: str, *, name: str, pan: str, state: str = "33", city: str = "Chennai", pincode: str = "600001") -> Api:
    s = await login_phone(client, phone, name=f"{name} Owner")
    r = await s.post("/api/seller/register", {"display_name": name})
    assert r.status_code == 201, r.text
    seller_id = r.json()["id"]
    r = await s.put(
        "/api/seller/profile",
        {
            "display_name": name,
            "description": "Quality goods",
            "legal_name": f"{name} Traders",
            "business_type": "proprietorship",
            "gstin": valid_gstin(state, pan),
            "pan": pan,
            "contact_email": f"{pan.lower()}@example.com",
            "contact_phone": phone,
        },
    )
    assert r.status_code == 200, r.text
    r = await s.put("/api/seller/pickup-address", {"line1": "12 Market Road", "city": city, "state_code": state, "pincode": pincode})
    assert r.status_code == 200, r.text
    r = await s.put("/api/seller/bank", {"holder_name": f"{name} Traders", "account_number": "123456789012", "confirm_account_number": "123456789012", "ifsc": "HDFC0001234"})
    assert r.status_code == 200, r.text
    r = await s.put("/api/seller/grievance-officer", {"name": "Ravi Kumar", "email": "grievance@example.com", "phone": phone})
    assert r.status_code == 200, r.text
    for kind in ("pan_card", "gst_certificate", "cancelled_cheque"):
        r = await client.post(f"/api/seller/documents/{kind}", headers=s.h(), files={"file": (f"{kind}.pdf", PDF, "application/pdf")})
        assert r.status_code == 200, r.text
    r = await s.post("/api/seller/submit")
    assert r.status_code == 200, r.text
    r = await admin.post(f"/api/admin/sellers/{seller_id}/approve")
    assert r.status_code == 200, r.text
    s.seller_id = seller_id
    return s


async def upload_image(client, api: Api) -> str:
    r = await client.post("/api/seller/images", headers=api.h(), files={"file": ("p.png", png_bytes(), "image/png")})
    assert r.status_code == 201, r.text
    return r.json()["url"]


async def make_live_product(client, admin: Api, seller: Api, category_id: str, *, title: str, variants: list[dict], gst_bps: int = 500, brand: str = "Acme") -> dict:
    img = await upload_image(client, seller)
    r = await seller.post(
        "/api/seller/products",
        {
            "category_id": category_id,
            "title": title,
            "brand": brand,
            "description": "A well made product with great materials and finish.",
            "highlights": ["Durable", "Comfortable"],
            "specs": {"Material": "Cotton"},
            "hsn_code": "6205",
            "gst_bps": gst_bps,
            "images": [img],
            "variants": variants,
        },
    )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    r = await seller.post(f"/api/seller/products/{pid}/submit")
    assert r.status_code == 200, r.text
    r = await admin.post(f"/api/admin/products/{pid}/approve")
    assert r.status_code == 200, r.text
    return r.json()


async def add_address(api: Api, *, state: str = "33", pincode: str = "600028", city: str = "Chennai") -> str:
    r = await api.post(
        "/api/addresses",
        {"full_name": "Priya S", "phone": "9876500000", "line1": "4 Lake View St", "city": city, "state_code": state, "pincode": pincode},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]
