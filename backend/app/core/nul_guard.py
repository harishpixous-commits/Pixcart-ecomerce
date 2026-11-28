"""Refuses a JSON body that carries a NUL character: the database cannot store it and it would end as a server error."""
from __future__ import annotations

import json

_MAX = 2_000_000  # JSON bodies bigger than this are passed on untouched (the routes have their own limits)


class NulGuardMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            return await self.app(scope, receive, send)
        ctype = dict(scope["headers"]).get(b"content-type", b"")
        if b"json" not in ctype:
            return await self.app(scope, receive, send)
        chunks, more, total = [], True, 0
        while more:
            msg = await receive()
            if msg["type"] != "http.request":
                break
            chunks.append(msg.get("body", b""))
            total += len(chunks[-1])
            more = msg.get("more_body", False)
            if total > _MAX:
                break
        body = b"".join(chunks)
        replay = iter([{"type": "http.request", "body": body, "more_body": more}])

        async def receive_again():
            try:
                return next(replay)
            except StopIteration:
                return await receive()

        if total <= _MAX and (b"\x00" in body or b"\\u0000" in body.lower()):
            out = json.dumps({"error": {"code": "invalid_text", "message": "The text contains a character that is not allowed", "fields": {}}}).encode()
            await send({"type": "http.response.start", "status": 400, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(out)).encode())]})
            await send({"type": "http.response.body", "body": out})
            return
        await self.app(scope, receive_again, send)
