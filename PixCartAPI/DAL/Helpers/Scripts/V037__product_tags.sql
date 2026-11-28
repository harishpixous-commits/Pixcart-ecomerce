-- products.tags: short lower-case labels; product_collections.tag: collection rule
ALTER TABLE products ADD COLUMN tags JSON NOT NULL DEFAULT (JSON_ARRAY());
ALTER TABLE product_collections ADD COLUMN tag VARCHAR(30) NOT NULL DEFAULT '';
