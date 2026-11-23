"""Languages, currencies and payments (Admin → Languages and currencies): settings, region suggestions, paying in the
shopper's currency (and refunds in it), translations, payment methods and cards saved with Razorpay."""
from __future__ import annotations

import uuid

from app.services import translate
from tests.conftest import add_address, login_phone
from tests.test_orders import marketplace


async def online_order(client, admin, categories, phone: str, currency: str | None = None):
    _, _, _, cable = await marketplace(client, admin, categories)
    buyer = await login_phone(client, phone)
    addr = await add_address(buyer)
    await buyer.post("/api/cart/items", {"variant_id": cable["variants"][0]["id"], "qty": 1})
    body = {"address_id": addr, "payment_method": "online", "idempotency_key": uuid.uuid4().hex}
    if currency:
        body["currency"] = currency
    r = await buyer.post("/api/orders", body)
    assert r.status_code == 201, r.text
    return buyer, r.json()["order"], r.json()["payment"]


async def test_settings_and_region_suggestion(client, admin):
    r = await admin.get("/api/admin/regional")
    assert r.status_code == 200 and r.json()["currencies"][0]["code"] == "INR"
    r = await admin.put("/api/admin/regional", {
        "currencies": [{"code": "INR"}, {"code": "USD", "rate": "0.012", "enabled": True}, {"code": "KWD", "rate": "0.0037", "enabled": True}],
        "languages": [{"code": "en"}, {"code": "ta", "enabled": True}, {"code": "ar", "enabled": True}],
        "regions": [{"country": "US", "currency": "USD", "language": "en"}, {"country": "KW", "currency": "KWD", "language": "ar"}],
        "markup_bps": 200,
    })
    assert r.status_code == 200, r.text
    pub = (await client.get("/api/regional?country=KW")).json()
    assert pub["suggest"] == {"currency": "KWD", "language": "ar"}
    assert {c["code"] for c in pub["currencies"]} == {"INR", "USD", "KWD"}
    kwd = next(c for c in pub["currencies"] if c["code"] == "KWD")
    assert kwd["digits"] == 3 and abs(kwd["rate"] - 0.0037 * 1.02) < 1e-9  # the 2% conversion charge is included
    assert next(x for x in pub["languages"] if x["code"] == "ar")["rtl"] is True
    assert (await client.get("/api/regional?country=FR")).json()["suggest"] == {"currency": "INR", "language": "en"}
    # mistakes are explained
    bad = await admin.put("/api/admin/regional", {"currencies": [{"code": "US", "rate": "1"}]})
    assert bad.status_code == 400 and "3-letter" in bad.json()["error"]["message"]
    bad = await admin.put("/api/admin/regional", {"default_currency": "EUR"})
    assert bad.status_code == 400
    bad = await admin.put("/api/admin/regional", {"pay_methods": {m: False for m in ("upi", "card", "netbanking", "wallet", "emi", "paylater")}})
    assert bad.status_code == 400
    # only staff with the settings permission
    buyer = await login_phone(client, "9770000001")
    assert (await buyer.get("/api/admin/regional")).status_code == 403


async def test_charge_in_rupees_by_default(client, admin, categories, gateway):
    await admin.put("/api/admin/regional", {"currencies": [{"code": "INR"}, {"code": "USD", "rate": "0.012", "enabled": True}]})
    buyer, order, pay = await online_order(client, admin, categories, "9770000002", currency="USD")
    assert pay["currency"] == "INR" and pay["amount"] == order["grand_total"]
    assert order["currency"] == "USD"  # remembered for showing the order in dollars


async def test_charge_in_the_shoppers_currency_and_refund_in_it(client, admin, categories, gateway):
    await admin.put("/api/admin/regional", {"currencies": [{"code": "INR"}, {"code": "USD", "rate": "0.012", "enabled": True}], "charge_in": "shopper"})
    buyer, order, pay = await online_order(client, admin, categories, "9770000003", currency="USD")
    expected = round(order["grand_total"] / 100 * 0.012 * 100)
    assert pay["currency"] == "USD" and pay["amount"] == expected
    assert gateway.orders[pay["razorpay_order_id"]]["currency"] == "USD"
    pid, sig = gateway.pay(pay["razorpay_order_id"])
    r = await buyer.post("/api/payments/razorpay/verify", {"razorpay_order_id": pay["razorpay_order_id"], "razorpay_payment_id": pid, "razorpay_signature": sig})
    assert r.status_code == 200, r.text
    mine = r.json()["order"]
    assert mine["payment_status"] == "paid" and mine["paid"]["currency"] == "USD" and mine["paid"]["charge_amount"] == expected
    # cancelling refunds in dollars, at the order's rate
    sub = mine["sub_orders"][0]
    r = await buyer.post(f"/api/orders/{order['id']}/cancel", {"sub_order_id": sub["id"], "reason": "Changed my mind"})
    assert r.status_code == 200, r.text
    refunds = list(gateway.refunds.values())
    assert refunds and refunds[0]["amount"] <= expected


