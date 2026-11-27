-- Refund references can be longer than Razorpay's (other gateways use longer ids).
ALTER TABLE refunds MODIFY provider_payment_id VARCHAR(100) NULL;
ALTER TABLE refunds MODIFY provider_refund_id VARCHAR(100) NULL;
