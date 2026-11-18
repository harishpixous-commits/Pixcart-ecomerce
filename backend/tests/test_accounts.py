"""Separate sign-in and create-account flows, the on-screen dev OTP and its switch, sign-up switches,
and admin account management (customer detail, edit, create, sign out; sellers created by staff)."""
from app.services import sms
from conftest import add_address, login_phone
from test_phase2_money import key, setup

H = {"X-Requested-With": "pixcart"}


async def otp(client, phone: str, purpose: str, **kw):
    return await client.post("/api/auth/otp/request", json={"phone": phone, "purpose": purpose, **kw}, headers=H)


async def verify(client, phone: str, code: str, purpose: str, **kw):
    r = await client.post("/api/auth/otp/verify", json={"phone": phone, "code": code, "purpose": purpose, **kw}, headers=H)
    client.cookies.clear()
    return r


async def test_sign_in_and_create_account_are_separate(client):
    # Sign in with a number that has no account: no code is sent, the screen offers "Create account".
    r = await otp(client, "9630000001", "signin")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_account"
    assert "9630000001" not in sms.DEV_OUTBOX

    # Create account: the code is shown on screen in test mode, name and terms are required.
    r = await otp(client, "9630000001", "signup")
    assert r.status_code == 200 and r.json()["dev_otp"] == sms.DEV_OUTBOX["9630000001"]
    code = r.json()["dev_otp"]
    assert (await verify(client, "9630000001", code, "signup", name="Anu")).json()["error"]["code"] == "terms_required"
    assert (await verify(client, "9630000001", code, "signup", name="", accept_terms=True)).json()["error"]["code"] == "name_required"
    r = await verify(client, "9630000001", code, "signup", name="Anu  Kumar", email="Anu@Example.in", accept_terms=True, marketing_opt_in=True)
    assert r.status_code == 200 and r.json()["is_new"] is True
    me = r.json()["user"]
    assert me["name"] == "Anu Kumar" and me["email"] == "anu@example.in" and me["marketing_opt_in"] is True

    # Creating it again is refused; signing in works.
    r = await otp(client, "9630000001", "signup")
    assert r.status_code == 409 and r.json()["error"]["code"] == "account_exists"
    client.cookies.clear()
    # (the resend cooldown applies per number, so wait it out by clearing the challenge age in the test DB)
    from sqlalchemy import update

    from app.db import SessionLocal, utcnow
    from app.models import OtpChallenge
    async with SessionLocal() as s:
        await s.execute(update(OtpChallenge).values(created_at=utcnow().replace(year=2020)))
        await s.commit()
    r = await otp(client, "9630000001", "signin")
    assert r.status_code == 200
    r = await verify(client, "9630000001", r.json()["dev_otp"], "signin")
    assert r.status_code == 200 and r.json()["is_new"] is False

    # Older clients (no purpose) keep working: sign in or create in one step.
    r = await otp(client, "9630000002", "any")
    assert r.status_code == 200
    assert (await verify(client, "9630000002", r.json()["dev_otp"], "any", name="Old App")).json()["is_new"] is True


