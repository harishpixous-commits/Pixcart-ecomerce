"""Storefront themes: switching the theme, colour presets and per-theme colours, validation, and that a theme change
never touches other site settings (Admin → Storefront → Theme and layout)."""
from __future__ import annotations

from app.db import SessionLocal
from app.models import PlatformSetting
from app.services.cms import SITE_KEY


async def test_default_theme_is_classic(client):
    site = (await client.get("/api/site")).json()
    assert site["theme"] == "classic"
    assert site["theme_settings"] == {}


async def test_switch_theme_with_preset_and_colours(client, admin):
    r = await admin.put("/api/admin/storefront/theme", {
        "theme": "bazaar",
        "settings": {"bazaar": {"preset": "crimson", "colors": {"primary": "#9b1b30", "page": "#F7F1F2", "evil": "#000000"}}},
    })
    assert r.status_code == 200, r.text
    assert r.json() == {"theme": "bazaar", "theme_settings": {"bazaar": {"preset": "crimson", "colors": {"primary": "#9B1B30", "page": "#F7F1F2"}}}}
    site = (await client.get("/api/site")).json()
    assert site["theme"] == "bazaar"
    assert site["theme_settings"]["bazaar"]["preset"] == "crimson"

    # another theme's settings are added without losing Bazaar's
    r = await admin.put("/api/admin/storefront/theme", {"theme": "luxe", "settings": {"luxe": {"preset": "emerald"}}})
    assert r.status_code == 200, r.text
    settings = (await client.get("/api/site")).json()["theme_settings"]
    assert settings["luxe"] == {"preset": "emerald"} and settings["bazaar"]["preset"] == "crimson"

    # switching back keeps every theme's settings for next time
    assert (await admin.put("/api/admin/storefront/theme", {"theme": "classic"})).status_code == 200
    site = (await client.get("/api/site")).json()
    assert site["theme"] == "classic" and set(site["theme_settings"]) == {"bazaar", "luxe"}


async def test_theme_values_are_validated(client, admin):
    put = lambda body: admin.put("/api/admin/storefront/theme", body)  # noqa: E731
    assert (await put({"theme": "neon"})).status_code == 400
    assert (await put({"theme": "fresh", "settings": {"fresh": {"colors": {"primary": "green"}}}})).status_code == 400
    assert (await put({"theme": "fresh", "settings": {"fresh": {"colors": {"accent": "#FFF"}}}})).status_code == 400
    assert (await put({"theme": "fresh", "settings": {"fresh": {"preset": "<script>"}}})).status_code == 400
    # unknown themes in the settings are dropped, not stored
    r = await put({"theme": "fresh", "settings": {"neon": {"preset": "x"}, "fresh": {"preset": "berry"}}})
    assert r.status_code == 200 and r.json()["theme_settings"] == {"fresh": {"preset": "berry"}}


async def test_theme_change_keeps_other_site_settings(client, admin):
    r = await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai", "colors": {"primary": "#123456"}})
    assert r.status_code == 200, r.text
    assert (await admin.put("/api/admin/storefront/theme", {"theme": "fresh"})).status_code == 200
    site = (await client.get("/api/site")).json()
    assert site["brand_name"] == "Kadai" and site["colors"]["primary"] == "#123456" and site["theme"] == "fresh"

    # saving the whole site (other tabs) keeps the theme and its settings
    await admin.put("/api/admin/storefront/theme", {"theme": "fresh", "settings": {"fresh": {"preset": "citrus"}}})
    full = (await admin.get("/api/admin/storefront/site")).json()
    full["tagline"] = "Fresh every day"
    r = await admin.put("/api/admin/storefront/site", full)
    assert r.status_code == 200, r.text
    site = (await client.get("/api/site")).json()
    assert site["tagline"] == "Fresh every day" and site["theme"] == "fresh" and site["theme_settings"] == {"fresh": {"preset": "citrus"}}


async def test_a_removed_theme_reads_as_classic(client, admin):
    await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai"})
    async with SessionLocal() as s:
        row = await s.get(PlatformSetting, SITE_KEY)
        row.value = {**row.value, "theme": "retired", "theme_settings": {"retired": {"preset": "x"}, "luxe": {"colors": {"primary": "bad"}}}}
        await s.commit()
    site = (await client.get("/api/site")).json()
    assert site["theme"] == "classic" and site["theme_settings"] == {}


async def test_only_marketing_staff_change_the_theme(client, admin):
    from tests.conftest import login_phone

    shopper = await login_phone(client, "9876500001")
    assert (await shopper.put("/api/admin/storefront/theme", {"theme": "luxe"})).status_code in (401, 403)
    assert (await client.put("/api/admin/storefront/theme", json={"theme": "luxe"})).status_code == 401
