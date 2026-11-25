"""The JSON request-body schema of every route of the reference API, read from its OpenAPI schema with every $ref
expanded. The .NET API validates bodies against them before reading them (API/Infrastructure/ReferenceBodyFilter.cs),
with pydantic's rules and the reference's messages and field order, so an invalid body gets the reference's 422 answer.
Regenerate after the reference changes:
  cd <reference backend> && PYTHONPATH=. .venv/Scripts/python <this file> <repo>/PixCartAPI/API/Infrastructure/body-rules.json
Output: {"POST /api/x/{}": {"required": true|false, "schema": {...}}}"""
import json
import os
import re
import sys
import warnings

warnings.filterwarnings("ignore")
from app.main import app  # noqa: E402

spec = app.openapi()
comps = spec.get("components", {}).get("schemas", {})
KEEP = {"type", "format", "enum", "const", "properties", "required", "items", "anyOf", "oneOf", "allOf", "minLength",
        "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "minItems", "maxItems",
        "additionalProperties", "multipleOf", "title"}


def expand(s, depth=0):
    if depth > 12:
        return {}
    if isinstance(s, list):
        return [expand(x, depth + 1) for x in s]
    if not isinstance(s, dict):
        return s
    if "$ref" in s:
        return expand(comps[s["$ref"].split("/")[-1]], depth + 1)
    out = {}
    for k, v in s.items():
        if k not in KEEP:
            continue
        if k == "properties":
            out[k] = {name: expand(p, depth + 1) for name, p in v.items()}
        elif k in ("items", "additionalProperties") and isinstance(v, dict):
            out[k] = expand(v, depth + 1)
        elif k in ("anyOf", "oneOf", "allOf"):
            out[k] = [expand(x, depth + 1) for x in v]
        else:
            out[k] = v
    return out


rules = {}
for path, ops in spec["paths"].items():
    for method, op in ops.items():
        rb = op.get("requestBody")
        if not rb:
            continue
        content = rb.get("content", {}).get("application/json")
        if not content:
            continue
        key = method.upper() + " " + re.sub(r"\{[^}]+\}", "{}", path).rstrip("/").lower()
        rules[key] = {"required": bool(rb.get("required")), "schema": expand(content.get("schema", {}))}
os.makedirs(os.path.dirname(os.path.abspath(sys.argv[1])), exist_ok=True)
json.dump(rules, open(sys.argv[1], "w"), indent=0)  # no sort_keys: field order is the reference model order
print(len(rules), "routes with JSON bodies")
os._exit(0)  # the app starts background work on import; do not wait for it
