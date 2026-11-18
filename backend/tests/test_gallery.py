"""Product gallery: video upload checks, videos on listings (seller and staff), admin limits and switches,
and the gallery settings the storefront reads."""
from conftest import upload_image
from test_phase2_money import setup

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 2000
WEBM = bytes.fromhex("1a45dfa3") + b"\x9f\x42\x86\x81\x01\x42\x82\x84webm" + b"\x00" * 2000
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00" + b"\x00" * 2000


async def upload_video(api, path: str, data: bytes, name: str = "clip.mp4", ctype: str = "video/mp4"):
    return await api.c.post(path, files={"file": (name, data, ctype)}, headers=api.h())


def body_from(detail: dict, **over) -> dict:
    b = {k: detail[k] for k in ("category_id", "title", "brand", "description", "highlights", "specs", "hsn_code", "gst_bps",
                                "country_of_origin", "return_window_days", "images")}
    b["videos"] = detail.get("videos", [])
    b["variants"] = [{k: v[k] for k in ("id", "sku", "options", "mrp_paise", "price_paise", "stock")} for v in detail["variants"]]
    return b | over


async def test_seller_adds_videos_and_customers_see_them(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    # type checks by content, not by file name
    assert (await upload_video(tn, "/api/seller/videos", b"not a video at all" * 10)).json()["error"]["code"] == "invalid_video"
    assert (await upload_video(tn, "/api/seller/videos", MOV, "a.mov")).json()["error"]["code"] == "invalid_video"
    mp4 = (await upload_video(tn, "/api/seller/videos", MP4)).json()["url"]
    webm = (await upload_video(tn, "/api/seller/videos", WEBM, "b.webm", "video/webm")).json()["url"]
    assert mp4.startswith("/media/videos/") and mp4.endswith(".mp4") and webm.endswith(".webm")
    poster = await upload_image(client, tn)

    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert detail["status"] == "approved" and detail["videos"] == []
    videos = [{"url": mp4, "poster_url": poster, "title": "How it fits", "duration_s": 42}, {"url": webm, "title": "Fabric close-up"}]
    r = await tn.put(f"/api/seller/products/{shirt['id']}", body_from(detail, videos=videos))
    assert r.status_code == 200, r.text
    assert [v["title"] for v in r.json()["videos"]] == ["How it fits", "Fabric close-up"]
    assert r.json()["status"] == "pending"  # new videos are content: the listing is checked again
    # links to other sites are refused
    bad = body_from(r.json(), videos=[{"url": "https://evil.example/x.mp4"}])
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", bad)).status_code == 422

    await admin.post(f"/api/admin/products/{shirt['id']}/approve")
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["videos"][0] == {"url": mp4, "poster_url": poster, "title": "How it fits", "duration_s": 42}

    # admin: limit per listing, switch videos off (hidden from customers, uploads refused), zoom settings for the store
    r = await admin.put("/api/admin/settings", {"max_videos_per_listing": 1})
    assert r.status_code == 200
    again = body_from((await tn.get(f"/api/seller/products/{shirt['id']}")).json(), title="Handloom Cotton Shirt Blue Slim")
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", again)).status_code == 200  # same videos: not re-checked
    more = body_from((await tn.get(f"/api/seller/products/{shirt['id']}")).json())
    more["videos"] = more["videos"] + [{"url": mp4, "title": "again"}]
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", more)).json()["error"]["code"] == "too_many_videos"
    await admin.put("/api/admin/settings", {"feature_product_videos": False, "gallery_zoom": False, "gallery_zoom_level": 30})
    assert (await upload_video(tn, "/api/seller/videos", MP4)).json()["error"]["code"] == "videos_off"
    await admin.post(f"/api/admin/products/{shirt['id']}/approve")
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["videos"] == []
    site = (await client.get("/api/site")).json()
    assert site["gallery"]["zoom"] is False and site["gallery"]["zoom_level"] == 3.0 and site["features"]["product_videos"] is False
    assert (await admin.put("/api/admin/settings", {"gallery_zoom_level": 99})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"max_video_mb": 1})).status_code == 400


async def test_staff_manage_listing_videos_and_size_limit(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    await admin.put("/api/admin/settings", {"max_video_mb": 5})
    big = MP4 + b"\x00" * (5 * 1024 * 1024)
    assert (await upload_video(admin, "/api/admin/products/videos", big)).json()["error"]["code"] == "file_too_large"
    url = (await upload_video(admin, "/api/admin/products/videos", MP4)).json()["url"]
    r = await admin.put(f"/api/admin/products/{shirt['id']}/videos", {"videos": [{"url": url, "title": "Demo"}]})
    assert r.status_code == 200 and r.json()["videos"][0]["title"] == "Demo" and r.json()["status"] == "approved"  # staff fix keeps it live
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()["videos"][0]["url"] == url
    assert (await admin.put(f"/api/admin/products/{shirt['id']}/videos", {"videos": []})).json()["videos"] == []
    hist = (await admin.get("/api/admin/audit", params={"entity_id": shirt["id"]})).json()["items"]
    assert any(h["action"] == "product.videos" for h in hist)
    # sellers cannot use the staff endpoints
    assert (await tn.put(f"/api/admin/products/{shirt['id']}/videos", {"videos": []})).status_code == 403
