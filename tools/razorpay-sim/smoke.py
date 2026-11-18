"""End-to-end online payment check: order → Razorpay checkout → verify → webhook → cancel → refund.

Runs against a local stack wired to the simulator (see sim.py), using the console SMS provider's OTP
from the API log. Usage:

    python tools/razorpay-sim/smoke.py --api http://127.0.0.1:8000 --sim http://127.0.0.1:8790 --log /tmp/api.log --phone 9888800001
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import uuid

import httpx


def otp_from_log(log: str, phone: str) -> str:
    for _ in range(30):
        hits = re.findall(rf"DEV OTP for {phone}: (\d+)", open(log, encoding="utf-8", errors="ignore").read())
        if hits:
            return hits[-1]
        time.sleep(0.3)
    raise SystemExit(f"No OTP for {phone} in {log}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--sim", default="http://127.0.0.1:8790")
    ap.add_argument("--log", default="/tmp/api.log")
    ap.add_argument("--phone", default="9888800001")
    a = ap.parse_args()
    c = httpx.Client(base_url=a.api, timeout=30)
    step = lambda msg: print(f"✓ {msg}")  # noqa: E731

    r = c.post("/api/auth/otp/request", json={"phone": a.phone})
    assert r.status_code in (200, 429), r.text
    r = c.post("/api/auth/otp/verify", json={"phone": a.phone, "code": otp_from_log(a.log, a.phone), "name": "Payment Smoke"})
    assert r.status_code == 200, r.text
    c.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
    step("customer signed in with OTP")

    products = c.get("/api/catalog/products", params={"page_size": 50}).json()["items"]
    variant = None
    for p in products:
        d = c.get(f"/api/catalog/products/{p['slug']}").json()
        variant = next((v for v in d.get("variants", []) if v.get("in_stock")), None)
        if variant:
            break
    assert variant, "no product in stock"
    c.delete("/api/cart")
    assert c.post("/api/cart/items", json={"variant_id": variant["id"], "qty": 1}).status_code in (200, 201)
    addrs = c.get("/api/addresses").json()
    addrs = addrs.get("items", addrs) if isinstance(addrs, dict) else addrs
    if not addrs:
        addr = c.post("/api/addresses", json={"full_name": "Payment Smoke", "phone": a.phone, "line1": "12 Test Street", "city": "Chennai",
                                               "state_code": "33", "pincode": "600028"}).json()["id"]
    else:
        addr = addrs[0]["id"]
    r = c.post("/api/orders", json={"address_id": addr, "payment_method": "online", "idempotency_key": str(uuid.uuid4())})
    assert r.status_code in (200, 201), r.text
    order, pay = r.json()["order"], r.json()["payment"]
    assert pay and pay["razorpay_order_id"].startswith("order_") and order["status"] == "pending_payment"
    step(f"order {order['number']} created; Razorpay order {pay['razorpay_order_id']} for ₹{pay['amount'] / 100:,.2f}")

    resp = httpx.post(f"{a.sim}/sim/pay", json={"order_id": pay["razorpay_order_id"]}).json()
    r = c.post("/api/payments/razorpay/verify", json=resp)
    assert r.status_code == 200 and r.json()["order"]["status"] == "placed", r.text
    step(f"payment {resp['razorpay_payment_id']} verified by signature and confirmed with the gateway")

    bad = dict(resp, razorpay_signature="0" * 64)
    assert c.post("/api/payments/razorpay/verify", json=bad).status_code == 400
    step("a forged signature is rejected")

    events = httpx.get(f"{a.sim}/sim/events").json()["events"]
    assert any(e["event"] == "payment.captured" and e["sent"] for e in events)
    step("webhook payment.captured delivered (signed) and accepted")

    r = c.post(f"/api/orders/{order['id']}/cancel", json={"reason": "Smoke test cancellation"})
    assert r.status_code == 200, r.text
    for _ in range(20):
        events = httpx.get(f"{a.sim}/sim/events").json()["events"]
        if any(e["event"] == "refund.processed" for e in events):
            break
        time.sleep(0.5)
    assert any(e["event"] == "refund.processed" for e in events), "refund did not reach the gateway"
    step("cancellation refunded through the gateway (refund.processed)")
    health = httpx.get(f"{a.sim}/health").json()
    print(f"\nAll good. Simulator saw {health['orders']} orders, {health['payments']} payments, {health['refunds']} refunds.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
