"""Customer-facing shop assistant: isolation from the admin assistant and admin data, guest and customer journeys,
ownership checks, confirm-before-run changes, tickets from chat, admin switches, permissions and live mode."""
import ast
import json
import pathlib
import uuid

import httpx
from conftest import add_address, login_phone
from test_assistant import _live, anthropic_events
from test_phase2_money import key, setup

from app.llm import adapters
from app.shop_assistant import intents

H = {"X-Requested-With": "pixcart"}
APP = pathlib.Path(__file__).resolve().parents[1] / "app"
ADMIN_ONLY = ("commission", "payout", "tcs", "tds", "settlement", "gstin", "pan_", "bank", "seller_payout", "is_internal", "hsn", "sku",
              "taxable", "cgst", "sgst", "igst", "admin_role")


def events(r: httpx.Response) -> list[dict]:
    assert r.status_code == 200, r.text
    return [json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:")]


def text_of(ev: list[dict]) -> str:
    return "".join(e.get("delta", "") for e in ev if e["type"] == "text")


def cards(ev: list[dict], kind: str | None = None) -> list[dict]:
    return [e["card"] for e in ev if e["type"] == "card" and (kind is None or e["card"]["type"] == kind)]


async def guest_chat(client) -> tuple[str, dict]:
    r = await client.post("/api/shop-assistant/sessions", json={"page": {"path": "/"}}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()["id"], {**H, "X-Chat-Key": r.json()["guest_key"]}


async def ask_guest(client, chat: str, hdr: dict, text: str) -> list[dict]:
    return events(await client.post(f"/api/shop-assistant/sessions/{chat}/messages", json={"text": text}, headers=hdr))


async def customer_chat(api) -> str:
    r = await api.post("/api/shop-assistant/sessions", {"page": {"path": "/orders"}})
    assert r.status_code == 201 and r.json()["guest_key"] is None
    return r.json()["id"]


async def ask(api, chat: str, text: str, **kw) -> list[dict]:
    return events(await api.post(f"/api/shop-assistant/sessions/{chat}/messages", {"text": text, **kw}))


async def buyer_with_order(client, admin, categories, phone="9620000101", name="Meena"):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    buyer = await login_phone(client, phone, name=name)
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return buyer, o, tn


# ----------------------------------------------------------------------------- isolation by construction


def test_shop_assistant_never_imports_admin_code():
    files = list((APP / "shop_assistant").glob("*.py")) + [APP / "routers" / "shop_assistant.py"]
    banned = ("app.assistant", "app.ai", "app.routers.admin", "app.routers.admin_extras", "app.routers.assistant", "app.routers.staff",
              "app.routers.admin_shop_assistant", "app.routers.integrations", "app.routers.exports")
    for f in files:
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""] if isinstance(node, ast.ImportFrom) else []
            for n in names:
                assert not any(n == b or n.startswith(b + ".") for b in banned), f"{f.name} imports {n}"


def test_intents_understand_customers_in_their_language():
    cases = {"where is my order PC261118ABC123": "track", "en order enga?": "track", "எனது ஆர்டர் எங்கே": "track", "मेरा ऑर्डर कहाँ है": "track",
             "cancel pannanum": "cancel", "item arrived damaged": "damaged", "I want to return this": "return", "refund varala": "refund",
             "money deducted but payment failed": "payment", "talk to customer care": "human", "my tickets": "tickets",
             "running shoes under 2000": "search", "hi": "greet", "thanks": "thanks", "highlights of the phone": "unknown"}
    for text, want in cases.items():
        assert intents.detect(text).name == want, text
    it = intents.detect("show me pressure cooker under ₹2,500")
    assert it.query == "pressure cooker" and it.max_price == 250000
    assert intents.detect("cancel PC261118ABC123-2").package_number == "PC261118ABC123-2"
    assert intents.detect("வணக்கம்").lang == "ta" and intents.detect("नमस्ते").lang == "hi"


# ----------------------------------------------------------------------------- guests


async def test_guest_gets_help_and_products_but_no_account_data(client, admin, categories):
    await buyer_with_order(client, admin, categories)
    cfg = (await client.get("/api/shop-assistant/config")).json()
    assert cfg["enabled"] and cfg["mode"] == "guided" and not cfg["signed_in"]
    chat, hdr = await guest_chat(client)

    ev = await ask_guest(client, chat, hdr, "hello")
    assert ev[0]["type"] == "start" and ev[-1]["type"] == "done" and cards(ev, "chips")
    ev = await ask_guest(client, chat, hdr, "is cash on delivery available?")
    assert "Cash on delivery" in text_of(ev) and cards(ev, "article")
    ev = await ask_guest(client, chat, hdr, "show me cotton shirt under 1500")
    items = cards(ev, "products")[0]["items"]
    assert items[0]["title"] == "Handloom Cotton Shirt Blue" and set(items[0]) <= {"id", "slug", "title", "brand", "image", "price", "mrp", "discount_pct",
                                                                                     "rating_avg", "rating_count", "in_stock", "seller_name"}
    ev = await ask_guest(client, chat, hdr, "where is my order")
    assert cards(ev, "signin") and not cards(ev, "order") and not cards(ev, "orders")

    # the chat is reachable only with its key
    assert (await client.get(f"/api/shop-assistant/sessions/{chat}", headers=H)).status_code == 404
    assert (await client.get(f"/api/shop-assistant/sessions/{chat}", headers={**H, "X-Chat-Key": "x" * 32})).status_code == 404
    r = await client.get(f"/api/shop-assistant/sessions/{chat}", headers=hdr)
    assert r.status_code == 200 and len(r.json()["messages"]) == 8

    # signing in moves the guest chat to the account; the key alone no longer opens it
    me = await login_phone(client, "9620000199", name="Ravi")
    r = await client.get(f"/api/shop-assistant/sessions/{chat}", headers={**me.h(), **hdr})
    assert r.status_code == 200
    assert (await client.get(f"/api/shop-assistant/sessions/{chat}", headers=hdr)).status_code == 404


# ----------------------------------------------------------------------------- customers


async def test_customer_journey_track_cancel_ticket(client, admin, categories):
    buyer, o, _ = await buyer_with_order(client, admin, categories)
    chat = await customer_chat(buyer)

    ev = await ask(buyer, chat, "en order enga?")
    order = cards(ev, "order")[0]["order"]
    assert order["number"] == o["number"] and "waiting for the seller" in text_of(ev)
    assert not any(k in json.dumps(order).lower() for k in ADMIN_ONLY)

    ev = await ask(buyer, chat, f"cancel {o['number']}")
    conf = cards(ev, "confirm")[0]
    assert conf["status"] == "pending" and "Yes, cancel" in text_of(ev)
    assert (await buyer.get(f"/api/orders/{o['id']}")).json()["sub_orders"][0]["status"] == "placed"  # nothing changed yet

    other = await login_phone(client, "9620000102", name="Someone")
    assert (await other.post(f"/api/shop-assistant/actions/{conf['action_id']}/confirm")).status_code == 404
    r = await buyer.post(f"/api/shop-assistant/actions/{conf['action_id']}/confirm")
    assert r.status_code == 200 and "is cancelled" in r.json()["message"]["text"]
    assert (await buyer.get(f"/api/orders/{o['id']}")).json()["sub_orders"][0]["status"] == "cancelled"
    assert (await buyer.post(f"/api/shop-assistant/actions/{conf['action_id']}/confirm")).status_code == 409
    saved = (await buyer.get(f"/api/shop-assistant/sessions/{chat}")).json()["messages"]
    assert any(b.get("type") == "confirm" and b["status"] == "done" for m in saved for b in m["blocks"])

    ev = await ask(buyer, chat, "I want to talk to customer care about my refund")
    form = cards(ev, "ticket_form")[0]
    assert form["category"] == "payment" and "refund" in form["message"]
    r = await buyer.post(f"/api/shop-assistant/sessions/{chat}/ticket", {"category": form["category"], "subject": "Refund question",
                                                                       "message": form["message"], "order_id": o["id"]})
    assert r.status_code == 201, r.text
    number = r.json()["ticket"]["number"]
    staff_view = (await admin.get("/api/admin/tickets")).json()
    tid = next(t["id"] for t in staff_view["items"] if t["number"] == number)
    detail = (await admin.get(f"/api/admin/tickets/{tid}")).json()
    assert "Chat with the help assistant" in detail["messages"][0]["body"]

    # a staff-only note never reaches the chat; a real reply does
    await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "Internal: customer is a VIP, check payout hold", "internal": True})
    await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "Hi Meena, your refund is not needed for COD.", "status": "awaiting_customer"})
    ev = await ask(buyer, chat, f"status of {number}")
    assert "Hi Meena" in text_of(ev) and "VIP" not in json.dumps(ev) and "payout" not in json.dumps(ev)

    ev = await ask(buyer, chat, "எனது ஆர்டர் எங்கே")
    assert "ஆர்டர்" in text_of(ev)


