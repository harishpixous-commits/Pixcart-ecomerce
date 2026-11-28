"""URL redirects: staff map an old address to a new one; the shop's page-not-found screen asks and sends the visitor on."""
from __future__ import annotations


async def test_redirects_crud_rules_and_lookup(client, admin):
    r = await admin.post("/api/admin/redirects", {"from_path": "/Old-Shirt/", "to_path": "/p/new-shirt"})
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["from_path"] == "/old-shirt" and rule["status_code"] == 301 and rule["hits"] == 0   # tidied: lower case, no end slash
    # visitors resolve it with or without the slash, and each use is counted
    for path in ("/old-shirt", "/OLD-shirt/"):
        got = await client.get("/api/catalog/redirect", params={"path": path})
        assert got.status_code == 200 and got.json() == {"to": "/p/new-shirt", "status": 301}
    assert (await client.get("/api/catalog/redirect", params={"path": "/nothing-here"})).status_code == 404
    assert (await admin.get("/api/admin/redirects")).json()["items"][0]["hits"] == 2
    # rules that make no sense are refused
    bad = [
        {"from_path": "old", "to_path": "/x"},                       # must start with /
        {"from_path": "/", "to_path": "/x"},                          # the home page cannot be redirected
        {"from_path": "/admin/orders", "to_path": "/x"},              # reserved areas
        {"from_path": "/a", "to_path": "//evil.example"},             # not a safe address
        {"from_path": "/a", "to_path": "http://plain.example"},       # https only
        {"from_path": "/a", "to_path": "/a/"},                        # same place
        {"from_path": "/a", "to_path": "/x", "status_code": 307},
        {"from_path": "/p/new-shirt", "to_path": "/old-shirt"},       # a circle with the first rule
    ]
    for b in bad:
        assert (await admin.post("/api/admin/redirects", b)).status_code == 422, b
    assert (await admin.post("/api/admin/redirects", {"from_path": "/old-shirt", "to_path": "/y"})).status_code == 409   # one rule per old address
    # edit to a temporary redirect, then switch it off: the shop no longer follows it
    r2 = await admin.put(f"/api/admin/redirects/{rule['id']}", {"from_path": "/old-shirt", "to_path": "https://example.com/shirt", "status_code": 302})
    assert r2.status_code == 200 and r2.json()["status_code"] == 302
    assert (await client.get("/api/catalog/redirect", params={"path": "/old-shirt"})).json()["to"] == "https://example.com/shirt"
    await admin.put(f"/api/admin/redirects/{rule['id']}", {"from_path": "/old-shirt", "to_path": "/p/new-shirt", "is_active": False})
    assert (await client.get("/api/catalog/redirect", params={"path": "/old-shirt"})).status_code == 404
    assert (await admin.delete(f"/api/admin/redirects/{rule['id']}")).status_code == 200
    assert (await admin.get("/api/admin/redirects")).json()["items"] == []
