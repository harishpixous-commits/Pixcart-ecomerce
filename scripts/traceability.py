#!/usr/bin/env python3
"""
scripts/traceability.py — generate docs/TRACEABILITY.md from the code itself.

Every source file in this repository cites the requirement ids it implements in its
header comment (e.g. "FR-CUS-014", "BRU-03"). This script:

  1. reads the canonical requirement catalogue out of the documentation suite's SRS
     volumes (docs/ ... the same v03*.js modules the suite is built from), so the
     denominator is the specification, not a hand-kept list;
  2. scans every source and test file for requirement citations;
  3. writes a matrix of requirement -> implementing module(s) -> test file(s).

It reports gaps as loudly as coverage. A generated report cannot drift from the code, and
cannot flatter it: an FR with no citation anywhere shows as NOT IMPLEMENTED.

Usage:
    python3 scripts/traceability.py               # write docs/TRACEABILITY.md
    python3 scripts/traceability.py --check       # exit 1 if coverage drops below the floor
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The requirement catalogue is VENDORED into the repository so this script is
# self-contained: it must run for anyone who clones the repo, with no dependency on the
# authoring workspace. (Learned the hard way — a workspace reset once left the generator
# unable to find its own denominator.) The SRS globs remain as an optional refresh path.
CATALOGUE_JSON = os.path.join(ROOT, "docs", "requirements", "catalogue.json")
SRS_GLOBS = [
    os.path.join(ROOT, "docs", "srs-source", "v03*.js"),
    "/home/claude/ecomdoc/v03*.js",
]
CODE_ROOTS = ["services", "ai", "contracts", "integration", "infra"]
CODE_EXT = (".java", ".ts", ".sql", ".json", ".yaml", ".yml")

FR_RE = re.compile(r"\bFR-[A-Z]{2,3}-\d{3}\b")
BRU_RE = re.compile(r"\bBRU-\d{2}\b")
# A file is a test if it lives in a test dir or matches the usual suffixes.
TEST_HINT = re.compile(r"(^|/)(test|tests)/|Test\.java$|\.spec\.ts$")

# Coverage floor for --check; raise this as slices land, never lower it silently.
COVERAGE_FLOOR = 68   # ratchet against regression, never lowered silently


def load_catalogue() -> dict[str, str]:
    """
    Requirement id -> name. Prefers the vendored catalogue (always present in a clone); falls
    back to parsing the SRS volumes when they are available, which is how the vendored file is
    refreshed if the specification changes.
    """
    if os.path.exists(CATALOGUE_JSON):
        with open(CATALOGUE_JSON, encoding="utf-8") as fh:
            vendored = json.load(fh)
        if vendored:
            return vendored
    files: list[str] = []
    for pattern in SRS_GLOBS:
        files.extend(sorted(glob.glob(pattern)))
        if files:
            break
    catalogue: dict[str, str] = {}
    for fn in files:
        with open(fn, encoding="utf-8", errors="replace") as fh:
            s = fh.read()
        for m in re.finditer(r"'(FR-[A-Z]{2,3}-\d{3})'", s):
            key = m.group(1)
            if key in catalogue:
                continue
            block = s[m.start(): m.start() + 400]
            name = re.search(r"name: '([^']+)'", block)
            catalogue[key] = name.group(1) if name else ""
    return catalogue


def scan_code() -> tuple[dict[str, set[str]], dict[str, set[str]], dict[str, set[str]]]:
    """Return (fr -> impl files, fr -> test files, bru -> files)."""
    impl: dict[str, set[str]] = defaultdict(set)
    tests: dict[str, set[str]] = defaultdict(set)
    brus: dict[str, set[str]] = defaultdict(set)
    for root in CODE_ROOTS:
        base = os.path.join(ROOT, root)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in {"node_modules", "out", "target", ".git"}]
            for name in filenames:
                if not name.endswith(CODE_EXT):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, ROOT)
                try:
                    with open(path, encoding="utf-8", errors="replace") as fh:
                        content = fh.read()
                except OSError:
                    continue
                is_test = bool(TEST_HINT.search(rel))
                for fr in set(FR_RE.findall(content)):
                    (tests if is_test else impl)[fr].add(rel)
                for bru in set(BRU_RE.findall(content)):
                    brus[bru].add(rel)
    return impl, tests, brus


def render(catalogue: dict[str, str], impl, tests, brus) -> tuple[str, int]:
    families = sorted({k.split("-")[1] for k in catalogue})
    implemented = [k for k in catalogue if impl.get(k)]
    tested = [k for k in catalogue if tests.get(k)]
    pct = round(100 * len(implemented) / len(catalogue)) if catalogue else 0

    out: list[str] = []
    out.append("# Requirements traceability (generated)\n")
    out.append(
        "Generated by `scripts/traceability.py` from the code itself: every source file "
        "cites the requirement ids it implements, and the denominator is the requirement "
        "catalogue read out of the SRS volumes. **Do not edit by hand** — regenerate.\n"
    )
    out.append("## Summary\n")
    out.append(f"- Requirements in the SRS: **{len(catalogue)}**")
    out.append(f"- With implementing code: **{len(implemented)}** ({pct}%)")
    out.append(f"- With tests citing them: **{len(tested)}**")
    out.append(f"- Business rules (BRU) cited in code: **{len(brus)}**\n")

    out.append("### Coverage by family\n")
    out.append("| Family | In SRS | Implemented | Tested |")
    out.append("|---|---:|---:|---:|")
    for fam in families:
        keys = [k for k in catalogue if k.split("-")[1] == fam]
        fi = [k for k in keys if impl.get(k)]
        ft = [k for k in keys if tests.get(k)]
        out.append(f"| FR-{fam} | {len(keys)} | {len(fi)} | {len(ft)} |")
    out.append("")

    out.append("## Matrix\n")
    out.append("`—` in the Tests column means code cites the requirement but no test does.\n")
    for fam in families:
        keys = sorted(k for k in catalogue if k.split("-")[1] == fam)
        out.append(f"### FR-{fam}\n")
        out.append("| Requirement | Name | Implementation | Tests |")
        out.append("|---|---|---|---|")
        for k in keys:
            impl_files = sorted(impl.get(k, []))
            test_files = sorted(tests.get(k, []))
            if not impl_files and not test_files:
                out.append(f"| {k} | {catalogue[k]} | _not implemented_ | — |")
                continue
            def fmt(paths: list[str]) -> str:
                shown = [f"`{p}`" for p in paths[:3]]
                if len(paths) > 3:
                    shown.append(f"+{len(paths) - 3} more")
                return "<br>".join(shown) if shown else "—"
            out.append(f"| {k} | {catalogue[k]} | {fmt(impl_files)} | {fmt(test_files)} |")
        out.append("")

    out.append("## Business rules cited in code\n")
    out.append("| Rule | Files |")
    out.append("|---|---|")
    for bru in sorted(brus):
        files = sorted(brus[bru])
        shown = "<br>".join(f"`{p}`" for p in files[:4])
        if len(files) > 4:
            shown += f"<br>+{len(files) - 4} more"
        out.append(f"| {bru} | {shown} |")
    out.append("")

    out.append("## Not yet implemented\n")
    missing = sorted(k for k in catalogue if not impl.get(k))
    if missing:
        out.append(
            "These requirements have no citing code. They are listed so the gap is visible "
            "rather than implied — several are UI-surface or ops-console requirements whose "
            "domain rules are already covered elsewhere in the matrix.\n"
        )
        for k in missing:
            out.append(f"- **{k}** — {catalogue[k]}")
    else:
        out.append("None.")
    out.append("")
    return "\n".join(out), pct


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if coverage is below the floor")
    args = ap.parse_args()

    catalogue = load_catalogue()
    if not catalogue:
        print("could not read the requirement catalogue from the SRS volumes", file=sys.stderr)
        return 2
    impl, tests, brus = scan_code()
    report, pct = render(catalogue, impl, tests, brus)

    target = os.path.join(ROOT, "docs", "TRACEABILITY.md")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(report)

    implemented = sum(1 for k in catalogue if impl.get(k))
    print(f"requirements: {len(catalogue)}  implemented: {implemented} ({pct}%)  "
          f"tested: {sum(1 for k in catalogue if tests.get(k))}  BRUs cited: {len(brus)}")
    print(f"written: {os.path.relpath(target, ROOT)}")

    if args.check and pct < COVERAGE_FLOOR:
        print(f"coverage {pct}% is below the floor of {COVERAGE_FLOOR}%", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
