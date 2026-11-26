"""Online-payment parity: Razorpay flows on the reference (Python) and the .NET API, step by step, compared.

  A. pay now:        online order -> Razorpay order -> UPI payment captured (+ webhooks) -> verify -> payment status
                     -> return from the UPI app (callback) -> order page
  B. payment fails:  online order -> failed payment (+ webhook) -> payment status -> callback with the error -> cancel
  C. pay later:      online order -> UPI request approved a few seconds later -> status "waiting" -> webhook -> "paid"

Both APIs talk to the same local Razorpay simulator (http://127.0.0.1:8790). The simulator delivers its webhooks only
to the reference API (its configured address), so this script delivers the same signed events to the .NET API itself.
Run DataMigrator just before, so both start from the same data.
  python -I payment_scenario.py <python base> <dotnet base> <out.txt>
"""
import base64
import hashlib
import hmac
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

PY, NET, OUT = sys.argv[1:4]
SIM = "http://127.0.0.1:8790"
SIM_AUTH = "Basic " + base64.b64encode(b"rzp_test_sim:sim_secret").decode()
WEBHOOK_SECRET = b"sim_whsec"
VARIANT = "e94ab24f-047c-4cbc-ab5e-5747a7c08bb1"  # copper water bottle (Mumbai Home Store)
PHONE = "9" + str(random.randint(100000000, 999999999))
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
NUMBER_KEYS = {"number", "order_number", "sub_number", "return_number", "invoice_number", "fee_invoice_number", "idempotency_key",
               "access_token", "dev_otp", "token", "expires_at", "razorpay_order_id", "razorpay_payment_id", "reference", "provider_payment_id"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def call(base, method, path, token=None, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with OPENER.open(req, timeout=90) as r:
            text = r.read()
            return r.status, (json.loads(text) if text and "json" in r.headers.get("Content-Type", "") else {"location": r.headers.get("Location")})
    except urllib.error.HTTPError as e:
        text = e.read()
        if e.code in (301, 302, 303, 307):
            return e.code, {"location": e.headers.get("Location")}
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text[:200].decode(errors="replace")


def sim(method, path, body=None):
    req = urllib.request.Request(SIM + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", SIM_AUTH)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def deliver_webhook(base, event, payload):
    """The simulator's webhook, delivered to an API (used for the .NET API; the simulator itself serves the reference)."""
    body = json.dumps({"entity": "event", "event": event, "contains": list(payload), "payload": payload, "created_at": int(time.time())}).encode()
    sig = hmac.new(WEBHOOK_SECRET, body, hashlib.sha256).hexdigest()
    return call(base, "POST", "/api/payments/razorpay/webhook", raw=body,
                headers={"x-razorpay-signature": sig, "x-razorpay-event-id": "evt_" + uuid.uuid4().hex[:14]})


def normalise(node, ids):
    if isinstance(node, dict):
        return {(ids.setdefault(k, f"<id{len(ids) + 1}>") if UUID.match(k) else k):
                ("<number>" if k in NUMBER_KEYS and node[k] not in (None, "") else normalise(v, ids)) for k, v in node.items()}
    if isinstance(node, list):
        return [normalise(x, ids) for x in node]
    if isinstance(node, str):
        if UUID.match(node):
            return ids.setdefault(node, f"<id{len(ids) + 1}>")
        if TIME.match(node):
            return "<time>"
        node = re.sub(r"\bPC\d{6}[A-Z0-9]{6}(-\d+)?\b", "<order>", node)
        node = re.sub(r"\b(order|pay)_[A-Za-z0-9]{6,}\b", r"<\1>", node)
        node = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", lambda m: ids.setdefault(m.group(0), f"<id{len(ids) + 1}>"), node)
    return node


def diff(a, b, path="$", out=None, limit=10):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in list(dict.fromkeys(list(a) + list(b))):
            if k not in a:
                out.append(f"{path}.{k}: only in .NET = {json.dumps(b[k])[:80]}")
            elif k not in b:
                out.append(f"{path}.{k}: missing in .NET (python = {json.dumps(a[k])[:80]})")
            else:
                diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out, limit)
    elif a != b and not (isinstance(a, (int, float)) and isinstance(b, (int, float)) and float(a) == float(b)):
        out.append(f"{path}: {json.dumps(a)[:90]} vs {json.dumps(b)[:90]}")
    return out


report, counts = [], {"same": 0, "different": 0}
state = {PY: {"ids": {}}, NET: {"ids": {}}}


def step(name, fn):
    res = {}
    for base in (PY, NET):
        try:
            res[base] = fn(base, state[base])
        except Exception as e:  # noqa: BLE001
            res[base] = ("error", f"{type(e).__name__}: {e}")
    (sa, ja), (sb, jb) = res[PY], res[NET]
    problems = ([f"status {sa} vs {sb}"] if sa != sb else []) + diff(normalise(ja, state[PY]["ids"]), normalise(jb, state[NET]["ids"]))
    counts["different" if problems else "same"] += 1
    if problems:
        report.append(f"[{name}]\n    " + "\n    ".join(problems))
    print(f"{'same' if not problems else 'DIFF'}  {name}  ({sa} / {sb})", flush=True)


def signup(base, s):
    code = call(base, "POST", "/api/auth/otp/request", body={"phone": PHONE})[1].get("dev_otp")
    st, b = call(base, "POST", "/api/auth/otp/verify", body={"phone": PHONE, "code": code, "name": "Online Shopper", "accept_terms": True})
    s["c"] = b.get("access_token") if isinstance(b, dict) else None
    return st, {"user": b.get("user") if isinstance(b, dict) else b}


def address(base, s):
    st, b = call(base, "POST", "/api/addresses", s["c"], {"full_name": "Online Shopper", "phone": PHONE, "line1": "4 Linking Road",
                                                         "city": "Mumbai", "state_code": "27", "pincode": "400050", "is_default": True})
    s["addr"] = b.get("id") if isinstance(b, dict) else None
    return st, b


def place_online(tag):
    def run(base, s):
        call(base, "POST", "/api/cart/items", s["c"], {"variant_id": VARIANT, "qty": 1})
        st, b = call(base, "POST", "/api/orders", s["c"], {"address_id": s["addr"], "payment_method": "online", "idempotency_key": f"pay-{tag}-" + uuid.uuid4().hex[:12]})
        s[tag] = {"order": (b.get("order") or {}).get("id"), "rzp": (b.get("payment") or {}).get("razorpay_order_id")} if isinstance(b, dict) else {}
        return st, b
    return run


def pay(tag, outcome):
    """The shopper pays in the (simulated) Razorpay window; the .NET API gets the same webhooks the simulator sends."""
    def run(base, s):
        o = s[tag]
        r = sim("POST", "/sim/pay", {"order_id": o["rzp"], "method": "upi", **({"outcome": outcome} if outcome else {})})
        o["pay"] = r
        if base == NET:
            if outcome is None:
                p = sim("GET", f"/v1/payments/{r['razorpay_payment_id']}")
                order = next((x for x in sim("GET", "/v1/orders?count=200").get("items", []) if x["id"] == o["rzp"]), None)
                deliver_webhook(NET, "payment.captured", {"payment": {"entity": p}})
                if order:
                    deliver_webhook(NET, "order.paid", {"order": {"entity": order}, "payment": {"entity": p}})
            elif outcome == "fail":
                pid = r["error"]["metadata"]["payment_id"]
                deliver_webhook(NET, "payment.failed", {"payment": {"entity": sim("GET", f"/v1/payments/{pid}")}})
        return 200, {"simulated": outcome or "captured"}
    return run


def verify(tag):
    def run(base, s):
        p = s[tag]["pay"]
        return call(base, "POST", "/api/payments/razorpay/verify", s["c"], {k: p[k] for k in ("razorpay_order_id", "razorpay_payment_id", "razorpay_signature")})
    return run


def status(tag):
    return lambda base, s: call(base, "POST", f"/api/orders/{s[tag]['order']}/payment-status", s["c"], {})


def callback_success(tag):
    def run(base, s):
        p = s[tag]["pay"]
        q = "&".join(f"{k}={p[k]}" for k in ("razorpay_order_id", "razorpay_payment_id", "razorpay_signature"))
        return call(base, "GET", f"/api/payments/razorpay/callback?{q}")
    return run


def callback_failure(tag):
    def run(base, s):
        meta = json.dumps(s[tag]["pay"]["error"]["metadata"])
        form = urllib.parse.urlencode({"error[code]": "BAD_REQUEST_ERROR", "error[description]": "Payment failed (simulated)",
                                       "error[source]": "customer", "error[metadata]": meta}).encode()
        return call(base, "POST", "/api/payments/razorpay/callback", raw=form, headers={"Content-Type": "application/x-www-form-urlencoded"})
    return run


def pay_later(tag):
    """The shopper approves in the UPI app a few seconds later (the simulator approves after 3 s)."""
    def run(base, s):
        r = sim("POST", "/sim/pay", {"order_id": s[tag]["rzp"], "outcome": "later", "after": 3})
        s[tag]["pay"] = {"payment_id": r.get("payment_id")}
        return 200, {"pending": bool(r.get("pending"))}
    return run


def approve_later_webhook(tag):
    def run(base, s):
        time.sleep(6)  # the simulated UPI app approves after 3 s; the simulator has told the reference by now
        if base == NET:
            pid = s[tag]["pay"]["payment_id"]
            p = sim("GET", f"/v1/payments/{pid}")
            if p.get("status") == "captured":
                deliver_webhook(NET, "payment.captured", {"payment": {"entity": p}})
        return 200, {"waited": True}
    return run


import urllib.parse  # noqa: E402

step("shopper signs up", signup)
step("adds an address", address)
step("A: places an online order", place_online("a"))
step("A: pays by UPI (captured)", pay("a", None))
step("A: payment window verifies", verify("a"))
step("A: payment status", status("a"))
step("A: return from the UPI app", callback_success("a"))
step("A: order page", lambda base, s: call(base, "GET", f"/api/orders/{s['a']['order']}", s["c"]))
step("B: places an online order", place_online("b"))
step("B: payment fails", pay("b", "fail"))
step("B: payment status", status("b"))
step("B: return with the error", callback_failure("b"))
step("B: shopper cancels the unpaid order", lambda base, s: call(base, "POST", f"/api/orders/{s['b']['order']}/cancel", s["c"], {"reason": "Changed my mind"}))
step("C: places an online order", place_online("later"))
step("C: UPI request sent, approved later", pay_later("later"))
step("C: status while the UPI app is open", status("later"))
step("C: the UPI app approves", approve_later_webhook("later"))
step("C: status after approval", status("later"))
step("C: order page", lambda base, s: call(base, "GET", f"/api/orders/{s['later']['order']}", s["c"]))
step("shopper's order list", lambda base, s: call(base, "GET", "/api/orders", s["c"]))

with open(OUT, "w", encoding="utf-8") as f:
    f.write(f"shopper {PHONE}: same {counts['same']}, different {counts['different']}\n\n" + "\n".join(report))
print(f"same {counts['same']}, different {counts['different']} -> {OUT}")
