"""Product page and reviews: product information and unit price, category requirements, social proof,
offers, seller snapshot, delivery cut-off, review photos, helpful votes, reports, moderation and the
"report an issue with this product" flow."""
from __future__ import annotations

from datetime import datetime

from app.services.delivery import IST, estimate
from app.services.product_info import unit_price
from app.services.product_page import bucket, topic_stats
from app.services.review_settings import DEFAULT_TOPICS
from tests.conftest import add_address, login_phone, png_bytes
from tests.test_gallery import body_from
from tests.test_phase2_money import key, setup, ship_and_deliver


async def buy(client, product, phone):
    buyer = await login_phone(client, phone, name=f"Buyer {phone[-2:]}")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": product["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return buyer, o["sub_orders"][0]["id"]


def test_unit_price_and_counts():
    assert unit_price(21000, 50, "g") == {"paise": 42000, "per": "100 g"}
    assert unit_price(50000, 2000, "g") == {"paise": 25000, "per": "kg"}
    assert unit_price(171000, 90, "pcs") == {"paise": 1900, "per": "piece"}
    assert unit_price(10000, 0, "g") is None and unit_price(10000, 5, "") is None
    assert [bucket(n) for n in (7, 42, 340, 2400)] == ["7", "40+", "300+", "2K+"]
    texts = [(5, "Great quality, worth the money"), (4, "Good quality"), (1, "Poor quality and leaked"), (5, "fast delivery")]
    q = next(t for t in topic_stats(texts, DEFAULT_TOPICS) if t["name"] == "Quality")
    assert q["count"] == 3 and q["positive"] == 2 and q["negative"] == 1


def test_dispatch_cutoff_countdown():
    morning = datetime(2026, 11, 18, 10, 0, tzinfo=IST)  # a Wednesday
    cfg = {"transit_days_same_city": 1, "transit_days_same_state": 3, "transit_days_national": 6}
    before = estimate(cfg, 1, "600001", "33", "600028", now=morning, cutoff="14:00")
    after = estimate(cfg, 1, "600001", "33", "600028", now=morning.replace(hour=15), cutoff="14:00")
    none = estimate(cfg, 1, "600001", "33", "600028", now=morning)
    assert before["order_within_min"] == 240 and after["order_within_min"] is None
    assert after["min_date"] > before["min_date"] == none["min_date"]


