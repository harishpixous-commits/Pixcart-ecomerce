"""Write-flow parity: the full cash-on-delivery order journey through the API, step by step, on the reference (Python)
and on the .NET API (same data: run DataMigrator just before), comparing every response.

  customer signs up -> address -> cart -> quote -> COD order -> order page
  seller (Mumbai Home Store) confirms -> packs -> ships -> delivers
  customer asks for a return -> seller approves -> receives (sellable) -> admin records the UPI refund -> order page

Generated values (ids, order/sub/return/invoice numbers, times, tokens) are normalised; everything else must be equal.
  python -I scenario_diff.py <python base> <dotnet base> <admin password file> <out.txt>
"""
import json
import random
import re
import sys
import urllib.error
import urllib.request
import uuid

PY, NET, PWFILE, OUT = sys.argv[1:5]
SELLER_PHONE = "9000000003"  # Mumbai Home Store: not used by the page agents
VARIANT = "e94ab24f-047c-4cbc-ab5e-5747a7c08bb1"  # copper water bottle, Rs 599
PHONE = "9" + str(random.randint(100000000, 999999999))  # a new shopper (separate databases: the same number on both)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")
NUMBER_KEYS = {"number", "order_number", "sub_number", "return_number", "invoice_number", "fee_invoice_number",
               "credit_note_number", "idempotency_key", "access_token", "refresh_token", "dev_otp", "token", "expires_at"}
VOLATILE = {"generated_at", "now", "server_time", "elapsed_ms", "request_id"}


def call(base, method, path, token=None, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw and r.headers.get("Content-Type", "").startswith("application/json") else raw[:100].decode(errors="replace")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:200].decode(errors="replace")


def normalise(node, ids):
    if isinstance(node, dict):
        return {(ids.setdefault(k, f"<id{len(ids) + 1}>") if UUID.match(k) else k):
                ("<number>" if k in NUMBER_KEYS and node[k] not in (None, "") else normalise(v, ids))
                for k, v in node.items() if k not in VOLATILE}
    if isinstance(node, list):
        return [normalise(x, ids) for x in node]
    if isinstance(node, str):
        if UUID.match(node):
            return ids.setdefault(node, f"<id{len(ids) + 1}>")
        if TIME.match(node):
            return "<time>"
        node = re.sub(r"\bPC\d{6}[A-Z0-9]{6}(-\d+)?\b", "<order>", node)
        node = re.sub(r"\bRT\d{6}[A-Z0-9]{6}\b", "<return>", node)
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


report, same, different = [], 0, 0
state = {PY: {"ids": {}}, NET: {"ids": {}}}


def step(name, fn):
    """Runs one step on both APIs; fn(base, s) returns (status, json) and may store values in s."""
    global same, different
    results = {}
    for base in (PY, NET):
        s = state[base]
        try:
            results[base] = fn(base, s)
        except Exception as e:  # noqa: BLE001 - a crash in a step is a finding, not a stop
            results[base] = ("error", f"{type(e).__name__}: {e}")
    (sa, ja), (sb, jb) = results[PY], results[NET]
    na, nb = normalise(ja, state[PY]["ids"]), normalise(jb, state[NET]["ids"])
    problems = ([f"status {sa} vs {sb}"] if sa != sb else []) + diff(na, nb)
    if problems:
        different += 1
        report.append(f"[{name}]\n    " + "\n    ".join(problems))
    else:
        same += 1
    print(f"{'same' if not problems else 'DIFF'}  {name}  ({sa} / {sb})", flush=True)
    return results


def otp_token(base, phone, extra):
    s, b = call(base, "POST", "/api/auth/otp/request", body={"phone": phone, **({"purpose": extra.get("purpose")} if extra.get("purpose") else {})})
    code = b.get("dev_otp") if isinstance(b, dict) else None
    return call(base, "POST", "/api/auth/otp/verify", body={"phone": phone, "code": code, **extra})


def signup(base, s):
    st, b = otp_token(base, PHONE, {"name": "Scenario Shopper", "accept_terms": True})
    s["c"] = b.get("access_token") if isinstance(b, dict) else None
    return st, b


def seller_signin(base, s):
    st, b = otp_token(base, SELLER_PHONE, {"purpose": "signin", "accept_terms": True})
    s["s"] = b.get("access_token") if isinstance(b, dict) else None
    return st, {k: v for k, v in (b or {}).items() if k != "user"} if isinstance(b, dict) else b


def admin_signin(base, s):
    st, b = call(base, "POST", "/api/auth/login", body={"email": "admin@pixcart.in", "password": open(PWFILE, encoding="utf-8").read().strip(), "totp": ""})
    s["a"] = b.get("access_token") if isinstance(b, dict) else None
    return st, {"ok": st == 200}


