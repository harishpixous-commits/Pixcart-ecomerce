-- V007__wishlist.sql
-- FR-CUS-006 Wishlist — screen SCR-012 (release R1).
--
-- V001–V006 left the wishlist unpersisted: `services/cart-checkout-svc` models it as an
-- in-memory `Wishlist` aggregate with retention/alert rules, but nothing wrote it down.
-- The delivery layer needs a durable store, so this closes that dangling reference
-- (CLAUDE.md §6) without touching any earlier migration.
--
-- Conventions inherited from V001–V006: ULID CHAR(26) primary key, TIMESTAMP(3),
-- row_version for optimistic locking, CHECK constraints for the state vocabulary.

CREATE TABLE cus_wishlist (
  id           CHAR(26) PRIMARY KEY,
  customer_id  CHAR(26) NOT NULL,
  listing_id   CHAR(26) NOT NULL,
  note         VARCHAR(120) NULL,            -- FR-CUS-006 optional shopper note
  -- OUT_OF_STOCK_ALERT mirrors the Wishlist aggregate's notify-me affordance (SCR-006).
  notify_when_in_stock TINYINT(1) NOT NULL DEFAULT 0,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  row_version  INT NOT NULL DEFAULT 0,
  -- a listing appears at most once per customer's list
  UNIQUE KEY uq_wishlist_customer_listing (customer_id, listing_id),
  KEY ix_wishlist_customer (customer_id, created_at),
  CONSTRAINT ck_wishlist_notify CHECK (notify_when_in_stock IN (0, 1))
) ENGINE=InnoDB;
