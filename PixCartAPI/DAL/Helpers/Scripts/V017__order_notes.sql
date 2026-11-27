-- Private staff notes on orders.
CREATE TABLE IF NOT EXISTS order_notes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  author_id CHAR(36) NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT '',
  note VARCHAR(1000) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY ix_order_notes_order_id (order_id),
  CONSTRAINT fk_order_notes_order_id_orders FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_notes_author_id_users FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
