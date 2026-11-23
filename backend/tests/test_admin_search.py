"""Quick find (Ctrl+K in the admin header): one search over orders, customers, sellers, listings, partners, tickets
and payouts, limited to what the caller's role can open."""
from __future__ import annotations

from app.db import SessionLocal
from app.models import SupportTicket
from tests.conftest import Api, login_phone, make_live_product, make_seller

URL = "/api/admin/search"


async def staff(client, admin: Api, email: str, role: str) -> Api:
    r = await admin.post("/api/admin/staff", {"email": email, "name": role.title(), "role": role, "password": "Staff@2026xyz"})
    assert r.status_code in (200, 201), r.text
    r = await client.post("/api/auth/login", json={"email": email, "password": "Staff@2026xyz"})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return Api(client, r.json()["access_token"], r.json()["user"])


async def find(api: Api, q: str) -> list[dict]:
    r = await api.get(URL, params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def kinds(results: list[dict]) -> set[str]:
    return {x["kind"] for x in results}


async def test_finds_each_kind_and_masks_contacts(client, admin, categories):
    shopper = await login_phone(client, "9612345678", name="Lakshmi Narayanan")
    seller = await make_seller(client, admin, "9623456789", name="Lakshmi Silks", pan="ABCPL1234K")
    await make_live_product(client, admin, seller, categories["shirts"], title="Kanchipuram silk saree",
                            variants=[{"sku": "LKS-SAREE-01", "options": {}, "mrp_paise": 500000, "price_paise": 450000, "stock": 3}])
    r = await shopper.post("/api/support/tickets", {"category": "order", "subject": "Lakshmi saree colour", "message": "Is it pure silk?"})
    assert r.status_code in (200, 201), r.text

    res = await find(admin, "lakshmi")
    assert {"customer", "seller", "ticket"} <= kinds(res)
    customer = next(x for x in res if x["kind"] == "customer")
    assert customer["title"] == "Lakshmi Narayanan" and customer["href"] == f"/admin/customers/{shopper.user['id']}"
    assert "5678" in customer["sub"] and "9612345678" not in str(res)  # phone shown masked
    # a seller's own account is listed as a seller, not as a customer
    assert [x["title"] for x in res if x["kind"] == "customer"] == ["Lakshmi Narayanan"]

    # listings by title and by SKU
    by_title = [x for x in await find(admin, "kanchipuram") if x["kind"] == "product"]
    by_sku = [x for x in await find(admin, "lks-saree") if x["kind"] == "product"]
    assert by_title and by_title == by_sku and by_title[0]["href"].startswith("/admin/products/")

    # an id pasted from a link finds that record
    res = await find(admin, shopper.user["id"])
    assert [(x["kind"], x["id"]) for x in res] == [("customer", shopper.user["id"])]


async def test_scoped_to_the_role(client, admin, categories):
    shopper = await login_phone(client, "9634567890", name="Ravi Kumar")
    seller = await make_seller(client, admin, "9645678901", name="Ravi Traders", pan="ABCPR1234K")
    await make_live_product(client, admin, seller, categories["shirts"], title="Ravi cotton dhoti",
                            variants=[{"sku": "RAVI-DHOTI", "options": {}, "mrp_paise": 90000, "price_paise": 80000, "stock": 5}])
    await shopper.post("/api/support/tickets", {"category": "order", "subject": "Ravi dhoti size", "message": "Which size?"})

    assert {"customer", "seller", "product", "ticket"} <= kinds(await find(admin, "ravi"))
    catalog = await staff(client, admin, "cat@kadai.in", "catalog")
    assert kinds(await find(catalog, "ravi")) == {"product"}
    support = await staff(client, admin, "help@kadai.in", "support")
    assert kinds(await find(support, "ravi")) == {"customer", "ticket"}
    # an id of a record the role cannot open finds nothing
    assert await find(catalog, shopper.user["id"]) == []


async def test_input_handling(client, admin):
    await login_phone(client, "9656789012", name="Anu 100% cotton")
    await login_phone(client, "9667890123", name="Anu 1000 cotton")
    # too short: nothing is searched
    assert (await admin.get(URL, params={"q": " a "})).json() == {"q": "a", "results": []}
    # % and _ are matched as typed, not as wildcards
    titles = [x["title"] for x in await find(admin, "100%")]
    assert titles == ["Anu 100% cotton"]
    assert await find(admin, "a_u") == []
    # spaces are tidied; very long input is refused
    assert [x["title"] for x in await find(admin, "  anu   1000 ")] == ["Anu 1000 cotton"]
    assert (await admin.get(URL, params={"q": "x" * 81})).status_code == 422
    # at most five of each kind
    for i in range(7):
        await login_phone(client, f"96780000{i:02d}", name=f"Bulk shopper {i}")
    assert len([x for x in await find(admin, "bulk shopper") if x["kind"] == "customer"]) == 5


async def test_not_for_customers_or_guests(client):
    assert (await client.get(URL, params={"q": "ravi"})).status_code == 401
    shopper = await login_phone(client, "9689012345", name="Shopper")
    assert (await shopper.get(URL, params={"q": "ravi"})).status_code == 403
    async with SessionLocal() as s:  # nothing was written
        assert (await s.execute(SupportTicket.__table__.select())).first() is None


async def test_every_word_counts(client, admin):
    await login_phone(client, "9690123456", name="Meena Sundaram")
    await login_phone(client, "9691234567", name="Meena Raj")
    # words in any order, each must appear
    assert [x["title"] for x in await find(admin, "sundaram meena")] == ["Meena Sundaram"]
    assert [x["title"] for x in await find(admin, "meena")] == ["Meena Raj", "Meena Sundaram"]  # newest first
    assert await find(admin, "meena kumar") == []
