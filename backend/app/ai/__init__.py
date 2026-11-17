"""AI pipeline: one path for every AI feature.

    request → task registry (what may run, for whom) → AI settings (switches, budget, model, brand voice)
            → subject snapshot (only the facts the task needs) → layered prompt (frozen rules | brand | request)
            → Claude, or the sandbox when no key is set → parse and validate → AiRun record (tokens, cost,
              latency, status) → a person applies, edits, sends or discards it.

Adapted from Metanic's AI messaging core (lazy client, deterministic sandbox, cached prompt layers,
human-reviewed drafts with token accounting) and its deterministic risk briefs.
"""
