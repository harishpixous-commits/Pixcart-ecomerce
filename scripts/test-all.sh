#!/usr/bin/env bash
# scripts/test-all.sh — run every test in the repository and report an authoritative total.
#
# Why this exists: each module is independently testable, but a colleague cloning the repo
# should be able to verify the whole thing with one command rather than trusting a summary.
# This is the local equivalent of CI stage 1 (Validate) in Vol. 11 §11.4.
#
#   Java modules  — two build paths, chosen by the module itself rather than by a list that
#                   can drift out of date with it:
#                     * a module with a pom.xml is built by Maven. It declares third-party
#                       dependencies (identity-svc imports nimbus-jose-jwt), which a bare
#                       `javac -cp junit.jar` cannot see, and no hand-maintained classpath
#                       list is going to stay correct as dependencies are added.
#                     * a module with no pom.xml is framework-free by construction and compiles
#                       with the JDK + JUnit console standalone. Spring-bearing sources are
#                       excluded by CONTENT: domain classes such as VendorKycApplication.java
#                       legitimately end in "Application", so filtering by filename is wrong.
#   TS modules    — vitest via npm.
#
# The JDK is resolved explicitly (JAVA_HOME, then the documented toolchain path, then PATH)
# instead of trusting whatever `javac` happens to be on PATH. It was not on PATH at all on the
# machine this script was last fixed on, and the script's response was to print the awk output
# of an error message as if it were a version and report seven modules as COMPILE FAILED.
# A gate that misreports a missing tool as seven product failures is worse than no gate.
#
# Usage:  ./scripts/test-all.sh            (all modules)
#         ./scripts/test-all.sh java       (Java only)
#         ./scripts/test-all.sh ts         (TypeScript only)
#
# Env:    JUNIT_JAR   path to junit-platform-console-standalone.jar (non-Maven modules)
#         MVN         path to mvn (pom.xml modules); discovered if unset

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

JUNIT_JAR="${JUNIT_JAR:-/usr/share/java/junit-platform-console-standalone.jar}"
WHICH="${1:-all}"

# ---------------------------------------------------------------- JDK discovery
# Order: JAVA_HOME, then the toolchain this project documents, then PATH.
jdk_bin() {
  local c
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/javac" ]]; then echo "$JAVA_HOME/bin"; return 0; fi
  for c in "$HOME/pixtool/jdk21/bin" /c/Users/haris/pixtool/jdk21/bin; do
    [[ -x "$c/javac" ]] && { echo "$c"; return 0; }
  done
  if command -v javac >/dev/null 2>&1; then dirname "$(command -v javac)"; return 0; fi
  return 1
}

