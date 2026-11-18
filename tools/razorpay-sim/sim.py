"""Razorpay simulator for local development and automated tests. NEVER run it in production.

It speaks the parts of the Razorpay API this marketplace uses, with real-shaped responses and real
signatures, and serves a stand-in for checkout.js, so the full online-payment flow runs end to end
without internet access or a Razorpay account:

    checkout (simulated window) → /api/payments/razorpay/verify (HMAC order_id|payment_id)
    → webhook payment.captured (HMAC of the raw body, X-Razorpay-Signature, X-Razorpay-Event-Id)
    → cancellation → refund (POST /payments/{id}/refund) → webhook refund.processed

Start (from the repo root):

    RAZORPAY_SIM_KEY_ID=rzp_test_sim RAZORPAY_SIM_KEY_SECRET=sim_secret RAZORPAY_SIM_WEBHOOK_SECRET=sim_whsec \\
    RAZORPAY_SIM_WEBHOOK_URL=http://127.0.0.1:8000/api/payments/razorpay/webhook \\
    backend/.venv/bin/uvicorn sim:app --app-dir tools/razorpay-sim --port 8790

and point the backend at it (development only):

    RAZORPAY_API_BASE=http://127.0.0.1:8790/v1
    RAZORPAY_CHECKOUT_URL=http://127.0.0.1:8790/v1/checkout.js
    RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET = the same three values as above
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

if os.environ.get("ENVIRONMENT") == "production":
    raise SystemExit("The Razorpay simulator must never run in production.")

KEY_ID = os.environ.get("RAZORPAY_SIM_KEY_ID", "rzp_test_sim")
KEY_SECRET = os.environ.get("RAZORPAY_SIM_KEY_SECRET", "sim_secret")
WEBHOOK_SECRET = os.environ.get("RAZORPAY_SIM_WEBHOOK_SECRET", "sim_whsec")
WEBHOOK_URL = os.environ.get("RAZORPAY_SIM_WEBHOOK_URL", "")
PUBLIC = os.environ.get("RAZORPAY_SIM_PUBLIC_URL", "http://127.0.0.1:8790")

app = FastAPI(title="Razorpay simulator (development only)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ORDERS: dict[str, dict] = {}
PAYMENTS: dict[str, dict] = {}
REFUNDS: dict[str, dict] = {}
EVENTS: list[dict] = []


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(7)}"


def _auth(request: Request) -> None:
    expected = "Basic " + base64.b64encode(f"{KEY_ID}:{KEY_SECRET}".encode()).decode()
    if not hmac.compare_digest(request.headers.get("authorization", ""), expected):
        raise HTTPException(401, detail={"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}})


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": {"code": "BAD_REQUEST_ERROR", "description": msg}}, status_code=status)


async def _webhook(event: str, payload: dict) -> None:
    body = json.dumps({"entity": "event", "event": event, "contains": list(payload), "payload": payload, "created_at": int(time.time())}).encode()
    sig = hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()
    EVENTS.append({"event": event, "sent": bool(WEBHOOK_URL)})
    if not WEBHOOK_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(WEBHOOK_URL, content=body, headers={"content-type": "application/json", "x-razorpay-signature": sig, "x-razorpay-event-id": _id("evt")})
    except httpx.HTTPError:
        pass  # Razorpay retries; the app also reconciles with the API


# ----------------------------------------------------------------------------- REST API (subset)


@app.get("/v1/orders")
async def list_orders(request: Request, count: int = 10) -> dict:
    _auth(request)
    items = list(ORDERS.values())[-count:]
    return {"entity": "collection", "count": len(items), "items": items}


@app.post("/v1/orders")
async def create_order(request: Request) -> dict:
    _auth(request)
    b = await request.json()
    if not isinstance(b.get("amount"), int) or b["amount"] < 100:
        return _err(400, "The amount must be atleast INR 1.00")
    o = {"id": _id("order"), "entity": "order", "amount": b["amount"], "amount_paid": 0, "amount_due": b["amount"], "currency": b.get("currency", "INR"),
         "receipt": b.get("receipt"), "status": "created", "attempts": 0, "notes": b.get("notes", {}), "created_at": int(time.time())}
    ORDERS[o["id"]] = o
    return o


@app.get("/v1/orders/{order_id}/payments")
async def order_payments(order_id: str, request: Request) -> dict:
    _auth(request)
    items = [p for p in PAYMENTS.values() if p["order_id"] == order_id]
    return {"entity": "collection", "count": len(items), "items": items}


@app.get("/v1/payments/{payment_id}")
async def get_payment(payment_id: str, request: Request) -> dict:
    _auth(request)
    p = PAYMENTS.get(payment_id)
    return p if p else _err(404, "The id provided does not exist")


@app.post("/v1/payments/{payment_id}/capture")
async def capture(payment_id: str, request: Request) -> dict:
    _auth(request)
    p = PAYMENTS.get(payment_id)
    if not p:
        return _err(404, "The id provided does not exist")
    p["status"], p["captured"] = "captured", True
    return p


@app.post("/v1/payments/{payment_id}/refund")
async def refund(payment_id: str, request: Request) -> dict:
    _auth(request)
    p = PAYMENTS.get(payment_id)
    if not p or p["status"] != "captured":
        return _err(400, "The payment has not been captured")
    b = await request.json()
    amount = int(b.get("amount") or p["amount"])
    if amount > p["amount"] - p["amount_refunded"]:
        return _err(400, "The refund amount provided is greater than amount captured")
    r = {"id": _id("rfnd"), "entity": "refund", "amount": amount, "currency": "INR", "payment_id": payment_id, "receipt": b.get("receipt"),
         "notes": b.get("notes", {}), "status": "processed", "speed_processed": "normal", "created_at": int(time.time())}
    REFUNDS[r["id"]] = r
    p["amount_refunded"] += amount
    p["refund_status"] = "full" if p["amount_refunded"] == p["amount"] else "partial"
    await _webhook("refund.processed", {"refund": {"entity": r}, "payment": {"entity": p}})
    return r


# ----------------------------------------------------------------------------- checkout


@app.post("/sim/pay")
async def sim_pay(request: Request) -> dict:
    """What happens when the shopper presses Pay in the simulated window."""
    b = await request.json()
    o = ORDERS.get(b.get("order_id", ""))
    if not o:
        raise HTTPException(404, "order not found")
    if b.get("outcome") == "fail":
        pid = _id("pay")
        PAYMENTS[pid] = {"id": pid, "entity": "payment", "amount": o["amount"], "currency": "INR", "status": "failed", "order_id": o["id"], "method": b.get("method", "upi"),
                         "captured": False, "amount_refunded": 0, "error_description": "Payment failed (simulated)", "created_at": int(time.time())}
        await _webhook("payment.failed", {"payment": {"entity": PAYMENTS[pid]}})
        return {"error": {"description": "Payment failed (simulated)", "metadata": {"payment_id": pid, "order_id": o["id"]}}}
    pid = _id("pay")
    p = {"id": pid, "entity": "payment", "amount": o["amount"], "currency": "INR", "status": "captured", "order_id": o["id"], "method": b.get("method", "upi"),
         "captured": True, "amount_refunded": 0, "refund_status": None, "email": "", "contact": "", "created_at": int(time.time())}
    PAYMENTS[pid] = p
    o["status"], o["amount_paid"], o["amount_due"], o["attempts"] = "paid", o["amount"], 0, o["attempts"] + 1
    signature = hmac.new(KEY_SECRET.encode(), f"{o['id']}|{pid}".encode(), hashlib.sha256).hexdigest()
    await _webhook("payment.captured", {"payment": {"entity": p}})
    await _webhook("order.paid", {"order": {"entity": o}, "payment": {"entity": p}})
    return {"razorpay_order_id": o["id"], "razorpay_payment_id": pid, "razorpay_signature": signature}


@app.get("/sim/events")
async def events() -> dict:
    return {"events": EVENTS[-50:]}


CHECKOUT_JS = """
(function(){
  var BASE = %(base)s;
  function Razorpay(opts){ this.opts = opts; this.handlers = {}; }
  Razorpay.prototype.on = function(ev, cb){ this.handlers[ev] = cb; };
  Razorpay.prototype.open = function(){
    var self = this, o = this.opts;
    var wrap = document.createElement('div');
    wrap.setAttribute('role','dialog'); wrap.setAttribute('aria-label','Razorpay test payment');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:99999;font-family:system-ui,sans-serif';
    var amt = (o.amount/100).toLocaleString('en-IN',{style:'currency',currency:'INR'});
    wrap.innerHTML = '<div style="background:#fff;border-radius:14px;padding:22px;width:320px;box-shadow:0 20px 60px rgba(0,0,0,.3)">'+
      '<p style="margin:0;font-size:12px;color:#b45309;font-weight:700">TEST MODE · SIMULATOR</p>'+
      '<p style="margin:6px 0 2px;font-weight:700;font-size:18px">'+(o.name||'')+'</p>'+
      '<p style="margin:0 0 14px;color:#555">'+(o.description||'')+' · <b>'+amt+'</b></p>'+
      '<button data-x="ok" style="width:100%%;padding:12px;border:0;border-radius:10px;background:#0B5563;color:#fff;font-weight:700;font-size:15px;cursor:pointer">Pay '+amt+' (succeeds)</button>'+
      '<button data-x="fail" style="width:100%%;margin-top:8px;padding:10px;border:1px solid #ddd;border-radius:10px;background:#fff;cursor:pointer">Simulate a failed payment</button>'+
      '<button data-x="close" style="width:100%%;margin-top:8px;padding:8px;border:0;background:none;color:#666;cursor:pointer">Close</button></div>';
    document.body.appendChild(wrap);
    function done(){ wrap.remove(); }
    wrap.addEventListener('click', function(e){
      var x = e.target && e.target.getAttribute && e.target.getAttribute('data-x'); if(!x) return;
      if(x==='close'){ done(); o.modal && o.modal.ondismiss && o.modal.ondismiss(); return; }
      fetch(BASE + '/sim/pay', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({order_id:o.order_id, outcome: x==='ok'?'success':'fail'})})
        .then(function(r){return r.json();}).then(function(r){
          if(r.error){ self.handlers['payment.failed'] && self.handlers['payment.failed']({error:r.error}); wrap.querySelector('p').textContent = 'PAYMENT FAILED (SIMULATED) · TRY AGAIN'; return; }
          done(); o.handler && o.handler(r);
        });
    });
  };
  window.Razorpay = Razorpay;
})();
"""


@app.get("/v1/checkout.js")
async def checkout_js() -> Response:
    return Response(CHECKOUT_JS % {"base": json.dumps(PUBLIC)}, media_type="application/javascript")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "orders": len(ORDERS), "payments": len(PAYMENTS), "refunds": len(REFUNDS)}
