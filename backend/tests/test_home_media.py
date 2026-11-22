"""Home media (Admin → Storefront → Home page): optional videos on hero slides, banners, banner grids and card tiles;
the "Image or video block"; the category style of a categories section; and the media library taking videos as well
as images."""
from __future__ import annotations

import pytest
from conftest import login_phone, png_bytes

from app.services.cms import MEDIA_ASPECTS, validate_section

# The smallest files that pass the content checks (see test_gallery.py): an MP4 "ftyp" box and a WebM EBML header.
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 2000
WEBM = bytes.fromhex("1a45dfa3") + b"\x9f\x42\x86\x81\x01\x42\x82\x84webm" + b"\x00" * 2000
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00" + b"\x00" * 2000
HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 2000  # a phone photo, not a video

IMAGE = "/media/products/0123456789abcdef.webp"
VIDEO = "/media/videos/0123456789abcdef.mp4"
VIDEO_MSG = "Videos must be uploaded through the media library"
BAD_VIDEOS = [
    "javascript:alert(1)//x.mp4",
    "JavaScript:alert(1)",
    "http://cdn.example.com/clip.mp4",  # not https
    "//cdn.example.com/clip.mp4",  # another site, without a scheme
    "data:video/mp4;base64,AAAA",
    "/media/videos/clip.mov",  # not MP4 or WebM
    "/media/videos/clip.mp4.exe",
    IMAGE,  # a picture in the video field
    "https://cdn.example.com/page.html?file=.mp4",  # the file's own extension counts, not the query's
    '/media/videos/"onerror=alert(1).mp4',
    "/media/videos/" + "a" * 400 + ".mp4",  # longer than 400 characters
    "https://[cdn.example.com/clip.mp4",  # not a valid address
]


def slide(**over) -> dict:
    return {"image": IMAGE, "heading": "Silk week", "text": "Handloom sarees", "cta": "Shop now", "link": "/c/fashion"} | over


def tiles_card(*tiles: dict) -> dict:
    return {"cards": [{"title": "Top picks", "mode": "tiles", "tiles": list(tiles)}]}


async def test_videos_on_slides_banners_grids_and_tiles():
    hero = validate_section("hero", {"slides": [slide(video=VIDEO), slide()], "style": "fade"})
    assert hero["slides"][0]["video"] == VIDEO and hero["slides"][0]["image"] == IMAGE  # the image stays as the poster
    assert hero["slides"][1]["video"] == ""
    assert hero["slides"][0]["image_mobile"] == "" and hero["slides"][0]["theme"] == "light"  # the other fields are unchanged

    https_video = "https://cdn.example.com/home/loop.webm?v=2"
    banner = validate_section("banner", slide(video=https_video))
    assert banner == {"image": IMAGE, "video": https_video, "link": "/c/fashion", "heading": "Silk week", "text": "Handloom sarees", "cta": "Shop now"}
    assert validate_section("banner", slide(video=None))["video"] == ""  # optional

    grid = validate_section("banner_grid", {"items": [slide(video=VIDEO), slide(video=" /media/videos/loop.WEBM ")]})
    assert [i["video"] for i in grid["items"]] == [VIDEO, "/media/videos/loop.WEBM"]  # trimmed; any letter case

    cards = validate_section("cards", tiles_card({"image": IMAGE, "video": VIDEO, "label": "Sarees", "link": "/c/sarees"}, {"label": "Kurtas"}))
    assert cards["cards"][0]["tiles"] == [
        {"image": IMAGE, "video": VIDEO, "label": "Sarees", "link": "/c/sarees", "badge": ""},
        {"image": "", "video": "", "label": "Kurtas", "link": "", "badge": ""},
    ]


async def test_video_addresses_are_checked_everywhere():
    for bad in BAD_VIDEOS:
        for kind, cfg in (
            ("hero", {"slides": [slide(video=bad)]}),
            ("banner", slide(video=bad)),
            ("banner_grid", {"items": [slide(), slide(video=bad)]}),
            ("cards", tiles_card({"image": IMAGE, "video": bad})),
            ("media", {"image": IMAGE, "video": bad}),
        ):
            with pytest.raises(ValueError, match=VIDEO_MSG):
                validate_section(kind, cfg)
                pytest.fail(f"{kind} took {bad!r}")


