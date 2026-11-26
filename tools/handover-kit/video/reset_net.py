"""Before each recording of the Angular + .NET version (demo database only), the same clean-up as reset.py does for the
Python version: cancel open orders left by earlier takes (so no stray delivery request pops up), let demo partners hold
more cash, and allow more sign-in codes for the many takes from one computer.

    python reset_net.py            (env: BASE = the site with /api, e.g. http://localhost:5180; ADMIN_PW;
                                    MYSQL_EXE; MYSQL_DB, default pixcart_parity)
Uses only the standard library: the API for every change it can make, MySQL only for the rate-limit rows.
"""
import json
import os
import subprocess
import urllib.error
import urllib.request

BASE = os.environ.get("BASE", "http://localhost:5180")
MYSQL = os.environ.get("MYSQL_EXE", r"C:\Users\haris\pixcart-tools\mysql\bin\mysql.exe")
DB = os.environ.get("MYSQL_DB", "pixcart_parity")
OPEN = ("pending_payment", "placed", "confirmed", "packed", "shipped")


def sql(query):
    out = subprocess.run([MYSQL, "--host=127.0.0.1", "--port=3307", "--user=root", "--password=pixcart", "-N", "-B", DB, "-e", query],
                         capture_output=True, text=True, check=True)
    return [line.split("\t") for line in out.stdout.splitlines() if line.strip()]


def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Requested-With", "pixcart")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# rate-limit rows first, so the admin sign-in below is never refused after many takes
sql("DELETE FROM rate_limit_events WHERE `key` LIKE 'otp:%' OR `key` LIKE 'login%'; DELETE FROM otp_challenges;")
status, text = call("POST", "/api/auth/login", {"email": "admin@pixcart.in", "password": os.environ["ADMIN_PW"]})
if status != 200:
    raise SystemExit(f"admin sign-in failed: {status} {text[:200]}")
token = json.loads(text)["access_token"]
print("cash limit", call("PUT", "/api/admin/delivery/settings", {"cod_limit_paise": 5_000_000}, token)[0])
print("code limits", call("PUT", "/api/admin/auth-settings",
                          {"otp_max_per_hour": 20, "otp_resend_cooldown_seconds": 15, "otp_max_per_ip_hour": 500}, token)[0])
rows = sql("SELECT id, number, status FROM sub_orders WHERE status IN (" + ",".join(f"'{s}'" for s in OPEN) + ")")
for sub_id, number, state in rows:
    status, text = call("POST", f"/api/admin/sub-orders/{sub_id}/cancel", {"reason": "Demo clean-up before recording"}, token)
    print("cancel", number, state, status, "" if status == 200 else text[:120])
