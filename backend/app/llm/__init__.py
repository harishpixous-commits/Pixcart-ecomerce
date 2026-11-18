"""Model-agnostic LLM access: any provider, several keys per provider, ordered fallbacks per route.

- ``catalog``: provider types (Anthropic + every OpenAI-compatible API, cloud or local) and routes.
- ``config``: connections, encrypted keys and routes saved from Admin → AI providers.
- ``adapters``: the two wire protocols, normalised to one event stream.
- ``router``: tries targets and keys in order with cooldowns; ``stream()`` and ``complete()``.
"""
