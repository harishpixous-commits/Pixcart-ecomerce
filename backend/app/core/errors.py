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
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
            msg = str(err.get("msg", "Invalid value"))
            if msg.startswith("Value error, "):
                msg = msg[len("Value error, ") :]
            fields[".".join(loc) or "_"] = msg
        first = next(iter(fields.items()), ("", "Invalid input"))
        message = f"{first[0]}: {first[1]}" if first[0] and first[0] != "_" else first[1]
        return JSONResponse(_body("validation_error", message, fields), status_code=422)
