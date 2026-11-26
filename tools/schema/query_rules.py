"""The path- and query-parameter rules of every route of the reference API, read from its OpenAPI schema.
The .NET API checks them before the request is read (API/Infrastructure/QueryRulesFilter.cs), with the reference's
messages, so a missing or invalid query value gets the same 422 answer as the reference.
Regenerate after the reference changes:
  cd <reference backend> && PYTHONPATH=. .venv/Scripts/python <this file> <repo>/PixCartAPI/API/Infrastructure/query-rules.json
Output: {"GET /api/x/{}": [{name, in (path|query), required, type, format?, enum?, min_length?, max_length?, ge?, le?, gt?, lt?,
         pattern?, max_items?, item_type?}, ...]} in the reference's parameter order."""
import json
import re
import sys
import warnings

warnings.filterwarnings("ignore")
from app.main import app  # noqa: E402

spec = app.openapi()
out = {}
for path, ops in spec["paths"].items():
    for method, op in ops.items():
        rules = []
        for p in op.get("parameters", []):
            if p["in"] not in ("query", "path"):
                continue
            s = p.get("schema", {})
            if "anyOf" in s:
                s = next(x for x in s["anyOf"] if x.get("type") != "null")
            r = {"name": p["name"], "in": p["in"], "required": bool(p.get("required")), "type": s.get("type", "string")}
            for src, dst in (("format", "format"), ("enum", "enum"), ("minLength", "min_length"), ("maxLength", "max_length"),
                             ("minimum", "ge"), ("maximum", "le"), ("exclusiveMinimum", "gt"), ("exclusiveMaximum", "lt"),
                             ("pattern", "pattern"), ("maxItems", "max_items")):
                if src in s:
                    r[dst] = s[src]
            if s.get("type") == "array":
                r["item_type"] = s.get("items", {}).get("type", "string")
            rules.append(r)
        if rules:
            out[method.upper() + " " + re.sub(r"\{[^}]+\}", "{}", path).rstrip("/").lower()] = rules
json.dump(out, open(sys.argv[1], "w"), indent=0, sort_keys=True)
print(len(out), "routes with query rules,", sum(len(v) for v in out.values()), "parameters")
