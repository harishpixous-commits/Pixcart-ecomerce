"""A category's size guide: lines of cells split by "|", the first line is the header."""
from __future__ import annotations

MAX_ROWS = 30
MAX_COLS = 8
MAX_CELL = 30


def _parse(text: str) -> list[list[str]]:
    out = []
    for line in (text or "").splitlines():
        cells = [" ".join(c.split())[:MAX_CELL] for c in line.split("|")]
        if any(cells):
            out.append(cells)
    return out


def clean(text: str) -> str:
    """The stored text: tidy lines. Raises ValueError for a table that cannot be shown."""
    grid = _parse(text)
    if not grid:
        return ""
    if len(grid) < 2:
        raise ValueError("A size guide needs a header line and at least one size line")
    if len(grid) > MAX_ROWS:
        raise ValueError(f"A size guide has at most {MAX_ROWS} lines")
    if any(len(r) > MAX_COLS for r in grid):
        raise ValueError(f"A size guide has at most {MAX_COLS} columns")
    if len({len(r) for r in grid}) != 1:
        raise ValueError("Every line of the size guide needs the same number of columns")
    return "\n".join(" | ".join(r) for r in grid)


def rows(text: str) -> list[list[str]] | None:
    """The table for the product page, or None when there is no guide."""
    grid = _parse(text)
    return grid if len(grid) >= 2 else None
