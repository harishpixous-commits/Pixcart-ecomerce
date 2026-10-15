#!/usr/bin/env bash
# scripts/test-all.sh — run every test in the repository and report an authoritative total.
#
# Why this exists: each module is independently testable, but a colleague cloning the repo
# should be able to verify the whole thing with one command rather than trusting a summary.
# This is the local equivalent of CI stage 1 (Validate) in Vol. 11 §11.4.
#
#   Java modules  — the framework-free domain layers compile with the JDK + JUnit console
#                   standalone (no Maven needed). The Spring application shells are excluded
#                   here because they require Maven Central; CI builds those with ./mvnw.
#   TS modules    — vitest via npm.
#
# Usage:  ./scripts/test-all.sh            (all modules)
#         ./scripts/test-all.sh java       (Java only)
#         ./scripts/test-all.sh ts         (TypeScript only)

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

JUNIT_JAR="${JUNIT_JAR:-/usr/share/java/junit-platform-console-standalone.jar}"
WHICH="${1:-all}"

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
total=0
failed=0
declare -a ROWS=()

have_junit() { [[ -f "$JUNIT_JAR" ]]; }

# Java domain modules. Each entry: <module-path>[:<extra-source-roots...>]
JAVA_MODULES=(
  "services/identity-svc"
  "services/catalogue-svc"
  "services/payment-svc"
  "services/order-svc"
  "services/finance-svc"
  "services/inventory-svc"
)

run_java_module() {
  local module="$1"
  [[ -d "$module/src" ]] || return 0
  local out; out="$(mktemp -d)"
  # Exclude Spring application shells by CONTENT (they need Maven Central, which CI
  # provides). Filtering by filename is wrong: domain classes such as
  # VendorKycApplication.java legitimately end in "Application".
  local srcs; srcs="$(find "$module/src" -name '*.java' -print0 \
      | xargs -0 grep -L 'org\.springframework' 2>/dev/null)"
  [[ -n "$srcs" ]] || { rm -rf "$out"; return 0; }
  if ! javac --release 21 -cp "$JUNIT_JAR" -d "$out" $srcs > "$out/compile.log" 2>&1; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}COMPILE FAILED${OFF}")")
    sed 's/^/    /' "$out/compile.log" | head -12
    failed=$((failed + 1)); rm -rf "$out"; return 0
  fi
  local log="$out/test.log"
  java -jar "$JUNIT_JAR" --class-path "$out" --scan-class-path --details=summary > "$log" 2>&1
  local passed; passed="$(grep -oE '[0-9]+ tests successful' "$log" | grep -oE '[0-9]+' | head -1)"
  local failcount; failcount="$(grep -oE '[0-9]+ tests failed' "$log" | grep -oE '[0-9]+' | head -1)"
  passed="${passed:-0}"; failcount="${failcount:-0}"
  total=$((total + passed))
  if [[ "$failcount" != "0" ]]; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}${failcount} FAILED${OFF} (${passed} passed)")")
    failed=$((failed + failcount))
    grep -E 'MethodSource|expected|AssertionFailed' "$log" | head -8 | sed 's/^/    /'
  else
    ROWS+=("$(printf '%-42s %s' "$module" "${GREEN}${passed} passed${OFF}")")
  fi
  rm -rf "$out"
}

