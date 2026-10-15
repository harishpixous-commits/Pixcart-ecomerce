-- V006__experience_tables.sql
-- Closes dangling references found while building the delivery layer (CLAUDE.md §6:
-- "Close dangling references. If a rule cites something not yet built, build that next").
--
-- V001–V005 are the Vol. 6 §6.4 excerpt (DDL-01..04) and are not modified here. Every
-- table below backs a functional requirement that V001–V005 left unpersisted:
--   id_address      FR-CUS-005 Address Book
--   ven_store       FR-VEN-001 Vendor Registration & KYC, FR-VEN-002 Store Settings
--   cart/cart_line  FR-CUS-007 Shopping Cart
--   rev_review      FR-CUS-023 Product Reviews, FR-CUS-024 Ratings & Aggregation
--   rma_request     FR-CUS-017 Returns & Replacements, FR-CUS-018 Refunds
--   rma_event       FR-CUS-017 (state history) + WF-RET-01
--   mkt_coupon      FR-MKT-001 Coupon Engine
--   cms_content     FR-ADM-007 CMS (Pages, Banners, Content Blocks)
--   notif_message   FR-CUS-022 Notifications & Preferences, FR-ADM-015 Notification Centre
--
-- Conventions inherited from V001–V005: ULID CHAR(26) primary keys, DECIMAL(12,2)
-- for money, integer paise for ledger-adjacent amounts, row_version for optimistic
-- locking, TIMESTAMP(3), CHECK constraints for every state vocabulary, utf8mb4/InnoDB.

-- ===== FR-CUS-005 — Address Book =============================================
CREATE TABLE id_address (
  id           CHAR(26) PRIMARY KEY,
  customer_id  CHAR(26) NOT NULL,
  label        VARCHAR(24)  NOT NULL DEFAULT 'HOME',   -- HOME | WORK | OTHER
  line1        VARCHAR(120) NOT NULL,
  line2        VARCHAR(120) NULL,
  landmark     VARCHAR(80)  NULL,
  city         VARCHAR(60)  NOT NULL,
  state        VARCHAR(60)  NOT NULL,
  pincode      CHAR(6)      NOT NULL,
  country      CHAR(2)      NOT NULL DEFAULT 'IN',
  mobile       VARCHAR(16)  NOT NULL,                  -- delivery contact
  is_default   TINYINT(1)   NOT NULL DEFAULT 0,
  -- Exactly one default per customer (FR-CUS-005), without also limiting how many
  -- non-default addresses may exist: the index is unique on (customer, 1) only, and
  -- every non-default row projects to NULL, which a UNIQUE index permits many of.
  default_flag TINYINT      GENERATED ALWAYS AS (IF(is_default = 1, 1, NULL)) STORED,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  row_version  INT NOT NULL DEFAULT 0,
  KEY ix_address_customer (customer_id, is_default),
  CONSTRAINT ck_address_pincode CHECK (pincode REGEXP '^[0-9]{6}$'),
  CONSTRAINT ck_address_label  CHECK (label IN ('HOME','WORK','OTHER')),
  UNIQUE KEY uq_address_one_default (customer_id, default_flag)
) ENGINE=InnoDB;

-- ===== FR-VEN-001 / FR-VEN-002 — Vendor entity & store settings ===============
CREATE TABLE ven_store (
  id             CHAR(26) PRIMARY KEY,                 -- the vendor_id used everywhere
  legal_name     VARCHAR(160) NOT NULL,
  display_name   VARCHAR(80)  NOT NULL,
  gstin          VARCHAR(15)  NULL,
  pan            VARCHAR(10)  NULL,
  email          VARCHAR(254) NOT NULL,
  mobile         VARCHAR(16)  NOT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'PENDING',  -- approval queue SCR-031
  kyc_state      VARCHAR(16)  NOT NULL DEFAULT 'NOT_STARTED',
  rating_avg     DECIMAL(3,2) NOT NULL DEFAULT 0,
  rating_count   INT          NOT NULL DEFAULT 0,
  on_time_pct    INT          NOT NULL DEFAULT 100,        -- basis: percentage points
  store_slug     VARCHAR(100) NOT NULL,
  logo_url       VARCHAR(300) NULL,
  settings       JSON         NOT NULL,                   -- FR-VEN-002 store settings
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                   ON UPDATE CURRENT_TIMESTAMP(3),
  row_version    INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_store_slug (store_slug),
  UNIQUE KEY uq_store_email (email),
  KEY ix_store_status (status),
  CONSTRAINT ck_store_status CHECK (status IN
    ('PENDING','APPROVED','REJECTED','SUSPENDED','PAUSED')),
  CONSTRAINT ck_store_kyc CHECK (kyc_state IN
    ('NOT_STARTED','DOCUMENTS_SUBMITTED','UNDER_REVIEW','VERIFIED','REJECTED')),
  CONSTRAINT ck_store_rating CHECK (rating_avg >= 0 AND rating_avg <= 5)
) ENGINE=InnoDB;

