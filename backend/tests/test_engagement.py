"""Product questions and answers, back-in-stock and price-drop alerts, compare, frequently bought together."""
from __future__ import annotations

from sqlalchemy import select

from app.db import SessionLocal
from app.models import Notification, StockAlert
from app.services import engagement
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


async def test_questions_and_answers(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    slug = shirt["slug"]
    assert (await client.get(f"/api/catalog/products/{slug}/questions")).json()["items"] == []
    assert (await client.post(f"/api/catalog/products/{slug}/questions", json={"text": "Is this pure cotton?"})).status_code == 401
    asker = await login_phone(client, "9600000081", name="Meena Asker")
    assert (await asker.post(f"/api/catalog/products/{slug}/questions", {"text": "Short?"})).status_code == 422
    r = (await asker.post(f"/api/catalog/products/{slug}/questions", {"text": "Is this shirt pure cotton or a blend?"})).json()
    assert r["status"] == "published"
    qid = r["id"]
    held = (await asker.post(f"/api/catalog/products/{slug}/questions", {"text": "Call me on 9876543210 about bulk price"})).json()
    assert held["status"] == "pending"
    seller_inbox = [n["title"] for n in (await tn.get("/api/notifications")).json()["items"]]
    assert "New customer question" in seller_inbox

    # a shopper who did not buy answers; a verified buyer answers; the seller answers
    other = await login_phone(client, "9600000082", name="Ravi Other")
    assert (await other.post(f"/api/questions/{qid}/answers", {"text": "I think it is cotton"})).json()["role"] == "customer"
    buyer = await login_phone(client, "9600000083", name="Kumar Buyer")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    await ship_and_deliver(tn, o["sub_orders"][0]["id"])
    assert (await buyer.post(f"/api/questions/{qid}/answers", {"text": "Yes, 100% cotton. Very soft."})).json()["role"] == "buyer"
    sq = (await tn.get("/api/seller/questions", params={"unanswered": True})).json()
    assert sq["unanswered"] == 1 and sq["items"][0]["id"] == qid
    assert (await tn.get("/api/seller/badges")).json()["questions"] == 1  # seller hub menu count
    assert (await admin.get("/api/admin/dashboard")).json()["questions_pending"] == 1  # the held question
    assert (await tn.post(f"/api/seller/questions/{qid}/answer", {"text": "Pure handloom cotton, pre-washed."})).json()["role"] == "seller"
    assert (await tn.get("/api/seller/badges")).json()["questions"] == 0
    assert (await ka.post(f"/api/seller/questions/{qid}/answer", {"text": "Not my product"})).status_code == 404
    assert (await asker.post(f"/api/questions/{qid}/answers", {"text": "Answering myself"})).json()["error"]["code"] == "own_question"

    data = (await client.get(f"/api/catalog/products/{slug}/questions")).json()
    q0 = data["items"][0]
    assert q0["answer_count"] == 3 and q0["answers"][0]["role"] == "seller" and q0["answers"][0]["author"] == "Kovai Textiles"
    assert [a["role_label"] for a in q0["answers"]][1:] in (["Verified buyer", "Customer"], ["Customer", "Verified buyer"])
    assert (await client.get(f"/api/catalog/products/{slug}/questions", params={"q": "pre-washed"})).json()["total"] == 1
    asker_inbox = [n["title"] for n in (await asker.get("/api/notifications")).json()["items"]]
    assert "Your question was answered" in asker_inbox

    # helpful votes toggle; not on your own answer
    aid = q0["answers"][1]["id"]
    voter = await login_phone(client, "9600000084", name="Voter")
    assert (await voter.post(f"/api/answers/{aid}/helpful")).json() == {"voted": True, "helpful_count": 1}
    assert (await voter.post(f"/api/answers/{aid}/helpful")).json()["helpful_count"] == 0
    seller_answer = q0["answers"][0]["id"]
    assert (await tn.post(f"/api/answers/{seller_answer}/helpful")).json()["error"]["code"] == "own_answer"

    # moderation: the held question waits; reports hide a post; staff publish or hide
    queue = (await admin.get("/api/admin/questions")).json()
    assert queue["counts"]["pending"] == 1 and queue["items"][0]["kind"] == "question"
    assert (await admin.post(f"/api/admin/questions/question/{held['id']}/publish")).json()["status"] == "published"
    for ph in ("9600000085", "9600000086", "9600000087"):
        rep = await login_phone(client, ph, name="Reporter")
        await rep.post("/api/qa/report", {"kind": "answer", "id": aid})
    assert (await client.get(f"/api/catalog/products/{slug}/questions", params={"q": "shirt pure"})).json()["items"][0]["answer_count"] == 2
    assert (await admin.post(f"/api/admin/questions/answer/{aid}/hide")).json()["status"] == "hidden"

    # only the seller and buyers may answer when the store says so; switching Q&A off
    await admin.put("/api/admin/settings", {"qa_buyers_answer_only": True})
    assert (await other.post(f"/api/questions/{qid}/answers", {"text": "Another guess"})).json()["error"]["code"] == "buyers_only"
    await admin.put("/api/admin/settings", {"feature_qa": False})
    assert (await client.get(f"/api/catalog/products/{slug}/questions")).json()["enabled"] is False
    assert (await asker.post(f"/api/catalog/products/{slug}/questions", {"text": "Is there a bigger size available?"})).json()["error"]["code"] == "qa_off"


async def test_qa_reports_count_each_person_once(client, admin, categories):
    """One account cannot hide a post by reporting it again and again; the owner sets how many people it takes."""
    tn, ka, shirt, phone = await setup(client, admin, categories)
    slug = shirt["slug"]
    asker = await login_phone(client, "9600000091", name="Meena Asker")
    qid = (await asker.post(f"/api/catalog/products/{slug}/questions", {"text": "Does the colour fade after washing?"})).json()["id"]

    async def visible() -> bool:
        return any(q["id"] == qid for q in (await client.get(f"/api/catalog/products/{slug}/questions")).json()["items"])

    async def report(api) -> dict:
        return (await api.post("/api/qa/report", {"kind": "question", "id": qid})).json()

    rival = await login_phone(client, "9600000092", name="Rival")
    assert await report(rival) == {"ok": True, "already": False, "hidden": False}
    for _ in range(4):
        assert (await report(rival))["already"] is True
    assert await visible()
    second, third = [await login_phone(client, f"96000000{n}", name="Shopper") for n in (93, 94)]
    assert (await report(second))["hidden"] is False
    assert (await report(third))["hidden"] is True  # three different people by default
    assert not await visible()

    # staff put it back: earlier reporters cannot hide it again; the owner's number applies to new reporters
    assert (await admin.post(f"/api/admin/questions/question/{qid}/publish")).json()["status"] == "published"
    assert (await admin.put("/api/admin/settings", {"qa_report_hide_at": 51})).status_code == 400
    assert (await admin.put("/api/admin/settings", {"qa_report_hide_at": 2})).json()["qa_report_hide_at"] == 2
    for api in (rival, second, third):
        assert (await report(api))["already"] is True
    assert await visible()
    fourth, fifth = [await login_phone(client, f"96000000{n}", name="Shopper") for n in (95, 96)]
    assert (await report(fourth))["hidden"] is False and (await report(fifth))["hidden"] is True
    assert not await visible()

    # 0 = reports never hide a post by themselves
    await admin.post(f"/api/admin/questions/question/{qid}/publish")
    await admin.put("/api/admin/settings", {"qa_report_hide_at": 0})
    for n in (97, 98):
        assert (await report(await login_phone(client, f"96000000{n}", name="Shopper")))["hidden"] is False
    assert await visible()
    queue = (await admin.get("/api/admin/questions", params={"status": "published"})).json()["items"]
    assert next(i for i in queue if i["id"] == qid)["report_count"] == 2  # reports since staff last checked it


async def test_back_in_stock_and_price_drop_alerts(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    vid = shirt["variants"][0]["id"]
    shopper = await login_phone(client, "9600000091", name="Alert Shopper")
    # price drop: saved at ₹1,000, the seller lowers it by 15 %
    assert (await shopper.put(f"/api/wishlist/{shirt['id']}")).status_code == 200
    # back in stock: the seller sells out, the shopper asks to be told
    assert (await tn.patch(f"/api/seller/variants/{vid}", {"stock": 0})).status_code == 200
    assert (await shopper.post("/api/alerts/stock", {"variant_id": vid})).json()["subscribed"] is True
    assert (await shopper.get("/api/alerts", params={"variant_id": vid})).json()["stock"][0]["in_stock"] is False
    async with SessionLocal() as s:
        assert await engagement.send_stock_alerts(s) == 0  # still out of stock
    await tn.patch(f"/api/seller/variants/{vid}", {"stock": 5, "price_paise": 85000})
    async with SessionLocal() as s:
        assert await engagement.send_stock_alerts(s) == 1
        assert await engagement.send_stock_alerts(s) == 0  # once
        assert await engagement.send_price_drops(s) == 1
        assert await engagement.send_price_drops(s) == 0  # not again at the same price
        alert = (await s.execute(select(StockAlert))).scalar_one()
        assert alert.active is False and alert.notified_at is not None
        events = set((await s.execute(select(Notification.event).where(Notification.channel == "inapp"))).scalars())
        assert {"back_in_stock", "price_drop"} <= events
    assert (await shopper.get("/api/alerts")).json()["stock"] == []
    assert (await shopper.post("/api/alerts/stock", {"variant_id": vid})).status_code == 201
    assert (await shopper.delete(f"/api/alerts/stock/{vid}")).json()["subscribed"] is False
    assert (await client.post("/api/alerts/stock", json={"variant_id": vid})).status_code == 401


async def test_compare_and_bought_together(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    c = (await client.get("/api/catalog/compare", params={"ids": f"{shirt['id']},{phone['id']},not-an-id"})).json()
    assert [x["slug"] for x in c["items"]] == [shirt["slug"], phone["slug"]] and "Brand" in c["info_keys"]
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}/bought-together")).json()["items"] == []
    buyer = await login_phone(client, "9600000095", name="Basket Buyer")
    addr = await add_address(buyer, state="33")
    for p in (shirt, phone):
        await buyer.post("/api/cart/items", {"variant_id": p["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    fbt = (await client.get(f"/api/catalog/products/{shirt['slug']}/bought-together")).json()["items"]
    assert [x["slug"] for x in fbt] == [shirt["slug"], phone["slug"]]
    await admin.put("/api/admin/settings", {"feature_bought_together": False, "feature_compare": False})
    assert (await client.get(f"/api/catalog/products/{shirt['slug']}/bought-together")).json()["items"] == []
    assert (await client.get("/api/catalog/compare", params={"ids": shirt["id"]})).json()["error"]["code"] == "compare_off"
