#!/usr/bin/env bash
# scripts/setup-dev-db.sh — build a development database the code can actually run against.
#
# WHY THIS EXISTS.
# The migrations in infra/db/migrations are the schema's source of truth, and
# ./scripts/verify-migrations.sh proves they build a clean 36-table schema. But that proof goes
# into a throwaway database it drops at the end, and nothing created a PERMANENT database from
# them. On the machine this script was written for the result was three databases, none usable:
#
#   pixcart        35 tables, hand-built, does not match the migrations at all. It has 8 tables
#                  no migration creates (ven_vendor, crt_cart, crt_cart_line, ord_quote,
#                  ord_quote_line, ord_item, cat_media, cat_product_copy), is missing 9 the
#                  migrations do create (ven_store, cart, cart_line, rma_request, rma_event,
#                  mkt_coupon, cms_content, notif_message, cus_wishlist), and id_staff has no
#                  password_hash - so V008's fix is absent and no staff can log in. The code
#                  references ven_store in 14 files and ven_vendor in ZERO, so this schema
#                  cannot serve a request that touches a vendor.
#   pixcart_dev    the canonical name (README, application.yml, the provisioning script) - and
#                  it had ZERO tables.
#   pixcart_verify correct, but dropped and recreated by the verification gate every run.
#
# So there was no database on the box that the application could start against, and no command
# that would produce one. This is that command.
#
# WHAT IT DOES
#   1. connects (MYSQL_ARGS if set, else the same discovery verify-migrations.sh uses)
#   2. refuses a non-empty target database unless --rebuild is passed, because dropping a
#      database is irreversible and CLAUDE.md asks me to ask rather than assume
#   3. creates the database and the application login it expects
#   4. applies V001..V008 in order
#   5. records flyway_schema_history so identity-svc's baseline-on-migrate has real history to
#      see instead of being told to pretend the schema is at V006
#
# Afterwards:
#   cd services/bff && npm run seed                     # demo data (idempotent)
#   ./scripts/provision-dev-credentials.ps1             # staff/vendor passwords (explicit)
#
# Usage:  ./scripts/setup-dev-db.sh                     # build ./pixcart_dev if empty
#         ./scripts/setup-dev-db.sh --rebuild           # DROP and rebuild (destructive)
#         DB_NAME=mydb ./scripts/setup-dev-db.sh --rebuild

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/infra/db/migrations"
DB="${DB_NAME:-pixcart_dev}"
DB_USER="${DB_USER:-pixcart}"
DB_PASSWORD="${DB_PASSWORD:-pixcart_dev_pw}"

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'
REBUILD=0
[[ "${1:-}" == "--rebuild" ]] && REBUILD=1

# ---------------------------------------------------------------- connection
if [[ -z "${MYSQL_ARGS:-}" ]]; then
  if [[ -x /usr/sbin/mariadbd ]] && command -v mariadb-install-db >/dev/null 2>&1; then
    D="${TMPDIR:-/tmp}/pixcart-setup-data"; S="${TMPDIR:-/tmp}/pixcart-setup.sock"
    if ! mariadb-admin --socket="$S" ping >/dev/null 2>&1; then
      [[ -d "$D" ]] || { mkdir -p "$D"; mariadb-install-db --datadir="$D" --user="$(id -un)" \
        --auth-root-authentication-method=normal >/dev/null 2>&1; }
      /usr/sbin/mariadbd --user="$(id -un)" --datadir="$D" --socket="$S" --skip-networking \
          --pid-file="${TMPDIR:-/tmp}/pixcart-setup.pid" >"${TMPDIR:-/tmp}/pixcart-setup.log" 2>&1 &
      for _ in $(seq 1 30); do mariadb-admin --socket="$S" ping >/dev/null 2>&1 && break; sleep 1; done
    fi
    MYSQL_ARGS="--socket=$S"
    OWN_SERVER=1
  elif command -v mariadb >/dev/null 2>&1 \
       && mariadb -h 127.0.0.1 -P 3306 -u root --skip-ssl -e "SELECT 1" >/dev/null 2>&1; then
    MYSQL_ARGS="-h 127.0.0.1 -P 3306 -u root --skip-ssl"
    OWN_SERVER=0   # borrowed: never shut down a server we did not start
  else
    echo "${RED}No reachable MySQL-compatible engine${OFF}" >&2
    echo "  start a server, or export MYSQL_ARGS=\"-h 127.0.0.1 -P 3306 -u root\"" >&2
    exit 1
  fi
