"""Admin layouts: each staff member's own interface preferences (layout, folded menu sections, folded sidebar) and the
owner's default layout (Admin → Marketplace settings)."""
from __future__ import annotations

from app.db import SessionLocal
from app.models import User
from tests.conftest import Api, login_phone

URL = "/api/admin/me/preferences"


async def staff(client, admin: Api, email: str, role: str = "support") -> Api:
    r = await admin.post("/api/admin/staff", {"email": email, "name": role.title(), "role": role, "password": "Staff@2026xyz"})
    assert r.status_code in (200, 201), r.text
    r = await client.post("/api/auth/login", json={"email": email, "password": "Staff@2026xyz"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


async def test_defaults(admin):
    r = await admin.get(URL)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "ui_prefs": {"admin_layout": None, "nav_collapsed": [], "sidebar_collapsed": False},
        "admin_layout": "sidebar",
        "default_layout": "sidebar",
        "layouts": ["sidebar", "topnav", "rail", "glass"],
        "environment": "test",  # shown as a badge in the admin header outside production
    }
    assert (await admin.get("/api/admin/settings")).json()["admin_layout_default"] == "sidebar"


async def test_saving_merges_and_persists(admin):
    r = await admin.put(URL, {"admin_layout": "glass"})
    assert r.status_code == 200, r.text
    assert r.json()["admin_layout"] == "glass" and r.json()["ui_prefs"]["admin_layout"] == "glass"

    # fields left out keep their value; names are tidied and repeats dropped
    r = await admin.put(URL, {"nav_collapsed": ["  Delivery   fleet ", "AI", "AI"], "sidebar_collapsed": True})
    assert r.status_code == 200, r.text
    assert r.json()["ui_prefs"] == {"admin_layout": "glass", "nav_collapsed": ["Delivery fleet", "AI"], "sidebar_collapsed": True}

    # saved on the account, so every device sees it
    assert (await admin.get(URL)).json()["ui_prefs"]["nav_collapsed"] == ["Delivery fleet", "AI"]
    async with SessionLocal() as s:
        u = await s.get(User, admin.user["id"])
        assert u.ui_prefs == {"admin_layout": "glass", "nav_collapsed": ["Delivery fleet", "AI"], "sidebar_collapsed": True}

    # null goes back to the owner's default; unknown fields are dropped, never stored
    r = await admin.put(URL, {"admin_layout": None, "nav_collapsed": [], "theme": "dark", "is_admin": False})
    assert r.status_code == 200, r.text
    assert r.json()["admin_layout"] == "sidebar"
    assert r.json()["ui_prefs"] == {"admin_layout": None, "nav_collapsed": [], "sidebar_collapsed": True}
    async with SessionLocal() as s:
        u = await s.get(User, admin.user["id"])
        assert set(u.ui_prefs) == {"admin_layout", "nav_collapsed", "sidebar_collapsed"} and u.is_admin


async def test_validation(admin):
    bad = [
        {"admin_layout": "dark"},
        {"admin_layout": 3},
        {"admin_layout": ["glass"]},
        {"nav_collapsed": "AI"},
        {"nav_collapsed": [1, 2]},
        {"nav_collapsed": [""]},
        {"nav_collapsed": ["x" * 41]},
        {"nav_collapsed": [f"Section {i}" for i in range(21)]},
        {"sidebar_collapsed": "yes"},
        {"sidebar_collapsed": 1},
    ]
    for body in bad:
        r = await admin.put(URL, body)
        assert r.status_code == 422, (body, r.text)
        assert r.json()["error"]["code"] == "validation_error"
    # nothing was saved by the refused requests
    assert (await admin.get(URL)).json()["ui_prefs"] == {"admin_layout": None, "nav_collapsed": [], "sidebar_collapsed": False}
    # the limits themselves are allowed
    r = await admin.put(URL, {"nav_collapsed": [f"Section {i:02d}" + "x" * 30 for i in range(20)]})
    assert r.status_code == 200 and len(r.json()["ui_prefs"]["nav_collapsed"]) == 20

    # damaged stored values are read back as the defaults
    async with SessionLocal() as s:
        u = await s.get(User, admin.user["id"])
        u.ui_prefs = {"admin_layout": "neon", "nav_collapsed": "AI", "sidebar_collapsed": "yes", "x": 1}
        await s.commit()
    assert (await admin.get(URL)).json()["ui_prefs"] == {"admin_layout": None, "nav_collapsed": [], "sidebar_collapsed": False}


async def test_owner_default(client, admin):
    helper = await staff(client, admin, "desk@kadai.in")
    r = await admin.put("/api/admin/settings", {"admin_layout_default": "rail"})
    assert r.status_code == 200, r.text
    assert r.json()["admin_layout_default"] == "rail"

    # staff who have not chosen see the owner's default ...
    r = await helper.get(URL)
    assert r.json()["admin_layout"] == "rail" and r.json()["default_layout"] == "rail" and r.json()["ui_prefs"]["admin_layout"] is None
    # ... and their own choice wins over it
    await helper.put(URL, {"admin_layout": "topnav"})
    assert (await helper.get(URL)).json()["admin_layout"] == "topnav"
    await admin.put("/api/admin/settings", {"admin_layout_default": "glass"})
    assert (await helper.get(URL)).json()["admin_layout"] == "topnav"
    assert (await helper.get(URL)).json()["default_layout"] == "glass"

    # the default is validated like every other setting
    for value in ("dark", "", None, 1, True):
        r = await admin.put("/api/admin/settings", {"admin_layout_default": value})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_setting", (value, r.text)
    # and only staff with the settings permission may change it
    r = await helper.put("/api/admin/settings", {"admin_layout_default": "sidebar"})
    assert r.status_code == 403
    assert (await admin.get("/api/admin/settings")).json()["admin_layout_default"] == "glass"
    # it is not part of the public site settings
    assert "admin_layout_default" not in (await client.get("/api/site")).text


async def test_staff_change_only_their_own(client, admin):
    a = await staff(client, admin, "one@kadai.in", "support")
    b = await staff(client, admin, "two@kadai.in", "catalog")
    assert (await a.put(URL, {"admin_layout": "glass", "nav_collapsed": ["AI"]})).status_code == 200
    # another person's id in the body is ignored: the request always changes the caller's own preferences
    r = await b.put(URL, {"admin_layout": "rail", "user_id": a.user["id"], "id": a.user["id"]})
    assert r.status_code == 200 and r.json()["admin_layout"] == "rail"
    assert (await a.get(URL)).json()["ui_prefs"] == {"admin_layout": "glass", "nav_collapsed": ["AI"], "sidebar_collapsed": False}
    assert (await b.get(URL)).json()["ui_prefs"]["nav_collapsed"] == []
    # the owner's own preferences are untouched by both
    assert (await admin.get(URL)).json()["ui_prefs"]["admin_layout"] is None


async def test_not_for_customers_or_guests(client, admin):
    assert (await client.get(URL)).status_code == 401
    assert (await client.put(URL, json={"admin_layout": "glass"})).status_code == 401
    shopper = await login_phone(client, "9630011111", name="Shopper")
    assert (await shopper.get(URL)).status_code == 403
    assert (await shopper.put(URL, {"admin_layout": "glass"})).status_code == 403
    async with SessionLocal() as s:
        u = await s.get(User, shopper.user["id"])
        assert u.ui_prefs == {}