-- ===== FR-CUS-007 — Shopping Cart ============================================
CREATE TABLE cart (
  id           CHAR(26) PRIMARY KEY,
  customer_id  CHAR(26) NULL,                            -- NULL = guest cart (FR-CUS-007)
  guest_token  VARCHAR(64) NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE | MERGED | ABANDONED | CHECKED_OUT
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3)  NOT NULL,                    -- CART_TTL_DAYS
  row_version  INT NOT NULL DEFAULT 0,
  KEY ix_cart_customer (customer_id, status),
  KEY ix_cart_guest (guest_token),
  CONSTRAINT ck_cart_status CHECK (status IN ('ACTIVE','MERGED','ABANDONED','CHECKED_OUT')),
  CONSTRAINT ck_cart_owner CHECK (customer_id IS NOT NULL OR guest_token IS NOT NULL)
) ENGINE=InnoDB;

CREATE TABLE cart_line (
  id            CHAR(26) PRIMARY KEY,
  cart_id       CHAR(26) NOT NULL,
  listing_id    CHAR(26) NOT NULL,
  variant_sku   VARCHAR(40) NULL,
  vendor_id     CHAR(26) NOT NULL,
  qty           INT      NOT NULL,
  unit_mrppaise BIGINT   NOT NULL,                       -- integer paise
  unit_salepaise BIGINT  NOT NULL,
  saved_for_later TINYINT(1) NOT NULL DEFAULT 0,
  added_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  row_version   INT NOT NULL DEFAULT 0,
  KEY ix_cartline_cart (cart_id, saved_for_later),
  CONSTRAINT fk_cartline_cart FOREIGN KEY (cart_id) REFERENCES cart (id)
    ON DELETE CASCADE,
  CONSTRAINT ck_cartline_qty CHECK (qty > 0)
) ENGINE=InnoDB;

-- ===== FR-CUS-023 / FR-CUS-024 — Reviews & rating aggregation =================
CREATE TABLE rev_review (
  id           CHAR(26) PRIMARY KEY,
  listing_id   CHAR(26) NOT NULL,
  product_id   CHAR(26) NOT NULL,
  vendor_id    CHAR(26) NOT NULL,
  customer_id  CHAR(26) NOT NULL,
  order_id     CHAR(26) NULL,                            -- verified purchase when set
  rating       TINYINT  NOT NULL,
  title        VARCHAR(120) NULL,
  body         TEXT     NULL,
  status       VARCHAR(12) NOT NULL DEFAULT 'PUBLISHED', -- moderation gate
  helpful_up   INT NOT NULL DEFAULT 0,
  helpful_down INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  row_version  INT NOT NULL DEFAULT 0,
  -- one review per customer per listing (FR-CUS-023)
  UNIQUE KEY uq_review_customer_listing (customer_id, listing_id),
  KEY ix_review_listing_status (listing_id, status, created_at),
  KEY ix_review_product (product_id),
  CONSTRAINT ck_review_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT ck_review_status CHECK (status IN ('PENDING','PUBLISHED','REJECTED','FLAGGED'))
) ENGINE=InnoDB;

-- ===== FR-CUS-017 / FR-CUS-018 — Returns & refunds (WF-RET-01, WF-REF-01) =====
CREATE TABLE rma_request (
  id            CHAR(26) PRIMARY KEY,
  order_id      CHAR(26) NOT NULL,
  sub_order_id  CHAR(26) NOT NULL,
  customer_id   CHAR(26) NOT NULL,
  vendor_id     CHAR(26) NOT NULL,
  listing_id    CHAR(26) NOT NULL,
  qty           INT NOT NULL,
  reason_code   VARCHAR(24) NOT NULL,                    -- FR-CUS-017 reason taxonomy
  reason_text   VARCHAR(500) NULL,
  state         VARCHAR(24) NOT NULL DEFAULT 'REQUESTED',
  refund_paise  BIGINT NULL,                             -- settled amount, integer paise
  refund_method VARCHAR(12) NULL,                        -- ORIGINAL | WALLET
  requested_at  DATETIME(3) NOT NULL,
  decided_at    DATETIME(3) NULL,
  row_version   INT NOT NULL DEFAULT 0,
  KEY ix_rma_customer (customer_id, state),
  KEY ix_rma_order (order_id),
  KEY ix_rma_sub (sub_order_id),
  CONSTRAINT ck_rma_state CHECK (state IN (
    'REQUESTED','APPROVED','REJECTED','PICKUP_SCHEDULED','PICKED_UP',
    'IN_TRANSIT','QC_PASSED','QC_FAILED','REFUND_INITIATED','REFUNDED','CLOSED')),
  CONSTRAINT ck_rma_reason CHECK (reason_code IN
    ('DAMAGED','WRONG_ITEM','MISSING_PARTS','NOT_AS_DESCRIBED',
     'SIZE_ISSUE','CHANGED_MIND','LATE_DELIVERY','QUALITY_ISSUE')),
  CONSTRAINT ck_rma_refund CHECK (refund_paise IS NULL OR refund_paise >= 0),
  CONSTRAINT ck_rma_refund_method CHECK (refund_method IS NULL
    OR refund_method IN ('ORIGINAL','WALLET'))
) ENGINE=InnoDB;

