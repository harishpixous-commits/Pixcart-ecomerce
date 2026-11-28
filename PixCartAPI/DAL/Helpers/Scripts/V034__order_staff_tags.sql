-- orders.staff_tags: private labels staff give an order
ALTER TABLE orders ADD COLUMN staff_tags JSON NOT NULL DEFAULT (JSON_ARRAY());
