"""Request IDs, trusted client IP and structured logging (adapted from Metanic core/observability)."""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.config import settings

_request_id: ContextVar[str] = ContextVar("request_id", default="")

_REDACTIONS = [
    (re.compile(r"(?i)(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._\-]+"), r"\1[REDACTED]"),
    (re.compile(r"eyJ[A-Za-z0-9._\-]{10,}"), "[REDACTED_JWT]"),
    (re.compile(r"(?i)(password|secret|api[_-]?key|token)(\"?\s*[:=]\s*\"?)([^\s\",}]+)"), r"\1\2[REDACTED]"),
]


def redact(text: str) -> str:
    for pat, repl in _REDACTIONS:
        text = pat.sub(repl, text)
    return text


def client_ip(request: Request) -> str:
    """Spoof-resistant client IP.

    X-Forwarded-For is trusted only when TRUST_PROXY_HEADERS is on, and then the client is read
    TRUSTED_PROXY_COUNT entries from the right: attackers can prepend values on the left, but the
    trusted load balancer appends the real peer on the right.
    """
    peer = request.client.host if request.client and request.client.host else "unknown"
    if not settings.trust_proxy_headers:
        return peer[:64]
    parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if not parts:
        return peer[:64]
    idx = max(0, len(parts) - max(1, settings.trusted_proxy_count))
    return (parts[idx] or peer)[:64]


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get()
        return True


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
            "request_id": getattr(record, "request_id", ""),
        }
        for key in ("method", "path", "status", "duration_ms", "ip"):
            if hasattr(record, key):
                data[key] = getattr(record, key)
        if record.exc_info:
            data["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(data, ensure_ascii=False)


class _ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(f"[{getattr(record, 'request_id', '') or '-'}] {super().format(record)}")


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(_ContextFilter())
    if settings.log_format == "json":
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(_ConsoleFormatter("%(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


access_log = logging.getLogger("pixcart.request")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Assigns a request id, adds security headers and logs one line per request."""

    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id", "")
        if not re.fullmatch(r"[A-Za-z0-9\-]{8,64}", rid):
            rid = uuid.uuid4().hex
        token = _request_id.set(rid)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            access_log.exception("unhandled error", extra={"method": request.method, "path": request.url.path})
            _request_id.reset(token)
            raise
        response.headers["X-Request-ID"] = rid
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if settings.environment == "production":
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path != "/api/health":
            access_log.info(
                "%s %s %s",
                request.method,
                request.url.path,
                response.status_code,
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 1),
                    "ip": client_ip(request),
                },
            )
        _request_id.reset(token)
        return response
