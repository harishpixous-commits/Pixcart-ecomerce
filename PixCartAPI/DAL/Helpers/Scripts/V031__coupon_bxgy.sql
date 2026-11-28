-- coupons: buy X get Y kind (buy_qty, get_qty; value = percent off the discounted units)
ALTER TABLE coupons ADD COLUMN buy_qty INT NOT NULL DEFAULT 0, ADD COLUMN get_qty INT NOT NULL DEFAULT 0;
ALTER TABLE coupons DROP CHECK ck_coupons_kind;
ALTER TABLE coupons ADD CONSTRAINT ck_coupons_kind CHECK (kind IN ('percent','flat','bxgy'));
