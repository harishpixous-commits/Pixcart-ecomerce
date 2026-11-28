-- coupons.product_ids: a platform coupon limited to chosen products
ALTER TABLE coupons ADD COLUMN product_ids JSON NOT NULL DEFAULT (JSON_ARRAY());