def add_address(base, s):
    st, b = call(base, "POST", "/api/addresses", s["c"], {"full_name": "Scenario Shopper", "phone": PHONE, "line1": "12 Marine Drive",
                                                         "city": "Mumbai", "state_code": "27", "pincode": "400001", "kind": "home", "is_default": True})
    s["addr"] = b.get("id") if isinstance(b, dict) else None
    return st, b


def place(base, s):
    st, b = call(base, "POST", "/api/orders", s["c"], {"address_id": s["addr"], "payment_method": "cod", "idempotency_key": "scen-" + uuid.uuid4().hex[:16]})
    order = b.get("order", b) if isinstance(b, dict) else {}
    s["order"] = order.get("id")
    subs = order.get("sub_orders") or []
    s["sub"] = subs[0]["id"] if subs else None
    return st, b


def create_return(base, s):
    # the line-item id comes from "what can be returned", as on the order page
    returnable = call(base, "GET", f"/api/orders/{s['order']}/returnable", s["c"])[1]
    lines = (returnable.get("items") or {}).get(s["sub"]) or [] if isinstance(returnable, dict) else []
    s["item"] = lines[0]["order_item_id"] if lines else None
    reasons = call(base, "GET", "/api/returns/reasons")[1]
    code = next((r["code"] for r in reasons.get("reasons", []) if not r.get("defect")), "changed_mind") if isinstance(reasons, dict) else "changed_mind"
    st, b = call(base, "POST", "/api/returns", s["c"], {"sub_order_id": s["sub"], "items": [{"order_item_id": s["item"], "qty": 1}],
                                                       "reason": code, "comment": "Scenario return", "refund_upi": "shopper@okaxis"})
    s["ret"] = b.get("id") if isinstance(b, dict) else None
    return st, b


# make sure the order and item ids are known even when the order answer nests them differently
def order_page(base, s):
    return call(base, "GET", f"/api/orders/{s['order']}", s["c"])


step("customer signs up (OTP)", signup)
step("adds an address", add_address)
step("adds 2 bottles to the cart", lambda base, s: call(base, "POST", "/api/cart/items", s["c"], {"variant_id": VARIANT, "qty": 2}))
step("cart", lambda base, s: call(base, "GET", "/api/cart", s["c"]))
step("checkout quote (COD)", lambda base, s: call(base, "POST", "/api/checkout/quote", s["c"], {"address_id": s["addr"], "payment_method": "cod"}))
step("places the COD order", place)
step("order page after placing", order_page)
step("seller signs in", seller_signin)
step("seller opens the package", lambda base, s: call(base, "GET", f"/api/seller/orders/{s['sub']}", s["s"]))
step("seller confirms", lambda base, s: call(base, "POST", f"/api/seller/orders/{s['sub']}/confirm", s["s"], {}))
step("seller packs", lambda base, s: call(base, "POST", f"/api/seller/orders/{s['sub']}/pack", s["s"], {}))
step("seller ships (courier)", lambda base, s: call(base, "POST", f"/api/seller/orders/{s['sub']}/ship", s["s"],
                                                    {"courier_name": "Delhivery", "tracking_number": "AWB1234567"}))
step("seller marks delivered", lambda base, s: call(base, "POST", f"/api/seller/orders/{s['sub']}/deliver", s["s"], {}))
step("order page after delivery", order_page)
step("what can be returned", lambda base, s: call(base, "GET", f"/api/orders/{s['order']}/returnable", s["c"]))
step("customer asks for a return", create_return)
step("seller approves the return", lambda base, s: call(base, "POST", f"/api/seller/returns/{s['ret']}", s["s"], {"action": "approve"}))
step("seller receives it (sellable)", lambda base, s: call(base, "POST", f"/api/seller/returns/{s['ret']}", s["s"],
                                                           {"action": "received", "items": [{"order_item_id": s["item"], "condition": "sellable"}]}))
step("admin signs in", admin_signin)
step("admin records the UPI refund", lambda base, s: call(base, "POST", f"/api/admin/returns/{s['ret']}", s["a"],
                                                          {"action": "mark_refunded", "reference": "UTR987654321"}))
step("order page at the end", order_page)
step("customer's order list", lambda base, s: call(base, "GET", "/api/orders", s["c"]))
step("customer's notifications", lambda base, s: call(base, "GET", "/api/notifications", s["c"]))

with open(OUT, "w", encoding="utf-8") as f:
    f.write(f"shopper {PHONE}: same {same}, different {different}\n\n" + "\n".join(report))
print(f"same {same}, different {different} -> {OUT}")
