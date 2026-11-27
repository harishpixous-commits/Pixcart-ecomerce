-- Several payment gateways (docs/PAYMENT_GATEWAYS.md): longer gateway references, the data the browser needs to reopen a
-- payment attempt, and gateway health events (kept 7 days).
ALTER TABLE payments MODIFY provider_order_id VARCHAR(100) NOT NULL;
ALTER TABLE payments MODIFY provider_payment_id VARCHAR(100) NULL;
ALTER TABLE payments ADD COLUMN client_data JSON NULL;
CREATE TABLE IF NOT EXISTS payment_gateway_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  gateway VARCHAR(12) NOT NULL,
  ok TINYINT(1) NOT NULL,
  ms INT NOT NULL DEFAULT 0,
  `error` VARCHAR(300) NOT NULL DEFAULT '',
  created_at DATETIME(6) NOT NULL,
  KEY ix_payment_gateway_events_gateway_created_at (gateway, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
