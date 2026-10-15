#!/usr/bin/env bash
# scripts/verify-migrations.sh — apply every migration in order against a live engine and
# re-run the invariants the slices proved, so the schema guarantees are reproducible by
# anyone, not just asserted in a commit message.
#
# Local: expects a MySQL-compatible server. Defaults to a throwaway MariaDB on a unix socket
# (what the development sandbox has); override with MYSQL_ARGS to point at MySQL 8.
#   MYSQL_ARGS="-h 127.0.0.1 -P 3306 -u root -proot" ./scripts/verify-migrations.sh
#
# CI runs this against the MySQL 8 service container (Vol. 11 §11.4 stage 5).

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/infra/db/migrations"
DB="${DB_NAME:-pixcart_verify}"

RED=$'\033[31m'; GREEN=$'\033[32m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
fails=0
check() { # check <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  ${GREEN}PASS${OFF} $1"; else echo "  ${RED}FAIL${OFF} $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi
}

OWN_SERVER=0
if [[ -z "${MYSQL_ARGS:-}" ]]; then
  # start a throwaway MariaDB on a socket
  D="${TMPDIR:-/tmp}/pixcart-verify-data"; S="${TMPDIR:-/tmp}/pixcart-verify.sock"
  rm -rf "$D"; mkdir -p "$D"
  mariadb-install-db --datadir="$D" --user="$(id -un)" --auth-root-authentication-method=normal >/dev/null 2>&1
  /usr/sbin/mariadbd --user="$(id -un)" --datadir="$D" --socket="$S" --skip-networking \
      --pid-file="${TMPDIR:-/tmp}/pixcart-verify.pid" >"${TMPDIR:-/tmp}/pixcart-verify.log" 2>&1 &
  for _ in $(seq 1 30); do mariadb-admin --socket="$S" ping >/dev/null 2>&1 && break; sleep 1; done
  MYSQL_ARGS="--socket=$S"
  OWN_SERVER=1
fi
M() { mariadb $MYSQL_ARGS "$DB" -N -B -e "$1" 2>&1; }
cleanup() { [[ "$OWN_SERVER" == "1" ]] && mariadb-admin $MYSQL_ARGS shutdown >/dev/null 2>&1; }
trap cleanup EXIT

echo "${BOLD}PixCart — migration & invariant verification${OFF}"
mariadb $MYSQL_ARGS -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4" 2>&1 | grep -i error && exit 1

echo
echo "${BOLD}1. apply migrations in order${OFF}"
# Read the sorted list one path per line. `for f in $(ls ...)` word-splits on any space
# in the path, which is exactly what happens in a checkout dir named "pixcart source
# new": the loop then opened /c/Users/haris/Downloads/pixcart as a migration. Glob
# expansion is already lexicographic, so the printf keeps `sort` without the split.
while IFS= read -r f; do
  name="$(basename "$f")"
  if err="$(mariadb $MYSQL_ARGS "$DB" < "$f" 2>&1)"; then
    echo "  ${GREEN}applied${OFF} $name"
  else
    echo "  ${RED}FAILED${OFF} $name"; echo "$err" | head -5 | sed 's/^/      /'; fails=$((fails+1))
  fi
done < <(printf '%s\n' "$MIGRATIONS"/V*.sql | sort)
tables="$(M "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB'")"
echo "  tables created: $tables"

echo
echo "${BOLD}2. constraint invariants${OFF}"

# inventory: reserved may never exceed on_hand (ck_inv_nonneg)
M "INSERT INTO cat_category (id,parent_id,name,slug,attribute_schema) VALUES ('01VCAT0000000000000000001',NULL,'C','c-verify','{}')" >/dev/null
M "INSERT INTO cat_product (id,category_id,title,attributes,hsn_code) VALUES ('01VPRD0000000000000000001','01VCAT0000000000000000001','P','{}','6109')" >/dev/null
M "INSERT INTO cat_listing (id,vendor_id,product_id,title,mrp,price,attributes,hsn_code) VALUES ('01VLST0000000000000000001','01VVND0000000000000000001','01VPRD0000000000000000001','P',100.00,100.00,'{}','6109')" >/dev/null
M "INSERT INTO cat_variant (id,listing_id,sku,option_map) VALUES ('01VVAR0000000000000000001','01VLST0000000000000000001','VERIFY-SKU','{}')" >/dev/null
M "INSERT INTO inv_location (id,vendor_id,name,pincode) VALUES ('01VLOC0000000000000000001','01VVND0000000000000000001','FC','641012')" >/dev/null
M "INSERT INTO inv_item (variant_sku,location_id,on_hand,reserved) VALUES ('VERIFY-SKU','01VLOC0000000000000000001',10,0)" >/dev/null
oversell="$(M "UPDATE inv_item SET reserved=reserved+11 WHERE variant_sku='VERIFY-SKU'" | grep -c 'ck_inv_nonneg')"
check "ck_inv_nonneg blocks overselling" "1" "$oversell"

