-- Gift cards issued by staff and the balance moved into coupons (Admin -> Growth -> Gift cards).
CREATE TABLE IF NOT EXISTS gift_cards (
  id CHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(20) NOT NULL,
  initial_paise INT NOT NULL,
  balance_paise INT NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'active',
  note VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  UNIQUE KEY uq_gift_cards_code (code),
  CONSTRAINT ck_gift_cards_status CHECK (status IN ('active','void')),
  CONSTRAINT ck_gift_cards_balance CHECK (balance_paise >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS gift_card_uses (
  id CHAR(36) NOT NULL PRIMARY KEY,
  gift_card_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  coupon_code VARCHAR(30) NOT NULL,
  amount_paise INT NOT NULL,
  restored TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  KEY ix_gift_card_uses_gift_card_id (gift_card_id),
  CONSTRAINT fk_gift_card_uses_gift_card_id FOREIGN KEY (gift_card_id) REFERENCES gift_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_gift_card_uses_user_id_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
