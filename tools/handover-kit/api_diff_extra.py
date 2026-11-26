"""The GET routes api_diff.py cannot reach by following list pages: their ids come from the copied database (the same
ids as the reference's, after DataMigrator). Compares status and JSON (files: status, type and size).
  python -I api_diff_extra.py <python base> <dotnet base> <admin password file> <out.txt>
"""
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

PY, NET, PWFILE, OUT = sys.argv[1:5]
MYSQL = r"C:\Users\haris\pixcart-tools\mysql\bin\mysql.exe"
ACCOUNTS = {"seller": "9000000003", "partner": "7300000003", "customer": "9999900001"}


def sql(query):
    out = subprocess.run([MYSQL, "--host=127.0.0.1", "--port=3307", "--user=root", "--password=pixcart", "-N", "-B", "pixcart_parity", "-e", query],
                         capture_output=True, text=True)
    return [line.split("\t") for line in out.stdout.splitlines() if line.strip()]


def call(base, path, token=None):
    req = urllib.request.Request(base + path)
    req.add_header("X-Requested-With", "pixcart")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


def post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def login(base, role):
    if role == "admin":
        return post(base, "/api/auth/login", {"email": "admin@pixcart.in", "password": open(PWFILE, encoding="utf-8").read().strip(), "totp": ""})[1].get("access_token")
    purpose = "any" if role == "partner" else "signin"
    for _ in range(8):
        code = post(base, "/api/auth/otp/request", {"phone": ACCOUNTS[role], "purpose": purpose})[1].get("dev_otp")
        if code:
            return post(base, "/api/auth/otp/verify", {"phone": ACCOUNTS[role], "code": code, "purpose": purpose, "accept_terms": True})[1].get("access_token")
        time.sleep(35)
    return None


VOLATILE = {"generated_at", "now", "server_time", "elapsed_ms", "took_ms", "request_id"}


def diff(a, b, path="$", out=None, limit=8):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in VOLATILE:
                continue
            if k not in a:
                out.append(f"{path}.{k}: only in .NET")
            elif k not in b:
                out.append(f"{path}.{k}: missing in .NET")
            else:
                diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: {len(a)} items vs {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, f"{path}[{i}]", out, limit)
    elif a != b and not (isinstance(a, (int, float)) and isinstance(b, (int, float)) and float(a) == float(b)):
        out.append(f"{path}: {json.dumps(a)[:80]} vs {json.dumps(b)[:80]}")
    return out



C, S, P = ACCOUNTS["customer"], ACCOUNTS["seller"], ACCOUNTS["partner"]
first = lambda q: (sql(q) or [[None]])[0]  # noqa: E731
ROUTES = [
    ("customer", "/api/catalog/stores/{}", first("SELECT slug FROM sellers WHERE status='approved' ORDER BY slug LIMIT 1")),
    ("customer", "/api/pages/{}", first("SELECT slug FROM cms_pages WHERE is_published=1 ORDER BY slug LIMIT 1")),
    ("customer", "/api/support/tickets/{}", first(f"SELECT t.id FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE u.phone='{C}' LIMIT 1")),
    ("customer", "/api/shop-assistant/sessions/{}", first(f"SELECT s.id FROM shop_chat_sessions s JOIN users u ON u.id=s.user_id WHERE u.phone='{C}' LIMIT 1")),
    ("customer", "/api/orders/{}/delivery-proof/{}", first(f"SELECT a.order_id, a.sub_order_id FROM delivery_assignments a JOIN orders o ON o.id=a.order_id JOIN users u ON u.id=o.user_id WHERE u.phone='{C}' AND a.status='delivered' AND a.proof_photo<>'' LIMIT 1")),
    ("seller", "/api/seller/documents/{}", first(f"SELECT d.kind FROM seller_documents d JOIN sellers s ON s.id=d.seller_id JOIN users u ON u.id=s.user_id WHERE u.phone='{S}' LIMIT 1")),
    ("partner", "/api/delivery/trips/{}", first(f"SELECT a.id FROM delivery_assignments a JOIN delivery_boys b ON b.id=a.delivery_boy_id JOIN users u ON u.id=b.user_id WHERE u.phone='{P}' ORDER BY a.assigned_at DESC LIMIT 1")),
    ("admin", "/api/admin/ai/briefs/order/{}", first("SELECT id FROM orders ORDER BY created_at DESC LIMIT 1")),
    ("admin", "/api/admin/ai/briefs/seller/{}", first("SELECT id FROM sellers WHERE status='approved' ORDER BY created_at LIMIT 1")),
    ("admin", "/api/admin/delivery/packages/{}/candidates", first("SELECT id FROM sub_orders WHERE status IN ('placed','confirmed','packed') ORDER BY created_at DESC LIMIT 1")),
    ("admin", "/api/admin/delivery/returns/{}/candidates", first("SELECT id FROM return_requests ORDER BY created_at DESC LIMIT 1")),
    ("admin", "/api/admin/products/{}", first("SELECT id FROM products ORDER BY created_at LIMIT 1")),
    ("admin", "/api/admin/sellers/{}/documents/{}", first("SELECT seller_id, kind FROM seller_documents ORDER BY uploaded_at LIMIT 1")),
    ("admin", "/api/admin/shop-assistant/chats/{}", first("SELECT id FROM shop_chat_sessions ORDER BY created_at DESC LIMIT 1")),
    ("admin", "/api/admin/tickets/{}", first("SELECT id FROM support_tickets ORDER BY created_at DESC LIMIT 1")),
]

tokens, report, same, different, skipped = {}, [], 0, 0, []
for role, template, values in ROUTES:
    if not values or values[0] is None:
        skipped.append(f"[{role}] {template}: no such record in the demo data")
        continue
    path = template.format(*values)
    if role not in tokens:
        tokens[role] = (login(PY, role), login(NET, role))
    a, b = call(PY, path, tokens[role][0]), call(NET, path, tokens[role][1])
    problems = []
    if a[0] != b[0]:
        problems.append(f"status {a[0]} vs {b[0]}: {b[2][:160]!r}")
    elif "json" in a[1]:
        problems += diff(json.loads(a[2] or b"null"), json.loads(b[2] or b"null"))
    else:
        if a[1].split(";")[0] != b[1].split(";")[0]:
            problems.append(f"content type {a[1]} vs {b[1]}")
        if hashlib.sha256(a[2]).hexdigest() != hashlib.sha256(b[2]).hexdigest():
            problems.append(f"file differs: {len(a[2])} bytes vs {len(b[2])} bytes")
    if problems:
        different += 1
        report.append(f"[{role}] GET {path}\n    " + "\n    ".join(problems))
    else:
        same += 1
    print(f"{'same' if not problems else 'DIFF'}  [{role}] {template}  ({a[0]} / {b[0]})", flush=True)
with open(OUT, "w", encoding="utf-8") as f:
    f.write(f"same {same}, different {different}, skipped {len(skipped)}\n\n" + "\n".join(report) + "\n\n" + "\n".join(skipped))
print(f"same {same}, different {different}, skipped {len(skipped)} -> {OUT}")