async def test_admin_switches_dev_otp_and_signups(client, admin, categories):
    opts = (await client.get("/api/auth/options")).json()
    assert opts["dev_otp"] is True and opts["customer_signup"] and opts["seller_signup"]
    s = (await admin.get("/api/admin/auth-settings")).json()
    assert s["dev_otp"]["active"] and s["sms_provider"] == "console" and s["otp"]["length"] == 6

    r = await admin.put("/api/admin/auth-settings", {"show_dev_otp": False})
    assert r.status_code == 200 and r.json()["dev_otp"]["active"] is False
    r = await otp(client, "9630000003", "signup")
    assert r.status_code == 200 and "dev_otp" not in r.json()  # still sent (server log), not shown
    assert (await client.get("/api/auth/options")).json()["dev_otp"] is False

    await admin.put("/api/admin/auth-settings", {"customer_signup": False, "signup_email": "required"})
    r = await otp(client, "9630000004", "signup")
    assert r.status_code == 403 and r.json()["error"]["code"] == "signup_closed"
    # sellers can still register while customer sign-up is paused
    assert (await otp(client, "9630000004", "signup", for_seller=True)).status_code == 200
    r = await verify(client, "9630000004", sms.DEV_OUTBOX["9630000004"], "signup", name="Shop Owner", accept_terms=True, for_seller=True)
    assert r.json()["error"]["code"] == "email_required"

    await admin.put("/api/admin/auth-settings", {"seller_signup": False, "customer_signup": True})
    seller_user = await login_phone(client, "9630000005", name="Wannabe")
    r = await seller_user.post("/api/seller/register", {"display_name": "New Shop"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "seller_signup_closed"
    assert (await admin.put("/api/admin/auth-settings", {"signup_email": "maybe"})).status_code == 400
    assert (await admin.put("/api/admin/auth-settings", {"show_dev_otp": "yes"})).status_code == 400

    # only staff with the settings permission
    await admin.post("/api/admin/staff", {"email": "sup1@kadai.in", "name": "Sup", "role": "support", "password": "Support@2026xx"})
    tok = (await client.post("/api/auth/login", json={"email": "sup1@kadai.in", "password": "Support@2026xx"})).json()["access_token"]
    assert (await client.put("/api/admin/auth-settings", json={"show_dev_otp": True}, headers={"Authorization": f"Bearer {tok}"})).status_code == 403


async def test_blocked_account_cannot_sign_in(client, admin):
    u = await login_phone(client, "9630000006", name="Blocked")
    await admin.post(f"/api/admin/customers/{u.user['id']}/block", {"reason": "Fraudulent orders"})
    r = await otp(client, "9630000006", "signin")
    assert r.status_code == 403


async def test_admin_manages_customer_accounts(client, admin, categories):
    # create a customer for a phone order
    r = await admin.post("/api/admin/customers", {"name": "Lakshmi", "phone": "+91 96300 00007", "email": "lakshmi@example.in"})
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert (await admin.post("/api/admin/customers", {"name": "Dup", "phone": "9630000007"})).json()["error"]["code"] == "phone_taken"
    assert (await admin.post("/api/admin/customers", {"name": "Bad", "phone": "12345"})).status_code == 400

    # the customer signs in on their own mobile and orders
    tn, ka, shirt, _ = await setup(client, admin, categories)
    buyer = await login_phone(client, "9630000007")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})
    await buyer.post("/api/support/tickets", {"category": "order", "subject": "Need invoice", "message": "Please send the GST invoice"})

    d = (await admin.get(f"/api/admin/customers/{cid}")).json()
    assert d["name"] == "Lakshmi" and d["phone"] == "9630000007" and d["email"] == "lakshmi@example.in"
    assert d["stats"]["orders"] == 1 and d["stats"]["tickets"] == 1 and d["stats"]["spent"] > 0
    assert d["addresses"][0]["text"].startswith("4 Lake View St") and d["orders"][0]["number"]
    assert d["sessions"] and d["history"][0]["action"] == "user.create"

    # edit: a new mobile number signs the customer out everywhere
    r = await admin.patch(f"/api/admin/customers/{cid}", {"name": "Lakshmi R", "phone": "9630000008", "marketing_opt_in": True})
    assert r.status_code == 200 and r.json()["phone"] == "9630000008" and r.json()["sessions"] == []
    assert (await buyer.get("/api/orders")).status_code == 200  # access token still valid until it expires...
    r = await client.post("/api/auth/refresh", headers=H)
    assert r.status_code == 401  # ...but the session cannot be renewed
    assert (await admin.patch(f"/api/admin/customers/{cid}", {"email": "admin@pixcart.in"})).json()["error"]["code"] == "email_taken"
    assert (await admin.patch(f"/api/admin/customers/{cid}", {"clear_email": True})).json()["email"] is None

    buyer2 = await login_phone(client, "9630000008")
    assert buyer2.user["id"] == cid
    r = await admin.post(f"/api/admin/customers/{cid}/sign-out")
    assert r.json()["sessions"] == 1
    hist = (await admin.get(f"/api/admin/customers/{cid}")).json()["history"]
    assert {h["action"] for h in hist} >= {"user.edit", "user.sign_out", "user.create"}

    # support staff can read customers; a catalogue manager cannot
    await admin.post("/api/admin/staff", {"email": "cat1@kadai.in", "name": "Cat", "role": "catalog", "password": "Catalog@2026xx"})
    tok = (await client.post("/api/auth/login", json={"email": "cat1@kadai.in", "password": "Catalog@2026xx"})).json()["access_token"]
    assert (await client.get(f"/api/admin/customers/{cid}", headers={"Authorization": f"Bearer {tok}"})).status_code == 403


