-- V003__catalogue.sql
-- Catalogue module. Entities per Vol. 5 UML-CLS-01 / ERD-01 (Category, Brand, Product,
-- Variant, Location) and the workflows of FR-VEN-003 (listing lifecycle, change-log per
-- field) and FR-ADM-004 (approval queue). Elaborated columns cite their source inline.

CREATE TABLE cat_category (
  id               CHAR(26) PRIMARY KEY,
  parent_id        CHAR(26) NULL,                 -- NULL = root of the tree
  name             VARCHAR(80)  NOT NULL,
  slug             VARCHAR(100) NOT NULL,
  -- FR-VEN-003: "category-driven attribute forms" — the schema listings must satisfy
  attribute_schema JSON NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                     ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_category_slug (slug),
  KEY ix_category_parent (parent_id),
  CONSTRAINT fk_category_parent FOREIGN KEY (parent_id) REFERENCES cat_category(id),
  CONSTRAINT ck_category_status CHECK (status IN ('ACTIVE','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE cat_brand (
  id         CHAR(26) PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL,
  slug       VARCHAR(100) NOT NULL,
  -- FR-VEN-003 inputs: "brand (from registry or request-new)" — request-new lands PENDING
  status     VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_brand_slug (slug),
  CONSTRAINT ck_brand_status CHECK (status IN ('ACTIVE','PENDING','REJECTED','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Catalogue master (one Product; many vendor Listings offer it — UML-CLS-01).
CREATE TABLE cat_product (
  id          CHAR(26) PRIMARY KEY,
  category_id CHAR(26) NOT NULL,
  brand_id    CHAR(26) NULL,
  title       VARCHAR(150) NOT NULL,              -- FR-VEN-003: title 20–150 chars
  attributes  JSON NOT NULL,
  hsn_code    VARCHAR(8) NOT NULL,                -- FR-VEN-003: HSN must be in master
  status      VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_product_category (category_id),
  CONSTRAINT fk_product_category FOREIGN KEY (category_id) REFERENCES cat_category(id),
  CONSTRAINT fk_product_brand    FOREIGN KEY (brand_id)    REFERENCES cat_brand(id),
  CONSTRAINT ck_product_status CHECK (status IN ('ACTIVE','RETIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Variant matrix per listing (FR-VEN-003: size/colour up to 100 combos).
CREATE TABLE cat_variant (
  id         CHAR(26) PRIMARY KEY,
  listing_id CHAR(26) NOT NULL,
  sku        VARCHAR(40) NOT NULL,
  option_map JSON NOT NULL,                       -- e.g. {"size":"M","colour":"Navy"}
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_variant_sku (sku),
  KEY ix_variant_listing (listing_id),
  CONSTRAINT fk_variant_listing FOREIGN KEY (listing_id) REFERENCES cat_listing(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE inv_location (
  id         CHAR(26) PRIMARY KEY,
  vendor_id  CHAR(26) NOT NULL,
  name       VARCHAR(80) NOT NULL,
  pincode    CHAR(6) NOT NULL,
  kind       VARCHAR(12) NOT NULL DEFAULT 'WAREHOUSE',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_location_vendor (vendor_id),
  CONSTRAINT ck_location_kind CHECK (kind IN ('WAREHOUSE','STORE','DROPSHIP'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- FR-VEN-003 outputs: "change-log per field"; regulated revisions feed re-approval diffs.
CREATE TABLE cat_listing_revision (
  id          CHAR(26) PRIMARY KEY,
  listing_id  CHAR(26) NOT NULL,
  revision_no INT NOT NULL,
  -- BRU-02 / FR-VEN-003 rules: title, category, brand, images, MRP re-enter approval
  regulated   TINYINT(1) NOT NULL DEFAULT 0,
  field_diff  JSON NOT NULL,                      -- {"mrp":{"from":"1999.00","to":"1499.00"},…}
  created_by  CHAR(26) NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_revision (listing_id, revision_no),
  CONSTRAINT fk_revision_listing FOREIGN KEY (listing_id) REFERENCES cat_listing(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- FR-ADM-004 approval queue; every decision also appends to adm_audit_event (V001).
CREATE TABLE adm_approval_case (
  id                CHAR(26) PRIMARY KEY,
  listing_id        CHAR(26) NOT NULL,
  revision_no       INT NOT NULL,
  regulated_edit    TINYINT(1) NOT NULL DEFAULT 0,
  prohibited_flag   TINYINT(1) NOT NULL DEFAULT 0, -- AI QC pre-check hit
  prohibited_reason VARCHAR(120) NULL,
  diff_viewed       TINYINT(1) NOT NULL DEFAULT 0, -- FR-ADM-004: mandatory for regulated edits
  state             VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  fix_list          JSON NULL,                     -- FR-ADM-004 outputs: fix-lists to vendors
  submitted_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_by        CHAR(26) NULL,
  decided_at        TIMESTAMP(3) NULL,
  KEY ix_case_state (state, submitted_at),
  UNIQUE KEY uq_case_revision (listing_id, revision_no),
  CONSTRAINT fk_case_listing FOREIGN KEY (listing_id) REFERENCES cat_listing(id),
  CONSTRAINT ck_case_state CHECK (state IN ('PENDING','APPROVED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Retro-fit referential integrity onto V001 tables (none are partitioned).
ALTER TABLE cat_listing
  ADD CONSTRAINT fk_listing_product FOREIGN KEY (product_id) REFERENCES cat_product(id);
ALTER TABLE inv_item
  ADD CONSTRAINT fk_inv_variant  FOREIGN KEY (variant_sku) REFERENCES cat_variant(sku),
  ADD CONSTRAINT fk_inv_location FOREIGN KEY (location_id) REFERENCES inv_location(id);
