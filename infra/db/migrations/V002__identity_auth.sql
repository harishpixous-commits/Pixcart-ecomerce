-- V002__identity_auth.sql
-- Identity module completion. Tables id_staff, id_mfa_factor, id_session come from the
-- Vol. 6 §6.3 module catalogue; id_otp_challenge and id_refresh_token realise the
-- normative mechanisms of Vol. 10 §10.3 (OTP: 6-digit/5-min/3-attempt; refresh tokens:
-- opaque, rotating, family reuse-detection → family revoke). Columns not enumerated in
-- §6.3 are elaborations and each carries the governing reference inline.

CREATE TABLE id_staff (
  id            CHAR(26) PRIMARY KEY,
  email         VARCHAR(254) NOT NULL,
  email_norm    VARCHAR(254) GENERATED ALWAYS AS (LOWER(email)) STORED,
  full_name     VARCHAR(120) NOT NULL,
  -- Vol. 2 §2.4 staff roles (Customer/Vendor principals live in their own tables;
  -- DELIVERY operates through the partner portal but authenticates as staff-class)
  role          VARCHAR(16) NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  mfa_enforced  TINYINT(1)  NOT NULL DEFAULT 1,   -- §10.3: admin access ⇒ mandatory MFA
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                  ON UPDATE CURRENT_TIMESTAMP(3),
  row_version   INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_staff_email (email_norm),
  CONSTRAINT ck_staff_role CHECK (role IN
    ('ADMIN','SUPER_ADMIN','FINANCE','MARKETING','WAREHOUSE','DELIVERY','SUPPORT')),
  CONSTRAINT ck_staff_status CHECK (status IN ('ACTIVE','SUSPENDED','DELETED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE id_mfa_factor (
  id             CHAR(26) PRIMARY KEY,
  principal_type VARCHAR(10) NOT NULL,            -- CUSTOMER | STAFF
  principal_id   CHAR(26) NOT NULL,
  kind           VARCHAR(10) NOT NULL,            -- §10.3: TOTP RFC 6238; RECOVERY ×10
  secret_enc     VARBINARY(256) NULL,             -- TOTP secret, encrypted at rest (§10.4)
  code_hash      VARBINARY(64)  NULL,             -- recovery codes stored hashed, single-use
  used_at        TIMESTAMP(3) NULL,
  verified_at    TIMESTAMP(3) NULL,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at     TIMESTAMP(3) NULL,
  KEY ix_mfa_principal (principal_type, principal_id, kind),
  CONSTRAINT ck_mfa_ptype CHECK (principal_type IN ('CUSTOMER','STAFF')),
  CONSTRAINT ck_mfa_kind  CHECK (kind IN ('TOTP','RECOVERY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE id_otp_challenge (
  id            CHAR(26) PRIMARY KEY,
  principal     VARCHAR(254) NOT NULL,            -- mobile or email being proven
  purpose       VARCHAR(10) NOT NULL,
  code_hash     VARBINARY(64) NOT NULL,           -- FR-CUS-001: 6-digit CSPRNG, hashed
  attempts_used TINYINT NOT NULL DEFAULT 0,       -- FR-CUS-001: 3 attempts
  max_attempts  TINYINT NOT NULL DEFAULT 3,
  expires_at    DATETIME(3) NOT NULL,             -- FR-CUS-001: 5-minute TTL
  resend_after  DATETIME(3) NOT NULL,             -- FR-CUS-001: 30 s resend cool-down
  consumed_at   TIMESTAMP(3) NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_otp_principal (principal, purpose, created_at),
  CONSTRAINT ck_otp_purpose  CHECK (purpose IN ('REGISTER','LOGIN','RESET','STEP_UP')),
  CONSTRAINT ck_otp_attempts CHECK (attempts_used BETWEEN 0 AND max_attempts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per device login. The session IS the refresh-token family (§10.3);
-- the concurrent cap of 8 devices is enforced by the service at issue time.
CREATE TABLE id_session (
  id                CHAR(26) PRIMARY KEY,
  principal_type    VARCHAR(10) NOT NULL,
  principal_id      CHAR(26) NOT NULL,
  device_label      VARCHAR(120) NULL,            -- §10.3: device list & revoke
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at        TIMESTAMP(3) NULL,
  reuse_detected_at TIMESTAMP(3) NULL,            -- §10.3: reuse ⇒ whole family revoked
  KEY ix_session_principal (principal_type, principal_id, revoked_at),
  CONSTRAINT ck_session_ptype CHECK (principal_type IN ('CUSTOMER','STAFF'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE id_refresh_token (
  id          CHAR(26) PRIMARY KEY,
  session_id  CHAR(26) NOT NULL,
  token_hash  VARBINARY(64) NOT NULL,             -- opaque token, stored hashed (§10.3)
  issued_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at  DATETIME(3) NOT NULL,
  used_at     TIMESTAMP(3) NULL,                  -- set on rotation; a second use = reuse
  replaced_by CHAR(26) NULL,
  UNIQUE KEY uq_refresh_hash (token_hash),
  KEY ix_refresh_session (session_id, issued_at),
  CONSTRAINT fk_refresh_session FOREIGN KEY (session_id) REFERENCES id_session(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
