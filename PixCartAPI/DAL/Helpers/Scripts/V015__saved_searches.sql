-- Searches shoppers follow, to be told about new matching products.
CREATE TABLE IF NOT EXISTS saved_searches (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  query VARCHAR(120) NOT NULL,
  max_price_paise BIGINT NULL,
  created_at DATETIME(6) NOT NULL,
  last_checked_at DATETIME(6) NOT NULL,
  last_notified_at DATETIME(6) NULL,
  KEY ix_saved_searches_user_id (user_id),
  CONSTRAINT fk_saved_searches_user_id_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
