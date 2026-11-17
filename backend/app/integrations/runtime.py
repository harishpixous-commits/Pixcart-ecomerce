"""Settings that live inside running libraries (Sentry) are re-applied when they change."""
from __future__ import annotations

import logging

from app.config import Settings

log = logging.getLogger("pixcart.integrations")
_sentry_dsn: str | None = None


def apply_sentry(cfg: Settings) -> None:
    """Starts, restarts or stops Sentry to match the saved DSN. No request bodies or personal data are sent."""
    global _sentry_dsn
    dsn = cfg.sentry_dsn or ""
    if dsn == (_sentry_dsn or "") or cfg.environment == "test":
        return
    import sentry_sdk

    sentry_sdk.init(
        dsn=dsn or None,
        environment=cfg.environment,
        send_default_pii=False,
        traces_sample_rate=float(cfg.sentry_traces_sample_rate or 0),
        max_request_body_size="never",
    )
    _sentry_dsn = dsn
    log.info("sentry %s", "enabled" if dsn else "disabled")
