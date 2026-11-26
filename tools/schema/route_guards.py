"""Which sign-in / permission rule guards each route of the reference API, read from its FastAPI dependencies.
The .NET API enforces the same rule for every route BEFORE it reads the request (API/Infrastructure/
RouteGuardFilter.cs), so unauthorised calls get 401/403 exactly like the reference, never 422/404 first.
Regenerate after the reference changes:
  cd <reference backend> && PYTHONPATH=. .venv/Scripts/python <this file> <repo>/PixCartAPI/API/Infrastructure/route-guards.json
Output: JSON list of {method, path, guard} where guard is one of
  public | optional | signed_in | admin | perm:<code> | seller | approved_seller | partner:<dep name> | other:<dep name>
Run from the reference backend folder:  .venv/Scripts/python route_guards.py <out.json>"""
import json
import sys

from app.main import app

KNOWN = {
    "current_user": "signed_in",
    "optional_user": "optional",
    "admin_user": "admin",
    "seller_account": "seller",
    "approved_seller": "approved_seller",
}


def guard_of(dependant):
    """The strongest guard in the dependency tree (permission > admin > seller > signed in > optional)."""
    found = []

    def visit(d):
        call = getattr(d, "call", None)
        name = getattr(call, "__name__", "")
        if name == "_dep" and call.__closure__:
            for cell in call.__closure__:
                v = cell.cell_contents
                if isinstance(v, str):
                    found.append("perm:" + v)
        elif name in KNOWN:
            found.append(KNOWN[name])
        elif name and ("partner" in name or "delivery_boy" in name or "boy" in name):
            found.append("partner:" + name)
        for sub in getattr(d, "dependencies", []) or []:
            visit(sub)

    visit(dependant)
    order = ["perm:", "admin", "approved_seller", "seller", "partner:", "signed_in", "optional"]
    for prefix in order:
        hit = [f for f in found if f.startswith(prefix)]
        if hit:
            return hit[0]
    return "public"


out = []


def walk(routes, prefix=""):
    for r in routes:
        if type(r).__name__ == "_IncludedRouter":
            walk(r.original_router.routes, prefix + (getattr(r.include_context, "prefix", "") or ""))
            continue
        dep = getattr(r, "dependant", None)
        for m in getattr(r, "methods", None) or []:
            if m in ("HEAD", "OPTIONS"):
                continue
            p = prefix + r.path
            if p.startswith("/api/docs") or p in ("/api/openapi.json", "/docs/oauth2-redirect", "/redoc"):
                continue
            out.append({"method": m, "path": p, "guard": guard_of(dep) if dep else "public"})


walk(app.routes)
out.sort(key=lambda x: (x["path"], x["method"]))
json.dump(out, open(sys.argv[1], "w"), indent=0)
from collections import Counter
print(len(out), "routes;", Counter(g["guard"].split(":")[0] + (":" if ":" in g["guard"] else "") for g in out))
print("partner/other guards:", sorted({g["guard"] for g in out if g["guard"].startswith(("partner:", "other:"))}))
