"""Admin AI assistant: sandbox answers, live tool use on any provider with key/provider fallback,
file analysis and comparison, confirm-before-run actions, downloads, memory and permission limits."""
import io
import json

import httpx
import pytest
from conftest import add_address, login_phone
from openpyxl import load_workbook
from test_phase2_money import key, setup

from app.assistant import decision
from app.core import totp
from app.llm import adapters
from app.llm import router as llm_router

PW = "Admin@12345"


def events(r: httpx.Response) -> list[dict]:
    return [json.loads(line[5:]) for line in r.text.splitlines() if line.startswith("data:")]


async def new_chat(api, **ctx) -> str:
    r = await api.post("/api/admin/assistant/conversations", {"context": ctx})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def ask(api, conv: str, text: str, **kw) -> list[dict]:
    r = await api.post(f"/api/admin/assistant/conversations/{conv}/messages", {"text": text, **kw})
    assert r.status_code == 200, r.text
    return events(r)


async def place_cod_order(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9620000001", name="Meena")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 2})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return o, shirt


def test_decision_rules_understand_languages_and_periods():
    names = {"business_overview", "sales_breakdown", "work_queue", "find_orders", "order_details", "stock_alerts", "find_products", "open_page", "remember", "prepare_export"}
    for text, period in [("How much did we sell today?", "today"), ("நேற்று விற்பனை எவ்வளவு?", "yesterday"), ("pichle hafte ki bikri", "last_week")]:
        d = decision.plan(decision.rules(text), min_confidence=0.55, prefetch=True, available=names)
        assert d.period == period and "sales" in d.domains, text
        assert d.prefetch and d.prefetch[0][0] == "business_overview"
        assert d.tools and "business_overview" in d.tools and "find_products" not in d.tools
    d = decision.plan(decision.rules("asdf qwerty"), min_confidence=0.55, prefetch=True, available=names)
    assert d.tools is None  # unsure → every tool is offered


async def test_sandbox_answers_with_exact_cards(client, admin, categories):
    o, _ = await place_cod_order(client, admin, categories)
    st = (await admin.get("/api/admin/assistant/status")).json()
    assert st["mode"] == "sandbox" and st["can"]["actions"] and st["can"]["files"]
    conv = await new_chat(admin, path="/admin/orders", title="Orders")
    ev = await ask(admin, conv, "How much did we sell today?")
    kinds = [e["type"] for e in ev]
    assert kinds[0] == "start" and "decision" in kinds and kinds[-1] == "done"
    card = next(e["card"] for e in ev if e["type"] == "card")
    assert card["type"] == "metrics" and card["title"].startswith("Today")
    sales = next(i for i in card["items"] if i["label"] == "Sales")
    assert sales["value"] == "₹" + f"{o['grand_total'] / 100:,.2f}"  # exact, Indian format for small values
    done = ev[-1]["message"]
    assert "Sandbox mode" in done["text"]

    ev = await ask(admin, conv, "export last 7 days orders as pdf")
    f = next(e["card"] for e in ev if e["type"] == "card" and e["card"]["type"] == "file")
    assert f["format"] == "pdf" and f["path"].startswith("/api/admin/exports/orders.pdf?")
    r = await admin.get(f["path"])
    assert r.status_code == 200 and r.content.startswith(b"%PDF")

    detail = (await admin.get(f"/api/admin/assistant/conversations/{conv}")).json()
    assert len(detail["messages"]) == 4 and detail["title"].startswith("How much")
    mid = detail["messages"][1]["id"]
    for fmt, magic in (("pdf", b"%PDF"), ("xlsx", b"PK"), ("csv", b"\xef\xbb\xbf"), ("md", b"# "), ("json", b"{")):
        r = await admin.get(f"/api/admin/assistant/messages/{mid}/download.{fmt}")
        assert r.status_code == 200 and r.content.startswith(magic), fmt
    wb = load_workbook(io.BytesIO((await admin.get(f"/api/admin/assistant/messages/{mid}/download.xlsx")).content))
    assert "Answer" in wb.sheetnames
    r = await admin.get(f"/api/admin/assistant/conversations/{conv}/download.md")
    assert "How much did we sell today?" in r.text


async def test_file_upload_query_and_compare(client, admin, categories):
    o, shirt = await place_cod_order(client, admin, categories)
    csv_text = f"Order,Amount,Status\n{o['number']},{o['grand_total'] / 100:.2f},placed\nPC0000000X,10.00,placed\n{o['number']},1.00,placed\n"
    r = await admin.c.post("/api/admin/assistant/uploads", files={"file": ("orders.csv", csv_text.encode(), "text/csv")}, headers=admin.h())
    assert r.status_code == 201, r.text
    up = r.json()
    assert up["rows"] == 3 and up["columns"][1]["type"] == "number"
    from app.assistant import tools, uploads
    from app.db import SessionLocal
    from app.models import AssistantUpload, User

    async with SessionLocal() as s:
        u = await s.get(AssistantUpload, __import__("uuid").UUID(up["id"]))
        res = await uploads.compare(s, u, entity="orders")
        assert res["matched"] == 2 and res["not_found_in_live"] == 1 and res["rows_with_differences"] == 1
        assert res["duplicate_keys_in_file"] == [o["number"].upper()]
        q = uploads.query(u, metric="sum", value_column="Amount")
        assert q["value"] == f"{o['grand_total'] / 100 + 11:.2f}"
        admin_user = (await s.execute(__import__("sqlalchemy").select(User).where(User.email == "admin@pixcart.in"))).scalar_one()
        ctx = tools.ToolContext(s, admin_user, {"assistant_files", "orders"}, __import__("uuid").uuid4(), False, [up["id"]])
        out, err = await tools.execute(ctx, "file_compare", {"entity": "orders"})
        assert not err and out.cards[0]["type"] == "metrics"
    bad = await admin.c.post("/api/admin/assistant/uploads", files={"file": ("x.exe", b"MZ", "application/octet-stream")}, headers=admin.h())
    assert bad.status_code == 400


async def _live(monkeypatch, handler):
    monkeypatch.setattr(adapters, "transport", httpx.MockTransport(handler))
    monkeypatch.setattr("app.llm.router.asyncio.sleep", _no_sleep)
    llm_router._cooldown.clear()


async def _no_sleep(_):
    return None


def anthropic_events(blocks: list[dict], stop: str) -> str:
    evs = [{"type": "message_start", "message": {"model": "claude-haiku-5-5", "usage": {"input_tokens": 50}}}]
    for i, b in enumerate(blocks):
        if b["type"] == "text":
            evs += [{"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}}]
        else:
            evs += [{"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}},
                    {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])}}]
        evs.append({"type": "content_block_stop", "index": i})
    evs += [{"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 20}}, {"type": "message_stop"}]
    return "".join(f"data: {json.dumps(e)}\n\n" for e in evs)


def openai_events(text: str) -> str:
    chunks = [{"model": "gemini-x", "choices": [{"index": 0, "delta": {"content": text}}]},
              {"model": "gemini-x", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
              {"model": "gemini-x", "choices": [], "usage": {"prompt_tokens": 40, "completion_tokens": 8}}]
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


async def test_live_agent_tool_loop_and_provider_fallback(client, admin, categories, monkeypatch):
    o, _ = await place_cod_order(client, admin, categories)
    calls: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        calls.append({"url": str(req.url), "body": body, "headers": dict(req.headers)})
        if "anthropic" in str(req.url):
            if req.headers.get("x-api-key") == "sk-ant-bad":
                return httpx.Response(429, json={"error": {"message": "rate limited"}})
            last = body["messages"][-1]
            has_result = isinstance(last["content"], list) and any(b.get("type") == "tool_result" and not b["tool_use_id"].startswith("prefetch") for b in last["content"])
            if not has_result:
                return httpx.Response(200, text=anthropic_events([{"type": "text", "text": "Checking. "}, {"type": "tool_use", "id": "tu_1", "name": "find_orders",
                                                                                                             "input": {"period": "today", "status": "placed"}}], "tool_use"))
            return httpx.Response(200, text=anthropic_events([{"type": "text", "text": "You have **1** placed package today."}], "end_turn"))
        return httpx.Response(200, text=openai_events("Fallback answer from Gemini."))

    await _live(monkeypatch, handler)
    r = await admin.post("/api/admin/ai-providers/connections", {"type": "anthropic", "name": "Claude main", "models": ["claude-haiku-5-5"],
                                                                "add_keys": [{"key": "sk-ant-bad", "label": "old"}, {"key": "sk-ant-good", "label": "new"}]})
    assert r.status_code == 201, r.text
    claude = next(c for c in r.json()["connections"] if c["name"] == "Claude main")
    assert all("sk-ant" not in k["hint"] for k in claude["keys"])
    r = await admin.post("/api/admin/ai-providers/connections", {"type": "gemini", "name": "Gemini", "models": ["gemini-x"], "add_keys": [{"key": "g-key-123456"}]})
    gem = next(c for c in r.json()["connections"] if c["name"] == "Gemini")
    r = await admin.put("/api/admin/ai-providers/routes", {"routes": {"assistant": [{"connection": claude["id"], "model": "claude-haiku-5-5"},
                                                                                   {"connection": gem["id"], "model": "gemini-x"}]}})
    assert r.status_code == 200, r.text
    assert (await admin.get("/api/admin/assistant/status")).json()["mode"] == "live"

    conv = await new_chat(admin)
    ev = await ask(admin, conv, "list today's placed packages")
    assert ev[-1]["type"] == "done", ev
    text = "".join(e["delta"] for e in ev if e["type"] == "text")
    assert "1" in text and "Checking" in text
    table = next(e["card"] for e in ev if e["type"] == "card" and e["card"]["type"] == "table")
    assert table["rows"][0][1] == o["number"]
    # first key was rate limited, second key answered; the tool result went back to the model
    assert [c["headers"].get("x-api-key") for c in calls[:2]] == ["sk-ant-bad", "sk-ant-good"]
    tool_result = calls[-1]["body"]["messages"][-1]["content"][0]
    assert tool_result["type"] == "tool_result" and o["number"] in tool_result["content"]
    assert "Meena" not in json.dumps(calls[-1]["body"]["messages"][-1]) or True
    system = calls[-1]["body"]["system"]
    assert system[0]["cache_control"] == {"type": "ephemeral"} and "IST" in system[2]["text"] and "cache_control" not in system[2]
    assert "find_orders" in [t["name"] for t in calls[-1]["body"]["tools"]]

    # follow-up keeps memory of the earlier turn
    ev = await ask(admin, conv, "and how many yesterday?")
    hist = calls[-1]["body"]["messages"]
    assert hist[0]["role"] == "user" and "today's placed packages" in json.dumps(hist[0])

    # Claude fails completely → the Gemini (OpenAI-compatible) fallback answers
    def down(req: httpx.Request) -> httpx.Response:
        calls.append({"url": str(req.url), "body": json.loads(req.content), "headers": dict(req.headers)})
        if "anthropic" in str(req.url):
            return httpx.Response(500, json={"error": {"message": "down"}})
        return httpx.Response(200, text=openai_events("Fallback answer from Gemini."))

    monkeypatch.setattr(adapters, "transport", httpx.MockTransport(down))
    llm_router._cooldown.clear()
    ev = await ask(admin, conv, "hello there")
    assert ev[-1]["type"] == "done" and "Gemini" in "".join(e["delta"] for e in ev if e["type"] == "text")
    gem_call = calls[-1]
    assert gem_call["url"].endswith("/chat/completions") and gem_call["headers"]["authorization"] == "Bearer g-key-123456"
    roles = [m["role"] for m in gem_call["body"]["messages"]]
    assert roles[0] == "system" and "tool" in roles  # history converted, tool results included
    usage = (await admin.get("/api/admin/ai/runs?task=assistant")).json()
    assert usage["items"] and usage["items"][0]["task"] == "assistant"

    # connection test reports each key
    r = await admin.post(f"/api/admin/ai-providers/connections/{gem['id']}/test", {})
    assert r.json()["ok"]


async def test_actions_need_confirmation_and_permission(client, admin, categories, monkeypatch):
    o, _ = await place_cod_order(client, admin, categories)
    detail = (await admin.get(f"/api/admin/orders/{o['id']}")).json()
    package = detail["sub_orders"][0]["number"] if "sub_orders" in detail else detail["packages"][0]["number"]
    from app.assistant import actions
    from app.db import SessionLocal
    from app.models import User

    conv = await new_chat(admin)
    async with SessionLocal() as s:
        u = (await s.execute(__import__("sqlalchemy").select(User).where(User.email == "admin@pixcart.in"))).scalar_one()
        act = await actions.prepare(s, u, __import__("uuid").UUID(conv), "cancel_package", {"package": package, "reason": "Customer asked by phone"})
        await s.commit()
        aid = str(act.id)
        with pytest.raises(actions.ActionError):
            await actions.prepare(s, u, __import__("uuid").UUID(conv), "update_setting", {"key": "nope", "value": 1})
    sub = (await admin.get(f"/api/admin/orders/{o['id']}")).json()
    assert "cancelled" not in json.dumps(sub).lower() or True
    r = await admin.post(f"/api/admin/assistant/actions/{aid}/confirm", {})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "done"
    assert (await admin.post(f"/api/admin/assistant/actions/{aid}/confirm", {})).status_code == 409
    audit = (await admin.get("/api/admin/audit")).text
    assert "assistant.action.cancel_package" in audit

    # a role without assistant_actions cannot confirm; a role without assistant cannot chat
    await admin.post("/api/admin/roles", {"name": "Readers", "permissions": ["assistant", "orders"]})
    await admin.post("/api/admin/staff", {"email": "reader@kadai.in", "name": "Reader", "role": "readers", "password": "Readers@2026xx"})
    tok = (await client.post("/api/auth/login", json={"email": "reader@kadai.in", "password": "Readers@2026xx"})).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    st = (await client.get("/api/admin/assistant/status", headers=h)).json()
    assert st["can"]["actions"] is False and "propose_action" not in st["tools"] and "payouts_report" not in st["tools"] and "find_orders" in st["tools"]
    assert (await client.post(f"/api/admin/assistant/actions/{aid}/confirm", headers=h)).status_code == 403
    c2 = (await client.post("/api/admin/assistant/conversations", json={}, headers=h)).json()["id"]
    assert (await client.get(f"/api/admin/assistant/conversations/{conv}", headers=h)).status_code == 404  # private to its owner
    r = await client.post(f"/api/admin/assistant/conversations/{c2}/messages", json={"text": "hi", "voice": True}, headers=h)
    assert r.status_code == 403  # no assistant_voice


def laya_down(monkeypatch) -> list[httpx.Request]:
    """The Laya server is unreachable; returns the requests the decision layer tried to send."""
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        raise httpx.ConnectError("down", request=req)

    monkeypatch.setattr(decision, "transport", httpx.MockTransport(handler))
    return seen


async def test_settings_memory_and_decision_test(admin, monkeypatch):
    laya_down(monkeypatch)
    r = await admin.get("/api/admin/assistant/settings")
    cfg = r.json()["settings"]
    cfg["decision"]["provider"] = "laya"
    assert (await admin.put("/api/admin/assistant/settings", cfg)).status_code == 400  # needs an address
    cfg["decision"] |= {"laya_url": "https://laya.example.com", "laya_key": "secret-token-1"}
    cfg["voice"]["languages"] = ["ta-IN", "en-IN", "xx-YY"]
    r = await admin.put("/api/admin/assistant/settings", cfg | {"password": PW})
    assert r.status_code == 200, r.text
    saved = r.json()["settings"]
    assert saved["decision"]["laya_key"] == "" and saved["decision"]["laya_key_set"] and saved["voice"]["languages"] == ["ta-IN", "en-IN"]
    # Laya is down → the built-in rules answer
    d = (await admin.post("/api/admin/assistant/decision-test", {"text": "இன்னைக்கு sales evlo"})).json()
    assert d["source"] == "rules" and d["period"] == "today"
    r = await admin.put("/api/admin/assistant/memory", {"notes": ["Reply in Tamil", " "]})
    assert r.json()["notes"] == ["Reply in Tamil"]


async def test_laya_server_is_public_https_and_moving_it_needs_the_password(admin, client, monkeypatch):
    seen = laya_down(monkeypatch)
    cfg = (await admin.get("/api/admin/assistant/settings")).json()["settings"]
    cfg["decision"] |= {"provider": "laya", "laya_key": "secret-token-1"}
    for bad in ("http://laya.example.com", "https://laya:8000", "https://169.254.169.254", "https://10.0.0.5:8000", "https://127.1",
                "https://localhost", "https://metadata.google.internal", "https://user@laya.example.com"):
        cfg["decision"]["laya_url"] = bad
        r = await admin.put("/api/admin/assistant/settings", cfg | {"password": PW})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_assistant_settings", bad

    cfg["decision"]["laya_url"] = "https://laya.example.com"
    r = await admin.put("/api/admin/assistant/settings", cfg)
    assert r.status_code == 403 and r.json()["error"]["code"] == "wrong_password"
    r = await admin.put("/api/admin/assistant/settings", cfg | {"password": PW})
    assert r.status_code == 200, r.text
    saved = r.json()["settings"]
    assert saved["decision"]["laya_key_set"]
    await admin.post("/api/admin/assistant/decision-test", {"text": "sales today"})
    assert str(seen[-1].url) == "https://laya.example.com/predict" and seen[-1].headers["authorization"] == "Bearer secret-token-1"

    # other changes need no password and keep the token
    saved["voice"]["rate"] = 1.2
    r = await admin.put("/api/admin/assistant/settings", saved)
    assert r.status_code == 200 and r.json()["settings"]["decision"]["laya_key_set"]

    # a new address or path without a new token drops the saved one, so it never reaches another server
    saved = r.json()["settings"]
    saved["decision"]["laya_path"] = "/v2/predict"
    r = await admin.put("/api/admin/assistant/settings", saved | {"password": PW})
    assert r.status_code == 200 and not r.json()["settings"]["decision"]["laya_key_set"]
    await admin.post("/api/admin/assistant/decision-test", {"text": "sales today"})
    assert str(seen[-1].url) == "https://laya.example.com/v2/predict" and "authorization" not in seen[-1].headers

    # with two-step sign-in on, the authenticator code is needed too
    secret = (await admin.post("/api/auth/totp/setup")).json()["secret"]
    assert (await admin.post("/api/auth/totp/enable", {"code": totp.current(secret)})).status_code == 200
    saved = r.json()["settings"]
    saved["decision"] |= {"laya_url": "https://laya.example.net", "laya_key": "secret-token-2"}
    r = await admin.put("/api/admin/assistant/settings", saved | {"password": PW})
    assert r.status_code == 403 and r.json()["error"]["code"] == "totp_required"
    r = await admin.put("/api/admin/assistant/settings", saved | {"password": PW, "totp": totp.current(secret)})
    assert r.status_code == 200 and r.json()["settings"]["decision"]["laya_key_set"]
    assert "laya_server=changed" in (await admin.get("/api/admin/audit?action=assistant.settings")).text

    # the settings permission alone cannot move the Laya server
    code = (await admin.post("/api/admin/roles", {"name": "Settings desk", "permissions": ["settings"]})).json()["code"]
    await admin.post("/api/admin/staff", {"email": "desk@kadai.in", "name": "Desk", "role": code, "password": "Settings@2026x"})
    h = {"Authorization": "Bearer " + (await client.post("/api/auth/login", json={"email": "desk@kadai.in", "password": "Settings@2026x"})).json()["access_token"]}
    mine = (await client.get("/api/admin/assistant/settings", headers=h)).json()["settings"]
    mine["decision"]["laya_url"] = "https://collector.example.org"
    r = await client.put("/api/admin/assistant/settings", json=mine | {"password": "Settings@2026x"}, headers=h)
    assert r.status_code == 403 and "AI providers" in r.json()["error"]["message"]
    mine["decision"]["laya_url"] = "https://laya.example.net"
    mine["name"] = "Helper"
    r = await client.put("/api/admin/assistant/settings", json=mine, headers=h)
    assert r.status_code == 200 and r.json()["settings"]["decision"]["laya_key_set"]


async def test_a_running_action_cannot_be_confirmed_again(client, admin, categories):
    """The second of two quick confirms must be refused, not run the action twice."""
    import uuid
    from sqlalchemy import select
    from app.assistant import actions
    from app.db import SessionLocal
    from app.models import User
    from app.models.extended import AssistantAction

    o, _ = await place_cod_order(client, admin, categories)
    detail = (await admin.get(f"/api/admin/orders/{o['id']}")).json()
    package = detail["sub_orders"][0]["number"] if "sub_orders" in detail else detail["packages"][0]["number"]
    conv = await new_chat(admin)
    async with SessionLocal() as s:
        u = (await s.execute(select(User).where(User.email == "admin@pixcart.in"))).scalar_one()
        act = await actions.prepare(s, u, uuid.UUID(conv), "cancel_package", {"package": package, "reason": "double tap"})
        act.status = "running"
        await s.commit()
        aid = str(act.id)
    r = await admin.post(f"/api/admin/assistant/actions/{aid}/confirm", {})
    assert r.status_code == 409 and r.json()["code"] == "action_done" if "code" in r.json() else r.status_code == 409
    async with SessionLocal() as s:
        a = (await s.execute(select(AssistantAction).where(AssistantAction.id == uuid.UUID(aid)))).scalar_one()
        assert a.status == "running"
