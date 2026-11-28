ALTER TABLE coupons DROP CHECK ck_coupons_kind;
ALTER TABLE coupons ADD CONSTRAINT ck_coupons_kind CHECK (kind IN ('percent','flat','bxgy','bundle','volume','freeship'));