async def test_customers_never_see_each_others_records(client, admin, categories):
    buyer, o, _ = await buyer_with_order(client, admin, categories)
    thief = await login_phone(client, "9620000103", name="Other")
    chat = await customer_chat(thief)
    ev = await ask(thief, chat, f"track {o['number']}")
    assert not cards(ev, "order") and o["number"] in text_of(ev) and "couldn't find" in text_of(ev)
    ev = await ask(thief, chat, f"cancel {o['number']}")
    assert not cards(ev, "confirm") and "No order with that number" in text_of(ev)
    # another customer's chat is invisible
    mine = await customer_chat(buyer)
    assert (await thief.get(f"/api/shop-assistant/sessions/{mine}")).status_code == 404
    assert (await thief.post(f"/api/shop-assistant/sessions/{mine}/messages", {"text": "hi"})).status_code == 404


async def test_shipped_order_shows_tracking_and_cannot_be_cancelled(client, admin, categories):
    buyer, o, seller = await buyer_with_order(client, admin, categories)
    sub = (await buyer.get(f"/api/orders/{o['id']}")).json()["sub_orders"][0]["id"]
    for step in ("confirm", "pack"):
        assert (await seller.post(f"/api/seller/orders/{sub}/{step}")).status_code == 200
    r = await seller.post(f"/api/seller/orders/{sub}/ship", {"courier_name": "Delhivery", "tracking_number": "DL12345678"})
    assert r.status_code == 200, r.text
    chat = await customer_chat(buyer)
    ev = await ask(buyer, chat, "where is my package")
    assert "Delhivery" in text_of(ev) and "DL12345678" in text_of(ev)
    ev = await ask(buyer, chat, f"cancel {o['number']}")
    assert not cards(ev, "confirm") and "already shipped" in text_of(ev)