async def test_product_information_unit_price_and_category_requirements(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    cats = (await admin.get("/api/admin/categories")).json()
    shirts = next(c for c in cats if c["id"] == categories["shirts"])
    body = {k: shirts[k] for k in ("name", "parent_id", "image_url", "commission_bps", "default_gst_bps", "position", "is_active")}
    assert (await admin.put(f"/api/admin/categories/{shirts['id']}", body | {"required_details": ["nonsense"]})).status_code == 422
    r = await admin.put(f"/api/admin/categories/{shirts['id']}", body | {"required_details": ["manufacturer", "net_quantity", "customer_care"]})
    assert r.status_code == 200 and r.json()["required_details"] == ["net_quantity", "manufacturer", "customer_care"]
    # the parent category's requirement is inherited
    root = next(c for c in cats if c["id"] == shirts["parent_id"])
    rb = {k: root[k] for k in ("name", "parent_id", "image_url", "commission_bps", "default_gst_bps", "position", "is_active")}
    await admin.put(f"/api/admin/categories/{root['id']}", rb | {"required_details": ["generic_name"]})
    req = (await tn.get("/api/seller/listing-requirements", params={"category_id": shirts["id"]})).json()["required"]
    assert req == ["net_quantity", "generic_name", "manufacturer", "customer_care"]

    detail = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    assert len(detail["missing_details"]) == 4
    # a new draft in this category cannot be submitted without them
    draft = body_from(detail, title="Handloom Cotton Shirt Green")
    draft["variants"] = [{"sku": "HL-G", "options": {}, "mrp_paise": 200000, "price_paise": 100000, "stock": 5}]
    new = (await tn.post("/api/seller/products", draft)).json()
    r = await tn.post(f"/api/seller/products/{new['id']}/submit")
    assert r.json()["error"]["code"] == "listing_incomplete" and "manufacturer" in r.json()["error"]["message"]

    bad = body_from(detail) | {"details": {"fssai_license": "123"}}
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", bad)).status_code == 422
    info = {"net_unit": "g", "generic_name": "Shirt", "manufacturer": "Kovai Textiles, 12 Mill Road, Coimbatore 641001",
            "customer_care": "care@kovai.example, 0422 1234567", "in_the_box": ["1 shirt"], "key_specs": ["Fabric"],
            "ingredients": "", "warranty": "No warranty"}
    good = body_from(detail, specs={"Fabric": "Cotton", "Fit": "Slim"}) | {"details": info}
    good["variants"][0]["net_qty"] = 250
    r = await tn.put(f"/api/seller/products/{shirt['id']}", good)
    assert r.status_code == 200, r.text
    assert r.json()["missing_details"] == [] and r.json()["status"] == "pending" and r.json()["variants"][0]["net_qty"] == 250
    # price-only edits after this do not send the listing back to review
    await admin.post(f"/api/admin/products/{shirt['id']}/approve")
    again = (await tn.get(f"/api/seller/products/{shirt['id']}")).json()
    again_body = body_from(again) | {"details": again["details"]}
    again_body["variants"][0]["net_qty"] = 250
    again_body["variants"][0]["price_paise"] = 90000
    assert (await tn.put(f"/api/seller/products/{shirt['id']}", again_body)).json()["status"] == "approved"

    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    v = page["variants"][0]
    assert v["net_quantity"] == "250 g" and v["unit_price"] == {"paise": 36000, "per": "100 g"}
    labels = {row["label"]: row["value"] for row in page["info"]}
    assert labels["Manufacturer"].startswith("Kovai Textiles") and labels["In the box"] == "1 shirt" and labels["Warranty"] == "No warranty"
    assert [k["label"] for k in page["key_specs"]] == ["Brand", "Fabric"]
    assert page["important"] == []
    # switches
    await admin.put("/api/admin/settings", {"pdp_unit_price": False, "pdp_key_specs": False})
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["variants"][0]["unit_price"] is None and page["key_specs"] == []
    site = (await client.get("/api/site")).json()
    assert site["pdp"]["unit_price"] is False and site["pdp"]["share"] is True and site["reviews"]["photos"] is True


async def test_social_proof_offers_snapshot_and_delivery(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    await admin.post("/api/admin/coupons", {"code": "WELCOME10", "kind": "percent", "value": 1000, "max_discount_paise": 15000, "per_user_limit": 1})
    await tn.post("/api/seller/coupons", {"code": "KOVAI100", "kind": "flat", "value": 10000, "min_order_paise": 50000})
    await ka.post("/api/seller/coupons", {"code": "MYSURU50", "kind": "flat", "value": 5000})
    await admin.put("/api/admin/settings", {"pdp_bought_min": 1})
    _, sub = await buy(client, shirt, "9600000011")
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["bought_last_month"] == "1 bought in the past month"
    codes = {o["code"]: o for o in page["offers"]}
    assert set(codes) == {"WELCOME10", "KOVAI100"}  # another seller's coupon is not offered here
    assert codes["WELCOME10"]["title"] == "10% off up to ₹150" and codes["KOVAI100"]["terms"] == "on orders of ₹500 or more"
    assert codes["KOVAI100"]["source"] == "seller"
    snap = page["seller_snapshot"]
    assert snap["top_seller"] is False and snap["since"] and snap["orders_90d"] is None  # fewer than 5 orders: not shown
    assert page["bestseller"] is None or page["bestseller"]["rank"] >= 1
    await admin.put("/api/admin/settings", {"pdp_offers": False, "pdp_bought_count": False, "pdp_seller_snapshot": False})
    page = (await client.get(f"/api/catalog/products/{shirt['slug']}")).json()
    assert page["offers"] == [] and page["bought_last_month"] is None and page["seller_snapshot"] is None

    # seller dispatch cut-off feeds the delivery estimate
    assert (await tn.put("/api/seller/preferences", {"dispatch_days": 1, "holiday_mode": False, "dispatch_cutoff": "25:00"})).status_code == 422
    r = await tn.put("/api/seller/preferences", {"dispatch_days": 1, "holiday_mode": False, "dispatch_cutoff": "23:59"})
    assert r.json()["dispatch_cutoff"] == "23:59"
    est = (await client.get("/api/catalog/delivery-estimate", params={"variant_id": shirt["variants"][0]["id"], "pincode": "641001"})).json()
    assert est["serviceable"] and est["state"] == "Tamil Nadu" and est["delivery_fee_paise"] == 0 and "order_within_min" in est


async def test_reviews_photos_votes_reports_and_moderation(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    slug = shirt["slug"]
    buyer, sub = await buy(client, shirt, "9600000021")
    guest = (await client.get(f"/api/catalog/products/{slug}/reviews")).json()
    assert guest["can_review"] is False and guest["cannot_review_reason"] == "sign_in"
    assert (await buyer.get(f"/api/catalog/products/{slug}/reviews")).json()["cannot_review_reason"] == "not_purchased"
    assert (await tn.get(f"/api/catalog/products/{slug}/reviews")).json()["cannot_review_reason"] == "own_product"
    await ship_and_deliver(tn, sub)
    assert (await buyer.get(f"/api/catalog/products/{slug}/reviews")).json()["can_review"] is True

    # guests cannot upload; customers upload a photo, other sites' links are refused
    assert (await client.post("/api/reviews/media", files={"file": ("a.png", png_bytes(), "image/png")})).status_code == 401
    up = await client.post("/api/reviews/media", headers=buyer.h(), files={"file": ("a.png", png_bytes(), "image/png")})
    assert up.status_code == 201 and up.json()["kind"] == "image" and "/reviews/" in up.json()["url"]
    photo = up.json()["url"]
    bad = {"rating": 5, "media": [{"kind": "image", "url": "https://evil.example/x.png"}]}
    assert (await buyer.put(f"/api/catalog/products/{slug}/reviews", bad)).status_code == 422
    r = await buyer.put(f"/api/catalog/products/{slug}/reviews", {"rating": 5, "title": "Great quality", "body": "Soft cotton, great quality",
                                                                   "media": [{"kind": "image", "url": photo}]})
    assert r.status_code == 200 and r.json()["status"] == "published"
    data = (await client.get(f"/api/catalog/products/{slug}/reviews")).json()
    item = data["items"][0]
    assert item["verified"] and item["media"][0]["url"] == photo and data["with_media_count"] == 1 and data["media_total"] == 1
    assert data["media"][0]["review_id"] == item["id"]
    assert (await client.get(f"/api/catalog/products/{slug}/reviews", params={"star": 3})).json()["total"] == 0
    assert (await client.get(f"/api/catalog/products/{slug}/reviews", params={"media": True})).json()["total"] == 1

    # helpful: signed-in only, one vote that toggles, not on your own review
    rid = item["id"]
    assert (await client.post(f"/api/reviews/{rid}/helpful")).status_code == 401
    assert (await buyer.post(f"/api/reviews/{rid}/helpful")).json()["error"]["code"] == "own_review"
    other = await login_phone(client, "9600000022", name="Other Shopper")
    assert (await other.post(f"/api/reviews/{rid}/helpful")).json() == {"ok": True, "voted": True, "helpful_count": 1}
    assert (await other.post(f"/api/reviews/{rid}/helpful")).json()["helpful_count"] == 0

    # customer photos can be limited to signed-in shoppers
    await admin.put("/api/admin/review-settings", {"media_public": False})
    assert (await client.get(f"/api/catalog/products/{slug}/reviews")).json()["items"][0]["media"] == []
    assert (await client.get(f"/api/catalog/products/{slug}/media")).json()["sign_in_to_see"] is True
    assert (await other.get(f"/api/catalog/products/{slug}/reviews")).json()["items"][0]["media"][0]["url"] == photo

    # reports: two reports hide the review until staff look; publishing dismisses them
    r = await admin.put("/api/admin/review-settings", {"report_hide_at": 2})
    assert r.status_code == 200 and r.json()["report_hide_at"] == 2
    assert (await other.post(f"/api/reviews/{rid}/report", {"reason": "bogus"})).json()["error"]["code"] == "invalid_reason"
    assert (await other.post(f"/api/reviews/{rid}/report", {"reason": "fake"})).json()["hidden"] is False
    assert (await other.post(f"/api/reviews/{rid}/report", {"reason": "fake"})).json()["already"] is True
    assert (await tn.post(f"/api/seller/reviews/{rid}/report", {"reason": "not_product", "note": "Wrong item shown"})).json()["hidden"] is True
    assert (await client.get(f"/api/catalog/products/{slug}/reviews")).json()["rating_count"] == 0
    queue = (await admin.get("/api/admin/reviews", params={"reported": True})).json()
    assert queue["items"][0]["report_count"] == 2 and len(queue["items"][0]["reports"]) == 2 and queue["counts"]["pending"] == 1
    assert (await admin.get("/api/admin/dashboard")).json()["reviews_needing_attention"] == 1
    assert (await admin.post(f"/api/admin/reviews/{rid}/publish")).json()["status"] == "published"
    assert (await admin.get("/api/admin/reviews", params={"reported": True})).json()["total"] == 0
    assert (await admin.post(f"/api/admin/reviews/{rid}/hide-media")).json()["media_status"] == "hidden"
    assert (await other.get(f"/api/catalog/products/{slug}/reviews")).json()["items"][0]["media"] == []

    # contact details in a review hold it for a person to check
    r = await buyer.put(f"/api/catalog/products/{slug}/reviews", {"rating": 4, "body": "Call me on 9876543210 for a discount"})
    assert r.json()["status"] == "pending" and r.json()["held_for_check"] is True

    # when anyone signed in may review, a non-buyer's review carries no "verified" badge
    assert (await other.put(f"/api/catalog/products/{slug}/reviews", {"rating": 3, "body": "Saw it in a shop"})).json()["error"]["code"] == "not_purchased"
    await admin.put("/api/admin/review-settings", {"buyers_only": False, "min_body_chars": 5})
    assert (await other.put(f"/api/catalog/products/{slug}/reviews", {"rating": 3, "body": "ok"})).json()["error"]["code"] == "review_too_short"
    assert (await other.put(f"/api/catalog/products/{slug}/reviews", {"rating": 3, "body": "Saw it in a shop, decent"})).status_code == 200
    items = (await client.get(f"/api/catalog/products/{slug}/reviews", params={"verified": True})).json()
    assert items["total"] == 0  # the buyer's review is waiting for a check; the other is not verified
    assert (await client.get(f"/api/catalog/products/{slug}/reviews")).json()["items"][0]["verified"] is False
    assert (await other.delete(f"/api/catalog/products/{slug}/reviews")).status_code == 200

    # seller view and settings validation
    sv = (await tn.get("/api/seller/reviews")).json()
    assert sv["total"] == 1 and sv["items"][0]["id"] == rid and sv["items"][0]["reported"] is True
    assert (await tn.get("/api/seller/reviews", params={"media": True})).json()["total"] == 0  # the photo was removed in the edit
    assert (await admin.put("/api/admin/review-settings", {"max_photos": 99})).status_code == 400
    assert (await admin.put("/api/admin/review-settings", {"topics": [{"name": "X", "words": ["a"]}]})).status_code == 400
    assert (await buyer.put("/api/admin/review-settings", {"photos": False})).status_code == 403


async def test_report_a_product(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    slug = shirt["slug"]
    assert (await client.post(f"/api/catalog/products/{slug}/report", json={"reason": "counterfeit"})).status_code == 401
    shopper = await login_phone(client, "9600000031", name="Careful Shopper")
    r = await shopper.post(f"/api/catalog/products/{slug}/report", {"reason": "counterfeit", "note": "short"})
    assert r.json()["error"]["code"] == "note_required"
    r = await shopper.post(f"/api/catalog/products/{slug}/report", {"reason": "price", "url": "javascript:alert(1)"})
    assert r.status_code == 422
    r = await shopper.post(f"/api/catalog/products/{slug}/report", {"reason": "counterfeit", "note": "The logo is different from the brand's"})
    assert r.status_code == 201
    # the seller sees it without the customer's details
    seller_view = (await tn.get("/api/seller/product-reports")).json()
    assert seller_view["open"] == 1 and "customer" not in seller_view["items"][0] and "phone" not in seller_view["items"][0]
    assert (await tn.post(f"/api/seller/product-reports/{seller_view['items'][0]['id']}/respond", {"note": "We sell only genuine stock"})).status_code == 200
    q = (await admin.get("/api/admin/product-reports")).json()
    assert q["counts"]["open"] == 1 and q["items"][0]["customer"] == "Careful Shopper" and q["items"][0]["seller_note"] == "We sell only genuine stock"
    assert (await admin.get("/api/admin/dashboard")).json()["product_reports_open"] == 1
    r = await admin.post(f"/api/admin/product-reports/{q['items'][0]['id']}", {"status": "resolved", "admin_note": "Brand confirmed it is fake", "take_down": True})
    assert r.json()["product_status"] == "rejected"
    assert (await client.get(f"/api/catalog/products/{slug}")).status_code == 404
    titles = [n["title"] for n in (await tn.get("/api/notifications")).json()["items"]]
    assert any("taken down" in t.lower() or "listing" in t.lower() for t in titles)
    await admin.put("/api/admin/settings", {"pdp_report": False})
    phone_slug = (await client.get("/api/catalog/products", params={"q": "Feature Phone"})).json()["items"][0]["slug"]
    assert (await shopper.post(f"/api/catalog/products/{phone_slug}/report", {"reason": "price"})).json()["error"]["code"] == "reports_off"
