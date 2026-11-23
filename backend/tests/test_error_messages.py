"""Validation errors read as plain guidance for people: no patterns, type names or raw field names in the message."""
from __future__ import annotations

from tests.conftest import login_phone, make_seller


async def test_product_form_errors_are_plain(client, admin, categories):
    seller = await make_seller(client, admin, "9740000001", name="Plain Words Co", pan="PLAIN1234P")
    r = await seller.post("/api/seller/products", {"category_id": categories["shirts"], "title": "Cotton kurta for men", "hsn_code": "",
                                                   "description": "x" * 40, "images": [], "variants": []})
    assert r.status_code == 422
    e = r.json()["error"]
    assert e["code"] == "validation_error"
    assert e["message"] == "HSN code: use 4, 6 or 8 digits", e
    assert e["fields"]["hsn_code"] == "use 4, 6 or 8 digits"  # the API field name stays for the form
    assert "pattern" not in r.text and "String should" not in r.text


async def test_common_errors(client):
    shopper = await login_phone(client, "9740000002", "Asha")
    r = await shopper.post("/api/addresses", {"full_name": "A", "phone": "98", "line1": "", "city": "Chennai", "state_code": "33", "pincode": "6000"})
    assert r.status_code == 422
    msg = r.json()["error"]["message"]
    assert ":" in msg and "String should" not in msg and "Input should" not in msg
    # a missing field
    r = await client.post("/api/auth/otp/request", json={})
    assert r.status_code == 422 and r.json()["error"]["message"] == "Mobile number: is required"
