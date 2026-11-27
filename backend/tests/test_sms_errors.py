"""The OTP sender turns every failed MSG91 answer into SmsError (never a 500), including a 200 that is not JSON."""
from __future__ import annotations

import httpx
import pytest

from app.services import sms


class Cfg:
    sms_provider = "msg91"
    msg91_auth_key = "k" * 20
    msg91_otp_template_id = "tmpl12345678"
    msg91_api_base = "https://control.msg91.com"


@pytest.mark.parametrize("response", [
    httpx.Response(200, text="<html>maintenance</html>"),
    httpx.Response(200, json={"type": "error", "message": "bad template"}),
    httpx.Response(500, text="oops"),
])
async def test_failed_msg91_answers_raise_sms_error(monkeypatch, response):
    async def fake_get(session=None):
        return Cfg()

    monkeypatch.setattr(sms, "get_integrations", fake_get)
    monkeypatch.setattr(sms, "transport", httpx.MockTransport(lambda request: response))
    with pytest.raises(sms.SmsError):
        await sms.send_otp("9876543210", "123456")


async def test_msg91_success_passes(monkeypatch):
    async def fake_get(session=None):
        return Cfg()

    monkeypatch.setattr(sms, "get_integrations", fake_get)
    monkeypatch.setattr(sms, "transport", httpx.MockTransport(lambda request: httpx.Response(200, json={"type": "success"})))
    await sms.send_otp("9876543210", "123456")