fi

# run <sql>   — returns the SQL output, warnings stripped (see verify-migrations.sh M()).
# Errors are NOT stripped; they are how a caller notices a failure.
run() { mariadb $MYSQL_ARGS -N -B -e "$1" 2>&1 | grep -v '^WARNING:'; }
# exec_sql_file <file> — run a migration file, printing only a real failure.
apply() {
  local f="$1" err
  if err="$(mariadb $MYSQL_ARGS "$DB" < "$f" 2>&1)"; then
    echo "  ${GREEN}applied${OFF} $(basename "$f")"
  else
    echo "  ${RED}FAILED${OFF} $(basename "$f")"
    printf '%s\n' "$err" | grep -v '^WARNING:' | head -8 | sed 's/^/      /'
    return 1
  fi
}

echo "${BOLD}PixCart — development database setup${OFF}"
echo "${DIM}target: $DB   login: $DB_USER   migrations: $MIGRATIONS${OFF}"
echo

# ---------------------------------------------------------------- refuse, don't guess
exists="$(run "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$DB'")"
if [[ -n "$exists" ]]; then
  tables="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$DB'")"
  if [[ "$tables" -gt 0 && "$REBUILD" -eq 0 ]]; then
    echo "${RED}$DB already has $tables table(s) and --rebuild was not given${OFF}"
    echo "  dropping a database is irreversible, so this script will not do it unasked."
    echo "  inspect first:  ${DIM}mariadb $MYSQL_ARGS -e 'SHOW TABLES' $DB${OFF}"
    echo "  then rebuild:   ${DIM}$0 --rebuild${OFF}"
    exit 2
  fi
  if [[ "$tables" -gt 0 ]]; then
    echo "${BOLD}1. drop existing database${OFF} ${DIM}(--rebuild was given)${OFF}"
    if [[ "$DB" == "mysql" || "$DB" == "sys" || "$DB" == "information_schema" || "$DB" == "performance_schema" ]]; then
      echo "  ${RED}refusing to drop the system schema '$DB'${OFF}"; exit 1
    fi
    run "DROP DATABASE \`$DB\`" >/dev/null
    echo "  ${GREEN}dropped${OFF} $DB"
    echo
  fi
fi

echo "${BOLD}1. create database and login${OFF}"
# CHARACTER SET utf8mb4 and NOTHING else, byte-for-byte what verify-migrations.sh does. An
# explicit COLLATE here (utf8mb4_unicode_ci) made V003 fail with
# "ERROR 1005 ... Foreign key constraint is incorrectly formed": a table created with an
# explicit DEFAULT CHARSET resolves a different collation than one inheriting the database
# default, and cat_variant.listing_id -> cat_listing.id must match character-for-character
# or MySQL refuses the foreign key. Pinning a collation in one place and not the other is
# how you get a schema that verifies in one database and will not build in another.
run "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4" >/dev/null
echo "  ${GREEN}database${OFF} $DB"
# Hosts cover both a socket peer and a TCP client on the same box. The password is a DEV
# credential that exists only in this script and .env.example; Vol. 10 §10.5 forbids a real
# one from living in the repository, and a production schema name is refused below.
if mariadb $MYSQL_ARGS -N -B -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD'" 2>/dev/null \
   && mariadb $MYSQL_ARGS -N -B -e "CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD'" 2>/dev/null; then
  :
fi
mariadb $MYSQL_ARGS -N -B -e "GRANT ALL PRIVILEGES ON \`$DB\`.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON \`$DB\`.* TO '$DB_USER'@'127.0.0.1'; FLUSH PRIVILEGES" 2>/dev/null
echo "  ${GREEN}login${OFF}     $DB_USER (passwordless in dev, see .env.example)"
echo