async def test_staff_create_a_seller_who_completes_onboarding(client, admin):
    r = await admin.post("/api/admin/sellers", {"phone": "9630000009", "name": "Ravi", "store_name": "Ravi  Electricals"})
    assert r.status_code == 201, r.text
    sid = r.json()["id"]
    assert (await admin.post("/api/admin/sellers", {"phone": "9630000009", "name": "Ravi", "store_name": "Again"})).status_code == 409
    seller = await login_phone(client, "9630000009")
    me = (await seller.get("/api/seller/me")).json()
    assert me["id"] == sid and me["status"] == "draft" and me["display_name"] == "Ravi Electricals"
    assert (await admin.get(f"/api/admin/sellers/{sid}")).status_code == 200


async def test_admin_edits_seller_kyc_and_sellers_are_told(client, admin, categories):
    tn, ka, shirt, _ = await setup(client, admin, categories)
    sid = (await tn.get("/api/seller/me")).json()["id"]
    # the seller cannot change bank details once approved; staff can, and the seller is told
    r = await tn.put("/api/seller/bank", {"holder_name": "Kovai Textiles", "account_number": "998877665544", "confirm_account_number": "998877665544", "ifsc": "HDFC0001234"})
    assert r.status_code == 409
    r = await admin.put(f"/api/admin/sellers/{sid}/bank", {"holder_name": "Kovai Textiles Pvt Ltd", "account_number": "998877665544",
                                                           "confirm_account_number": "998877665544", "ifsc": "HDFC0001234"})
    assert r.status_code == 200 and r.json()["bank"]["account_number"] == "998877665544"
    assert (await admin.put(f"/api/admin/sellers/{sid}/bank", {"holder_name": "X Y Z", "account_number": "1234567890", "confirm_account_number": "1234567899",
                                                               "ifsc": "HDFC0001234"})).json()["error"]["code"] == "account_mismatch"
    notes = (await tn.get("/api/notifications")).json()["items"]
    assert any("bank account changed" in n["title"] for n in notes)
    from app.db import SessionLocal
    from app.models import Seller
    async with SessionLocal() as s:
        assert (await s.get(Seller, __import__("uuid").UUID(sid))).payout_fund_account_id == ""  # payouts set up again for the new account

    r = await admin.put(f"/api/admin/sellers/{sid}/pickup-address", {"line1": "5 New Mill Road", "city": "Coimbatore", "state_code": "33", "pincode": "641001"})
    assert r.status_code == 200 and r.json()["pickup"]["city"] == "Coimbatore"
    r = await admin.put(f"/api/admin/sellers/{sid}/grievance-officer", {"name": "Kumar S", "email": "kumar@kovai.in", "phone": "9400000011"})
    assert r.json()["grievance"]["name"] == "Kumar S"
    me = (await tn.get("/api/seller/me")).json()
    r = await admin.put(f"/api/admin/sellers/{sid}/business", {"display_name": "Kovai Textiles", "legal_name": "Kovai Textiles LLP", "business_type": "llp",
                                                               "gstin": me["gstin"], "pan": "KOVAI1234K", "contact_email": "a@kovai.in", "contact_phone": "9400000001"})
    assert r.status_code == 200 and r.json()["legal_name"] == "Kovai Textiles LLP"
    assert (await admin.put(f"/api/admin/sellers/{sid}/business", {"display_name": "Kovai Textiles", "legal_name": "Kovai", "business_type": "llp",
                                                                   "gstin": me["gstin"], "pan": "ABCDE1234F", "contact_email": "a@kovai.in",
                                                                   "contact_phone": "9400000001"})).json()["error"]["code"] == "pan_gstin_mismatch"

    # send back, then approve directly once the details are complete; the seller hears about each step
    await admin.post(f"/api/admin/sellers/{sid}/reject", {"reason": "Please upload a clearer PAN card"})
    r = await admin.post(f"/api/admin/sellers/{sid}/approve")
    assert r.status_code == 200 and r.json()["status"] == "approved"
    titles = [n["title"] for n in (await tn.get("/api/notifications")).json()["items"]]
    assert any("sent back" in t for t in titles) and any("approved" in t for t in titles)
    assert any("Listing approved" in t for t in titles)  # from make_live_product
    hist = (await admin.get("/api/admin/audit", params={"entity_id": sid})).json()
    assert {"seller.edit_bank", "seller.edit_pickup", "seller.edit_business"} <= {h["action"] for h in hist["items"]}

    # staff without the sellers permission cannot change them
    await admin.post("/api/admin/staff", {"email": "sup2@kadai.in", "name": "Sup", "role": "support", "password": "Support@2026xx"})
    tok = (await client.post("/api/auth/login", json={"email": "sup2@kadai.in", "password": "Support@2026xx"})).json()["access_token"]
    r = await client.put(f"/api/admin/sellers/{sid}/grievance-officer", json={"name": "Hacker", "email": "h@x.in", "phone": "9400000012"}, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 403


async def test_admin_order_filters_and_list_search(client, admin, categories):
    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9630000010", name="Revathi")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    o1 = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    await buyer.post("/api/cart/items", {"variant_id": phone["variants"][0]["id"], "qty": 1})
    o2 = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "cod", "idempotency_key": key()})).json()["order"]
    tn_id = (await tn.get("/api/seller/me")).json()["id"]
    get = lambda **q: admin.get("/api/admin/orders", params=q)  # noqa: E731
    assert {i["number"] for i in (await get(seller_id=tn_id)).json()["items"]} == {o1["number"]}
    assert (await get(q="Revathi")).json()["total"] == 2
    assert (await get(q=o2["number"] + "-1")).json()["items"][0]["number"] == o2["number"]  # package number
    assert (await get(payment_method="online")).json()["total"] == 0
    assert (await get(package_status="placed")).json()["total"] == 2
    assert (await get(package_status="shipped")).json()["total"] == 0
    assert (await get(date_from="2000-01-01", date_to="2000-01-31")).json()["total"] == 0
    assert (await get(customer_id=buyer.user["id"])).json()["items"][0]["package_statuses"] == ["placed"]
    assert (await get(date_from="nope")).status_code == 422

    await buyer.post("/api/support/tickets", {"category": "order", "subject": "Wrong colour sent", "message": "I got a red shirt instead of blue"})
    t = (await admin.get("/api/admin/tickets", params={"status": "", "q": "colour"})).json()
    assert t["total"] == 1 and t["page_size"] == 30
    assert (await admin.get("/api/admin/tickets", params={"status": "", "q": "zzzz"})).json()["total"] == 0
    r = (await admin.get("/api/admin/returns", params={"q": "nothing"})).json()
    assert r["total"] == 0 and "page_size" in r
    assert "total" in (await admin.get("/api/admin/refunds")).json()
    assert "total" in (await admin.get("/api/admin/reviews")).json()
    assert (await admin.get("/api/admin/payouts", params={"seller_id": tn_id})).json()["total"] == 0
    kinds = {k: (await admin.get("/api/admin/customers", params={"kind": k})).json()["total"] for k in ("customers", "sellers", "staff", "blocked")}
    assert kinds["sellers"] == 2 and kinds["staff"] >= 1 and kinds["blocked"] == 0 and kinds["customers"] >= 1


