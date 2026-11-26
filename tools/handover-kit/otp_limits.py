import json, sys, urllib.request, pathlib
BASE = "http://localhost:8100"
pw = pathlib.Path(r"C:\Users\haris\pixcart-tools\parity-admin-password.txt").read_text(encoding="utf-8").strip()
H = {"Content-Type": "application/json", "X-Requested-With": "pixcart"}
def call(method, path, body=None, token=None):
    h = dict(H)
    if token: h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")
tok = call("POST", "/api/auth/login", {"email": "admin@pixcart.in", "password": pw, "totp": ""})["access_token"]
cur = call("GET", "/api/admin/auth-settings", token=tok)["settings"]
keep = pathlib.Path(__file__).resolve().with_name("otp-limits-original.json")
if not keep.exists():
    keep.write_text(json.dumps({k: cur[k] for k in ("otp_max_per_hour", "otp_max_per_ip_hour")}), encoding="utf-8")
mode = sys.argv[1]
if mode == "raise":
    new = {"otp_max_per_hour": 20, "otp_max_per_ip_hour": 500}
else:
    new = {k: v for k, v in json.loads(keep.read_text(encoding="utf-8")).items() if not k.startswith("_")}
out = call("PUT", "/api/admin/auth-settings", new, token=tok)["settings"]
print("was", {k: cur[k] for k in new}, "now", {k: out[k] for k in new})
