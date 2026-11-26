"""Differential read check: every GET route of the reference, called on the Python API and the .NET API (same data),
as guest, customer, seller, partner and admin; compares status codes and JSON bodies.
python -I api_diff.py <python base> <dotnet base> <route-guards.json> <admin password file> <out.txt> [roles]"""
import json
import time
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

PY, NET, GUARDS, PWFILE, OUT = sys.argv[1:6]
ROLES = (sys.argv[6] if len(sys.argv) > 6 else "guest,customer,seller,partner,admin").split(",")
ACCOUNTS = {"seller": "9000000003", "partner": "7300000003", "customer": "9999900001"}  # demo accounts the page agents do not use
VOLATILE = {"generated_at", "now", "server_time", "elapsed_ms", "took_ms", "request_id"}
SKIP = re.compile(r"/stream|/events$|/sse|/download|\.pdf$|\.csv$|\.xlsx$|/zip|/export|/invoice|/label|/media/|/proof$|/app/apk|/docs/")


def call(base, method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type", "")
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode(), ""


_TOKEN_CACHE = __import__("os").path.join(__import__("os").path.dirname(__import__("os").path.abspath(__file__)), "token-cache.json")


def login(base, role):
    """A cached token (10 minutes) when there is one: the demo accounts are shared and sign-ins are rate-limited."""
    try:
        cache = json.load(open(_TOKEN_CACHE))
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(f"{base}|{role}")
    if hit and time.time() - hit[1] < 600:
        return hit[0]
    tok = _login(base, role)
    cache[f"{base}|{role}"] = [tok, time.time()]
    json.dump(cache, open(_TOKEN_CACHE, "w"))
    return tok


def _login(base, role):
    if role == "guest":
        return None
    if role == "admin":
        pw = open(PWFILE, encoding="utf-8").read().strip()
        s, b, _ = call(base, "POST", "/api/auth/login", body={"email": "admin@pixcart.in", "password": pw, "totp": ""})
    else:
        purpose = "any" if role == "partner" else "signin"
        code = None
        for _ in range(8):  # the resend cooldown is shared with other people signing in as the same demo account
            s, b, _ = call(base, "POST", "/api/auth/otp/request", body={"phone": ACCOUNTS[role], "purpose": purpose})
            try:
                code = (json.loads(b or b"{}") or {}).get("dev_otp")
            except ValueError:
                code = None
            if code:
                break
            time.sleep(35)
        s, b, _ = call(base, "POST", "/api/auth/otp/verify", body={"phone": ACCOUNTS[role], "code": code, "purpose": purpose, "accept_terms": True})
    if s != 200:
        raise SystemExit(f"{role} sign-in failed on {base}: {s} {b[:200]!r}")
    return json.loads(b)["access_token"]


def items_of(j):
    if isinstance(j, list):
        return j
    if isinstance(j, dict):
        for k in ("items", "results", "rows", "data", "orders", "products", "list"):
            if isinstance(j.get(k), list):
                return j[k]
        for v in j.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
    return []


def find_key(j, key, depth=0):
    if depth > 6:
        return None
    if isinstance(j, dict):
        if key in j and isinstance(j[key], (str, int)) and j[key] != "":
            return j[key]
        for v in j.values():
            r = find_key(v, key, depth + 1)
            if r is not None:
                return r
    elif isinstance(j, list):
        for v in j[:20]:
            r = find_key(v, key, depth + 1)
            if r is not None:
                return r
    return None


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


rows = [r for r in json.load(open(GUARDS)) if r["method"] == "GET" and not SKIP.search(r["path"])]
report, totals, skipped_routes = [], {}, {}
for role in ROLES:
    tok = {PY: login(PY, role), NET: login(NET, role)}
    cache = {}
    same = differ = skipped = 0
    for r in rows:
        path = r["path"]
        params = re.findall(r"\{([^}]+)\}", path)
        filled = path
        if params:
            ok = True
            for p in params:
                parent = filled[: filled.index("{" + p + "}")].rstrip("/")
                if parent not in cache:
                    s, b, ct = call(PY, "GET", parent, tok[PY])
                    cache[parent] = json.loads(b) if s == 200 and "json" in ct else None
                src = cache[parent]
                key = "slug" if "slug" in p else ("id" if p.endswith("id") else p)
                lst = items_of(src)
                val = None
                if lst and isinstance(lst[0], dict):
                    val = lst[0].get(p) or lst[0].get(key) or lst[0].get("id")
                if val is None and src is not None:
                    val = find_key(src, p) or find_key(src, key)
                if val is None:
                    ok = False
                    break
                filled = filled.replace("{" + p + "}", urllib.parse.quote(str(val), safe=""), 1)
            if not ok:
                skipped += 1; skipped_routes.setdefault(role, []).append(path)
                continue
        a = call(PY, "GET", filled, tok[PY])
        b = call(NET, "GET", filled, tok[NET])
        if a[0] in (401, 403) and b[0] in (401, 403) and role != "admin" and a[0] == b[0]:
            same += 1
            continue
        problems = []
        if a[0] != b[0]:
            problems.append(f"status {a[0]} vs {b[0]}  net body: {b[1][:160]!r}")
        elif "json" in a[2]:
            try:
                ja, jb = json.loads(a[1] or b"null"), json.loads(b[1] or b"null")
                problems += diff(ja, jb)
            except ValueError as e:
                problems.append(f"bad JSON: {e}")
        if problems:
            differ += 1
            report.append(f"[{role}] GET {filled}\n    " + "\n    ".join(problems))
        else:
            same += 1
    totals[role] = (same, differ, skipped)
    print(f"[{role}] same {same}  different {differ}  skipped (no id found) {skipped}", flush=True)

with open(OUT, "w", encoding="utf-8") as f:
    f.write("\n".join(f"{k}: same {v[0]}, different {v[1]}, skipped {v[2]}" for k, v in totals.items()) + "\n\n")
    f.write("\n".join(report))
    f.write("\n\nSKIPPED (no id found)\n" + "\n".join(f"[{r}] {p}" for r, ps in skipped_routes.items() for p in ps))
print("details:", OUT)
