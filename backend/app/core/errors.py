from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    """An expected failure with a stable machine code and a human message."""

    status_code = 400

    def __init__(self, message: str, code: str = "bad_request", status_code: int | None = None, fields: dict[str, str] | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.fields = fields or {}


class NotFound(ApiError):
    status_code = 404

    def __init__(self, what: str = "Resource"):
        super().__init__(f"{what} not found", "not_found")


class Forbidden(ApiError):
    status_code = 403

    def __init__(self, message: str = "You do not have access to this resource"):
        super().__init__(message, "forbidden")


class Unauthorized(ApiError):
    status_code = 401

    def __init__(self, message: str = "Please sign in"):
        super().__init__(message, "unauthorized")


class Conflict(ApiError):
    status_code = 409

    def __init__(self, message: str, code: str = "conflict"):
        super().__init__(message, code)


class TooManyRequests(ApiError):
    status_code = 429

    def __init__(self, message: str = "Too many attempts. Please try again later."):
        super().__init__(message, "rate_limited")


def _body(code: str, message: str, fields: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "fields": fields or {}}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message, exc.fields), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields: dict[str, str] = {}
        labels: dict[str, str] = {}
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
            key = ".".join(loc) or "_"
            fields[key] = friendly_error(err, loc)
            labels[key] = field_label(loc)
        first = next(iter(fields.items()), ("", "Invalid input"))
        message = f"{labels[first[0]]}: {first[1]}" if first[0] and first[0] != "_" else first[1]
        return JSONResponse(_body("validation_error", message, fields), status_code=422)


# Field names people recognise, for messages like "HSN code: use 4, 6 or 8 digits" (the fields map keeps the API names).
FIELD_LABELS = {
    "hsn_code": "HSN code", "gst_bps": "GST rate", "gstin": "GSTIN", "pan": "PAN", "ifsc": "IFSC", "upi": "UPI ID", "sku": "SKU",
    "mrp_paise": "MRP", "price_paise": "Selling price", "qty": "Quantity", "pincode": "PIN code", "phone": "Mobile number",
    "email": "Email", "otp": "Code", "code": "Code", "line1": "Address", "state_code": "State", "vehicle_no": "Vehicle number",
}
# Formats that are easier to describe than to show as a pattern.
PATTERN_HINTS = {"hsn_code": "use 4, 6 or 8 digits", "pincode": "use the 6-digit PIN code", "ifsc": "use the 11-character IFSC, like SBIN0001234",
                 "phone": "use a 10-digit mobile number", "gstin": "use the 15-character GSTIN", "pan": "use the 10-character PAN, like ABCDE1234F"}


def field_label(loc: list[str]) -> str:
    names = [p for p in loc if not p.isdigit()]
    name = names[-1] if names else ""
    return FIELD_LABELS.get(name, name.replace("_", " ").strip().capitalize() or "Input")


def friendly_error(err: dict, loc: list[str]) -> str:
    """Pydantic's message in plain words (no regular expressions or type names shown to people)."""
    kind, ctx = err.get("type", ""), err.get("ctx") or {}
    names = [p for p in loc if not p.isdigit()]
    name = names[-1] if names else ""
    msg = str(err.get("msg", "Invalid value"))
    if msg.startswith("Value error, "):
        return msg[len("Value error, "):]
    if kind == "string_pattern_mismatch":
        return PATTERN_HINTS.get(name, "is not in the right format")
    if kind == "missing":
        return "is required"
    if kind == "string_too_short":
        n = ctx.get("min_length")
        return "is required" if n == 1 else f"needs at least {n} characters"
    if kind == "string_too_long":
        return f"can be at most {ctx.get('max_length')} characters"
    if kind == "too_short":
        return f"needs at least {ctx.get('min_length')}"
    if kind == "too_long":
        return f"can have at most {ctx.get('max_length')}"
    if kind in ("greater_than_equal", "greater_than"):
        return f"must be at least {ctx.get('ge', ctx.get('gt'))}"
    if kind in ("less_than_equal", "less_than"):
        return f"must be at most {ctx.get('le', ctx.get('lt'))}"
    if kind in ("int_parsing", "int_type", "float_parsing", "float_type", "decimal_parsing"):
        return "must be a number"
    if kind in ("bool_parsing", "bool_type"):
        return "must be on or off"
    if kind in ("literal_error", "enum"):
        return f"must be one of: {ctx.get('expected', 'the listed choices')}"
    if kind in ("value_error", "string_type") and "email" in msg.lower():
        return "is not a valid email address"
    if kind == "uuid_parsing":
        return "is not a valid id"
    return msg