# ----------------------------------------------------------------------------- admin switches, knowledge base, permissions


async def test_admin_switches_permissions_and_knowledge_base(client, admin, categories):
    buyer, o, _ = await buyer_with_order(client, admin, categories)
    s = (await admin.get("/api/admin/shop-assistant/settings")).json()
    assert s["status"]["mode"] == "guided" and {f["key"] for f in s["features"]} >= {"orders", "cancel_orders", "tickets"}

    # a feature switched off: the assistant points to the page instead
    assert (await admin.put("/api/admin/shop-assistant/settings", {"features": {"cancel_orders": False}})).status_code == 200
    chat = await customer_chat(buyer)
    ev = await ask(buyer, chat, f"cancel {o['number']}")
    assert not cards(ev, "confirm") and cards(ev, "link")[0]["link"] == "/orders"

    # guests off
    await admin.put("/api/admin/shop-assistant/settings", {"allow_guests": False})
    assert (await client.post("/api/shop-assistant/sessions", json={}, headers=H)).status_code == 401
    assert (await client.get("/api/shop-assistant/config")).json()["enabled"] is False

    # master switch off
    await admin.put("/api/admin/shop-assistant/settings", {"enabled": False})
    assert (await buyer.post(f"/api/shop-assistant/sessions/{chat}/messages", {"text": "hi"})).status_code == 409
    await admin.put("/api/admin/shop-assistant/settings", {"enabled": True, "allow_guests": True, "features": {"cancel_orders": True}})
    assert (await admin.put("/api/admin/shop-assistant/settings", {"ai": "magic"})).status_code == 400

    # knowledge base: add, find, hide, refuse unsafe links
    r = await admin.post("/api/admin/shop-assistant/articles", {"title": "Gift wrapping", "body": "We gift wrap orders for free on request.",
                                                                "keywords": ["gift wrap", "gift"], "topic": "orders", "link": "/pages/about"})
    assert r.status_code == 201, r.text
    art = r.json()
    assert (await admin.post("/api/admin/shop-assistant/articles", {"title": "Bad", "body": "Click this link now please", "link": "https://evil.example"})).status_code == 400
    hits = (await admin.post("/api/admin/shop-assistant/articles/try", {"question": "do you gift wrap?"})).json()["items"]
    assert hits[0]["title"] == "Gift wrapping"
    ev = await ask(buyer, chat, "do you gift wrap?")
    assert "gift wrap orders for free" in text_of(ev)
    await admin.put(f"/api/admin/shop-assistant/articles/{art['id']}", {**{k: art[k] for k in ("title", "body", "keywords", "topic", "link")}, "is_published": False})
    ev = await ask(buyer, chat, "do you gift wrap?")
    assert "gift wrap orders for free" not in text_of(ev)

    # chats and stats are for staff with the chats permission only
    lst = (await admin.get("/api/admin/shop-assistant/chats")).json()
    assert lst["total"] >= 1 and lst["items"][0]["customer"] == "Meena" and lst["items"][0]["phone"].startswith("••")
    assert (await admin.get(f"/api/admin/shop-assistant/chats/{chat}")).json()["messages"]
    assert (await admin.get("/api/admin/shop-assistant/stats")).json()["messages"] >= 3

    await admin.post("/api/admin/staff", {"email": "mkt9@kadai.in", "name": "Mkt", "role": "marketing", "password": "Marketing@2026x"})
    tok = (await client.post("/api/auth/login", json={"email": "mkt9@kadai.in", "password": "Marketing@2026x"})).json()["access_token"]
    mh = {"Authorization": f"Bearer {tok}"}
    assert (await client.get("/api/admin/shop-assistant/articles", headers=mh)).status_code == 200  # marketing writes articles
    assert (await client.get("/api/admin/shop-assistant/chats", headers=mh)).status_code == 403  # but cannot read customer chats
    assert (await client.put("/api/admin/shop-assistant/settings", json={"enabled": False}, headers=mh)).status_code == 403
    # customers cannot reach admin endpoints
    assert (await buyer.get("/api/admin/shop-assistant/chats")).status_code == 403


