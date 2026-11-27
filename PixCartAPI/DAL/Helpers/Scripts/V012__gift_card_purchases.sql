-- Shoppers buying gift cards online: one row per purchase, issued only after the gateway confirms the money.
CREATE TABLE IF NOT EXISTS gift_card_purchases (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  amount_paise INT NOT NULL,
  gateway VARCHAR(20) NOT NULL,
  gateway_ref VARCHAR(100) NOT NULL,
  client_data JSON NULL,
  status VARCHAR(8) NOT NULL DEFAULT 'created',
  gift_card_id CHAR(36) NULL,
  error VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  KEY ix_gift_card_purchases_user_id (user_id),
  UNIQUE KEY uq_gift_purchase_ref (gateway, gateway_ref),
  CONSTRAINT ck_gift_card_purchases_status CHECK (status IN ('created','issued','failed')),
  CONSTRAINT fk_gift_card_purchases_user_id_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_gift_card_purchases_gift_card_id FOREIGN KEY (gift_card_id) REFERENCES gift_cards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
