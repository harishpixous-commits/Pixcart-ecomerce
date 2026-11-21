"""AI pipeline: sandbox and live modes, prompt caching layers, switches, budget, permissions, human review,
customer messages, rule-based checks, risk briefs, usage accounting and the usage export."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import select

from app.config import settings
from app.core import permissions
from app.db import SessionLocal
from app.llm import adapters as llm_adapters
from app.models import AiRun, Notification, Product
from tests.conftest import add_address, login_phone, make_seller
from tests.test_phase2_money import key, setup

NOTES = "cotton kurta for men, blue, sizes M L XL, machine wash"


@pytest.fixture
def live(monkeypatch):
    """Switches the pipeline to live mode against a mock Anthropic API that records requests."""
    seen: list[dict] = []
    reply = {"text": "", "status": 200, "usage": {"input_tokens": 120, "output_tokens": 40, "cache_creation_input_tokens": 900, "cache_read_input_tokens": 0}}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append({"headers": dict(req.headers), "body": json.loads(req.content)})
        if reply["status"] != 200:
            return httpx.Response(reply["status"], json={"error": {"message": "overloaded"}})
        return httpx.Response(200, text=anthropic_sse(reply["text"], reply["usage"]), headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(settings, "anthropic_api_key", "sk-test")
    monkeypatch.setattr(llm_adapters, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr("app.llm.router.asyncio.sleep", _no_sleep)
    return seen, reply


def anthropic_sse(text: str, usage: dict, model: str = "claude-haiku-5-5") -> str:
    """A Messages API stream with one text block, as the real API sends it."""
    events = [
        {"type": "message_start", "message": {"model": model, "usage": {k: v for k, v in usage.items() if k != "output_tokens"}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": usage.get("output_tokens", 0)}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


async def _no_sleep(_):
    return None


async def test_sandbox_mode_works_without_a_key(client, admin, categories):
    seller = await make_seller(client, admin, "9610000001", name="AI Shop", pan="AISHO1234A")
    r = await seller.post("/api/seller/ai/listing", {"notes": "short"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "notes_too_short"
    r = await seller.post("/api/seller/ai/listing", {"notes": NOTES, "brand": "Kovai"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["mode"] == "sandbox" and "Sandbox draft" in out["description"] and out["title"].startswith("Kovai")
    done = await seller.post(f"/api/seller/ai/runs/{out['run_id']}/apply", {"final_text": out["title"]})
    assert done.json()["status"] == "applied"
    assert (await seller.post(f"/api/seller/ai/runs/{out['run_id']}/discard", {})).status_code == 404  # already closed


async def test_live_call_uses_cached_prompt_layers_and_records_usage(client, admin, categories, live):
    seen, reply = live
    await admin.put("/api/admin/storefront/site", {"brand_name": "Kadai"})
    r = await admin.put("/api/admin/ai", {"model": "claude-sonnet-5-5", "brand_voice": "Cheerful and short.",
                                          "tasks": {"listing_writer": {"enabled": True, "instructions": "Mention the city of manufacture if given."}, "nonsense": {"enabled": False}}})
    assert r.status_code == 200, r.text
    assert "nonsense" not in r.json()["settings"]["tasks"]
    reply["text"] = json.dumps({"title": "Men's Blue Cotton Kurta", "description": "A blue cotton kurta.", "highlights": ["100% cotton"], "specs": {"Fabric": "Cotton"}, "missing": ["Sleeve length?"]})
    seller = await make_seller(client, admin, "9610000002", name="Live Shop", pan="LIVES1234L")
    r = await seller.post("/api/seller/ai/listing", {"notes": NOTES, "category_id": categories["shirts"]})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "Men's Blue Cotton Kurta" and r.json()["mode"] == "live"
    body = seen[-1]["body"]
    assert seen[-1]["headers"]["x-api-key"] == "sk-test" and seen[-1]["headers"]["anthropic-version"] == "2023-06-01"
    assert body["model"] == "claude-sonnet-5-5"
    rules, brand = body["system"]
    assert rules["cache_control"] == {"type": "ephemeral"} and brand["cache_control"] == {"type": "ephemeral"}
    assert "never invent" in rules["text"] and "Kadai" in brand["text"] and "Cheerful" in brand["text"] and "city of manufacture" in brand["text"]
    assert NOTES in body["messages"][0]["content"] and "Kadai" not in body["messages"][0]["content"]
    async with SessionLocal() as s:
        run = (await s.execute(select(AiRun).where(AiRun.task == "listing_writer").order_by(AiRun.created_at.desc()))).scalars().first()
    assert (run.input_tokens, run.output_tokens, run.cache_creation_tokens, run.mode, run.model) == (120, 40, 900, "live", "claude-haiku-5-5")
    studio = (await admin.get("/api/admin/ai")).json()
    assert studio["status"]["mode"] == "live" and studio["usage"]["runs"] >= 1 and studio["usage"]["cost_usd"] > 0
    listing = next(t for t in studio["tasks"] if t["key"] == "listing_writer")
    assert listing["runs_this_month"] >= 1 and listing["instructions"].startswith("Mention")


async def test_switches_budget_and_failures(client, admin, categories, live):
    seen, reply = live
    seller = await make_seller(client, admin, "9610000003", name="Switch Shop", pan="SWITC1234S")
    await admin.put("/api/admin/ai", {"enabled": False})
    assert (await seller.post("/api/seller/ai/listing", {"notes": NOTES})).json()["error"]["code"] == "ai_off"
    await admin.put("/api/admin/ai", {"enabled": True, "tasks": {"listing_writer": {"enabled": False}}})
    assert (await seller.post("/api/seller/ai/listing", {"notes": NOTES})).json()["error"]["code"] == "ai_task_off"
    await admin.put("/api/admin/ai", {"enabled": True, "tasks": {}, "monthly_token_budget": 100})
    reply["text"] = json.dumps({"title": "T", "description": "D", "highlights": [], "specs": {}, "missing": []})
    assert (await seller.post("/api/seller/ai/listing", {"notes": NOTES})).status_code == 200  # 160 tokens used
    r = await seller.post("/api/seller/ai/listing", {"notes": NOTES})
    assert r.status_code == 429 and r.json()["error"]["code"] == "ai_budget"
    await admin.put("/api/admin/ai", {"monthly_token_budget": 0})
    # Provider errors are retried once, then recorded as a failed run.
    reply["status"] = 503
    before = len(seen)
    r = await seller.post("/api/seller/ai/listing", {"notes": NOTES})
    assert r.status_code == 502 and len(seen) - before == 2
    failed = (await admin.get("/api/admin/ai/runs?status=failed")).json()["items"]
    assert failed and failed[0]["error"]
    # Settings are validated.
    assert (await admin.put("/api/admin/ai", {"model": "gpt-4"})).status_code == 400
    assert (await admin.put("/api/admin/ai", {"monthly_token_budget": -5})).status_code == 400


async def test_support_reply_draft_is_reviewed_and_keeps_contact_details_private(client, admin, categories, live):
    seen, reply = live
    buyer = await login_phone(client, "9610000004", name="Priya Raman")
    t = (await buyer.post("/api/support/tickets", {"category": "delivery", "subject": "Parcel late", "message": "My parcel has not arrived. Call me on 9610000004."})).json()
    reply["text"] = "Here is a draft: Hi Priya, sorry for the delay. We are checking with the courier and will update you today."
    r = await admin.post("/api/admin/ai/tasks/support_reply", {"subject_id": t["id"], "tone": "apologetic", "intent": "apologise and say we are checking"})
    assert r.status_code == 200, r.text
    draft = r.json()
    assert draft["output"]["text"].startswith("Hi Priya")  # preamble removed
    prompt = seen[-1]["body"]["messages"][0]["content"]
    assert "Priya" in prompt and "Raman" not in prompt and "apologetic" in prompt
    # The customer's phone number in their message is the only contact detail the model sees; no account fields are added.
    assert "buyer" not in prompt.lower()
    sent = await admin.post(f"/api/admin/tickets/{t['id']}/reply", {"body": draft["output"]["text"] + " Thanks!", "ai_run_id": draft["id"]})
    assert sent.status_code == 200
    run = (await admin.get(f"/api/admin/ai/runs/{draft['id']}")).json()
    assert run["status"] == "sent" and run["final_text"].endswith("Thanks!")


async def test_customer_message_draft_and_send(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9610000005", name="Arun")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    assert (await admin.post("/api/admin/ai/tasks/customer_message", {"subject_id": o["id"], "intent": ""})).status_code == 400
    d = (await admin.post("/api/admin/ai/tasks/customer_message", {"subject_id": o["id"], "tone": "friendly", "intent": "Tell them the seller ships tomorrow"})).json()
    assert d["output"]["subject"].startswith("About your order") and d["mode"] == "sandbox"
    r = await admin.post(f"/api/admin/ai/runs/{d['id']}/send", {"subject": "Your order ships tomorrow", "text": "Hi Arun, the seller ships your order tomorrow."})
    assert r.status_code == 200 and r.json()["status"] == "sent"
    assert (await admin.post(f"/api/admin/ai/runs/{d['id']}/send", {"subject": "Again", "text": "Sending twice must fail."})).status_code == 409
    async with SessionLocal() as s:
        n = (await s.execute(select(Notification).where(Notification.event == "staff_message", Notification.channel == "inapp"))).scalars().first()
    assert n.subject == "Your order ships tomorrow" and "ships your order" in n.body
    # Risk brief for the same order: first COD order from a new account.
    brief = (await admin.get(f"/api/admin/ai/briefs/order/{o['id']}")).json()
    assert brief["level"] in ("GREEN", "AMBER", "RED") and any("First order" in f["text"] for f in brief["factors"])
    sbrief = (await admin.get(f"/api/admin/ai/briefs/seller/{tn.seller_id}")).json()
    assert sbrief["insufficient_history"] is True and sbrief["headline"]


async def test_listing_check_always_includes_rule_based_findings(client, admin, categories, live):
    seen, reply = live
    tn, ka, shirt, phone = await setup(client, admin, categories)
    async with SessionLocal() as s:
        p = await s.get(Product, uuid.UUID(shirt["id"]))
        p.description = "Handloom shirt. WhatsApp 9876543210 for wholesale."
        await s.commit()
    reply["text"] = json.dumps({"risk": "low", "issues": [], "suggested_reason": ""})
    r = await admin.post(f"/api/admin/products/{shirt['id']}/ai-check")
    assert r.status_code == 200, r.text
    assert r.json()["risk"] == "medium" and any("phone number" in i for i in r.json()["issues"])


async def test_permissions_and_seller_scoping(client, admin, categories):
    await admin.post("/api/admin/staff", {"email": "mkt2@kadai.in", "name": "Mkt", "role": "marketing", "password": "Marketing@2026x"})
    token = (await client.post("/api/auth/login", json={"email": "mkt2@kadai.in", "password": "Marketing@2026x"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert (await client.post("/api/admin/ai/tasks/support_reply", json={"subject_id": "x"}, headers=h)).status_code == 403
    assert (await client.get("/api/admin/ai", headers=h)).status_code == 403
    a = await make_seller(client, admin, "9610000006", name="Shop A", pan="SHOPA1234A")
    b = await make_seller(client, admin, "9610000007", name="Shop B", pan="SHOPB1234B")
    assert (await a.post("/api/seller/ai/tasks/support_reply", {"subject_id": "x"})).status_code == 404  # admin-only task
    run = (await a.post("/api/seller/ai/listing", {"notes": NOTES})).json()
    assert (await b.post(f"/api/seller/ai/runs/{run['run_id']}/apply", {"final_text": "mine now"})).status_code == 404
    # AI usage export
    csv = await admin.get("/api/admin/exports/ai-runs.csv")
    assert csv.status_code == 200 and b"listing_writer" in csv.content


async def test_ai_drafts_load_the_current_roles(client, admin, monkeypatch):
    """A worker that has not loaded the roles yet still knows a custom role when staff draft or discard with AI."""
    code = (await admin.post("/api/admin/roles", {"name": "Brief readers", "permissions": []})).json()["code"]
    await admin.post("/api/admin/staff", {"email": "brief@kadai.in", "name": "Brief", "role": code, "password": "Briefing@2026x"})
    token = (await client.post("/api/auth/login", json={"email": "brief@kadai.in", "password": "Briefing@2026x"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    monkeypatch.setattr(permissions, "_roles", {})  # a freshly started worker
    r = await client.post("/api/admin/ai/tasks/business_brief", json={"subject_id": "7"}, headers=h)
    assert r.status_code == 200, r.text
    monkeypatch.setattr(permissions, "_roles", {})
    r = await client.post(f"/api/admin/ai/runs/{r.json()['id']}/discard", json={}, headers=h)
    assert r.status_code == 200, r.text


async def test_business_brief_uses_only_supplied_figures(client, admin, categories, live):
    seen, reply = live
    reply["text"] = "Sales were steady.\n\nNext steps:\n- Reply to tickets"
    r = await admin.post("/api/admin/ai/tasks/business_brief", {"subject_id": "7"})
    assert r.status_code == 200, r.text
    prompt = seen[-1]["body"]["messages"][0]["content"]
    assert "Figures for the period" in prompt and "sales:" in prompt and "last 7 days" in prompt
    assert "use only the numbers provided" in seen[-1]["body"]["system"][0]["text"]