# ----------------------------------------------------------------------------- live mode (AI model connected)


async def test_live_mode_offers_only_customer_tools_and_falls_back(client, admin, categories, monkeypatch):
    buyer, o, _ = await buyer_with_order(client, admin, categories)
    other_buyer = await login_phone(client, "9620000104", name="Other")
    calls: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        calls.append(body)
        last = body["messages"][-1]
        results = [b for b in last["content"] if isinstance(last["content"], list) and b.get("type") == "tool_result" and not b["tool_use_id"].startswith("prefetch")]
        if not results:  # first turn: try an admin tool, then this customer's order
            return httpx.Response(200, text=anthropic_events([
                {"type": "tool_use", "id": "t1", "name": "business_overview", "input": {"period": "today"}},
                {"type": "tool_use", "id": "t2", "name": "order_details", "input": {"order_number": o["number"]}}], "tool_use"))
        return httpx.Response(200, text=anthropic_events([{"type": "text", "text": "Your order is placed."}], "end_turn"))

    await _live(monkeypatch, handler)
    r = await admin.post("/api/admin/ai-providers/connections", {"type": "anthropic", "name": "Claude shop", "models": ["claude-haiku-5-5"],
                                                                "add_keys": [{"key": "sk-ant-shop"}]})
    conn = next(c for c in r.json()["connections"] if c["name"] == "Claude shop")
    r = await admin.put("/api/admin/ai-providers/routes", {"routes": {"shop_assistant": [{"connection": conn["id"], "model": "claude-haiku-5-5"}]}})
    assert r.status_code == 200, r.text
    assert (await client.get("/api/shop-assistant/config")).json()["mode"] == "live"

    # the owner of the order
    chat = await customer_chat(buyer)
    ev = await ask(buyer, chat, "is my order coming?")
    assert ev[-1]["type"] == "done" and ev[-1]["mode"] == "live" and "Your order is placed." in text_of(ev)
    offered = {t["name"] for t in calls[0]["tools"]}
    assert offered == {"search_products", "product_info", "help_articles", "store_policies", "my_orders", "order_details",
                       "my_returns_and_refunds", "my_tickets", "ticket_details", "prepare_ticket", "prepare_cancellation"}
    system = json.dumps(calls[0]["system"])
    assert "customer help assistant" in system and "business_overview" not in system
    results = {b["tool_use_id"]: b for b in calls[-1]["messages"][-1]["content"]}
    assert "no tool called business_overview" in results["t1"]["content"]
    assert o["number"] in results["t2"]["content"]
    assert not any(k in results["t2"]["content"].lower() for k in ADMIN_ONLY)

    # the same model call made by another customer finds nothing
    calls.clear()
    chat2 = await customer_chat(other_buyer)
    await ask(other_buyer, chat2, "is my order coming?")
    results = {b["tool_use_id"]: b for b in calls[-1]["messages"][-1]["content"]}
    assert o["number"] not in results["t2"]["content"] and "No order with that number" in results["t2"]["content"]

    # guests are not offered account tools at all
    calls.clear()
    gchat, hdr = await guest_chat(client)
    await ask_guest(client, gchat, hdr, "hello")
    assert {t["name"] for t in calls[0]["tools"]} == {"search_products", "product_info", "help_articles", "store_policies"}

    # the model is down: the customer still gets a guided answer
    monkeypatch.setattr(adapters, "transport", httpx.MockTransport(lambda req: httpx.Response(500, json={"error": {"message": "down"}})))
    ev = await ask(buyer, chat, f"track {o['number']}")
    assert ev[-1]["type"] == "done" and ev[-1]["mode"] == "guided" and cards(ev, "order")
    usage = (await admin.get("/api/admin/shop-assistant/settings")).json()["status"]["tokens_this_month"]
    assert usage > 0


