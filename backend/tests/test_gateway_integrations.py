import httpx

from app.config import Settings
from app.integrations import checks
from app.integrations.registry import PROVIDERS
from app.services import gateways


def test_gateways_are_listed_with_switches():
    by = {p.key: p for p in PROVIDERS}
    for code in ("cashfree", "phonepe", "payu", "stripe"):
        p = by[code]
        assert p.group == "payments" and p.webhook_path == f"/api/payments/{code}/webhook"
        assert p.on == {f"{code}_checkout": True} and p.off == {f"{code}_checkout": False}
        assert all(hasattr(Settings(), f.setting) for f in p.fields)


def test_enabled_needs_keys_and_switch():
    cfg = Settings(stripe_secret_key="sk_test_1", payu_key="K", payu_salt="S", payu_checkout=False)
    assert gateways.enabled(cfg, "stripe") and not gateways.enabled(cfg, "payu") and not gateways.enabled(cfg, "cashfree")


async def test_connection_checks():
    seen = []

    def h(req):
        seen.append(req.url.path)
        if req.url.path.endswith("/balance"):
            return httpx.Response(200, json={"object": "balance"})
        if "pixcart_connection_test" in req.url.path:
            return httpx.Response(404, json={"message": "order not found"})
        return httpx.Response(401, json={"message": "bad keys"})
    gateways.transport = httpx.MockTransport(h)
    try:
        assert (await checks.stripe(Settings(stripe_secret_key="sk_test_1"))).ok
        r = await checks.cashfree(Settings(cashfree_client_id="TESTabcdef", cashfree_client_secret="s"))
        assert r.ok and "test mode" in r.message
        bad = await checks.stripe(Settings(stripe_secret_key=""))
        assert not bad.ok and "keys" in bad.message
    finally:
        gateways.transport = None