CREATE TABLE rma_event (
  id       CHAR(26) PRIMARY KEY,
  rma_id   CHAR(26) NOT NULL,
  from_state VARCHAR(24) NULL,
  to_state VARCHAR(24) NOT NULL,
  actor_type VARCHAR(12) NOT NULL,                       -- CUSTOMER | VENDOR | ADMIN | SYSTEM
  actor_id CHAR(26) NULL,
  note     VARCHAR(300) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_rmaevent_rma (rma_id, created_at),
  CONSTRAINT fk_rmaevent_rma FOREIGN KEY (rma_id) REFERENCES rma_request (id),
  CONSTRAINT ck_rmaevent_actor CHECK (actor_type IN ('CUSTOMER','VENDOR','ADMIN','SYSTEM'))
) ENGINE=InnoDB;

-- ===== FR-MKT-001 — Coupon Engine ============================================
CREATE TABLE mkt_coupon (
  id            CHAR(26) PRIMARY KEY,
  code          VARCHAR(32) NOT NULL,
  description   VARCHAR(200) NOT NULL,
  kind          VARCHAR(12) NOT NULL,                    -- PERCENT | FLAT
  value_bps     INT  NOT NULL,                           -- PERCENT: basis points
  value_paise   BIGINT NOT NULL DEFAULT 0,               -- FLAT: integer paise
  max_redemptions INT NOT NULL,
  used_count    INT NOT NULL DEFAULT 0,
  min_cart_paise BIGINT NOT NULL DEFAULT 0,
  per_user_limit INT NOT NULL DEFAULT 1,
  starts_at     DATETIME(3) NOT NULL,
  ends_at       DATETIME(3) NOT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_by    CHAR(26) NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  row_version   INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_coupon_code (code),
  KEY ix_coupon_status (status, ends_at),
  CONSTRAINT ck_coupon_kind CHECK (kind IN ('PERCENT','FLAT')),
  CONSTRAINT ck_coupon_status CHECK (status IN ('DRAFT','ACTIVE','PAUSED','EXHAUSTED','EXPIRED')),
  CONSTRAINT ck_coupon_bps CHECK ((kind = 'PERCENT' AND value_bps BETWEEN 1 AND 10000)
                               OR (kind = 'FLAT' AND value_paise > 0)),
  CONSTRAINT ck_coupon_window CHECK (ends_at > starts_at)
) ENGINE=InnoDB;

-- ===== FR-ADM-007 — CMS (pages, banners, content blocks) ======================
CREATE TABLE cms_content (
  id           CHAR(26) PRIMARY KEY,
  kind         VARCHAR(16) NOT NULL,                     -- PAGE | BANNER | BLOCK
  slug         VARCHAR(140) NOT NULL,
  title        VARCHAR(160) NOT NULL,
  body         MEDIUMTEXT NULL,
  media_url    VARCHAR(300) NULL,
  link_url     VARCHAR(300) NULL,
  locale       VARCHAR(8)  NOT NULL DEFAULT 'en',
  status       VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  publish_at   DATETIME(3) NULL,
  unpublish_at DATETIME(3) NULL,
  created_by   CHAR(26) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  row_version  INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_cms_slug_locale (slug, locale),
  KEY ix_cms_status (status, publish_at),
  CONSTRAINT ck_cms_kind CHECK (kind IN ('PAGE','BANNER','BLOCK')),
  CONSTRAINT ck_cms_status CHECK (status IN ('DRAFT','SCHEDULED','PUBLISHED','UNPUBLISHED'))
) ENGINE=InnoDB;

-- ===== FR-CUS-022 / FR-ADM-015 — Notification inbox with read state ===========
CREATE TABLE notif_message (
  id           CHAR(26) PRIMARY KEY,
  customer_id  CHAR(26) NOT NULL,
  category     VARCHAR(24) NOT NULL,                     -- ORDER | PAYMENT | PROMO | SYSTEM
  title        VARCHAR(160) NOT NULL,
  body         VARCHAR(500) NOT NULL,
  link_url     VARCHAR(300) NULL,
  severity     VARCHAR(10) NOT NULL DEFAULT 'INFO',
  read_at      TIMESTAMP(3) NULL,                        -- inbox read state (§8.3)
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_notif_customer (customer_id, read_at, created_at),
  CONSTRAINT ck_notif_category CHECK (category IN ('ORDER','PAYMENT','PROMO','SYSTEM','RETURN')),
  CONSTRAINT ck_notif_severity CHECK (severity IN ('INFO','SUCCESS','WARNING','ERROR'))
) ENGINE=InnoDB;
