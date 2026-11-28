"""Odd bodies (empty, huge text, NUL characters, wrong types, absurd numbers) never end as a server error on any staff or customer route."""
import re


async def test_staff_routes_never_server_error_on_odd_bodies(client, admin, categories):
    from app.main import app
    spec = app.openapi()
    bad = []
    n = 0
    for path, ops in spec["paths"].items():
        if not path.startswith("/api/admin"): continue
        if any(x in path for x in ("logout", "backup", "restore", "purge", "import")): continue
        for m, op in ops.items():
            if m not in ("post", "put", "patch"): continue
            url = re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)
            for body in ({}, {"name": "x" * 100000, "title": "a\x00b", "value": "z" * 10, "code": "\u0000" * 5, "reason": "r" * 50000},
                         [], {"id": None, "value": None, "enabled": "maybe", "amount_paise": -(10**20)}):
                try:
                    r = await admin.c.request(m.upper(), url, json=body, headers=admin.h())
                except Exception as e:
                    bad.append((m, path, "EXC", repr(e)[:100])); continue
                n += 1
                if r.status_code >= 500: bad.append((m, path, r.status_code, str(body)[:40]))
    assert n > 300
    assert not bad, bad[:40]


async def test_customer_routes_never_server_error_on_odd_bodies(client, admin, categories):
    from tests.conftest import login_phone
    admin = await login_phone(client, "9880000123", name="Fuzz Customer")
    from app.main import app
    spec = app.openapi()
    bad = []
    n = 0
    for path, ops in spec["paths"].items():
        if path.startswith("/api/admin") or "webhook" in path or "/auth/" in path: continue
        if any(x in path for x in ("logout", "backup", "restore", "purge", "import")): continue
        for m, op in ops.items():
            if m not in ("post", "put", "patch"): continue
            url = re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)
            for body in ({}, {"name": "x" * 100000, "title": "a\x00b", "value": "z" * 10, "code": "\u0000" * 5, "reason": "r" * 50000},
                         [], {"id": None, "value": None, "enabled": "maybe", "amount_paise": -(10**20)}):
                try:
                    r = await admin.c.request(m.upper(), url, json=body, headers=admin.h())
                except Exception as e:
                    bad.append((m, path, "EXC", repr(e)[:100])); continue
                n += 1
                if r.status_code >= 500: bad.append((m, path, r.status_code, str(body)[:40]))
    assert n > 300
    assert not bad, bad[:40]
