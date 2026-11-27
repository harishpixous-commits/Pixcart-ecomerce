-- Abandoned-cart reminders sent (Admin -> Growth -> Abandoned cart reminders).
CREATE TABLE IF NOT EXISTS cart_reminders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  stage INT NOT NULL,
  cart_paise INT NOT NULL DEFAULT 0,
  sent_at DATETIME(6) NOT NULL,
  KEY ix_cart_reminders_user_id (user_id),
  CONSTRAINT fk_cart_reminders_user_id_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