# sub-order state vocabulary (V004)
M "INSERT INTO ord_order (id,customer_id,quote_id,item_total,tax_total,grand_total,promo_allocation,ship_address,placed_at) VALUES ('01VORD0000000000000000001','01VCUS0000000000000000001','01VQTE0000000000000000001',100.00,0.00,100.00,'{}','{}','2026-08-15 10:00:00.000')" >/dev/null
badstate="$(M "INSERT INTO ord_sub_order (id,order_id,vendor_id,state,sla_accept_by,sla_ship_by) VALUES ('01VSUB0000000000000000001','01VORD0000000000000000001','01VVND0000000000000000001','TELEPORTED','2026-08-15 14:00:00.000','2026-08-17 10:00:00.000')" | grep -c 'ck_sub_order_state')"
check "ck_sub_order_state rejects an unknown state" "1" "$badstate"

# wallet non-negative (V005)
M "INSERT INTO wal_balance (customer_id,cash_paise) VALUES ('01VCUS0000000000000000001',50000)" >/dev/null
overdraft="$(M "UPDATE wal_balance SET cash_paise=cash_paise-50001 WHERE customer_id='01VCUS0000000000000000001'" | grep -c 'ck_wal_nonneg')"
check "ck_wal_nonneg blocks a wallet overdraft" "1" "$overdraft"

# loyalty non-negative (V005)
M "INSERT INTO loy_balance (customer_id,points) VALUES ('01VCUS0000000000000000001',1000)" >/dev/null
overredeem="$(M "UPDATE loy_balance SET points=points-1500 WHERE customer_id='01VCUS0000000000000000001'" | grep -c 'ck_loy_nonneg')"
check "ck_loy_nonneg blocks an over-redemption" "1" "$overredeem"

echo
echo "${BOLD}3. double-entry ledger closure${OFF}"
# capture 900 = vendor 810 + commission 90, then a full refund reversal
M "INSERT INTO fin_ledger_entry (id,journal_id,account_code,debit,credit,ref_type,ref_id,event_id,period) VALUES
 ('01VLG0CAPCLR000000000001','01VJRNCAP00000000000001','GATEWAY_CLEARING',900.00,0,'ORDER','01VORD0000000000000000001','01VEVTCAP0000000000001','2026-08'),
 ('01VLG0CAPVPY000000000001','01VJRNCAP00000000000001','VENDOR_PAYABLE',0,810.00,'ORDER','01VORD0000000000000000001','01VEVTCAP0000000000001','2026-08'),
 ('01VLG0CAPCMM000000000001','01VJRNCAP00000000000001','PLATFORM_COMMISSION',0,90.00,'ORDER','01VORD0000000000000000001','01VEVTCAP0000000000001','2026-08'),
 ('01VLG0REFVPY000000000001','01VJRNREF00000000000001','VENDOR_PAYABLE',810.00,0,'REFUND','01VORD0000000000000000001','01VEVTREF0000000000001','2026-08'),
 ('01VLG0REFCMM000000000001','01VJRNREF00000000000001','PLATFORM_COMMISSION',90.00,0,'REFUND','01VORD0000000000000000001','01VEVTREF0000000000001','2026-08'),
 ('01VLG0REFCLR000000000001','01VJRNREF00000000000001','GATEWAY_CLEARING',0,900.00,'REFUND','01VORD0000000000000000001','01VEVTREF0000000000001','2026-08')" >/dev/null