async def test_rate_limit_per_chat(client, admin, categories):
    await admin.put("/api/admin/shop-assistant/settings", {"limits": {"per_minute": 2, "per_day_customer": 100, "per_day_guest": 40}})
    chat, hdr = await guest_chat(client)
    for _ in range(2):
        await ask_guest(client, chat, hdr, "hi")
    r = await client.post(f"/api/shop-assistant/sessions/{chat}/messages", json={"text": "hi"}, headers=hdr)
    assert r.status_code == 429
    chat2, hdr2 = await guest_chat(client)  # another shopper on the same network is not blocked
    assert (await client.post(f"/api/shop-assistant/sessions/{chat2}/messages", json={"text": "hi"}, headers=hdr2)).status_code == 200
    assert uuid.UUID(chat2)


async def test_fees_on_the_bill_are_explained_and_reach_older_knowledge_bases(client, admin):
    """The marketplace's own fees (including the bad weather and late night fees) come from Admin → Checkout and fees;
    a knowledge base seeded before the "Fees on your bill" article existed gets it once."""
    from sqlalchemy import delete, func, select

    from app.db import SessionLocal, utcnow
    from app.models import PlatformSetting, ShopKbArticle
    from app.shop_assistant import kb

    await admin.put("/api/admin/checkout", {"fees": {"late_night_enabled": True, "late_night_paise": 1500, "surge_enabled": True, "surge_paise": 2500,
                                                     "surge_label": "Rain fee", "platform_enabled": True, "platform_paise": 500}})
    chat, hdr = await guest_chat(client)
    ev = await ask_guest(client, chat, hdr, "why is there a late night fee?")
    said = text_of(ev) + json.dumps(cards(ev, "article"), ensure_ascii=False)
    assert "Late night fee ₹15 on orders placed between 11 pm and 6 am" in said and "Rain fee ₹25 per order right now" in said, said
    assert "Platform fee ₹5 per order" in said

    # an older knowledge base (seeded at version 1, without the fees article) gets it once, never twice
    async with SessionLocal() as s:
        await s.execute(delete(ShopKbArticle).where(ShopKbArticle.title == "Fees on your bill"))
        row = await s.get(PlatformSetting, kb.SEEDED_KEY)
        row.value, row.updated_at = {"at": utcnow().isoformat()}, utcnow()
        await s.commit()
    for _ in range(2):
        async with SessionLocal() as s:
            await kb.ensure_starter(s)
    async with SessionLocal() as s:
        n = (await s.execute(select(func.count()).select_from(ShopKbArticle).where(ShopKbArticle.title == "Fees on your bill"))).scalar_one()
        assert n == 1 and (await s.get(PlatformSetting, kb.SEEDED_KEY)).value["version"] == kb.STARTER_VERSION
