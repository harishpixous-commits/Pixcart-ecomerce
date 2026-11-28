-- url_redirects: old address to new address
CREATE TABLE url_redirects (
	from_path VARCHAR(300) NOT NULL,
	to_path VARCHAR(500) NOT NULL,
	status_code INTEGER NOT NULL DEFAULT 301,
	is_active TINYINT(1) NOT NULL DEFAULT 1,
	hits INTEGER NOT NULL DEFAULT 0,
	id CHAR(36) NOT NULL,
	created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
	updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
	CONSTRAINT pk_url_redirects PRIMARY KEY (id),
	CONSTRAINT uq_url_redirects_from UNIQUE (from_path)
);