unbalanced="$(M "SELECT COUNT(*) FROM (SELECT journal_id FROM fin_ledger_entry GROUP BY journal_id HAVING SUM(debit)<>SUM(credit)) t")"
check "every journal balances (Sigma debit == Sigma credit)" "0" "$unbalanced"
netall="$(M "SELECT CAST(SUM(debit-credit) AS DECIMAL(18,2)) FROM fin_ledger_entry")"
check "capture+refund closes all accounts to zero" "0.00" "$netall"
replay="$(M "INSERT INTO fin_ledger_entry (id,journal_id,account_code,debit,credit,ref_type,ref_id,event_id,period) VALUES ('01VLG0DUP00000000000001','01VJRNCAP00000000000001','GATEWAY_CLEARING',900.00,0,'ORDER','01VORD0000000000000000001','01VEVTCAP0000000000001','2026-08')" | grep -c 'uq_ledger_event_leg')"
check "uq_ledger_event_leg blocks a ledger replay" "1" "$replay"

# V008: staff/vendor credentials and the VENDOR session principal
# ------------------------------------------------------------------------
# password_hash is NULL until an operator provisions it, and a NULL hash must
# never be writable as a non-null placeholder — a placeholder hash is a
# credential, i.e. a second unknown password.
hashnull="$(M "SELECT (SELECT COUNT(*) FROM id_staff WHERE password_hash IS NOT NULL)
             + (SELECT COUNT(*) FROM ven_store WHERE password_hash IS NOT NULL)")"
check "V008 leaves every staff/vendor hash NULL until provisioned" "0" "$hashnull"

# ven_store gained the same generated email_norm the other two principal tables
# have, so the login lookup stays index-backed and lower-casing lives in one place.
# Asserted as PARITY with the other two rather than as "is_nullable = NO": MariaDB
# reports every STORED GENERATED column as nullable regardless of its source, so a
# nullability check would fail against id_customer too and would prove nothing. What
# matters is (a) the same generation expression and (b) a NOT NULL source column,
# which together make a NULL email_norm unrepresentable.
norm="$(M "SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema='$DB' AND column_name='email_norm'
             AND table_name IN ('id_customer','id_staff','ven_store')
             AND generation_expression = 'lcase(\`email\`)'
             AND extra = 'STORED GENERATED'
             AND column_type = 'varchar(254)'")"
check "ven_store.email_norm is generated exactly as id_customer/id_staff do" "3" "$norm"
srcnotnull="$(M "SELECT is_nullable FROM information_schema.columns
                  WHERE table_schema='$DB' AND table_name='ven_store' AND column_name='email'")"
check "ven_store.email is NOT NULL, so email_norm can never be NULL" "NO" "$srcnotnull"
hasindex="$(M "SELECT COUNT(*) FROM information_schema.statistics
                WHERE table_schema='$DB' AND table_name='ven_store'
                  AND index_name='uq_store_email_norm' AND column_name='email_norm'")"
check "ven_store.email_norm is unique-keyed for the login lookup" "1" "$hasindex"

# id_session must now admit a VENDOR principal (a vendor operator is a ven_store
# row) and still refuse anything else — widening a CHECK is only safe if the
# boundary moved by exactly the intended amount.
M "INSERT INTO id_session (id,principal_type,principal_id,created_at) VALUES ('01VSESVENDOR00000000000001','VENDOR','01VVND0000000000000000001','2026-08-15 10:00:00.000')" >/dev/null
vendorok="$(M "SELECT principal_type FROM id_session WHERE id='01VSESVENDOR00000000000001'")"
check "ck_session_ptype admits a VENDOR principal" "VENDOR" "$vendorok"
badtype="$(M "INSERT INTO id_session (id,principal_type,principal_id,created_at) VALUES ('01VSESROBOT000000000000001','ROBOT','01VVND0000000000000000001','2026-08-15 10:00:00.000')" | grep -c 'ck_session_ptype')"
check "ck_session_ptype still refuses an unknown principal type" "1" "$badtype"

echo
if [[ "$fails" -eq 0 ]]; then
  echo "${GREEN}${BOLD}MIGRATIONS + INVARIANTS VERIFIED${OFF}"
  exit 0
else
  echo "${RED}${BOLD}${fails} check(s) failed${OFF}"
  exit 1
fi
