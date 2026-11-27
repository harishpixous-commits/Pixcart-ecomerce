"""Support desk extras: customer satisfaction rating of a resolved request."""
from __future__ import annotations

from tests.conftest import login_phone


async def test_customers_rate_a_resolved_request_once_and_staff_see_it(client, admin, categories):
    buyer = await login_phone(client, "9600000041")
    tid = (await buyer.post("/api/support/tickets", {"category": "delivery", "subject": "Late parcel", "message": "Where is it?"})).json()["id"]
    r = await buyer.post(f"/api/support/tickets/{tid}/rating", {"rating": 5})
    assert r.status_code == 409 and r.json()["error"]["code"] == "ticket_not_resolved"
    await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "Sorted, it arrives tomorrow.", "status": "resolved"})
    assert (await buyer.post(f"/api/support/tickets/{tid}/rating", {"rating": 6})).status_code == 422
    other = await login_phone(client, "9600000042")
    assert (await other.post(f"/api/support/tickets/{tid}/rating", {"rating": 4})).status_code == 404
    r = await buyer.post(f"/api/support/tickets/{tid}/rating", {"rating": 4, "comment": "  Quick   help "})
    assert r.status_code == 200 and r.json()["csat_rating"] == 4 and r.json()["csat_comment"] == "Quick help"
    again = await buyer.post(f"/api/support/tickets/{tid}/rating", {"rating": 1})
    assert again.status_code == 409 and again.json()["error"]["code"] == "already_rated"
    summary = (await admin.get("/api/admin/tickets/satisfaction")).json()
    assert summary["rated"] == 1 and summary["average"] == 4.0 and summary["spread"]["4"] == 1 and summary["unrated_closed"] == 0
    assert summary["recent"][0]["comment"] == "Quick help"
    assert (await admin.get(f"/api/admin/tickets/{tid}")).json()["csat_rating"] == 4
    assert (await buyer.get("/api/admin/tickets/satisfaction")).status_code == 403


async def test_support_staff_are_told_about_new_requests_replies_and_low_ratings(client, admin, categories):
    buyer = await login_phone(client, "9600000051")

    async def inbox() -> list[str]:
        return [n["title"] for n in (await admin.get("/api/notifications")).json()["items"]]

    tid = (await buyer.post("/api/support/tickets", {"category": "order", "subject": "Wrong colour", "message": "I got blue, not red.", "is_grievance": True})).json()["id"]
    assert any(t.startswith("New grievance TK") for t in await inbox())
    await buyer.post(f"/api/support/tickets/{tid}/messages", {"body": "Any update?"})
    assert any(t.startswith("Customer replied on TK") for t in await inbox())
    await admin.post(f"/api/admin/tickets/{tid}/reply", {"body": "Sorry, a replacement is on the way.", "status": "resolved"})
    await buyer.post(f"/api/support/tickets/{tid}/rating", {"rating": 2, "comment": "Slow"})
    assert any(t.startswith("Low rating on TK") for t in await inbox())
    tid2 = (await buyer.post("/api/support/tickets", {"category": "order", "subject": "Thanks for the help", "message": "All fine now, thank you"})).json()["id"]
    await admin.post(f"/api/admin/tickets/{tid2}/reply", {"body": "Great.", "status": "resolved"})
    await buyer.post(f"/api/support/tickets/{tid2}/rating", {"rating": 5})
    assert sum(t.startswith("Low rating") for t in await inbox()) == 1
