"""Validation parity: every POST/PUT/PATCH whose JSON body has required fields in the reference, called on both APIs
with an empty body by a role allowed to use it; compares status, error code, message and fields.
The reference refuses these before its handler runs, so its data is not changed.
python -I body_diff.py <python base> <dotnet base> <body-required.json> <route-guards.json> <admin pw file> <out.txt>"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

PY, NET, REQ, GUARDS, PWFILE, OUT = sys.argv[1:7]
ACCOUNTS = {"seller": "9000000001", "partner": "7300000001", "customer": "9999900001"}


def call(base, method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode()


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
        s, b = call(base, "POST", "/api/auth/login", body={"email": "admin@pixcart.in", "password": pw, "totp": ""})
    else:
        purpose = "any" if role == "partner" else "signin"
        code = None
        for _ in range(8):
            s, b = call(base, "POST", "/api/auth/otp/request", body={"phone": ACCOUNTS[role], "purpose": purpose})
            try:
                code = json.loads(b or b"{}").get("dev_otp")
            except ValueError:
                code = None
            if code:
                break
            time.sleep(35)
        s, b = call(base, "POST", "/api/auth/otp/verify", body={"phone": ACCOUNTS[role], "code": code, "purpose": purpose, "accept_terms": True})
    if s != 200:
        raise SystemExit(f"{role} sign-in failed on {base}: {s} {b[:200]!r}")
    return json.loads(b)["access_token"]


def role_for(guard):
    if guard.startswith("perm:") or guard == "admin":
        return "admin"
    if guard in ("seller", "approved_seller"):
        return "seller"
    if guard.startswith("partner:"):
        return "partner"
    if guard in ("signed_in", "optional"):
        return "customer"
    return "guest"


guards = {(g["method"], g["path"]): g["guard"] for g in json.load(open(GUARDS))}
rows = json.load(open(REQ))
tokens = {}
same, diffs = 0, []
for r in rows:
    role = role_for(guards.get((r["method"], r["path"]), "public"))
    if role not in tokens:
        tokens[role] = (login(PY, role), login(NET, role))
    path = re.sub(r"\{([^}]+)\}", lambda m: str(uuid.uuid4()) if m.group(1).endswith("id") else "x", r["path"])
    a = call(PY, r["method"], path, tokens[role][0], {})
    b = call(NET, r["method"], path, tokens[role][1], {})

    def norm(res):
        try:
            e = json.loads(res[1] or b"null")
        except ValueError:
            return (res[0], res[1][:80])
        e = (e or {}).get("error", e) if isinstance(e, dict) else e
        return (res[0], e.get("code") if isinstance(e, dict) else None, e.get("message") if isinstance(e, dict) else None,
                json.dumps(e.get("fields"), sort_keys=False) if isinstance(e, dict) else None)

    na, nb = norm(a), norm(b)
    if na == nb:
        same += 1
    else:
        diffs.append(f"[{role}] {r['method']} {r['path']}\n    py : {na}\n    net: {nb}")
with open(OUT, "w", encoding="utf-8") as f:
    f.write(f"same {same}, different {len(diffs)}\n\n" + "\n".join(diffs))
print(f"same {same}, different {len(diffs)} -> {OUT}")
