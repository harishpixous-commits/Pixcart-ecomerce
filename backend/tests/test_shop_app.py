"""The shop's mobile app (Admin -> Marketplace settings -> Mobile apps): download links on /app, the "Get the app" bar,
and publishing the customer Android app (APK)."""
from __future__ import annotations

import io
import zipfile

from tests.conftest import login_phone


def apk_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("AndroidManifest.xml", b"\x03\x00\x08\x00")
        z.writestr("classes.dex", b"dex\n035\x00")
    return buf.getvalue()


async def test_defaults_on_the_site(client):
    app = (await client.get("/api/site")).json()["app"]
    assert app == {"banner": True, "android_apk_url": "", "play_store_url": "", "app_store_url": "", "version": ""}


async def test_links_and_validation(client, admin):
    r = await admin.put("/api/admin/settings", {"shop_play_store_url": "https://play.google.com/store/apps/details?id=in.pixcart.shop",
                                                "shop_app_store_url": "https://apps.apple.com/in/app/pixcart/id123", "shop_app_banner": False})
    assert r.status_code == 200, r.text
    app = (await client.get("/api/site")).json()["app"]
    assert app["play_store_url"].startswith("https://play.google.com") and app["app_store_url"].startswith("https://apps.apple.com")
    assert app["banner"] is False
    for body in ({"shop_play_store_url": "javascript:alert(1)"}, {"shop_app_store_url": "ftp://x"}, {"shop_app_version": "x" * 21},
                 {"shop_app_banner": "yes"}, {"shop_android_apk_url": 5}):
        assert (await admin.put("/api/admin/settings", body)).status_code == 400, body
    # links can be cleared again
    assert (await admin.put("/api/admin/settings", {"shop_play_store_url": ""})).status_code == 200


async def test_upload_the_android_app(client, admin):
    files = {"file": ("app-release.apk", apk_bytes(), "application/vnd.android.package-archive")}
    r = await client.post("/api/admin/shop-app?version=1.2.0", files=files, headers=admin.h())
    assert r.status_code == 200, r.text
    url = r.json()["settings"]["shop_android_apk_url"]
    assert "pixcart-shop-1.2.0" in url and url.endswith(".apk")
    app = (await client.get("/api/site")).json()["app"]
    assert app["android_apk_url"] == url and app["version"] == "1.2.0"
    # not an app file
    r = await client.post("/api/admin/shop-app", files={"file": ("x.apk", b"hello", "application/octet-stream")}, headers=admin.h())
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_apk"
    # staff without the settings permission, and customers, cannot publish
    shopper = await login_phone(client, "9750000001", "Asha")
    assert (await client.post("/api/admin/shop-app", files=files, headers=shopper.h())).status_code == 403
