"""Every admin route must refuse an anonymous visitor and an ordinary customer."""
from __future__ import annotations

import re
import uuid

from app.main import app
from tests.conftest import login_phone

OPEN = {"/api/admin/auth/login", "/api/admin/auth/logout"}   # sign-in endpoints themselves


def admin_routes():
    out = []
    for path, ops in app.openapi()["paths"].items():
        if not path.startswith("/api/admin") or path in OPEN:
            continue
        for method in ops:
            if method.upper() in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                out.append((method.upper(), re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)))
    return out


async def test_every_admin_route_refuses_visitors_and_customers(client, admin, categories):
    routes = admin_routes()
    assert len(routes) > 100
    customer = await login_phone(client, "9770000611", name="Plain Customer")
    leaks = []
    for method, path in routes:
        for who, _c in (("visitor", client), ("customer", customer)):
            r = await client.request(method, path, json={}, headers={} if who == "visitor" else customer.h())
            if r.status_code not in (401, 403):
                leaks.append((who, method, path, r.status_code))
    assert not leaks, leaks[:20]