async def test_image_or_video_block():
    full = validate_section("media", {
        "image": IMAGE, "video": VIDEO, "link": "/deals", "heading": "H" * 200, "text": "T" * 400, "cta": "C" * 50,
        "align": "center", "tone": "dark", "aspect": "4/5", "width": "full", "controls": True, "onclick": "alert(1)",
    })
    assert full == {
        "image": IMAGE, "video": VIDEO, "link": "/deals", "heading": "H" * 80, "text": "T" * 160, "cta": "C" * 30,
        "align": "center", "tone": "dark", "aspect": "4/5", "width": "full", "controls": True,
    }
    # unknown choices fall back to safe defaults, and video controls need a video
    loose = validate_section("media", {"image": IMAGE, "align": "right", "tone": "neon", "aspect": "3/1", "width": "huge", "controls": True})
    assert loose == {
        "image": IMAGE, "video": "", "link": "", "heading": "", "text": "", "cta": "",
        "align": "left", "tone": "light", "aspect": "16/9", "width": "contained", "controls": False,
    }
    assert [validate_section("media", {"image": IMAGE, "aspect": a})["aspect"] for a in MEDIA_ASPECTS] == list(MEDIA_ASPECTS)
    assert validate_section("media", {"video": VIDEO, "controls": "yes"})["controls"] is False  # only a real true counts
    video_only = validate_section("media", {"video": VIDEO, "controls": True})
    assert video_only["image"] == "" and video_only["controls"] is True
    assert validate_section("media", {"image": IMAGE, "heading": "Silk\x00 week\x1b"})["heading"] == "Silk week"

    for empty in ({}, {"heading": "Nothing to show"}, {"image": "", "video": "  "}):
        with pytest.raises(ValueError, match="Add an image or a video"):
            validate_section("media", empty)
    with pytest.raises(ValueError, match="Links must start with / or https://"):
        validate_section("media", {"image": IMAGE, "link": "javascript:alert(1)"})
    for bad_image in ("javascript:alert(1)", "http://cdn.example.com/a.png"):
        with pytest.raises(ValueError, match="Images must be uploaded through the media library"):
            validate_section("media", {"image": bad_image, "video": VIDEO})


async def test_category_style():
    def style(value):
        return validate_section("categories", {"slugs": ["fashion"], "style": value})["style"]

    for kept in ("auto", "circles", "cards", "squares", "chips"):
        assert style(kept) == kept
    # "tiles" (saved by earlier versions) and anything unknown follow the theme
    for old in ("tiles", "grid", "", None, ["chips"], 3):
        assert style(old) == "auto"
    assert validate_section("categories", {}) == {"slugs": [], "style": "auto"}


async def test_admin_saves_media_sections(client, admin):
    listing = (await admin.get("/api/admin/storefront/sections")).json()
    assert listing["kinds"]["media"] == "Image or video block"
    categories = next(s for s in listing["items"] if s["kind"] == "categories")
    assert categories["config"]["style"] == "auto"  # a fresh store's default

    body = {"kind": "media", "title": "See it in use", "config": {"image": IMAGE, "video": VIDEO, "heading": "Brass lamps", "link": "/c/home", "aspect": "21/9"}}
    r = await admin.post("/api/admin/storefront/sections", body)
    assert r.status_code == 201, r.text
    block = r.json()
    assert block["kind_label"] == "Image or video block"
    assert block["config"] == {"image": IMAGE, "video": VIDEO, "link": "/c/home", "heading": "Brass lamps", "text": "", "cta": "",
                               "align": "left", "tone": "light", "aspect": "21/9", "width": "contained", "controls": False}

    r = await admin.post("/api/admin/storefront/sections", {"kind": "media", "config": {"heading": "Empty"}})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_section" and r.json()["error"]["message"] == "Add an image or a video"
    r = await admin.put(f"/api/admin/storefront/sections/{block['id']}", body | {"config": body["config"] | {"video": "http://cdn.example.com/x.mp4"}})
    assert r.status_code == 400 and r.json()["error"]["message"] == VIDEO_MSG
    r = await admin.put(f"/api/admin/storefront/sections/{block['id']}", body | {"config": body["config"] | {"controls": True, "width": "full"}})
    assert r.status_code == 200 and r.json()["config"]["controls"] is True and r.json()["config"]["width"] == "full"

    hero = {"kind": "hero", "config": {"slides": [slide(video=VIDEO)], "style": "boxed"}}
    assert (await admin.post("/api/admin/storefront/sections", hero)).status_code == 201
    r = await admin.put(f"/api/admin/storefront/sections/{categories['id']}", categories | {"config": {"slugs": [], "style": "tiles"}})
    assert r.status_code == 200 and r.json()["config"]["style"] == "auto"

    # shoppers get the blocks as saved
    sections = (await client.get("/api/home")).json()["sections"]
    media = next(s for s in sections if s["kind"] == "media")
    assert media["title"] == "See it in use" and media["config"]["video"] == VIDEO and media["config"]["controls"] is True
    assert next(s for s in sections if s["kind"] == "hero")["config"]["slides"][0]["video"] == VIDEO


