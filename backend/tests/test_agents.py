"""AI agents: they write proposals from real data, nothing runs until staff approve, and approving uses the normal admin code."""
from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select, update

from app.agents import core
from app.db import SessionLocal, utcnow
from app.models import AgentProposal, SubOrder
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup


async def _place(client, admin, categories, phone):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    a = await login_phone(client, phone, name="Agent Buyer")
    addr = await add_address(a, state="33")
    await a.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o = (await a.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return tn, a, o["sub_orders"][0]["id"]


async def _age(sid, **cols):
    async with SessionLocal() as s:
        await s.execute(update(SubOrder).where(SubOrder.id == uuid.UUID(sid)).values(**cols))
        await s.commit()


async def _run(force=False):
    async with SessionLocal() as s:
        n = await core.run_agent(s, "delivery", force=force)
        await s.commit()
        return n


async def test_delivery_agent_proposes_and_staff_approve(client, admin, categories):
    tn, buyer, sid = await _place(client, admin, categories, "9770000201")
    assert (await tn.post(f"/api/seller/orders/{sid}/confirm")).status_code == 200
    await _age(sid, confirmed_at=utcnow() - timedelta(hours=30))
    assert await _run() == 0  # off by default
    assert (await admin.put("/api/admin/agents/settings", {"enabled": True, "delivery_enabled": True})).status_code == 200
    assert (await admin.put("/api/admin/agents/settings", {"delivery_nudge_hours": 0})).status_code == 400
    ov = (await admin.get("/api/admin/agents")).json()
    assert ov["agents"][0]["key"] == "delivery" and ov["agents"][0]["enabled"] and ov["agents"][0]["not_wired"]
    assert (await admin.post("/api/admin/agents/run")).json()["new"]["delivery"] == 1
    assert (await admin.post("/api/admin/agents/run")).json()["new"]["delivery"] == 0  # the same idea is not written twice
    items = (await admin.get("/api/admin/agents/proposals")).json()["items"]
    assert len(items) == 1 and items[0]["kind"] == "nudge_seller" and "ship" in items[0]["summary"]
    # nothing has been sent yet
    assert not [n for n in (await tn.get("/api/notifications")).json()["items"] if "waiting to ship" in n["title"]]
    assert (await buyer.post(f"/api/admin/agents/proposals/{items[0]['id']}/approve")).status_code == 403
    r = await admin.post(f"/api/admin/agents/proposals/{items[0]['id']}/approve")
    assert r.status_code == 200 and r.json()["status"] == "done"
    assert len([n for n in (await tn.get("/api/notifications")).json()["items"] if "waiting to ship" in n["title"]]) == 1
    assert (await admin.post(f"/api/admin/agents/proposals/{items[0]['id']}/approve")).status_code == 409  # once only
    assert "agent.delivery.nudge_seller" in (await admin.get("/api/admin/audit")).text


async def test_delivery_agent_cancel_reject_and_stale(client, admin, categories):
    tn, buyer, sid = await _place(client, admin, categories, "9770000202")
    assert (await tn.post(f"/api/seller/orders/{sid}/confirm")).status_code == 200
    await admin.put("/api/admin/agents/settings", {"enabled": True, "delivery_enabled": True})
    await _age(sid, confirmed_at=utcnow() - timedelta(days=9))
    assert await _run() == 1
    p = (await admin.get("/api/admin/agents/proposals")).json()["items"][0]
    assert p["kind"] == "cancel_package"
    # staff say no: nothing is cancelled and it is not proposed again
    assert (await admin.post(f"/api/admin/agents/proposals/{p['id']}/reject")).json()["status"] == "rejected"
    assert await _run() == 0
    async with SessionLocal() as s:
        assert (await s.get(SubOrder, uuid.UUID(sid))).status == "confirmed"
    # a package that shipped before staff looked is stale, not cancelled
    await _age(sid, confirmed_at=utcnow() - timedelta(hours=30))
    assert await _run() == 1  # a gentler nudge for the same package is a new idea
    p2 = (await admin.get("/api/admin/agents/proposals")).json()["items"][0]
    assert p2["kind"] == "nudge_seller"
    assert (await tn.post(f"/api/seller/orders/{sid}/pack")).status_code == 200
    assert (await tn.post(f"/api/seller/orders/{sid}/ship", {"courier_name": "DTDC", "tracking_number": "AWB9"})).status_code == 200
    assert (await admin.post(f"/api/admin/agents/proposals/{p2['id']}/approve")).status_code == 409
    assert (await admin.get("/api/admin/agents/proposals?status=expired")).json()["items"][0]["id"] == p2["id"]
    # shipped with no tracking: proposes asking for it; approving cancels nothing
    await _age(sid, tracking_number="", shipped_at=utcnow() - timedelta(hours=20))
    assert await _run() == 1
    p3 = [x for x in (await admin.get("/api/admin/agents/proposals")).json()["items"] if x["kind"] == "nudge_tracking"][0]
    assert (await admin.post(f"/api/admin/agents/proposals/{p3['id']}/approve")).status_code == 200
    # approving a cancel runs the real cancel and refund
    await _age(sid, status="confirmed", confirmed_at=utcnow() - timedelta(days=9), tracking_number="AWB9")
    async with SessionLocal() as s:
        s.add(AgentProposal(agent="delivery", kind="cancel_package", dedupe_key="cancel_package:manual", summary="x", details=[], params={"sub_id": sid, "reason": "Test cancel"},
                            permission="orders", status="pending", result={}, created_at=utcnow()))
        await s.commit()
        pid = (await s.execute(select(AgentProposal.id).where(AgentProposal.dedupe_key == "cancel_package:manual"))).scalar_one()
    assert (await admin.post(f"/api/admin/agents/proposals/{pid}/approve")).status_code == 200
    async with SessionLocal() as s:
        assert (await s.get(SubOrder, uuid.UUID(sid))).status == "cancelled"


async def test_order_update_agent_proposes_delay_notice_and_customer_hears_only_after_approval(client, admin, categories):
    tn, buyer, sid = await _place(client, admin, categories, "9770000203")
    assert (await tn.post(f"/api/seller/orders/{sid}/confirm")).status_code == 200
    assert (await tn.post(f"/api/seller/orders/{sid}/pack")).status_code == 200
    assert (await tn.post(f"/api/seller/orders/{sid}/ship", {"courier_name": "DTDC", "tracking_number": "AWB7"})).status_code == 200
    await _age(sid, expected_delivery_at=utcnow() - timedelta(hours=30))
    await admin.put("/api/admin/agents/settings", {"enabled": True})

    async def run():
        async with SessionLocal() as s:
            n = await core.run_agent(s, "orderupdate")
            await s.commit()
            return n

    assert await run() == 0  # its own switch is off
    assert (await admin.put("/api/admin/agents/settings", {"orderupdate_enabled": True})).status_code == 200
    assert await run() == 1 and await run() == 0
    p = (await admin.get("/api/admin/agents/proposals?agent=orderupdate")).json()["items"][0]
    assert p["kind"] == "delay_notice" and "late" in p["summary"]

    def delay_notes(items):
        return [n for n in items if n["title"] == "Your package is running late"]

    assert delay_notes((await buyer.get("/api/notifications")).json()["items"]) == []
    assert (await admin.post(f"/api/admin/agents/proposals/{p['id']}/approve")).json()["status"] == "done"
    assert len(delay_notes((await buyer.get("/api/notifications")).json()["items"])) == 1
    # a package that arrived before approval is skipped, not messaged
    await _age(sid, expected_delivery_at=utcnow() - timedelta(hours=40), status="delivered", delivered_at=utcnow())
    async with SessionLocal() as s:
        s.add(AgentProposal(agent="orderupdate", kind="delay_notice", dedupe_key="delay_notice:manual", summary="x", details=[], params={"sub_id": sid, "expected": "1 Jan"},
                            permission="orders", status="pending", result={}, created_at=utcnow()))
        await s.commit()
    pid = (await admin.get("/api/admin/agents/proposals")).json()["items"][0]["id"]
    assert (await admin.post(f"/api/admin/agents/proposals/{pid}/approve")).status_code == 409
    assert len(delay_notes((await buyer.get("/api/notifications")).json()["items"])) == 1


async def test_reorder_agent_asks_seller_to_restock_fast_sellers_only(client, admin, categories):
    tn, buyer, sid = await _place(client, admin, categories, "9770000204")
    async with SessionLocal() as s:
        from app.models import OrderItem, Variant

        item = (await s.execute(select(OrderItem).where(OrderItem.sub_order_id == uuid.UUID(sid)))).scalars().first()
        v = await s.get(Variant, item.variant_id)
        v.stock = 4
        vid = str(v.id)
        await s.commit()
    await admin.put("/api/admin/agents/settings", {"enabled": True, "reorder_cover_days": 180, "reorder_min_sold": 1})

    async def run():
        async with SessionLocal() as s:
            n = await core.run_agent(s, "reorder")
            await s.commit()
            return n

    assert await run() == 0  # its switch is off
    assert (await admin.put("/api/admin/agents/settings", {"reorder_enabled": True})).status_code == 200
    assert await run() == 1 and await run() == 0
    p = (await admin.get("/api/admin/agents/proposals?agent=reorder")).json()["items"][0]
    assert p["kind"] == "request_restock" and "4 left" in p["summary"]
    notes = lambda items: [n for n in items if n["title"].startswith("Restock")]
    assert notes((await tn.get("/api/notifications")).json()["items"]) == []
    assert (await admin.post(f"/api/admin/agents/proposals/{p['id']}/approve")).json()["status"] == "done"
    assert len(notes((await tn.get("/api/notifications")).json()["items"])) == 1
    # stock topped up before approval: nothing is sent
    async with SessionLocal() as s:
        s.add(AgentProposal(agent="reorder", kind="request_restock", dedupe_key="request_restock:manual", summary="x", details=[],
                            params={"variant_id": vid, "item": "Shirt", "stock": 4, "sold": 12, "days": 30, "left": 10, "suggest": 5}, permission="orders", status="pending", result={}, created_at=utcnow()))
        from app.models import Variant as V

        (await s.get(V, uuid.UUID(vid))).stock = 50
        await s.commit()
    pid = (await admin.get("/api/admin/agents/proposals")).json()["items"][0]["id"]
    assert (await admin.post(f"/api/admin/agents/proposals/{pid}/approve")).status_code == 409
    assert len(notes((await tn.get("/api/notifications")).json()["items"])) == 1
    # a slow seller is not asked: plenty of stock for the cover period
    async with SessionLocal() as s:
        (await s.get(V, uuid.UUID(vid))).stock = 400
        await s.commit()
    assert await run() == 0


async def test_marketing_agent_proposes_coupon_for_slow_category_and_approval_creates_it(client, admin, categories):
    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    await admin.put("/api/admin/agents/settings", {"enabled": True, "marketing_min_items": 1, "marketing_max_sold": 5})

    async def run():
        async with SessionLocal() as s:
            n = await core.run_agent(s, "marketing")
            await s.commit()
            return n

    assert await run() == 0  # its switch is off
    assert (await admin.put("/api/admin/agents/settings", {"marketing_enabled": True})).status_code == 200
    n = await run()
    assert n >= 1 and await run() == 0
    items = (await admin.get("/api/admin/agents/proposals?agent=marketing")).json()["items"]
    p = items[0]
    assert p["kind"] == "create_coupon"
    code = p["params"]["code"] if "params" in p else None
    async with SessionLocal() as s:
        from app.models import Coupon

        assert (await s.execute(select(Coupon).where(Coupon.description.like("%off%")))).scalars().first() is None
    assert (await admin.post(f"/api/admin/agents/proposals/{p['id']}/approve")).json()["status"] == "done"
    async with SessionLocal() as s:
        from app.models import Coupon

        c = (await s.execute(select(Coupon).where(Coupon.description.like("% off %")))).scalars().first()
        assert c is not None and c.kind == "percent" and c.funded_by == "platform" and c.category_id is not None and c.ends_at > utcnow()


async def test_listing_agent_approves_clean_listings_and_sends_back_bad_ones(client, admin, categories):
    from app.models import Product

    tn, ka, shirt, phone_p = await setup(client, admin, categories)
    async with SessionLocal() as s:
        ps = (await s.execute(select(Product))).scalars().all()
        for p in ps:
            p.status = "pending"
        ps[0].description = "Call me on 9876543210 for a cheaper price"
        await s.commit()
        ids = [str(p.id) for p in ps]
    await admin.put("/api/admin/agents/settings", {"enabled": True})

    async def run():
        async with SessionLocal() as s:
            n = await core.run_agent(s, "listing")
            await s.commit()
            return n

    assert await run() == 0
    assert (await admin.put("/api/admin/agents/settings", {"listing_enabled": True})).status_code == 200
    assert await run() == len(ids) and await run() == 0
    items = (await admin.get("/api/admin/agents/proposals?agent=listing")).json()["items"]
    kinds = {i["kind"] for i in items}
    assert "reject_listing" in kinds
    bad = next(i for i in items if i["kind"] == "reject_listing")
    async with SessionLocal() as s:
        assert (await s.get(Product, uuid.UUID(bad["params"]["product_id"] if "params" in bad else ids[0]))).status == "pending"
    assert (await admin.post(f"/api/admin/agents/proposals/{bad['id']}/approve")).json()["status"] == "done"
    async with SessionLocal() as s:
        sts = {str(p.id): p.status for p in (await s.execute(select(Product))).scalars()}
    assert "rejected" in sts.values()


async def test_support_agent_drafts_first_reply_and_staff_approval_sends_it(client, admin, categories):
    from app.models import SupportTicket

    a = await login_phone(client, "9770000207", name="Ticket Buyer")
    r = await a.post("/api/support/tickets", {"category": "order", "subject": "Where is my parcel", "message": "It has been a week with no update."})
    assert r.status_code == 201
    async with SessionLocal() as s:
        await s.execute(update(SupportTicket).values(created_at=utcnow() - timedelta(hours=10)))
        from app.models import TicketMessage

        await s.execute(update(TicketMessage).values(created_at=utcnow() - timedelta(hours=10)))
        await s.commit()
    await admin.put("/api/admin/agents/settings", {"enabled": True})

    async def run():
        async with SessionLocal() as s:
            n = await core.run_agent(s, "support")
            await s.commit()
            return n

    assert await run() == 0
    assert (await admin.put("/api/admin/agents/settings", {"support_enabled": True})).status_code == 200
    assert await run() == 1 and await run() == 0
    p = (await admin.get("/api/admin/agents/proposals?agent=support")).json()["items"][0]
    assert p["kind"] == "reply_ticket"
    tid = r.json()["id"]
    assert len((await a.get(f"/api/support/tickets/{tid}")).json()["messages"]) == 1
    assert (await admin.post(f"/api/admin/agents/proposals/{p['id']}/approve")).json()["status"] == "done"
    msgs = (await a.get(f"/api/support/tickets/{tid}")).json()["messages"]
    assert len(msgs) == 2 and "Ticket" in msgs[1]["body"] and "refund" not in msgs[1]["body"].lower()
