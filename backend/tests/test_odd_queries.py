"""Odd query strings (huge page sizes, NUL characters, wrong types, odd sort values) never end as a server error on any read route."""
import re

ODD = ["-1", "0", "99999999999999999999", "x" * 3000, "a\x00b", "%00", "abc", "1.5e9", "null", "[]", "2026-13-45", "' OR 1=1 --"]


async def _sweep(c, headers, admin_routes):
    from app.main import app
    spec = app.openapi()
    bad, n = [], 0
    for path, ops in spec["paths"].items():
        if path.startswith("/api/admin") != admin_routes or "webhook" in path or "/auth/" in path or "download" in path or "export" in path:
            continue
        op = ops.get("get")
        if not op:
            continue
        url = re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)
        names = [p["name"] for p in op.get("parameters", []) if p["in"] == "query"] or ["q", "limit", "page", "sort"]
        for v in ODD:
            params = {k: v for k in names}
            try:
                r = await c.get(url, params=params, headers=headers)
            except Exception as e:
                bad.append((path, "EXC", repr(e)[:90])); continue
            n += 1
            if r.status_code >= 500:
                bad.append((path, r.status_code, v[:12]))
    assert n > 300
    assert not bad, bad[:30]


async def test_staff_read_routes_never_server_error_on_odd_queries(client, admin, categories):
    await _sweep(client, admin.h(), True)


async def test_customer_read_routes_never_server_error_on_odd_queries(client, categories):
    from tests.conftest import login_phone
    u = await login_phone(client, "9880000125", name="Query Fuzz")
    await _sweep(client, u.h(), False)
