"""Known LLM providers and how to talk to them.

Two wire protocols cover almost every provider:

- ``anthropic`` — Anthropic Messages API (Claude).
- ``openai`` — OpenAI Chat Completions, which most providers also serve: OpenAI, Azure OpenAI (v1 API),
  Google Gemini (its OpenAI-compatible endpoint), Groq, Mistral, DeepSeek, xAI, OpenRouter, Together,
  Fireworks, Cerebras, and local servers such as Ollama, LM Studio and vLLM.

A provider entry only supplies defaults (address, auth header, example models). Admins can add any
OpenAI-compatible server with the ``custom`` type, so a new provider needs no code change.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProviderType:
    key: str
    name: str
    protocol: str  # "anthropic" | "openai"
    base_url: str
    auth: str = "bearer"  # bearer | x-api-key | api-key | none
    needs_key: bool = True
    local: bool = False
    example_models: tuple[str, ...] = ()
    docs_url: str = ""
    notes: str = ""
    extra_headers: dict[str, str] = field(default_factory=dict)


PROVIDER_TYPES: tuple[ProviderType, ...] = (
    ProviderType("anthropic", "Anthropic (Claude)", "anthropic", "https://api.anthropic.com", auth="x-api-key",
                 example_models=("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"), docs_url="https://docs.claude.com/en/api/overview"),
    ProviderType("openai", "OpenAI", "openai", "https://api.openai.com/v1", docs_url="https://platform.openai.com/docs/api-reference/chat"),
    ProviderType("azure_openai", "Azure OpenAI", "openai", "https://YOUR-RESOURCE.openai.azure.com/openai/v1", auth="api-key",
                 docs_url="https://learn.microsoft.com/azure/ai-foundry/openai/reference", notes="Use your deployment name as the model."),
    ProviderType("gemini", "Google Gemini", "openai", "https://generativelanguage.googleapis.com/v1beta/openai",
                 docs_url="https://ai.google.dev/gemini-api/docs/openai", notes="Gemini's OpenAI-compatible endpoint."),
    ProviderType("groq", "Groq", "openai", "https://api.groq.com/openai/v1", docs_url="https://console.groq.com/docs/openai"),
    ProviderType("mistral", "Mistral", "openai", "https://api.mistral.ai/v1", docs_url="https://docs.mistral.ai/api/"),
    ProviderType("deepseek", "DeepSeek", "openai", "https://api.deepseek.com/v1", docs_url="https://api-docs.deepseek.com/"),
    ProviderType("xai", "xAI (Grok)", "openai", "https://api.x.ai/v1", docs_url="https://docs.x.ai/"),
    ProviderType("openrouter", "OpenRouter", "openai", "https://openrouter.ai/api/v1", docs_url="https://openrouter.ai/docs",
                 notes="One key for hundreds of models, including Bedrock and Vertex-hosted ones."),
    ProviderType("together", "Together AI", "openai", "https://api.together.xyz/v1", docs_url="https://docs.together.ai/"),
    ProviderType("fireworks", "Fireworks AI", "openai", "https://api.fireworks.ai/inference/v1", docs_url="https://docs.fireworks.ai/"),
    ProviderType("cerebras", "Cerebras", "openai", "https://api.cerebras.ai/v1", docs_url="https://inference-docs.cerebras.ai/"),
    ProviderType("ollama", "Ollama (local)", "openai", "http://localhost:11434/v1", auth="none", needs_key=False, local=True,
                 docs_url="https://github.com/ollama/ollama/blob/main/docs/openai.md", notes="Runs models on your own server. Pick a model that supports tools."),
    ProviderType("lmstudio", "LM Studio (local)", "openai", "http://localhost:1234/v1", auth="none", needs_key=False, local=True,
                 docs_url="https://lmstudio.ai/docs/app/api/endpoints/openai"),
    ProviderType("vllm", "vLLM (self-hosted)", "openai", "http://localhost:8000/v1", needs_key=False, local=True,
                 docs_url="https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html"),
    ProviderType("custom", "Any OpenAI-compatible server", "openai", "https://", needs_key=False, docs_url="", notes="Enter the address that ends before /chat/completions."),
)
TYPES = {p.key: p for p in PROVIDER_TYPES}

# What each route is used for; every route has its own ordered list of (connection, model) to try.
ROUTES: dict[str, dict[str, str]] = {
    "assistant": {"label": "AI assistant (chat and voice)", "help": "Needs a model that supports tool calling."},
    "assistant_fast": {"label": "Quick answers and voice", "help": "A fast model for short questions and spoken replies. Empty = use the assistant route."},
    "studio": {"label": "AI studio drafts", "help": "Listing writer, support drafts, review summaries, business brief."},
}
