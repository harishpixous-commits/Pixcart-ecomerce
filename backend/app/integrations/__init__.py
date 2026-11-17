"""Third-party connections (payments, SMS, email, WhatsApp, shipping, AI, monitoring, analytics).

- ``registry``: what can be connected, every field, and which runtime setting it overrides.
- ``store``: encrypted storage in ``platform_settings['integrations']``, merged over the environment.
- ``checks``: the "Test connection" call for each provider.
- ``runtime``: re-applies settings held inside libraries (Sentry).

Use ``await get()`` wherever code needs a key; never read provider keys from ``app.config.settings`` directly.
"""
from .store import get, invalidate

__all__ = ["get", "invalidate"]