# The e2e harness needs three services' domains on one classpath (test-only; see its README).
run_e2e() {
  [[ -d integration/e2e/src/test ]] || return 0
  local out; out="$(mktemp -d)"
  local srcs; srcs="$(find services/payment-svc/src/main services/order-svc/src/main \
      services/finance-svc/src/main/java/com/pixous/pixcart/finance/domain \
      integration/e2e/src/test -name '*.java' 2>/dev/null)"
  if ! javac --release 21 -cp "$JUNIT_JAR" -d "$out" $srcs > "$out/compile.log" 2>&1; then
    ROWS+=("$(printf '%-42s %s' "integration/e2e" "${RED}COMPILE FAILED${OFF}")")
    sed 's/^/    /' "$out/compile.log" | head -12
    failed=$((failed + 1)); rm -rf "$out"; return 0
  fi
  java -jar "$JUNIT_JAR" --class-path "$out" --scan-class-path --details=summary > "$out/test.log" 2>&1
  local passed; passed="$(grep -oE '[0-9]+ tests successful' "$out/test.log" | grep -oE '[0-9]+' | head -1)"
  local failcount; failcount="$(grep -oE '[0-9]+ tests failed' "$out/test.log" | grep -oE '[0-9]+' | head -1)"
  passed="${passed:-0}"; failcount="${failcount:-0}"
  total=$((total + passed))
  if [[ "$failcount" != "0" ]]; then
    ROWS+=("$(printf '%-42s %s' "integration/e2e" "${RED}${failcount} FAILED${OFF}")"); failed=$((failed + failcount))
  else
    ROWS+=("$(printf '%-42s %s' "integration/e2e" "${GREEN}${passed} passed${OFF}")")
  fi
  rm -rf "$out"
}

run_ts_module() {
  local module="$1"
  [[ -f "$module/package.json" ]] || return 0
  grep -q '"test"' "$module/package.json" || return 0
  if [[ ! -d "$module/node_modules" ]]; then
    (cd "$module" && npm install --no-audit --no-fund > /dev/null 2>&1)
  fi
  local log; log="$(mktemp)"
  (cd "$module" && npx vitest run --reporter=basic > "$log" 2>&1)
  local line; line="$(grep -oE 'Tests +[0-9]+ (passed|failed)' "$log" | tail -1)"
  local passed; passed="$(grep -oE '[0-9]+ passed' "$log" | grep -oE '[0-9]+' | tail -1)"
  local failcount; failcount="$(grep -oE '[0-9]+ failed' "$log" | grep -oE '[0-9]+' | tail -1)"
  passed="${passed:-0}"; failcount="${failcount:-0}"
  total=$((total + passed))
  if [[ "$failcount" != "0" ]]; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}${failcount} FAILED${OFF} (${passed} passed)")")
    failed=$((failed + failcount))
    grep -E 'FAIL|AssertionError|expected' "$log" | head -8 | sed 's/^/    /'
  else
    ROWS+=("$(printf '%-42s %s' "$module" "${GREEN}${passed} passed${OFF}")")
  fi
  rm -f "$log"
}

echo "${BOLD}PixCart — full test run${OFF}"
echo "${DIM}repo: $ROOT${OFF}"
echo

if [[ "$WHICH" == "all" || "$WHICH" == "java" ]]; then
  if have_junit; then
    echo "${BOLD}Java domain modules${OFF} ${DIM}(JDK $(javac --version 2>&1 | awk '{print $2}') + JUnit console)${OFF}"
    for m in "${JAVA_MODULES[@]}"; do run_java_module "$m"; done
    run_e2e
  else
    echo "${RED}JUnit console standalone not found at $JUNIT_JAR${OFF}"
    echo "  install: apt-get install -y junit5   (or set JUNIT_JAR)"
    failed=$((failed + 1))
  fi
fi

if [[ "$WHICH" == "all" || "$WHICH" == "ts" ]]; then
  echo
  echo "${BOLD}TypeScript modules${OFF} ${DIM}(vitest)${OFF}"
  # discovered rather than hard-coded, so a new module is picked up automatically
  while IFS= read -r pkg; do
    run_ts_module "$(dirname "$pkg")"
  done < <(find services ai contracts -maxdepth 3 -name package.json -not -path '*/node_modules/*' 2>/dev/null | sort)
fi

echo
printf '%s\n' "${ROWS[@]}"
echo
if [[ "$failed" -eq 0 ]]; then
  echo "${GREEN}${BOLD}ALL GREEN — ${total} tests passed${OFF}"
  exit 0
else
  echo "${RED}${BOLD}${failed} failure(s); ${total} tests passed${OFF}"
  exit 1
fi
