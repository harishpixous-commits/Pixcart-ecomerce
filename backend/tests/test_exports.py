"""CSV exports: format, scoping, permissions, filters and spreadsheet-formula safety."""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timedelta

from sqlalchemy import update

from app.db import SessionLocal
from app.models import OrderItem, Product
from app.services.exports import ADMIN_EXPORTS, SELLER_EXPORTS, safe_cell
from app.services.reports import IST
from tests.conftest import add_address, login_phone
from tests.test_phase2_money import key, setup, ship_and_deliver


def rows(resp) -> list[list[str]]:
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"] and resp.headers["cache-control"] == "no-store"
    assert resp.content.startswith(b"\xef\xbb\xbf"), "UTF-8 BOM for Excel"
    return list(csv.reader(io.StringIO(resp.content.decode("utf-8-sig"))))


async def _two_orders(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9800000011")
    addr = await add_address(buyer, state="33")
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    o = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    return tn, ka, buyer, o


async def test_admin_order_exports(client, admin, categories):
    tn, ka, buyer, o = await _two_orders(client, admin, categories)
    listing = (await admin.get("/api/admin/exports")).json()["items"]
    assert {i["name"] for i in listing} == set(ADMIN_EXPORTS)
    data = rows(await admin.get("/api/admin/exports/orders.csv"))
    assert data[0][0] == "Package" and len(data) == 3  # header + one package per seller
    head = data[0]
    by_pkg = {r[0]: dict(zip(head, r, strict=True)) for r in data[1:]}
    tn_pkg = next(v for v in by_pkg.values() if v["Seller"] == "Kovai Textiles")
    assert tn_pkg["Package total"] == "1000.00" and tn_pkg["Ship-to state"] == "Tamil Nadu"
    assert tn_pkg["Placed (IST)"].startswith(datetime.now(IST).strftime("%Y-%m-%d"))
    items = rows(await admin.get("/api/admin/exports/order-items.csv"))
    head = items[0]
    line = dict(zip(head, next(r for r in items[1:] if r[head.index("SKU")] == "HL-1"), strict=True))
    assert line["GST rate %"] == "5" and line["Inter-state"] == "no" and float(line["CGST"]) == float(line["SGST"])
    assert line["Place of supply"] == "33-Tamil Nadu"
    # Status filter and validation
    assert len(rows(await admin.get("/api/admin/exports/orders.csv?status=delivered"))) == 1
    assert (await admin.get("/api/admin/exports/orders.csv?status=nope")).status_code == 400
    today = datetime.now(IST).date()
    assert (await admin.get(f"/api/admin/exports/orders.csv?from={today}&to={today - timedelta(days=1)}")).status_code == 400
    assert (await admin.get(f"/api/admin/exports/orders.csv?from={today - timedelta(days=400)}&to={today}")).status_code == 400
    old = rows(await admin.get(f"/api/admin/exports/orders.csv?from={today - timedelta(days=60)}&to={today - timedelta(days=31)}"))
    assert len(old) == 1  # outside the range: header only
    assert (await admin.get("/api/admin/exports/nothing.csv")).status_code == 404
    # GSTR-8 needs a month
    assert (await admin.get("/api/admin/exports/tcs.csv")).status_code == 400
    tcs = rows(await admin.get(f"/api/admin/exports/tcs.csv?month={today.strftime('%Y-%m')}"))
    assert tcs[0][0] == "GSTIN of supplier"
    # Exports are audited
    audit = (await admin.get("/api/admin/audit")).json()["items"]
    assert any(a["action"] == "export.orders" for a in audit)


async def test_seller_exports_only_show_own_rows(client, admin, categories):
    tn, ka, buyer, o = await _two_orders(client, admin, categories)
    assert {i["name"] for i in (await tn.get("/api/seller/exports")).json()["items"]} == set(SELLER_EXPORTS)
    mine = rows(await tn.get("/api/seller/exports/orders.csv"))
    assert len(mine) == 2 and {r[3] for r in mine[1:]} == {"Kovai Textiles"}
    items = rows(await ka.get("/api/seller/exports/order-items.csv"))
    assert {r[items[0].index("SKU")] for r in items[1:]} == {"FP-1"}
    stock = rows(await tn.get("/api/seller/exports/stock.csv"))
    assert stock[0][:3] == ["sku", "warehouse_code", "quantity"] and {r[0] for r in stock[1:]} == {"HL-1"}
    # Sellers cannot reach admin exports, and the admin-only ones do not exist for sellers.
    assert (await tn.get("/api/admin/exports/orders.csv")).status_code in (401, 403)
    assert (await tn.get("/api/seller/exports/customers.csv")).status_code == 404
    sub = next(s for s in o["sub_orders"] if s["seller"]["name"] == "Kovai Textiles")
    await ship_and_deliver(tn, sub["id"])
    ledger = rows(await tn.get("/api/seller/exports/ledger.csv"))
    assert any(r[2] == "sale" for r in ledger[1:])


async def test_formula_cells_are_neutralised(client, admin, categories):
    tn, ka, buyer, o = await _two_orders(client, admin, categories)
    async with SessionLocal() as s:
        await s.execute(update(OrderItem).values(title='=HYPERLINK("http://evil","click")'))
        await s.execute(update(Product).values(brand="@SUM(1+1)"))
        await s.commit()
    items = rows(await admin.get("/api/admin/exports/order-items.csv"))
    titles = {r[items[0].index("Product")] for r in items[1:]}
    assert titles == {"'=HYPERLINK(\"http://evil\",\"click\")"}
    prods = rows(await admin.get("/api/admin/exports/products.csv"))
    assert {r[prods[0].index("Brand")] for r in prods[1:]} == {"'@SUM(1+1)"}
    # Negative amounts stay numbers.
    assert safe_cell("-125.50") == "-125.50" and safe_cell("-cmd") == "'-cmd" and safe_cell(True) == "yes"


async def test_export_permissions_follow_roles(client, admin, categories):
    await _two_orders(client, admin, categories)
    await admin.post("/api/admin/staff", {"email": "mkt@kadai.in", "name": "Marketing", "role": "marketing", "password": "Marketing@2026x"})
    token = (await client.post("/api/auth/login", json={"email": "mkt@kadai.in", "password": "Marketing@2026x"})).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    names = {i["name"] for i in (await client.get("/api/admin/exports", headers=h)).json()["items"]}
    assert "products" in names and "orders" not in names and "customers" not in names
    assert (await client.get("/api/admin/exports/customers.csv", headers=h)).status_code == 403
    assert (await client.get("/api/admin/exports/products.csv", headers=h)).status_code == 200


async def test_customer_export_skips_deleted_accounts(client, admin, categories):
    tn, ka, buyer, o = await _two_orders(client, admin, categories)
    gone = await login_phone(client, "9800000012")
    assert (await gone.delete("/api/account")).status_code == 200
    data = rows(await admin.get("/api/admin/exports/customers.csv"))
    phones = {r[1] for r in data[1:]}
    assert "9800000011" in phones and "9800000012" not in phones


async def test_registers_cover_all_dates_unless_filtered(client, admin, categories):
    await _two_orders(client, admin, categories)
    all_sellers = rows(await admin.get("/api/admin/exports/sellers.csv"))
    assert len(all_sellers) == 3
    today = datetime.now(IST).date()
    old = rows(await admin.get(f"/api/admin/exports/sellers.csv?from={today - timedelta(days=90)}&to={today - timedelta(days=60)}"))
    assert len(old) == 1


async def test_large_export_streams_every_row(client, admin, categories):
    """5,000 packages stream in batches; nothing is cut off and memory stays flat."""
    from sqlalchemy import insert, select

    from app.db import utcnow
    from app.models import Order, Seller, SubOrder

    tn, ka, buyer, o = await _two_orders(client, admin, categories)
    async with SessionLocal() as s:
        order = (await s.execute(select(Order))).scalars().first()
        seller_id = (await s.execute(select(Seller.id))).scalars().first()
        now = utcnow()
        await s.execute(insert(SubOrder), [
            {"order_id": order.id, "seller_id": seller_id, "number": f"BULK-{i:05d}", "status": "delivered", "items_total": 10000, "shipping_fee": 0,
             "cod_fee": 0, "seller_discount": 0, "platform_discount": 0, "total": 10000, "taxable_total": 9524, "shipping_gst_bps": 1800,
             "is_interstate": False, "commission_paise": 0, "commission_gst_paise": 0, "tcs_paise": 0, "tds_paise": 0, "seller_payout_paise": 10000,
             "settlement_status": "pending", "invoice_number": "", "shipping_provider": "manual", "provider_order_id": "", "provider_shipment_id": "",
             "label_url": "", "returned_total": 0, "courier_name": "", "tracking_number": "", "tracking_url": "", "cancelled_by": "", "cancel_reason": "",
             "created_at": now, "updated_at": now}
            for i in range(5000)
        ])
        await s.commit()
    data = rows(await admin.get("/api/admin/exports/orders.csv"))
    assert len(data) == 1 + 2 + 5000
    assert {r[0] for r in data[1:]} >= {f"BULK-{i:05d}" for i in range(5000)}


async def test_gift_card_and_referral_exports(client, admin, categories):
    from app.db import SessionLocal, utcnow
    from app.models import Referral
    await admin.put("/api/admin/growth/settings", {"gift_cards": {"enabled": True, "min_paise": 10000, "max_paise": 100000}})
    made = (await admin.post("/api/admin/growth/gift-cards", {"amount_paise": 50000, "note": "Diwali", "quantity": 1})).json()["items"][0]
    out = rows(await admin.get("/api/admin/exports/gift-cards.csv"))
    head = out[0]
    assert head[0] == "Card (last 4)" and len(out) == 2
    row = dict(zip(head, out[1], strict=True))
    assert row["Card (last 4)"] == made["code"][-4:] and made["code"] not in ",".join(out[1])
    assert row["Value"] == "500.00" and row["Balance"] == "500.00" and row["Used"] == "0.00" and row["Note"] == "Diwali"
    buyer = await login_phone(client, "9800000021")
    friend = await login_phone(client, "9800000022")
    me, fr = (await buyer.get("/api/auth/me")).json()["id"], (await friend.get("/api/auth/me")).json()["id"]
    async with SessionLocal() as s:
        s.add(Referral(referrer_id=uuid.UUID(me), referee_id=uuid.UUID(fr), status="rewarded", reward_paise=2500, created_at=utcnow(), rewarded_at=utcnow()))
        await s.commit()
    refs = rows(await admin.get("/api/admin/exports/referrals.csv"))
    r = dict(zip(refs[0], refs[1], strict=True))
    assert len(refs) == 2 and r["Status"] == "rewarded" and r["Reward"] == "25.00"
    only = rows(await admin.get("/api/admin/exports/referrals.csv?status=joined"))
    assert len(only) == 1


async def test_loyalty_and_coupon_use_exports(client, admin, categories):
    from app.db import SessionLocal, utcnow
    from app.models import LoyaltyEntry
    buyer = await login_phone(client, "9800000031")
    me = uuid.UUID((await buyer.get("/api/auth/me")).json()["id"])
    async with SessionLocal() as s:
        s.add(LoyaltyEntry(user_id=me, kind="earn", points=40, note="Order", created_at=utcnow()))
        s.add(LoyaltyEntry(user_id=me, kind="expire", points=-10, note="Points expired", created_at=utcnow()))
        await s.commit()
    out = rows(await admin.get("/api/admin/exports/loyalty.csv"))
    assert out[0][:2] == ["Date (IST)", "Customer"] and len(out) == 3
    assert {(r[3], r[4]) for r in out[1:]} == {("earn", "40"), ("expire", "-10")}
    assert len(rows(await admin.get("/api/admin/exports/loyalty.csv?status=expire"))) == 2
    assert rows(await admin.get("/api/admin/exports/coupon-use.csv"))[0][1] == "Coupon"
