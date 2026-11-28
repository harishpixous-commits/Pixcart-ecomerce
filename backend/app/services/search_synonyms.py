"""Search synonyms the admin sets: "tee = t-shirt = tshirt; sneakers = shoes".

Each group is words that mean the same to a shopper. A search for one word also finds products that use the others.
Only single words are matched. The groups are written in one text setting, separated by semicolons.
"""
from __future__ import annotations

import re

MAX_VARIANTS = 6


def parse_groups(text: str) -> list[list[str]]:
    groups: list[list[str]] = []
    for part in (text or "").replace("\n", ";").split(";"):
        words: list[str] = []
        for w in part.split("="):
            w = " ".join(re.split(r"[^\w-]+", w.lower())).strip()
            if w and " " not in w and w not in words:
                words.append(w)
        if len(words) > 1:
            groups.append(words)
    return groups


def check_groups(text: str) -> None:
    """Raise ValueError when a non-empty part does not make a group of two or more single words."""
    for part in (text or "").replace("\n", ";").split(";"):
        if part.strip() and not parse_groups(part):
            raise ValueError(f"search_synonyms: \"{part.strip()[:40]}\" needs two or more single words joined with =")


def variants(query: str, groups: list[list[str]]) -> list[str]:
    """The query itself first, then the same query with one word swapped for each of its synonyms (at most MAX_VARIANTS)."""
    out = [query]
    if not groups:
        return out
    tokens = [t for t in re.split(r"\s+", query.strip()) if t]
    for i, tok in enumerate(tokens):
        low = tok.lower()
        for g in groups:
            if low in g:
                for alt in g:
                    if alt != low:
                        v = " ".join(tokens[:i] + [alt] + tokens[i + 1:])
                        if v not in out:
                            out.append(v)
                    if len(out) >= MAX_VARIANTS:
                        return out
    return out
