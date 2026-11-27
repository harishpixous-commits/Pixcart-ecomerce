-- Loyalty points (Admin -> Growth -> Loyalty). One 'earn' row per delivered package; the balance is the sum of the rows.
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  sub_order_id CHAR(36) NULL,
  kind VARCHAR(10) NOT NULL,
  points INT NOT NULL,
  note VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_loyalty_sub_kind (sub_order_id, kind),
  KEY ix_loyalty_ledger_user_id (user_id),
  CONSTRAINT fk_loyalty_ledger_user_id_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_loyalty_ledger_sub_order_id_sub_orders FOREIGN KEY (sub_order_id) REFERENCES sub_orders (id) ON DELETE SET NULL,
  CONSTRAINT ck_loyalty_ledger_kind CHECK (kind IN ('earn','redeem','expire','adjust','reverse'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