async def test_media_library_takes_images_and_videos(client, admin):
    def upload(api, name: str, data: bytes, ctype: str):
        return client.post("/api/admin/media", params={"label": name}, files={"file": (name, data, ctype)}, headers=api.h())

    r = await upload(admin, "Festive banner", png_bytes((1200, 400)), "image/png")
    assert r.status_code == 201, r.text
    image = r.json()
    assert image["kind"] == "image" and image["url"].startswith("/media/products/") and image["url"].endswith(".webp")
    assert image["label"] == "Festive banner" and image["id"] and image["at"]

    r = await upload(admin, "Kitchen in use", MP4, "video/mp4")
    assert r.status_code == 201, r.text
    mp4 = r.json()
    assert mp4["kind"] == "video" and mp4["url"].startswith("/media/videos/") and mp4["url"].endswith(".mp4")
    webm = (await upload(admin, "Loop", WEBM, "video/webm")).json()
    assert webm["kind"] == "video" and webm["url"].endswith(".webm")
    # the content decides, not the name or the type the browser sent
    renamed = (await upload(admin, "not-a-photo.png", MP4, "image/png")).json()
    assert renamed["kind"] == "video" and renamed["url"].endswith(".mp4")

    assert (await upload(admin, "clip.mov", MOV, "video/quicktime")).json()["error"]["code"] == "invalid_video"
    assert (await upload(admin, "photo.heic", HEIC, "video/mp4")).json()["error"]["code"] == "invalid_image"  # never stored as a video
    assert (await upload(admin, "notes.txt", b"just some words " * 50, "text/plain")).json()["error"]["code"] == "invalid_image"
    assert (await upload(admin, "tiny.png", png_bytes((100, 100)), "image/png")).json()["error"]["code"] == "image_too_small"

    # every item says what it is; the list can be narrowed to one kind
    items = (await admin.get("/api/admin/media")).json()
    assert {m["id"]: m["kind"] for m in items} == {image["id"]: "image", mp4["id"]: "video", webm["id"]: "video", renamed["id"]: "video"}
    assert all(set(m) == {"id", "url", "label", "at", "kind"} for m in items)
    videos = (await admin.get("/api/admin/media", params={"kind": "video"})).json()
    assert sorted(m["id"] for m in videos) == sorted([mp4["id"], webm["id"], renamed["id"]])
    assert [m["id"] for m in (await admin.get("/api/admin/media", params={"kind": "image"})).json()] == [image["id"]]
    assert (await admin.get("/api/admin/media", params={"kind": "audio"})).status_code == 422

    # size limits: videos follow the product video limit (Admin → Product page), images keep theirs
    assert (await admin.put("/api/admin/settings", {"max_video_mb": 5})).status_code == 200
    big_video = MP4 + b"\x00" * (5 * 1024 * 1024)
    r = await upload(admin, "big.mp4", big_video, "video/mp4")
    assert r.json()["error"]["code"] == "file_too_large" and "5 MB" in r.json()["error"]["message"]
    big_image = png_bytes() + b"\x00" * (5 * 1024 * 1024)
    assert (await upload(admin, "big.png", big_image, "image/png")).json()["error"]["code"] == "file_too_large"
    assert len((await admin.get("/api/admin/media")).json()) == 4  # refused files are not listed

    # an uploaded video can be used on the home page at once
    banner = {"kind": "banner", "config": {"image": image["url"], "video": mp4["url"], "link": "/deals"}}
    r = await admin.post("/api/admin/storefront/sections", banner)
    assert r.status_code == 201 and r.json()["config"]["video"] == mp4["url"]

    # uploads are audited; shoppers cannot use the library
    history = (await admin.get("/api/admin/audit", params={"entity_id": mp4["id"]})).json()["items"]
    assert [(h["action"], h["detail"]) for h in history] == [("storefront.media_upload", "video")]
    shopper = await login_phone(client, "9600000081", name="Shopper")
    assert (await shopper.get("/api/admin/media")).status_code == 403
    assert (await upload(shopper, "clip.mp4", MP4, "video/mp4")).status_code == 403
