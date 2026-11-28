"""Staff notes and tags on a customer: private, saved from the customer page, never shown to the customer."""
from __future__ import annotations

from tests.conftest import login_phone


async def test_staff_note_and_tags_are_saved_and_stay_private(client, admin):
    u = await login_phone(client, "9770000501", name="Noted Buyer")
    uid = u.user["id"]
    r = await admin.patch(f"/api/admin/customers/{uid}", {"staff_note": "  Calls before delivery  ", "staff_tags": ["VIP", " vip ", "Wholesale", "VIP", ""]})
    assert r.status_code == 200
    d = r.json()
    assert d["staff_note"] == "Calls before delivery" and d["staff_tags"] == ["VIP", "vip", "Wholesale"]
    assert (await admin.get(f"/api/admin/customers/{uid}")).json()["staff_note"] == "Calls before delivery"
    # an edit that leaves them out keeps them; an empty list clears the tags
    assert (await admin.patch(f"/api/admin/customers/{uid}", {"name": "Noted Buyer"})).json()["staff_tags"] == ["VIP", "vip", "Wholesale"]
    assert (await admin.patch(f"/api/admin/customers/{uid}", {"staff_tags": []})).json()["staff_tags"] == []
    me = (await u.get("/api/auth/me")).json()
    assert "staff_note" not in str(me) and "Calls before" not in str(me)
    assert (await admin.patch(f"/api/admin/customers/{uid}", {"staff_note": "x" * 1001})).status_code == 422
