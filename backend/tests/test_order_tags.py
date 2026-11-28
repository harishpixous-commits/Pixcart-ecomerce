"""Staff tags on an order: set from the order page, searchable and filterable in the list, never shown to the customer."""
from __future__ import annotations

from tests.test_assistant import place_cod_order


async def test_order_tags_are_saved_filtered_and_private(client, admin, categories):
    o, _ = await place_cod_order(client, admin, categories)
    oid = o["id"]
    r = await admin.put(f"/api/admin/orders/{oid}/tags", {"tags": ["  Fraud check ", "Gift", "fraud check", "Gift", ""]})
    assert r.status_code == 200 and r.json()["staff_tags"] == ["Fraud check", "Gift", "fraud check"]
    assert (await admin.get(f"/api/admin/orders/{oid}")).json()["staff_tags"] == ["Fraud check", "Gift", "fraud check"]
    row = (await admin.get("/api/admin/orders?tag=GIFT")).json()
    assert [i["number"] for i in row["items"]] == [o["number"]] and row["items"][0]["staff_tags"][1] == "Gift"
    assert (await admin.get("/api/admin/orders?tag=nothing")).json()["total"] == 0
    assert (await admin.get("/api/admin/orders?q=fraud")).json()["total"] == 1   # the search box finds tags
    assert (await admin.put(f"/api/admin/orders/{oid}/tags", {"tags": [str(i) for i in range(11)]})).status_code == 422
    # the customer's own order output carries no tags
    assert "Fraud" not in (await client.get(f"/api/orders/{oid}")).text
    assert (await admin.put(f"/api/admin/orders/{oid}/tags", {"tags": []})).json()["staff_tags"] == []
