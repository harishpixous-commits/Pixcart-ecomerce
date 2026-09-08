#!/usr/bin/env bash
# scripts/typecheck-all.sh — typecheck every TypeScript module.
#
# Why this exists as a separate gate: vitest does NOT typecheck. A module can have every test
# passing while failing to compile, which is exactly what happened in marketing-svc — its tsconfig
# declared "types": [] while the source had begun using node:crypto and Buffer, and 166 green tests
# said nothing about it. Tests prove behaviour; only the compiler proves the code is well-typed.
#
# A module with NO tsconfig is treated as a FAILURE rather than skipped. Skipping is how the gap
# arose in the first place: contracts/ went unchecked for its whole life because nothing insisted.
#
# Usage:  ./scripts/typecheck-all.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

failed=0
checked=0
declare -a ROWS=()

echo "${BOLD}PixCart — TypeScript typecheck${OFF}"
echo "${DIM}vitest does not typecheck; this is the gate that does${OFF}"
echo

while IFS= read -r pkg; do
  module="$(dirname "$pkg")"
  # a package without a test script is not a source module we own
  grep -q '"test"' "$pkg" || continue
  checked=$((checked + 1))

  if [[ ! -f "$module/tsconfig.json" ]]; then
    ROWS+=("$(printf '%-34s %s' "$module" "${RED}NO TSCONFIG — cannot be typechecked${OFF}")")
    failed=$((failed + 1))
    continue
  fi

  if [[ ! -d "$module/node_modules" ]]; then
    echo "${DIM}installing deps for $module${OFF}"
    (cd "$module" && npm install --no-audit --no-fund >/dev/null 2>&1)
  fi

  out="$(cd "$module" && npx tsc --noEmit -p tsconfig.json 2>&1)"
  errors="$(printf '%s' "$out" | grep -c 'error TS' || true)"

  if [[ "$errors" == "0" ]]; then
    ROWS+=("$(printf '%-34s %s' "$module" "${GREEN}clean${OFF}")")
  else
    ROWS+=("$(printf '%-34s %s' "$module" "${RED}${errors} error(s)${OFF}")")
    failed=$((failed + 1))
    printf '%s\n' "$out" | grep 'error TS' | head -10 | sed 's/^/    /'
  fi
done < <(find services ai contracts -maxdepth 3 -name package.json -not -path '*/node_modules/*' 2>/dev/null | sort)

echo
printf '%s\n' "${ROWS[@]}"
echo
if [[ "$failed" -eq 0 ]]; then
  echo "${GREEN}${BOLD}ALL ${checked} TYPESCRIPT MODULES TYPECHECK CLEAN${OFF}"
  exit 0
else
  echo "${RED}${BOLD}${failed} of ${checked} module(s) failed typechecking${OFF}"
  exit 1
fi