# ---------------------------------------------------------------- Maven discovery
find_mvn() {
  local c
  if [[ -n "${MVN:-}" && -x "${MVN}" ]]; then echo "$MVN"; return 0; fi
  command -v mvn >/dev/null 2>&1 && { command -v mvn; return 0; }
  for c in "${LOCALAPPDATA:-}"/maven/*/bin/mvn "$HOME/pixtool/maven/bin/mvn"; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
total=0
failed=0
declare -a ROWS=()

have_junit() { [[ -f "$JUNIT_JAR" ]]; }

# Java domain modules. Each entry: <module-path>. Build style is derived from the module
# (pom.xml => Maven), not from this list, so adding a pom cannot silently change how it runs.
JAVA_MODULES=(
  "services/identity-svc"
  "services/catalogue-svc"
  "services/payment-svc"
  "services/order-svc"
  "services/finance-svc"
  "services/inventory-svc"
)

# Run one Java module. A pom.xml module goes to Maven; everything else to bare javac.
run_java_module() {
  local module="$1"
  [[ -d "$module/src" ]] || return 0

  if [[ -f "$module/pom.xml" ]]; then
    run_maven_module "$module"
    return 0
  fi

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
  tally "$module" "$log"
  rm -rf "$out"
}

# Maven-backed module. Separate from the javac path because its result must not be
# attributed to the classpath we hand it: mvn resolves its OWN dependencies.
run_maven_module() {
  local module="$1"
  if [[ -z "$MVN_BIN" ]]; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}NOT RUN${OFF} (needs Maven)")")
    echo "    $module declares a pom.xml but no mvn was found."
    echo "    install Maven, or set MVN=/path/to/mvn"
    failed=$((failed + 1)); return 0
  fi
  local log; log="$(mktemp)"
  # NOT -q: surefire's "Tests run:" lines are INFO output, and quiet mode suppresses exactly
  # the lines this tally parses. A silenced tally would report 0 tests as a pass.
  if ! "$MVN_BIN" -f "$module/pom.xml" test > "$log" 2>&1; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}FAILED${OFF}")")
    grep -E '^\[ERROR\]|Tests run:.*Failures: [1-9]|Tests run:.*Errors: [1-9]|BUILD FAILURE' "$log" \
      | head -12 | sed 's/^/    /'
    failed=$((failed + 1)); rm -f "$log"; return 0
  fi
  # surefire prints one summary line per class; the LAST "Tests run: N, ..." aggregate
  # line is the module total. Per-class lines are ignored on purpose.
  local passed failcount
  passed="$(grep -oE 'Tests run: [0-9]+, Failures: [0-9]+, Errors: [0-9]+, Skipped: [0-9]+' "$log" \
            | tail -1 | grep -oE 'Tests run: [0-9]+' | grep -oE '[0-9]+')"
  failcount="$(grep -oE 'Tests run: [0-9]+, Failures: [0-9]+, Errors: [0-9]+' "$log" \
            | tail -1 | grep -oE 'Failures: [0-9]+, Errors: [0-9]+' \
            | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}')"
  passed="${passed:-0}"; failcount="${failcount:-0}"
  total=$((total + passed))
  if [[ "$failcount" != "0" ]]; then
    ROWS+=("$(printf '%-42s %s' "$module" "${RED}${failcount} FAILED${OFF} (${passed} passed)")")
    failed=$((failed + failcount))
  else
    ROWS+=("$(printf '%-42s %s' "$module" "${GREEN}${passed} passed${OFF} (Maven)")")
  fi
  rm -f "$log"
}

# Shared pass/fail tally for a JUnit-console log, so the two paths report identically.
tally() {
  local label="$1" log="$2"
  local passed failcount
  passed="$(grep -oE '[0-9]+ tests successful' "$log" | grep -oE '[0-9]+' | head -1)"
  failcount="$(grep -oE '[0-9]+ tests failed' "$log" | grep -oE '[0-9]+' | head -1)"
  passed="${passed:-0}"; failcount="${failcount:-0}"
  total=$((total + passed))
  if [[ "$failcount" != "0" ]]; then
    ROWS+=("$(printf '%-42s %s' "$label" "${RED}${failcount} FAILED${OFF} (${passed} passed)")")
    failed=$((failed + failcount))
    grep -E 'MethodSource|expected|AssertionFailed' "$log" | head -8 | sed 's/^/    /'
  else
    ROWS+=("$(printf '%-42s %s' "$label" "${GREEN}${passed} passed${OFF}")")
  fi
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
  JDK_PATH="$(jdk_bin || true)"
  MVN_BIN="$(find_mvn || true)"

  if [[ -z "$JDK_PATH" ]]; then
    # Refuse rather than proceed: without a JDK every module would report COMPILE FAILED and
    # a reader would take seven product failures for a missing tool. This is the failure the
    # old header made impossible to see, by printing the awk of the error line as a version.
    echo "${RED}No JDK found — cannot run the Java tests${OFF}"
    echo "  looked in order: \$JAVA_HOME/bin, ~/pixtool/jdk21/bin, then PATH"
    echo "  fix: export JAVA_HOME=/path/to/jdk21   (CI sets this; this project targets 21)"
    echo "  note: Maven modules need a JDK too — mvn will not run without one."
    failed=$((failed + 1))
  else
    export PATH="$JDK_PATH:$PATH"
    export JAVA_HOME="$(cd "$(dirname "$JDK_PATH")" && pwd)"
    if ! have_junit; then
      echo "${RED}JUnit console standalone not found at $JUNIT_JAR${OFF}"
      echo "  install: apt-get install -y junit5   (or set JUNIT_JAR)"
      failed=$((failed + 1))
    else
      echo "${BOLD}Java modules${OFF} ${DIM}(JDK $(javac --version 2>&1 | awk '{print $2}'), JUnit console for pom-less modules, Maven for: services/identity-svc)${OFF}"
      [[ -n "$MVN_BIN" ]] || echo "${DIM}mvn not on PATH — pom.xml modules will be reported NOT RUN${OFF}"
      for m in "${JAVA_MODULES[@]}"; do run_java_module "$m"; done
      run_e2e
    fi
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
