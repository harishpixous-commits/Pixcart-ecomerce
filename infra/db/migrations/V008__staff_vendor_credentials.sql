-- V008__staff_vendor_credentials.sql
-- Staff and vendor sign-in — screens SCR-007..SCR-029 (release R1).
--
-- WHY THIS EXISTS
-- ==============
-- Until now the identity slice could only ever authenticate `id_customer`. There was no
-- credential column on `id_staff` or `ven_store`, so a staff member or a vendor operator had
-- nothing to present at /api/auth/login and could not be issued a token whose `role` claim
-- was ADMIN, FINANCE, VENDOR or anything else. Every vendor and admin surface in R1 (16 of
-- the 29 screens) was therefore reachable only by forging a token, because the BFF's
-- requireRole/requireCapability guards were unconditionally satisfied by a customer token
-- and unconditionally unsatisfiable by a real one.
--
-- A nullable column, on purpose
-- -----------------------------
-- `password_hash` is added NULLABLE and is NOT backfilled. A row with no hash simply cannot
-- authenticate: `PasswordHasher.matches` fails closed on a null or empty stored hash, so an
-- unprovisioned staff or vendor row is refused exactly as a wrong password is. Setting the
-- column NOT NULL would have required inventing a placeholder hash for 6 staff and 4 vendor
-- rows, and a placeholder hash is a credential -- a second, unknown password. Refusing is
-- the correct behaviour and needs no default at all.
--
-- Same type as `id_customer.password_hash` (V001), for the same reason
-- --------------------------------------------------------------------
-- VARBINARY(128) holding the ASCII of the encoded Argon2id string. One representation of a
-- hash across three tables means one encoder, one verifier, and one length check. A
-- VARCHAR here would be the same bytes under a different name, which is how a schema grows
-- a second behaviour wearing one name.
--
-- `email_norm` on ven_store
-- -------------------------
-- `id_customer` and `id_staff` both carry a STORED generated `lcase(email)` column with a
-- unique key on it, and login looks principals up by that normalised form. `ven_store` had
-- only a case-sensitive UNIQUE on `email`, so the same normalisation rule would otherwise
-- have to be re-implemented in the adapter as `WHERE LOWER(email) = ?` -- which is a second
-- implementation, and one that cannot use an index. The generated column makes the rule
-- structural instead of checked, matching the other two tables.
--
-- Widening ck_session_ptype
-- -------------------------
-- V002 declared `principal_type IN ('CUSTOMER','STAFF')`. A vendor operator is neither: they
-- are a `ven_store` row (confirmed by `cat_listing.vendor_id`, which references
-- `ven_store.id` and is the row the vendor's scoped RBAC cells are computed against).
-- Without VENDOR here, a vendor login would either be rejected on INSERT or -- worse --
-- have to be recorded as STAFF, which would collapse two different principals into one
-- session-principal namespace and let a vendor's session cap evict a staff member's.
--
-- DROP + ADD rather than MODIFY: MariaDB has no in-place ALTER for a CHECK expression.
-- The two statements are not atomic; a crash between them leaves `id_session` momentarily
-- unchecked. That is acceptable in a migration, which runs under a single exclusive DDL
-- lock and is recorded only on success -- it is not acceptable as a runtime code path, and
-- nothing here runs at runtime.

ALTER TABLE id_staff
  ADD COLUMN password_hash VARBINARY(128) NULL DEFAULT NULL
    COMMENT 'ASCII of the encoded Argon2id string; NULL = this account cannot sign in';

ALTER TABLE ven_store
  ADD COLUMN email_norm VARCHAR(254)
    GENERATED ALWAYS AS (lcase(`email`)) STORED,
  ADD COLUMN password_hash VARBINARY(128) NULL DEFAULT NULL
    COMMENT 'ASCII of the encoded Argon2id string; NULL = this store cannot sign in',
  ADD UNIQUE KEY uq_store_email_norm (email_norm);

ALTER TABLE id_session
  DROP CONSTRAINT ck_session_ptype,
  ADD CONSTRAINT ck_session_ptype CHECK (principal_type IN ('CUSTOMER','STAFF','VENDOR'));
