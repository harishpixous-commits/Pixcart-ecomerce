"""The footer newsletter box: off until admin opens it, collects clean addresses once, staff can list and remove them."""
from __future__ import annotations


async def test_newsletter_box(client, admin):
    assert (await client.get("/api/newsletter")).json()["enabled"] is False
    off = await client.post("/api/newsletter", json={"email": "a@example.com"})
    assert off.status_code == 400 and off.json()["error"]["code"] == "newsletter_off"

    r = await admin.put("/api/admin/growth/settings", {"newsletter": {"enabled": True, "title": "Join us"}})
    assert r.status_code == 200, r.text
    box = (await client.get("/api/newsletter")).json()
    assert box == {"enabled": True, "title": "Join us"}

    bad = await client.post("/api/newsletter", json={"email": "not-an-email"})
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "invalid_email"
    assert (await client.post("/api/newsletter", json={"email": "  Meena@Example.com "})).status_code == 201
    assert (await client.post("/api/newsletter", json={"email": "meena@example.com"})).status_code == 201  # again: same answer, one row

    lst = (await admin.get("/api/admin/growth/newsletter")).json()
    assert lst["enabled"] is True and lst["total"] == 1 and lst["items"][0]["email"] == "meena@example.com"
    assert (await client.get("/api/admin/growth/newsletter")).status_code in (401, 403)
    assert (await admin.delete(f"/api/admin/growth/newsletter/{lst['items'][0]['id']}")).status_code == 200
    assert (await admin.get("/api/admin/growth/newsletter")).json()["total"] == 0
