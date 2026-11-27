"""Builds the hand-over demo database package in <repo>/db from the local demo data (MySQL pixcart_parity, a fresh
copy of the demo data made with tools/DataMigrator):

  db/pixcart_demo_db.sql   one self-contained file: CREATE DATABASE pixcart_demo + full schema + demo data
  db/media/...             every public file the data refers to (product photos, partner photos, ...), same paths
  db/private/...           every private file the data refers to (generated "demo document" placeholders)

Run with the reference backend's virtual environment (it has cryptography, bcrypt and Pillow):
  "C:/Users/haris/Downloads/pixcart-marketplace 1/pixcart-marketplace/backend/.venv/Scripts/python.exe" -I tools/handover-kit/make_demo_db.py

What it removes or replaces: sessions, one-time codes, rate-limit rows, audit log, staff AI chats and usage, push
tokens, provider tokens, webhook logs; every password hash except the documented demo admin; two-step secrets;
payment-provider customer ids; test accounts get neutral names and clearly fake phone numbers; contact emails use
example.com; encrypted demo values (PAN, bank account, ID proof) are re-encrypted with the API's built-in development
key (appsettings.json App:FieldEncryptionKey) so a fresh install can read them; private documents are replaced by
generated placeholders; sign-in settings go back to the product defaults.
"""
import base64
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys

from cryptography.fernet import Fernet, InvalidToken

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = REPO / "db"
MYSQL = r"C:\Users\haris\pixcart-tools\mysql\bin\mysql.exe"
MYSQLDUMP = r"C:\Users\haris\pixcart-tools\mysql\bin\mysqldump.exe"
CONN = ["--host=127.0.0.1", "--port=3307", "--user=root", "--password=pixcart", "--default-character-set=utf8mb4"]
BUILD_DB, TARGET_DB = "pixcart_demo_build", "pixcart_demo"
# --source <database>: build from another local copy, e.g. the current package imported with
#   mysql ... < db/pixcart_demo_db.sql   (creates pixcart_demo)   then   make_demo_db.py --sanitize --source pixcart_demo
SRC_DB = next((sys.argv[i + 1] for i, a in enumerate(sys.argv[:-1]) if a == "--source"), "pixcart_parity")
REF_VAR = pathlib.Path(r"C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\backend\var")
# the demo API serves var/media-demo; the older copies are fall-backs
MEDIA_SRCS = [REF_VAR / "media-demo", REF_VAR / "media", pathlib.Path(r"C:\Users\haris\pixcart-tools\parity-media")]
PRIVATE_SRCS = [REF_VAR / "private", pathlib.Path(r"C:\Users\haris\pixcart-tools\parity-private")]
REF_ENV = pathlib.Path(r"C:\Users\haris\Downloads\pixcart-marketplace 1\pixcart-marketplace\backend\.env")
DEV_KEY = "62P9O54u1vWja43dxBhdx7DlDaxYQVgo27zjo_K_4fU="  # AppSettings.DevFieldEncryptionKey (development only)

ADMIN_EMAIL = "admin@pixcart.in"  # as db/README.md documents it
ADMIN_PASSWORD = "PixCart@Demo2026"
# default: the data exactly as it is (only the admin password is set to the documented one and encrypted values are
# moved onto the development key); --sanitize also empties logs and sessions and anonymises test accounts
SANITIZE = "--sanitize" in sys.argv
# curated demo accounts that keep their phone numbers (sellers, demo customer, delivery partners, seeded shoppers)
KEEP_PHONES = {"9000000001", "9000000002", "9000000003", "9999900001", "7300000001", "7300000002", "7300000003",
               "9876500011", "9876500022"}
# activity and secret tables emptied in the demo package
EMPTY = ["refresh_sessions", "otp_challenges", "rate_limit_events", "audit_logs", "assistant_conversations",
         "assistant_messages", "assistant_actions", "assistant_uploads", "ai_runs", "integration_tokens", "push_tokens",
         "shop_chat_actions", "shop_chat_messages", "shop_chat_sessions", "webhook_events", "translations"]


def run(args, stdin=None, db=None):
    cmd = [MYSQL, *CONN, "-N", "-B"] + ([db] if db else []) + args
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise SystemExit(f"mysql failed: {r.stderr.strip()[:500]}")
    return r.stdout


def q(sql, db=BUILD_DB):
    return run(["-e", sql], db=db)


def rows(sql, db=BUILD_DB):
    out = q(sql, db)
    return [line.split("\t") for line in out.splitlines() if line]