echo "${BOLD}2. apply migrations in order${OFF}"
ok=1
while IFS= read -r f; do
  apply "$f" || { ok=0; break; }
done < <(printf '%s\n' "$MIGRATIONS"/V*.sql | sort)
[[ "$ok" -eq 1 ]] || { echo; echo "${RED}setup aborted${OFF}"; exit 1; }

tables="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_TYPE='BASE TABLE'")"
echo "  tables created: $tables"
echo

# ---------------------------------------------------------------- flyway history
# identity-svc is configured with baseline-on-migrate + baseline-version, which exists for the
# case where a schema was migrated out of band. Now that a setup path exists, the honest thing
# is to record what is actually applied so the baseline is a fallback rather than a fiction.
echo "${BOLD}3. record migration history${OFF}"
exists_hist="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='flyway_schema_history'")"
if [[ "$exists_hist" == "0" ]]; then
  run "CREATE TABLE \`$DB\`.flyway_schema_history (
         installed_rank INT NOT NULL,
         version VARCHAR(50),
         description VARCHAR(200) NOT NULL,
         type VARCHAR(20) NOT NULL,
         script VARCHAR(1000) NOT NULL,
         checksum INT,
         installed_by VARCHAR(100) NOT NULL,
         installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         execution_time INT NOT NULL,
         success BOOLEAN NOT NULL,
         PRIMARY KEY (installed_rank)
       )" >/dev/null
  rank=0
  while IFS= read -r f; do
    rank=$((rank+1))
    name="$(basename "$f")"
    ver="${name%%__*}"
    desc="${name#*__}"; desc="${desc%.sql}"
    run "INSERT INTO \`$DB\`.flyway_schema_history
           (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success)
         VALUES ($rank, '${ver#V}', '$desc', 'SQL', '$name', NULL, 'setup-dev-db', 0, 1)" >/dev/null
  done < <(printf '%s\n' "$MIGRATIONS"/V*.sql | sort)
  echo "  ${GREEN}recorded${OFF} $rank migration(s) in flyway_schema_history"
else
  echo "  ${DIM}flyway_schema_history already present — left alone${OFF}"
fi
echo

echo "${BOLD}4. sanity: the columns the code needs${OFF}"
# Asserted because these are exactly the columns that were missing from the hand-built schema
# and would only have surfaced as a runtime failure on the first login attempt.
check() { # label expected actual
  if [[ "$2" == "$3" ]]; then echo "  ${GREEN}PASS${OFF} $1"; else
    echo "  ${RED}FAIL${OFF} $1 (expected '$2', got '$3')"; exit 1; fi
}
norm="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA='$DB' AND COLUMN_NAME='email_norm'
                AND TABLE_NAME IN ('id_customer','id_staff','ven_store')")"
check "email_norm on all three principal tables" "3" "$norm"
hashc="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='id_staff' AND COLUMN_NAME='password_hash'")"
check "id_staff.password_hash exists (V008)" "1" "$hashc"
store="$(run "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='ven_store'")"
check "ven_store exists (not ven_vendor)" "1" "$store"
hist="$(run "SELECT COUNT(*) FROM \`$DB\`.flyway_schema_history")"
check "flyway_schema_history has all 8 migrations" "8" "$hist"
echo

echo "${GREEN}${BOLD}DEV DATABASE READY — $DB, $tables tables${OFF}"
echo
echo "next steps:"
echo "  ${DIM}cd services/bff && npm run seed${OFF}                  # demo data (idempotent)"
echo "  ${DIM}./scripts/provision-dev-credentials.ps1${OFF}          # staff/vendor passwords"
echo "  ${DIM}cp .env.example .env${OFF}                            # then point it at $DB"

if [[ "${OWN_SERVER:-0}" == "1" ]]; then
  mariadb-admin $MYSQL_ARGS shutdown >/dev/null 2>&1
fi
exit 0
