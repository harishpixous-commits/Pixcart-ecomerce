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