def lit(v):
    """A MySQL string literal."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("\\", "\\\\").replace("'", "''") + "'"


def ref_key():
    m = re.search(r"^FIELD_ENCRYPTION_KEY=\s*\"?([A-Za-z0-9_\-=]+)", REF_ENV.read_text(encoding="utf-8"), re.M)
    return Fernet(m.group(1).encode())


def main():
    old, new = ref_key(), Fernet(DEV_KEY.encode())

    def recrypt(token):
        if not token:
            return token
        try:
            plain = old.decrypt(token.encode())
        except InvalidToken:
            plain = new.decrypt(token.encode())  # already on the development key
        return new.encrypt(plain).decode()

    # 1. a scratch copy of the demo data
    if rows(f"SELECT 1 FROM information_schema.schemata WHERE schema_name='{BUILD_DB}'", db=None):
        q(f"DROP DATABASE `{BUILD_DB}`", db=None)  # this script's own scratch database
    q(f"CREATE DATABASE `{BUILD_DB}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci", db=None)
    dump = subprocess.run([MYSQLDUMP, *CONN, "--single-transaction", "--no-tablespaces", "--set-gtid-purged=OFF",
                           "--routines", "--triggers", "--events", "--hex-blob", SRC_DB],
                          capture_output=True, text=True, encoding="utf-8")
    if dump.returncode:
        raise SystemExit(dump.stderr[:500])
    run([], stdin=dump.stdout, db=BUILD_DB)

    # 2. activity, sessions and secrets
    if SANITIZE:
        q("SET FOREIGN_KEY_CHECKS=0; " + " ".join(f"TRUNCATE TABLE `{t}`;" for t in EMPTY) + " SET FOREIGN_KEY_CHECKS=1;")
        q("UPDATE platform_settings SET value='{}' WHERE `key`='auth'")  # sign-in settings: product defaults
        # nobody is on duty in a fresh install: partners go online from their app (no partner shown as free since days)
        q("UPDATE delivery_boys SET is_online=0, online_since=NULL")

    # 3. accounts: one documented demo admin, no other password hashes, no two-step secrets or provider ids
    import bcrypt
    admin_hash = bcrypt.hashpw(ADMIN_PASSWORD.encode(), bcrypt.gensalt(12)).decode()
    admins = rows("SELECT id FROM users WHERE is_admin=1 ORDER BY created_at")
    if SANITIZE:
        q("UPDATE users SET password_hash=NULL, totp_secret_enc=NULL, totp_enabled=0, razorpay_customer_id=NULL, "
          "last_login_at=NULL, sessions_valid_after=NULL")
        q(f"UPDATE users SET email={lit(ADMIN_EMAIL)}, name='Demo Admin', password_hash={lit(admin_hash)} "
          f"WHERE id={lit(admins[0][0])}")
        for extra in admins[1:]:
            q(f"UPDATE users SET is_admin=0, admin_role='' WHERE id={lit(extra[0])}")
    else:
        q(f"UPDATE users SET password_hash={lit(admin_hash)}, totp_enabled=0, totp_secret_enc=NULL "
          f"WHERE id={lit(admins[0][0])}")
    admin_email = rows(f"SELECT email FROM users WHERE id={lit(admins[0][0])}")[0][0]

    # 4. test accounts: neutral names, clearly fake phone numbers (also in every copied place: addresses, orders, ...)
    remap = {}
    if SANITIZE:
        remap, n_shopper, n_partner, n_seller = {}, 0, 0, 0
        partners = {r[0] for r in rows("SELECT user_id FROM delivery_boys")}
        sellers = {r[0] for r in rows("SELECT user_id FROM sellers")}
        for uid, name, phone in rows("SELECT id, name, IFNULL(phone,'') FROM users WHERE deleted_at IS NULL ORDER BY created_at"):
            if not phone or phone in KEEP_PHONES:
                continue
            if uid in partners:
                n_partner += 1
                new_phone, new_name = f"73000000{3 + n_partner:02d}", f"Demo Partner {n_partner}"
            elif uid in sellers:
                n_seller += 1
                new_phone, new_name = f"90000000{3 + n_seller:02d}", f"Demo Seller Applicant {n_seller}"
            else:
                n_shopper += 1
                new_phone, new_name = f"99999000{10 + n_shopper:02d}", f"Demo Shopper {n_shopper}"
            remap[phone] = new_phone
            if name and name not in remap:
                remap[name] = new_name
            q(f"UPDATE users SET phone={lit(new_phone)}, name={lit(new_name)} WHERE id={lit(uid)}")
        remap["pixcart-demo.in"] = "example.com"
        # leftovers of automated test runs: neutral demo wording (specific phrases first, then the plain word)
        remap.update({
            "Parity Test Store": "Demo Draft Store", "parity-test-store": "demo-draft-store",
            "Parity test, not a real order": "Demo order, not a real purchase", "Parity test note": "Demo cancellation note",
            "Parity test shirt, scroll trace": "Cotton casual shirt, sample A", "parity-test-shirt-scroll-trace": "cotton-casual-shirt-sample-a",
            "Parity test shirt, scroll check": "Cotton casual shirt, sample B", "parity-test-shirt-scroll-check": "cotton-casual-shirt-sample-b",
            "Parity test kurta, cotton regular fit": "Cotton kurta, regular fit", "parity-test-kurta-cotton-regular-fit": "cotton-kurta-regular-fit",
            "Scenario return": "Demo return", "Parity": "Demo", "parity": "demo",
            "http://localhost:3100": "http://localhost:4201", "http://localhost:3200": "http://localhost:4201",
        })
        cols = rows("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema="
                    f"'{BUILD_DB}' AND data_type IN ('varchar','text','mediumtext','longtext','json','char','tinytext') "
                    "AND extra NOT LIKE '%GENERATED%'")
        stmts = []
        for table, col, dtype in cols:
            if (table, col) in {("users", "phone"), ("users", "name"), ("users", "password_hash")}:
                continue
            for a, b in remap.items():
                if dtype == "json":
                    stmts.append(f"UPDATE `{table}` SET `{col}`=CAST(REPLACE(CAST(`{col}` AS CHAR), {lit(a)}, {lit(b)}) AS JSON) "
                                 f"WHERE CAST(`{col}` AS CHAR) LIKE {lit('%' + a + '%')};")
                else:
                    stmts.append(f"UPDATE `{table}` SET `{col}`=REPLACE(`{col}`, {lit(a)}, {lit(b)}) WHERE `{col}` LIKE {lit('%' + a + '%')};")
        run([], stdin="SET FOREIGN_KEY_CHECKS=0;\n" + "\n".join(stmts) + "\nSET FOREIGN_KEY_CHECKS=1;\n", db=BUILD_DB)
        q("UPDATE return_requests SET refund_upi='demo@upi' WHERE refund_upi IS NOT NULL AND refund_upi<>''")
        q("UPDATE sellers SET contact_email=CONCAT('seller-', LEFT(id, 8), '@example.com') WHERE contact_email IS NOT NULL "
          "AND contact_email<>'' AND contact_email NOT LIKE '%@example.com'")

    # 5. encrypted demo values onto the development key
    def enc(is_null, v):
        return "NULL" if is_null == "1" else lit(recrypt(v) if v else v)

    for sid, pn, pan, bn, bank in rows("SELECT id, pan_enc IS NULL, IFNULL(pan_enc,''), bank_account_enc IS NULL, "
                                       "IFNULL(bank_account_enc,'') FROM sellers"):
        q(f"UPDATE sellers SET pan_enc={enc(pn, pan)}, bank_account_enc={enc(bn, bank)}, payout_fund_account_id='', "
          f"payout_contact_id='', razorpay_account_id='' WHERE id={lit(sid)}")
    for did, inull, idp, bnull, bank in rows("SELECT id, id_proof_enc IS NULL, IFNULL(id_proof_enc,''), "
                                             "bank_details IS NULL, IFNULL(bank_details,'') FROM delivery_boys"):
        bd = json.loads(bank) if bank else None
        if isinstance(bd, dict) and bd.get("account_enc"):
            bd["account_enc"] = recrypt(bd["account_enc"])
        bank_sql = "NULL" if bnull == "1" else lit(json.dumps(bd) if bd is not None else bank)
        q(f"UPDATE delivery_boys SET id_proof_enc={enc(inull, idp)}, bank_details={bank_sql} WHERE id={lit(did)}")

    # 6. the single .sql file
    OUT.mkdir(exist_ok=True)
    d = subprocess.run([MYSQLDUMP, *CONN, "--single-transaction", "--no-tablespaces", "--set-gtid-purged=OFF",
                        "--routines", "--triggers", "--events", "--hex-blob", "--complete-insert", "--skip-dump-date",
                        "--skip-comments", BUILD_DB], capture_output=True, text=True, encoding="utf-8")
    if d.returncode:
        raise SystemExit(d.stderr[:500])
    header = (f"-- PixCart demo database (schema + demo data). MySQL 8.4, utf8mb4.\n"
              f"-- Import on an empty server:  mysql -u root -p < pixcart_demo_db.sql   (creates the database `{TARGET_DB}`)\n"
              f"-- Admin sign-in: {admin_email} / {ADMIN_PASSWORD}. See db/README.md.\n\n"
              f"CREATE DATABASE IF NOT EXISTS `{TARGET_DB}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\n"
              f"USE `{TARGET_DB}`;\n\n")
    sql = header + d.stdout
    (OUT / "pixcart_demo_db.sql").write_text(sql, encoding="utf-8", newline="\n")

    # 7. files the data refers to, at the same paths
    media_refs = sorted(set(re.findall(r"/media/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{2,5})", sql)))
    private_refs = sorted(set(re.findall(r"['\"]((?:delivery-kyc|delivery-proof|kyc|seller-docs)/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]{2,5})", sql)))
    import tempfile
    previous = pathlib.Path(tempfile.mkdtemp(prefix="pixcart-demo-media-"))  # the last package's files: a fall-back source
    if (OUT / "media").exists():
        shutil.copytree(OUT / "media", previous / "media")
    media_srcs = MEDIA_SRCS + [previous / "media"]
    for sub in ("media", "private"):
        if (OUT / sub).exists():
            shutil.rmtree(OUT / sub)  # rebuilt from scratch on every run
    missing = []
    for rel in media_refs:
        src = next((s / rel for s in media_srcs if (s / rel).exists()), MEDIA_SRCS[0] / rel)
        if not src.exists():
            missing.append("media/" + rel)
            continue
        dst = OUT / "media" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    from PIL import Image, ImageDraw
    for rel in private_refs:
        dst = OUT / "private" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if not SANITIZE:
            src = next((s / rel for s in PRIVATE_SRCS if (s / rel).exists()), None)
            if src is None:
                missing.append("private/" + rel)
            else:
                shutil.copyfile(src, dst)
            continue
        label = "Proof of delivery (demo)" if rel.startswith("delivery-proof") else "Demo document"
        img = Image.new("RGB", (480, 320), (233, 240, 242))
        draw = ImageDraw.Draw(img)
        draw.rectangle([12, 12, 467, 307], outline=(17, 94, 89), width=4)
        draw.text((40, 140), f"PixCart - {label}", fill=(17, 94, 89))
        ext = rel.rsplit(".", 1)[1].lower()
        img.save(dst, {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "pdf": "PDF"}.get(ext, "PNG"))

    # 8. checks: every encrypted value opens with the development key; no secrets; only the demo admin has a hash
    tokens = set(re.findall(r"gAAAAA[A-Za-z0-9_\-=]{20,}", sql))
    bad_tokens = [t[:12] for t in tokens if not _opens(new, t)]
    hashes = re.findall(r"\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}", sql)
    emails = sorted(set(re.findall(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", sql)))
    real_emails = [e for e in emails if e != ADMIN_EMAIL and not re.search(r"(@example\.com|\.example|@deleted\.invalid|@upi)$", e)]
    secrets = re.findall(r"rzp_live_\w+|sk-[A-Za-z0-9]{20,}|sk_live_\w+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY", sql)
    report = {"sql_bytes": len(sql.encode()), "tables": len(re.findall(r"^CREATE TABLE", sql, re.M)),
              "media_files": len(media_refs) - len([m for m in missing if m.startswith("media/")]),
              "private_files": len(private_refs), "mode": "sanitized" if SANITIZE else "as-is", "missing_files": missing,
              "encrypted_values": len(tokens), "encrypted_values_not_on_dev_key": bad_tokens,
              "password_hashes": len(hashes), "emails": emails, "non_demo_emails": real_emails,
              "secret_like_strings": secrets, "renamed": {k: v for k, v in remap.items() if not k.isdigit()},
              "phones_replaced": len([k for k in remap if k.isdigit()])}
    print(json.dumps(report, indent=1, ensure_ascii=False))
    if bad_tokens or len(hashes) != 1 or secrets or missing or (SANITIZE and real_emails):
        raise SystemExit("CHECK FAILED (see the report above)")


def _opens(f, token):
    try:
        f.decrypt(token.encode())
        return True
    except InvalidToken:
        return False


if __name__ == "__main__":
    main()
