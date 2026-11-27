"""Gateway adapters for Cashfree, PhonePe, PayU and Stripe (docs/PAYMENT_GATEWAYS.md section 6).

Each adapter is built from a plain credentials dict and talks HTTP through `transport` (tests swap in httpx.MockTransport).
Nothing here reads the database: keys, routing and storage are wired in by the callers. Razorpay keeps its own module.
Amounts in and out are the smallest unit (paise); adapters convert to rupees where the gateway wants them.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any
from urllib.parse import parse_qs

import httpx

transport: httpx.AsyncBaseTransport | None = None


class GatewayError(Exception):
    pass


def _rupees(paise: int) -> str:
    return f"{paise / 100:.2f}"


def _paise(rupees: Any) -> int:
    return int(round(float(rupees) * 100))


async def _http(method: str, url: str, timeout: float = 8.0, **kw: Any) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=min(5.0, timeout)), transport=transport) as c:
            r = await c.request(method, url, **kw)
    except httpx.HTTPError as exc:
        raise GatewayError("Payment gateway is not reachable right now") from exc
    if r.status_code >= 400:
        try:
            body = r.json()
            msg = body.get("message") or (body.get("error") or {}).get("message") or ""
        except ValueError:
            msg = r.text[:200]
        raise GatewayError(str(msg) or f"Payment gateway error ({r.status_code})")
    return r


def _attempt(id_: str, status: str, method: str, amount: int, error: str = "") -> dict[str, Any]:
    return {"id": id_, "status": status, "method": method, "amount": amount, "error": error}


class Cashfree:
    code = "cashfree"
    sdk_url = "https://sdk.cashfree.com/js/v3/cashfree.js"

    def __init__(self, creds: dict[str, str], timeout: float = 8.0):
        self.id, self.secret, self.timeout = creds.get("client_id", ""), creds.get("client_secret", ""), timeout
        self.sandbox = self.id.startswith("TEST")
        self.base = "https://sandbox.cashfree.com/pg" if self.sandbox else "https://api.cashfree.com/pg"

    def _h(self) -> dict[str, str]:
        return {"x-client-id": self.id, "x-client-secret": self.secret, "x-api-version": "2023-08-01"}

    async def create(self, amount: int, currency: str, receipt: str, customer: dict, return_url: str, notify_url: str) -> dict[str, Any]:
        body = {"order_id": receipt, "order_amount": float(_rupees(amount)), "order_currency": currency,
                "customer_details": {"customer_id": customer.get("id") or receipt, "customer_phone": customer.get("contact") or "9999999999",
                                     "customer_name": customer.get("name") or "Customer", "customer_email": customer.get("email") or ""},
                "order_meta": {"return_url": return_url, "notify_url": notify_url}}
        data = (await _http("POST", f"{self.base}/orders", self.timeout, headers=self._h(), json=body)).json()
        if not data.get("payment_session_id"):
            raise GatewayError("Cashfree did not return a payment session")
        return {"reference": data.get("order_id") or receipt, "mode": "modal",
                "fields": {"sdk_url": self.sdk_url, "env": "sandbox" if self.sandbox else "production", "payment_session_id": data["payment_session_id"]}}

    async def attempts(self, reference: str) -> list[dict[str, Any]]:
        rows = (await _http("GET", f"{self.base}/orders/{reference}/payments", self.timeout, headers=self._h())).json() or []
        st = {"SUCCESS": "captured", "PENDING": "pending", "NOT_ATTEMPTED": "created"}
        return [_attempt(str(p.get("cf_payment_id")), st.get(p.get("payment_status"), "failed"), str(p.get("payment_group") or ""),
                         _paise(p.get("payment_amount") or 0), str((p.get("error_details") or {}).get("error_description") or ""))
                for p in rows]

    async def refund(self, reference: str, payment_id: str, amount: int, refund_id: str, note: str) -> dict[str, Any]:
        d = (await _http("POST", f"{self.base}/orders/{reference}/refunds", self.timeout, headers=self._h(),
                         json={"refund_amount": float(_rupees(amount)), "refund_id": refund_id, "refund_note": note[:100]})).json()
        return {"id": str(d.get("cf_refund_id") or refund_id), "status": "processed" if d.get("refund_status") == "SUCCESS" else "pending"}

    def verify_webhook(self, headers: dict[str, str], body: bytes) -> str | None:
        h = {k.lower(): v for k, v in headers.items()}
        ts, sig = h.get("x-webhook-timestamp", ""), h.get("x-webhook-signature", "")
        want = base64.b64encode(hmac.new(self.secret.encode(), ts.encode() + body, hashlib.sha256).digest()).decode()
        if not self.secret or not hmac.compare_digest(want, sig):
            return None
        import json
        try:
            return str(((json.loads(body).get("data") or {}).get("order") or {}).get("order_id") or "") or None
        except ValueError:
            return None

    def reference_from_return(self, params: dict[str, str]) -> str | None:
        return params.get("order_id") or None


class PhonePe:
    code = "phonepe"

    def __init__(self, creds: dict[str, str], timeout: float = 8.0):
        self.cid, self.secret, self.ver = creds.get("client_id", ""), creds.get("client_secret", ""), creds.get("client_version", "1")
        self.sandbox = str(creds.get("mode", "sandbox")) != "live"
        self.hook_user, self.hook_pass, self.timeout = creds.get("webhook_username", ""), creds.get("webhook_password", ""), timeout
        self.base = "https://api-preprod.phonepe.com/apis/pg-sandbox" if self.sandbox else "https://api.phonepe.com/apis/pg"
        self.token_url = (f"{self.base}/v1/oauth/token" if self.sandbox else "https://api.phonepe.com/apis/identity-manager/v1/oauth/token")
        self._token, self._exp = "", 0.0

    async def _auth(self) -> dict[str, str]:
        if not self._token or time.time() > self._exp - 30:
            d = (await _http("POST", self.token_url, self.timeout, data={"client_id": self.cid, "client_secret": self.secret,
                                                                          "client_version": self.ver, "grant_type": "client_credentials"})).json()
            self._token, self._exp = d.get("access_token", ""), float(d.get("expires_at") or time.time() + 300)
            if not self._token:
                raise GatewayError("PhonePe sign-in failed")
        return {"Authorization": f"O-Bearer {self._token}"}

    async def create(self, amount: int, currency: str, receipt: str, customer: dict, return_url: str, notify_url: str) -> dict[str, Any]:
        body = {"merchantOrderId": receipt, "amount": amount, "paymentFlow": {"type": "PG_CHECKOUT", "merchantUrls": {"redirectUrl": return_url}}}
        d = (await _http("POST", f"{self.base}/checkout/v2/pay", self.timeout, headers=await self._auth(), json=body)).json()
        if not d.get("redirectUrl"):
            raise GatewayError("PhonePe did not return a payment page")
        return {"reference": receipt, "mode": "redirect", "fields": {"url": d["redirectUrl"]}}

    async def attempts(self, reference: str) -> list[dict[str, Any]]:
        d = (await _http("GET", f"{self.base}/checkout/v2/order/{reference}/status", self.timeout, headers=await self._auth())).json()
        st = {"COMPLETED": "captured", "PENDING": "pending"}.get(d.get("state"), "failed")
        det = (d.get("paymentDetails") or [{}])[0]
        return [_attempt(str(det.get("transactionId") or d.get("orderId") or reference), st, str(det.get("paymentMode") or ""),
                         int(d.get("amount") or 0), str(det.get("errorCode") or ""))]

    async def refund(self, reference: str, payment_id: str, amount: int, refund_id: str, note: str) -> dict[str, Any]:
        d = (await _http("POST", f"{self.base}/payments/v2/refund", self.timeout, headers=await self._auth(),
                         json={"merchantRefundId": refund_id, "originalMerchantOrderId": reference, "amount": amount})).json()
        return {"id": str(d.get("refundId") or refund_id), "status": "processed" if d.get("state") == "COMPLETED" else "pending"}

    def verify_webhook(self, headers: dict[str, str], body: bytes) -> str | None:
        h = {k.lower(): v for k, v in headers.items()}
        want = hashlib.sha256(f"{self.hook_user}:{self.hook_pass}".encode()).hexdigest()
        if not (self.hook_user and self.hook_pass) or not hmac.compare_digest(want, h.get("authorization", "").removeprefix("SHA256(").removesuffix(")")):
            return None
        import json
        try:
            p = json.loads(body).get("payload") or {}
            return str(p.get("merchantOrderId") or p.get("originalMerchantOrderId") or "") or None
        except ValueError:
            return None

    def reference_from_return(self, params: dict[str, str]) -> str | None:
        return params.get("merchantOrderId") or params.get("merchantTransactionId") or None


class PayU:
    code = "payu"

    def __init__(self, creds: dict[str, str], timeout: float = 8.0):
        self.key, self.salt, self.timeout = creds.get("key", ""), creds.get("salt", ""), timeout
        self.sandbox = str(creds.get("mode", "sandbox")) != "live"
        self.base = "https://test.payu.in" if self.sandbox else "https://secure.payu.in"

    @staticmethod
    def _sha(s: str) -> str:
        return hashlib.sha512(s.encode()).hexdigest()

    async def create(self, amount: int, currency: str, receipt: str, customer: dict, return_url: str, notify_url: str) -> dict[str, Any]:
        f = {"key": self.key, "txnid": receipt, "amount": _rupees(amount), "productinfo": f"Order {receipt}"[:100],
             "firstname": (customer.get("name") or "Customer").split(" ")[0][:50], "email": customer.get("email") or "noreply@example.com",
             "phone": customer.get("contact") or "", "surl": return_url, "furl": return_url}
        f["hash"] = self._sha("|".join([f["key"], f["txnid"], f["amount"], f["productinfo"], f["firstname"], f["email"]]) + "|" * 11 + self.salt)
        return {"reference": receipt, "mode": "form", "fields": {"action": f"{self.base}/_payment", "fields": f}}

    async def attempts(self, reference: str) -> list[dict[str, Any]]:
        h = self._sha(f"{self.key}|verify_payment|{reference}|{self.salt}")
        info = "https://test.payu.in" if self.sandbox else "https://info.payu.in"
        d = (await _http("POST", f"{info}/merchant/postservice.php?form=2", self.timeout,
                         data={"key": self.key, "command": "verify_payment", "var1": reference, "hash": h})).json()
        tx = (d.get("transaction_details") or {}).get(reference)
        if not tx:
            return []
        st = {"success": "captured", "pending": "pending"}.get(str(tx.get("status")).lower(), "failed")
        return [_attempt(str(tx.get("mihpayid") or ""), st, str(tx.get("mode") or ""), _paise(tx.get("amt") or 0), str(tx.get("error_Message") or ""))]

    async def refund(self, reference: str, payment_id: str, amount: int, refund_id: str, note: str) -> dict[str, Any]:
        h = self._sha(f"{self.key}|cancel_refund_transaction|{payment_id}|{self.salt}")
        info = "https://test.payu.in" if self.sandbox else "https://info.payu.in"
        d = (await _http("POST", f"{info}/merchant/postservice.php?form=2", self.timeout,
                         data={"key": self.key, "command": "cancel_refund_transaction", "var1": payment_id, "var2": refund_id,
                               "var3": _rupees(amount), "hash": h})).json()
        if int(d.get("status", 0)) != 1:
            raise GatewayError(str(d.get("msg") or "PayU refund failed"))
        return {"id": str(d.get("request_id") or refund_id), "status": "pending"}

    def verify_post(self, p: dict[str, str]) -> bool:
        parts = [self.salt, p.get("status", ""), *[p.get(f"udf{i}", "") for i in range(5, 0, -1)], "", "", "", "", "",
                 p.get("email", ""), p.get("firstname", ""), p.get("productinfo", ""), p.get("amount", ""), p.get("txnid", ""), self.key]
        return bool(self.salt) and hmac.compare_digest(self._sha("|".join(parts)), p.get("hash", ""))

    def verify_webhook(self, headers: dict[str, str], body: bytes) -> str | None:
        p = {k: v[0] for k, v in parse_qs(body.decode("utf-8", "ignore")).items()}
        return p.get("txnid") if self.verify_post(p) else None

    def reference_from_return(self, params: dict[str, str]) -> str | None:
        return params.get("txnid") if self.verify_post(params) else None


class Stripe:
    code = "stripe"
    base = "https://api.stripe.com/v1"

    def __init__(self, creds: dict[str, str], timeout: float = 8.0):
        self.key, self.whsec, self.timeout = creds.get("secret_key", ""), creds.get("webhook_secret", ""), timeout
        self.sandbox = self.key.startswith("sk_test_")

    def _h(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.key}"}

    async def create(self, amount: int, currency: str, receipt: str, customer: dict, return_url: str, notify_url: str) -> dict[str, Any]:
        sep = "&" if "?" in return_url else "?"
        form = {"mode": "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": currency.lower(),
                "line_items[0][price_data][unit_amount]": str(amount), "line_items[0][price_data][product_data][name]": f"Order {receipt}",
                "success_url": f"{return_url}{sep}session_id={{CHECKOUT_SESSION_ID}}", "cancel_url": f"{return_url}{sep}session_id={{CHECKOUT_SESSION_ID}}",
                "client_reference_id": receipt, "metadata[order_number]": receipt}
        if customer.get("email"):
            form["customer_email"] = customer["email"]
        d = (await _http("POST", f"{self.base}/checkout/sessions", self.timeout, headers=self._h(), data=form)).json()
        if not d.get("url"):
            raise GatewayError("Stripe did not return a payment page")
        return {"reference": d["id"], "mode": "redirect", "fields": {"url": d["url"]}}

    async def attempts(self, reference: str) -> list[dict[str, Any]]:
        d = (await _http("GET", f"{self.base}/checkout/sessions/{reference}", self.timeout, headers=self._h(), params=[("expand[]", "payment_intent")])).json()
        pi = d.get("payment_intent") or {}
        pid = pi.get("id") if isinstance(pi, dict) else str(pi or reference)
        if d.get("payment_status") == "paid":
            st = "captured"
        elif d.get("status") == "expired":
            st = "failed"
        else:
            st = "pending"
        return [_attempt(str(pid or reference), st, "card", int(d.get("amount_total") or 0), "")]

    async def refund(self, reference: str, payment_id: str, amount: int, refund_id: str, note: str) -> dict[str, Any]:
        d = (await _http("POST", f"{self.base}/refunds", self.timeout, headers={**self._h(), "Idempotency-Key": refund_id},
                         data={"payment_intent": payment_id, "amount": str(amount)})).json()
        return {"id": str(d.get("id") or refund_id), "status": "processed" if d.get("status") == "succeeded" else "pending"}

    def verify_webhook(self, headers: dict[str, str], body: bytes, now: float | None = None) -> str | None:
        h = {k.lower(): v for k, v in headers.items()}
        parts = dict(x.split("=", 1) for x in h.get("stripe-signature", "").split(",") if "=" in x)
        t, v1 = parts.get("t", ""), parts.get("v1", "")
        if not self.whsec or not t.isdigit() or abs((now or time.time()) - int(t)) > 300:
            return None
        if not hmac.compare_digest(hmac.new(self.whsec.encode(), t.encode() + b"." + body, hashlib.sha256).hexdigest(), v1):
            return None
        import json
        try:
            return str(((json.loads(body).get("data") or {}).get("object") or {}).get("id") or "") or None
        except ValueError:
            return None

    def reference_from_return(self, params: dict[str, str]) -> str | None:
        return params.get("session_id") or None


ADAPTERS = {"cashfree": Cashfree, "phonepe": PhonePe, "payu": PayU, "stripe": Stripe}