async def test_disabled_currency_falls_back_to_rupees(client, admin, categories, gateway):
    await admin.put("/api/admin/regional", {"charge_in": "shopper"})
    _, order, pay = await online_order(client, admin, categories, "9770000004", currency="JPY")
    assert pay["currency"] == "INR" and order["currency"] == "INR"


async def test_payment_methods_and_saved_cards(client, admin, categories, gateway):
    await admin.put("/api/admin/regional", {"pay_methods": {"emi": False, "paylater": False}, "card_networks": ["visa", "rupay"]})
    buyer, order, pay = await online_order(client, admin, categories, "9770000005")
    assert pay["methods"]["emi"] is False and pay["methods"]["upi"] is True
    assert pay["card_networks"] == ["visa", "rupay"]
    cust = pay["customer_id"]
    assert cust.startswith("cust_")
    # the shopper saves a card in Razorpay's window; their account lists it (never the number)
    tid = gateway.save_card(cust, "4242")
    cards = (await buyer.get("/api/account/cards")).json()
    assert cards["items"][0]["last4"] == "4242" and cards["items"][0]["network"] == "visa" and "number" not in cards["items"][0]
    # another shopper cannot see or remove it
    other = await login_phone(client, "9770000006")
    assert (await other.get("/api/account/cards")).json()["items"] == []
    assert (await other.delete(f"/api/account/cards/{tid}")).status_code == 404
    assert (await buyer.delete(f"/api/account/cards/{tid}")).status_code == 200
    assert (await buyer.get("/api/account/cards")).json()["items"] == []
    # saving cards switched off: no customer in the payment window
    await admin.put("/api/admin/regional", {"save_cards": False})
    r = await buyer.get(f"/api/orders/{order['id']}")
    assert "customer_id" not in r.json()["payment"]


async def test_translations(client, admin, monkeypatch):
    await admin.put("/api/admin/regional", {"languages": [{"code": "en"}, {"code": "ta", "enabled": True}]})

    async def fake_ai(session, lang, texts):
        return {t: f"[{lang}] {t}" for t in texts}

    async def ready(session=None, route="studio"):
        return True

    monkeypatch.setattr(translate, "_ai_translate", fake_ai)
    monkeypatch.setattr("app.ai.client.configured", ready)
    r = await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Wrap as a gift", "₹499", "Wrap as a gift", "  "]})
    assert r.status_code == 200, r.text
    assert r.json()["translations"] == {"Wrap as a gift": "[ta] Wrap as a gift"}  # amounts and blanks are left alone
    # a staff correction wins, and the AI never overwrites it
    assert (await admin.put("/api/admin/translations", {"lang": "ta", "source": "Wrap as a gift", "text": "பரிசாகக் கட்டு"})).status_code == 200
    r = await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Wrap as a gift"]})
    assert r.json()["translations"]["Wrap as a gift"] == "பரிசாகக் கட்டு"
    lst = (await admin.get("/api/admin/translations?lang=ta&q=gift")).json()
    assert lst["total"] == 1 and lst["items"][0]["origin"] == "manual"
    # AI lines can be cleared to translate again; corrections stay
    await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Notify me"]})
    assert (await admin.delete("/api/admin/translations?lang=ta")).json()["removed"] == 1
    assert (await admin.get("/api/admin/translations?lang=ta")).json()["total"] == 1
    # a language that is off is refused; daily AI limit respected
    assert (await client.post("/api/i18n/translate", json={"lang": "fr", "texts": ["Hello"]})).status_code == 404
    await admin.put("/api/admin/regional", {"ai_translate_daily_max": 0})
    assert (await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Track order"]})).json()["translations"] == {}


async def test_builtin_tamil_and_hindi_without_ai(client, admin):
    """Tamil and Hindi work for the main screens even before an AI model is connected."""
    await admin.put("/api/admin/regional", {"languages": [{"code": "en"}, {"code": "ta", "enabled": True}, {"code": "hi", "enabled": True}]})
    r = (await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Add to cart", "Free delivery on orders over {0} from a seller", "Unknown words"]})).json()
    assert r["translations"]["Add to cart"] == "கார்ட்டில் சேர்" and "{0}" in r["translations"]["Free delivery on orders over {0} from a seller"]
    assert "Unknown words" not in r["translations"]
    assert (await client.post("/api/i18n/translate", json={"lang": "hi", "texts": ["Buy now"]})).json()["translations"]["Buy now"] == "अभी खरीदें"
    # a staff correction wins over the built-in line
    await admin.put("/api/admin/translations", {"lang": "ta", "source": "Buy now", "text": "உடனே வாங்கு"})
    assert (await client.post("/api/i18n/translate", json={"lang": "ta", "texts": ["Buy now"]})).json()["translations"]["Buy now"] == "உடனே வாங்கு"
