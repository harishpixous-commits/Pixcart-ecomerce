-- coupons.is_automatic: a coupon applied at checkout with no code (Growth, Automatic discounts)
ALTER TABLE coupons ADD COLUMN is_automatic TINYINT(1) NOT NULL DEFAULT 0;
