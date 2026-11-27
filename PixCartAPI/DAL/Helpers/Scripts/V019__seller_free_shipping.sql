-- Sellers can set their own free-delivery threshold (used only while Admin -> Growth -> Seller shipping is on).
ALTER TABLE sellers ADD COLUMN free_shipping_threshold_paise BIGINT NULL;
