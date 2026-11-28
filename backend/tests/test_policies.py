"""Two owner policies, each built both ways and chosen in Admin -> Growth: what happens to loyalty points when an account is
deleted (keep or clear), and whether staff may refund a bought gift card that was never used."""
from __future__ import annotations

from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import GiftCard, LoyaltyEntry
from tests.conftest import login_phone
from tests.test_growth import _PayFake


async def _points(user_id: str) -> int:
    import uuid

    async with SessionLocal() as s:
        return int((await s.execute(select(func.coalesce(func.sum(LoyaltyEntry.points), 0)).where(LoyaltyEntry.user_id == uuid.UUID(user_id)))).scalar_one())


async def test_account_delete_keeps_or_clears_loyalty_points_by_setting(client, admin):
    await admin.put("/api/admin/growth/settings", {"loyalty": {"enabled": True}})
    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"on_account_delete": "burn"}})).status_code == 400
    assert (await admin.get("/api/admin/growth/settings")).json()["settings"]["loyalty"]["on_account_delete"] == "keep"
    keep = await login_phone(client, "9876540001", name="Keeper")
    clear = await login_phone(client, "9876540002", name="Clearer")
    ids = {}
    for name, u in (("keep", keep), ("clear", clear)):
        ids[name] = (await u.get("/api/auth/me")).json()["id"]
        assert (await admin.post("/api/admin/growth/loyalty/adjust", {"user_id": ids[name], "points": 250, "note": "Goodwill"})).status_code == 200
    info = (await keep.get("/api/account/delete-info")).json()
    assert info == {"loyalty_points": 250, "points_will_be_cleared": False}
    r = await keep.delete("/api/account")
    assert r.status_code == 200 and r.json()["points_cleared"] == 0 and await _points(ids['keep']) == 250

    assert (await admin.put("/api/admin/growth/settings", {"loyalty": {"on_account_delete": "zero"}})).status_code == 200
    assert (await clear.get("/api/account/delete-info")).json() == {"loyalty_points": 250, "points_will_be_cleared": True}
    r = await clear.delete("/api/account")
    assert r.status_code == 200 and r.json()["points_cleared"] == 250
    assert await _points(ids['clear']) == 0
    assert "account.deleted" in (await admin.get("/api/admin/audit")).text


async def test_staff_can_refund_an_unused_bought_gift_card_only_when_switched_on(client, admin, monkeypatch):
    from app.services import payment_gateways

    fake = _PayFake()
    monkeypatch.setattr(payment_gateways.gateways, "build", fake.build)

    async def cands(*a, **k):
        return ["cashfree"]

    monkeypatch.setattr(payment_gateways, "candidates", cands)
    await admin.put("/api/admin/growth/settings", {"gift_cards": {"enabled": True, "allow_purchase": True, "min_paise": 10000, "max_paise": 100000}})
    buyer = await login_phone(client, "9876540003", name="Gift Buyer")

    async def buy() -> dict:
        pid = (await buyer.post("/api/gift-cards/purchase", {"amount_paise": 20000})).json()["id"]
        fake.attempts_now = [{"id": f"a{pid[:6]}", "status": "captured", "method": "upi", "error": "", "amount": 20000}]
        return {"pid": pid, "code": (await buyer.post(f"/api/gift-cards/purchase/{pid}/check", {})).json()["code"]}

    one, two = await buy(), await buy()
    # switched off by default: the same call is refused and the card is untouched
    off = await admin.post(f"/api/admin/growth/gift-card-purchases/{one['pid']}/refund", {"reference": "UPI123"})
    assert off.status_code == 400 and off.json()["error"]["code"] == "gift_refund_off"
    await admin.put("/api/admin/growth/settings", {"gift_cards": {"staff_refund": True}})
    assert (await buyer.post(f"/api/admin/growth/gift-card-purchases/{one['pid']}/refund", {"reference": "UPI123"})).status_code == 403
    assert (await admin.post(f"/api/admin/growth/gift-card-purchases/{one['pid']}/refund", {"reference": " "})).status_code in (400, 422)
    # a card the holder already spent from cannot be refunded
    assert (await buyer.post("/api/gift-cards/redeem", {"code": two["code"], "amount_paise": 5000})).status_code == 200
    used = await admin.post(f"/api/admin/growth/gift-card-purchases/{two['pid']}/refund", {"reference": "UPI999"})
    assert used.status_code == 409 and used.json()["error"]["code"] == "card_used"
    # an unused card is voided, its balance zeroed, and the purchase shows the refund
    ok = await admin.post(f"/api/admin/growth/gift-card-purchases/{one['pid']}/refund", {"reference": "UPI123"})
    assert ok.status_code == 200 and ok.json()["status"] == "refunded"
    again = await admin.post(f"/api/admin/growth/gift-card-purchases/{one['pid']}/refund", {"reference": "UPI123"})
    assert again.status_code == 200 and again.json()["status"] == "refunded"
    async with SessionLocal() as s:
        card = (await s.execute(select(GiftCard).where(GiftCard.code == one["code"]))).scalar_one()
        assert card.status == "void" and card.balance_paise == 0
    assert (await buyer.post("/api/gift-cards/redeem", {"code": one["code"], "amount_paise": None})).status_code == 400
    listed = (await admin.get("/api/admin/growth/gift-card-purchases")).json()["items"]
    assert next(x for x in listed if x["id"] == one["pid"])["refund_reference"] == "UPI123"
    assert "gift_card.purchase_refund" in (await admin.get("/api/admin/audit")).text
