-- Several payment gateways with automatic failover (docs/PAYMENT_GATEWAYS.md):
-- payments keep each gateway's references (up to 100 characters), the checkout fields of each attempt (so the order page
-- can open it again) and when the money was taken (an order's payment is the one captured first); refunds keep the
-- gateways' references too; payment_gateway_events records every call to a gateway for routing, the circuit breaker and
-- Admin -> Payments.
ALTER TABLE payments
	MODIFY provider_order_id VARCHAR(100) NOT NULL,
	MODIFY provider_payment_id VARCHAR(100) NULL,
	ADD COLUMN client_data JSON NULL,
	ADD COLUMN captured_at DATETIME(6) NULL;
ALTER TABLE refunds
	MODIFY provider_payment_id VARCHAR(100) NULL,
	MODIFY provider_refund_id VARCHAR(100) NULL;
CREATE TABLE payment_gateway_events (
	gateway VARCHAR(12) NOT NULL,
	ok TINYINT(1) NOT NULL,
	ms INT NOT NULL,
	error VARCHAR(300) NOT NULL DEFAULT '',
	created_at DATETIME(6) NOT NULL,
	id CHAR(36) NOT NULL,
	CONSTRAINT pk_payment_gateway_events PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
CREATE INDEX ix_payment_gateway_events_gateway_created ON payment_gateway_events (gateway, created_at);
