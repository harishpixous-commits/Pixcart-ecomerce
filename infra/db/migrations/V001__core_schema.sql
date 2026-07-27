-- V001__core_schema.sql
-- GENERATED from Documentation Suite v1.0, Vol. 6 SS6.4 (DDL-01..04).
-- Do not hand-edit: regenerate so the document and the database cannot drift.

-- ===== DDL-01 — Identity, listing and inventory (excerpt) =====
CREATE TABLE id_customer (
  id            CHAR(26) PRIMARY KEY,
  mobile        VARCHAR(16)  NULL UNIQUE,
  email         VARCHAR(254) NULL,
  email_norm    VARCHAR(254) GENERATED ALWAYS AS (LOWER(email)) STORED,
  password_hash VARBINARY(128) NULL,
  full_name     VARCHAR(120) NOT NULL,
  lang          VARCHAR(8)   NOT NULL DEFAULT 'en',
  status        VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
  kyc_tier      TINYINT      NOT NULL DEFAULT 0,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                    ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at    TIMESTAMP(3) NULL,
  row_version   INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_customer_email (email_norm),
  CONSTRAINT ck_customer_status CHECK (status IN
    ('ACTIVE','SUSPENDED','DELETION_PENDING','DELETED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE cat_listing (
  id           CHAR(26) PRIMARY KEY,
  vendor_id    CHAR(26) NOT NULL,
  product_id   CHAR(26) NOT NULL,
  state        VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  title        VARCHAR(150) NOT NULL,
  mrp          DECIMAL(12,2) NOT NULL,
  price        DECIMAL(12,2) NOT NULL,
  price_floor  DECIMAL(12,2) NULL,
  price_ceiling DECIMAL(12,2) NULL,
  attributes   JSON NOT NULL,
  hsn_code     VARCHAR(8) NOT NULL,
  qc_score     DECIMAL(4,1) NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  row_version  INT NOT NULL DEFAULT 0,
  KEY ix_listing_vendor_state (vendor_id, state),
  KEY ix_listing_product (product_id),
  CONSTRAINT ck_listing_state CHECK (state IN
    ('DRAFT','SUBMITTED','APPROVED','REJECTED','LIVE','PAUSED','ARCHIVED')),
  CONSTRAINT ck_listing_price CHECK (price <= mrp
    AND (price_floor IS NULL OR price_floor <= price))
) ENGINE=InnoDB;

CREATE TABLE inv_item (
  variant_sku  VARCHAR(40) NOT NULL,
  location_id  CHAR(26)    NOT NULL,
  on_hand      INT NOT NULL DEFAULT 0,
  reserved     INT NOT NULL DEFAULT 0,
  safety_stock INT NOT NULL DEFAULT 0,
  row_version  INT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (variant_sku, location_id),
  CONSTRAINT ck_inv_nonneg CHECK (on_hand >= 0 AND reserved >= 0 AND reserved <= on_hand)
) ENGINE=InnoDB;

-- ===== DDL-02 — Order and sub-order tables; keys are partition-aware =====
CREATE TABLE ord_order (
  id             CHAR(26) NOT NULL,
  customer_id    CHAR(26) NOT NULL,
  quote_id       CHAR(26) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  item_total     DECIMAL(12,2) NOT NULL,
  discount_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax_total      DECIMAL(12,2) NOT NULL,
  grand_total    DECIMAL(12,2) NOT NULL,
  promo_allocation JSON NOT NULL,
  ship_address   JSON NOT NULL,  -- immutable snapshot (FR-CUS-005)
  placed_at      DATETIME(3) NOT NULL,   -- DATETIME: RANGE COLUMNS rejects TIMESTAMP
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- every unique key of a partitioned table must contain the partitioning column
  PRIMARY KEY (id, placed_at),
  UNIQUE KEY uq_order_quote (quote_id, placed_at),
  KEY ix_order_customer_placed (customer_id, placed_at)
) ENGINE=InnoDB
  PARTITION BY RANGE COLUMNS(placed_at) (
    PARTITION p2026q3 VALUES LESS THAN ('2026-10-01'),
    PARTITION p2026q4 VALUES LESS THAN ('2027-01-01'),
    PARTITION pmax    VALUES LESS THAN (MAXVALUE));

CREATE TABLE ord_sub_order (
  id          CHAR(26) PRIMARY KEY,
  order_id    CHAR(26) NOT NULL,
  vendor_id   CHAR(26) NOT NULL,
  state       VARCHAR(24) NOT NULL DEFAULT 'CONFIRMED',
  sla_accept_by TIMESTAMP(3) NOT NULL,
  sla_ship_by   TIMESTAMP(3) NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                  ON UPDATE CURRENT_TIMESTAMP(3),
  row_version INT NOT NULL DEFAULT 0,
  KEY ix_sub_vendor_state (vendor_id, state),
  KEY ix_sub_order (order_id)
  -- no FK to ord_order: InnoDB forbids foreign keys on partitioned tables, so the
  -- Order service enforces this reference inside the same transaction instead
) ENGINE=InnoDB;

-- ===== DDL-02b — Payment table; the unique keys encode idempotency (FR-CUS-015) =====
CREATE TABLE pay_payment (
  id           CHAR(26) PRIMARY KEY,
  order_id     CHAR(26) NOT NULL,
  method       VARCHAR(16) NOT NULL,       -- UPI/CARD/NB/WALLET/COD
  status       VARCHAR(20) NOT NULL,       -- INITIATED/AUTHORISED/CAPTURED/FAILED/EXPIRED
  amount       DECIMAL(12,2) NOT NULL,
  gateway      VARCHAR(24) NOT NULL,
  gateway_order_ref VARCHAR(64) NOT NULL,
  auth_ref     VARCHAR(64) NULL,
  capture_ref  VARCHAR(64) NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_pay_idem (idempotency_key),
  UNIQUE KEY uq_pay_gwref (gateway, gateway_order_ref),
  KEY ix_pay_order (order_id)
) ENGINE=InnoDB;

-- ===== DDL-03 — Double-entry ledger core (FR-FIN-*); no UPDATE/DELETE grants exist on this table =====
CREATE TABLE fin_ledger_entry (
  id            CHAR(26) NOT NULL,
  journal_id    CHAR(26) NOT NULL,           -- groups balanced lines
  account_code  VARCHAR(32) NOT NULL,        -- e.g. VENDOR_PAYABLE:{vendorId}
  debit         DECIMAL(12,2) NOT NULL DEFAULT 0,
  credit        DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency      CHAR(3) NOT NULL DEFAULT 'INR',
  ref_type      VARCHAR(24) NOT NULL,        -- SUB_ORDER/REFUND/FEE/PAYOUT/ADJUSTMENT
  ref_id        CHAR(26) NOT NULL,
  event_id      CHAR(26) NOT NULL,           -- source event for replay-idempotency
  period        CHAR(7)  NOT NULL,           -- YYYY-MM for lock enforcement
  memo          VARCHAR(200) NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id, period),                 -- partitioning column must be in the key
  UNIQUE KEY uq_ledger_event_leg (event_id, account_code, ref_id, period),
  KEY ix_ledger_account_period (account_code, period),
  KEY ix_ledger_ref (ref_type, ref_id),
  CONSTRAINT ck_ledger_oneside CHECK ((debit = 0) <> (credit = 0))
) ENGINE=InnoDB
  PARTITION BY RANGE COLUMNS(period) (
    PARTITION p202607 VALUES LESS THAN ('2026-08'),
    PARTITION p202608 VALUES LESS THAN ('2026-09'),
    PARTITION pmax VALUES LESS THAN (MAXVALUE));
-- Invariant (enforced by posting service + nightly assert):
--   SELECT journal_id FROM fin_ledger_entry GROUP BY journal_id
--   HAVING SUM(debit) <> SUM(credit);  -- must return zero rows

-- ===== DDL-04 — Audit hash-chain (FR-ADM-013) and consent ledger (BRU-12) =====
CREATE TABLE adm_audit_event (
  id          CHAR(26) PRIMARY KEY,
  actor_type  VARCHAR(12) NOT NULL,   -- STAFF/VENDOR/CUSTOMER/SYSTEM
  actor_id    CHAR(26) NOT NULL,
  action      VARCHAR(64) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id   CHAR(26) NOT NULL,
  before_json JSON NULL,
  after_json  JSON NULL,
  justification VARCHAR(300) NULL,
  ip          VARBINARY(16) NULL,
  prev_hash   BINARY(32) NOT NULL,
  this_hash   BINARY(32) NOT NULL,    -- SHA-256(prev_hash || canonical(payload))
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_entity (entity_type, entity_id, created_at),
  KEY ix_audit_actor (actor_type, actor_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE id_consent (
  id          CHAR(26) PRIMARY KEY,
  customer_id CHAR(26) NOT NULL,
  purpose     VARCHAR(40) NOT NULL,   -- MARKETING_EMAIL/PERSONALISATION/VOICE/...
  granted     BOOLEAN NOT NULL,
  policy_ver  VARCHAR(16) NOT NULL,
  channel     VARCHAR(16) NOT NULL,   -- capture surface
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_consent_cust (customer_id, purpose, created_at)
) ENGINE=InnoDB;  -- append-only: current state = latest row per (customer,purpose)

