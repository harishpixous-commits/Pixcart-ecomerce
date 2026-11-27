-- A coupon can belong to one user (codes made from loyalty points and gift cards).
ALTER TABLE coupons ADD COLUMN only_user_id CHAR(36) NULL;
ALTER TABLE coupons ADD CONSTRAINT fk_coupons_only_user_id_users FOREIGN KEY (only_user_id) REFERENCES users (id) ON DELETE CASCADE;