async def test_failed_refund_can_be_settled_by_hand(client, admin, categories, gateway):
    import asyncio

    from sqlalchemy import select, update

    from app.db import SessionLocal
    from app.models import Refund

    tn, ka, shirt, phone = await setup(client, admin, categories)
    buyer = await login_phone(client, "9630000011", name="Deepa")
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": shirt["variants"][0]["id"], "qty": 1})
    r = (await buyer.post("/api/orders", {"address_id": addr, "payment_method": "online", "idempotency_key": key()})).json()
    pay = r["payment"]
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    await buyer.post(f"/api/orders/{r['order']['id']}/cancel", {"reason": "Ordered by mistake"})
    await asyncio.sleep(0.05)
    async with SessionLocal() as s:  # the gateway gave up on it
        await s.execute(update(Refund).values(status="failed", last_error="Gateway down"))
        await s.commit()
        refund_id = (await s.execute(select(Refund.id))).scalar_one()
    before = len((await buyer.get("/api/notifications")).json()["items"])
    assert (await admin.post(f"/api/admin/refunds/{refund_id}/settle", {"method": "upi", "reference": "x"})).status_code == 422
    r = await admin.post(f"/api/admin/refunds/{refund_id}/settle", {"method": "upi", "reference": "UPI 4123 9876 5501"})
    assert r.status_code == 200 and r.json()["status"] == "processed"
    assert (await admin.post(f"/api/admin/refunds/{refund_id}/settle", {"method": "upi", "reference": "UPI 4123 9876 5502"})).status_code == 409
    items = (await buyer.get("/api/notifications")).json()["items"]
    assert len(items) == before + 1 and items[0]["title"] == "Refund started"
    assert (await admin.get("/api/admin/refunds", params={"status": "processed"})).json()["total"] == 1
