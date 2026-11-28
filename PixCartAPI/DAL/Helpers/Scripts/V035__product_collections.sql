-- product_collections: pages of chosen products
CREATE TABLE product_collections (
	slug VARCHAR(80) NOT NULL,
	title VARCHAR(120) NOT NULL,
	description VARCHAR(1000) NOT NULL DEFAULT '',
	image_url VARCHAR(500) NOT NULL DEFAULT '',
	is_active TINYINT(1) NOT NULL DEFAULT 1,
	position INTEGER NOT NULL DEFAULT 0,
	product_ids JSON NOT NULL DEFAULT (JSON_ARRAY()),
	category_slug VARCHAR(120) NOT NULL DEFAULT '',
	brand VARCHAR(80) NOT NULL DEFAULT '',
	min_price_paise BIGINT NULL,
	max_price_paise BIGINT NULL,
	id CHAR(36) NOT NULL,
	created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
	updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
	CONSTRAINT pk_product_collections PRIMARY KEY (id),
	CONSTRAINT uq_product_collections_slug UNIQUE (slug)
);
