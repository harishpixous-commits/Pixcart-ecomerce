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


async def test_customer_list_filters_by_staff_tag(client, admin):
    a = await login_phone(client, "9770000511", name="Tag Alpha")
    b = await login_phone(client, "9770000512", name="Tag Beta")
    await admin.patch(f"/api/admin/customers/{a.user['id']}", {"staff_tags": ["VIP"]})
    await admin.patch(f"/api/admin/customers/{b.user['id']}", {"staff_tags": ["Wholesale"]})
    r = (await admin.get("/api/admin/customers?tag=vip")).json()
    assert [i["name"] for i in r["items"]] == ["Tag Alpha"] and r["items"][0]["staff_tags"] == ["VIP"]
    assert [i["name"] for i in (await admin.get("/api/admin/customers?q=wholesal")).json()["items"]] == ["Tag Beta"]  # the search box finds tags
    assert (await admin.get("/api/admin/customers?tag=nothing")).json()["total"] == 0
