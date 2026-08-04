-- V005__wallet_loyalty.sql
-- Closed-loop wallet (FR-CUS-019) and loyalty points (FR-CUS-020). Both are append-only
-- ledgers: a balance is the sum of its entries, which gives idempotency (uq on reference),
-- auditability, and "negative balance impossible by design" (a debit is only ever written
-- when the serialised balance check passes; the CHECK here is the last-resort guard).

-- Wallet is bucketed: CASH (never expires) and PROMO (default 90-day expiry), consumed
-- earliest-expiry-first (FR-CUS-019 VALIDATION). Each row is a signed movement in paise.
CREATE TABLE wal_entry (
  id            CHAR(26) PRIMARY KEY,
  customer_id   CHAR(26) NOT NULL,
  bucket        VARCHAR(8) NOT NULL,          -- CASH | PROMO
  amount_paise  BIGINT NOT NULL,              -- +credit / -debit
  reason        VARCHAR(24) NOT NULL,         -- REFUND | CASHBACK | SPEND | EXPIRY | REVERSAL
  reference     VARCHAR(64) NOT NULL,         -- idempotency key (payment/refund/order ref)
  expires_at    DATETIME(3) NULL,             -- PROMO credits only; NULL for CASH
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wal_reference (reference, reason),   -- replay-safe
  KEY ix_wal_customer (customer_id, bucket, created_at),
  CONSTRAINT ck_wal_bucket CHECK (bucket IN ('CASH','PROMO')),
  CONSTRAINT ck_wal_reason CHECK (reason IN ('REFUND','CASHBACK','SPEND','EXPIRY','REVERSAL'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A per-customer materialised balance guards the invariant at write time (serialised
-- debits, FR-CUS-019). The service updates this in the SAME transaction as the wal_entry
-- insert, with the CHECK making a negative balance physically impossible.
CREATE TABLE wal_balance (
  customer_id   CHAR(26) PRIMARY KEY,
  cash_paise    BIGINT NOT NULL DEFAULT 0,
  promo_paise   BIGINT NOT NULL DEFAULT 0,
  row_version   INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                    ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_wal_nonneg CHECK (cash_paise >= 0 AND promo_paise >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Loyalty points ledger (FR-CUS-020): integer points, 1 pt = ₹1 redemption unless config
-- differs. Accrual after return-window lapse; returns claw back points.
CREATE TABLE loy_entry (
  id           CHAR(26) PRIMARY KEY,
  customer_id  CHAR(26) NOT NULL,
  points       INT NOT NULL,                  -- +accrue / -redeem / -clawback
  reason       VARCHAR(16) NOT NULL,          -- ACCRUAL | REDEEM | CLAWBACK | EXPIRY
  reference    VARCHAR(64) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_loy_reference (reference, reason),
  KEY ix_loy_customer (customer_id, created_at),
  CONSTRAINT ck_loy_reason CHECK (reason IN ('ACCRUAL','REDEEM','CLAWBACK','EXPIRY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE loy_balance (
  customer_id  CHAR(26) PRIMARY KEY,
  points       INT NOT NULL DEFAULT 0,
  tier         VARCHAR(10) NOT NULL DEFAULT 'SILVER',   -- SILVER | GOLD | PLATINUM
  row_version  INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_loy_nonneg CHECK (points >= 0),
  CONSTRAINT ck_loy_tier CHECK (tier IN ('SILVER','GOLD','PLATINUM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
